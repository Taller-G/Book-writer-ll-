import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createAiClient } from "@/lib/ai";
import { DEFAULT_MODEL_CONFIG } from "@/lib/ai/config";
import {
  AiAuthError,
  AiCreditsError,
  AiProviderError,
  AiRateLimitError,
  OPENROUTER_TOPUP_URL,
} from "@/lib/ai/errors";
import { OpenRouterClient } from "@/lib/ai/openrouter";
import type { AiRequest } from "@/lib/ai/types";
import { openDatabase } from "@/lib/db/client";
import { getProjectSpend } from "@/lib/repo/aiUsage";
import { setApiKey } from "@/lib/repo/prefs";
import { createProject } from "@/lib/repo/projects";

// The crypto helper keeps its key under the data dir — point it at a temp dir.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "book-writer-test-"));
process.env.BOOK_WRITER_DATA_DIR = tmp;

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const TEST_KEY = "sk-or-v1-super-secret-test-key";

const REQUEST: AiRequest = {
  role: "large",
  system: {
    instructions: "Clean up this transcription.",
    contract: {
      projectId: "p1",
      mode: "hybrid",
      rules: "Keep the speaker's voice.",
      notes: "",
      signedAt: null,
    },
    styleProfile: {
      projectId: "p1",
      tone: "warm",
      register: "informal",
      person: "first",
      notes: "",
      data: "{}",
      updatedAt: "",
    },
  },
  messages: [{ role: "user", content: "hola um este mundo" }],
  projectId: "p1",
};

function ok(model: string, cost = 0.0123): Response {
  return new Response(
    JSON.stringify({
      model,
      choices: [{ message: { content: "cleaned text" } }],
      usage: { prompt_tokens: 100, completion_tokens: 80, cost },
    }),
    { status: 200 },
  );
}

function err(status: number, message = "", headers?: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: { message } }), { status, headers });
}

/** Mock fetch serving a queue of responses, recording every request. */
function mockFetch(queue: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = queue.shift();
    if (!next) throw new Error("mock fetch queue exhausted");
    return next;
  }) as typeof fetch;
  return { impl, calls };
}

function makeClient(
  fetchImpl: typeof fetch,
  onUsage?: ConstructorParameters<typeof OpenRouterClient>[0]["onUsage"],
) {
  const sleeps: number[] = [];
  const client = new OpenRouterClient({
    apiKey: TEST_KEY,
    getConfig: async () => DEFAULT_MODEL_CONFIG,
    onUsage,
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { client, sleeps };
}

describe("OpenRouter AI client", () => {
  it("completes with required headers and the system-context payload", async () => {
    const { impl, calls } = mockFetch([ok("anthropic/claude-sonnet-4.6")]);
    const { client } = makeClient(impl);
    const res = await client.complete(REQUEST);

    expect(res.text).toBe("cleaned text");
    expect(res.model).toBe("anthropic/claude-sonnet-4.6");
    expect(res.usage.costUsd).toBeCloseTo(0.0123);

    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TEST_KEY}`);
    expect(headers["HTTP-Referer"]).toBeTruthy();
    expect(headers["X-Title"]).toBeTruthy();

    const body = JSON.parse(String(calls[0].init.body));
    expect(body.model).toBe("anthropic/claude-sonnet-4.6");
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("Editorial contract (mode: hybrid)");
    expect(body.messages[0].content).toContain("Style profile — tone: warm");
    // The key is never placed in the request body.
    expect(String(calls[0].init.body)).not.toContain(TEST_KEY);
  });

  it("retries a rate-limited call with backoff and completes", async () => {
    const { impl, calls } = mockFetch([
      err(429),
      err(429, "", { "retry-after": "2" }),
      ok("anthropic/claude-sonnet-4.6"),
    ]);
    const { client, sleeps } = makeClient(impl);
    const res = await client.complete(REQUEST);

    expect(res.text).toBe("cleaned text");
    expect(calls).toHaveLength(3);
    // Exponential backoff first, then the Retry-After header is honored.
    expect(sleeps).toEqual([500, 2000]);
  });

  it("surfaces a rate-limit error once retries are exhausted", async () => {
    const { impl } = mockFetch([err(429), err(429), err(429), err(429)]);
    const { client } = makeClient(impl);
    await expect(client.complete(REQUEST)).rejects.toThrow(AiRateLimitError);
  });

  it("maps 401 to the named 'invalid key' error", async () => {
    const { impl } = mockFetch([err(401, "User not found.")]);
    const { client } = makeClient(impl);
    await expect(client.complete(REQUEST)).rejects.toThrow(/Invalid key/);
  });

  it("maps 402 to an actionable 'no credit' notice with the top-up link", async () => {
    const { impl } = mockFetch([err(402, "Insufficient credits")]);
    const { client } = makeClient(impl);
    const failure = await client.complete(REQUEST).catch((e) => e);
    expect(failure).toBeInstanceOf(AiCreditsError);
    expect(failure.message).toContain("No credit");
    expect(failure.message).toContain(OPENROUTER_TOPUP_URL);
  });

  it("falls back across Claude variants on provider outage", async () => {
    const { impl, calls } = mockFetch([
      err(502, "provider down"),
      ok("anthropic/claude-opus-4.8"),
    ]);
    const { client } = makeClient(impl);
    const res = await client.complete(REQUEST);

    expect(res.model).toBe("anthropic/claude-opus-4.8");
    expect(JSON.parse(String(calls[0].init.body)).model).toBe(
      "anthropic/claude-sonnet-4.6",
    );
    expect(JSON.parse(String(calls[1].init.body)).model).toBe(
      "anthropic/claude-opus-4.8",
    );
  });

  it("reports an outage only after every Claude variant failed", async () => {
    // large role has 1 primary + 2 fallbacks in the default config.
    const { impl, calls } = mockFetch([err(503), err(503), err(503)]);
    const { client } = makeClient(impl);
    await expect(client.complete(REQUEST)).rejects.toThrow(AiProviderError);
    expect(calls).toHaveLength(3);
  });

  it("never includes the API key in any thrown error message", async () => {
    const scenarios = [
      [err(401, `bad key ${TEST_KEY}`)],
      [err(402, `key ${TEST_KEY} has no credits`)],
      [err(429), err(429), err(429), err(429)],
      [err(500, TEST_KEY), err(500, TEST_KEY), err(500, TEST_KEY)],
      [err(404, `model gone, auth Bearer ${TEST_KEY}`)],
    ];
    for (const queue of scenarios) {
      const { impl } = mockFetch(queue);
      const { client } = makeClient(impl);
      const failure: unknown = await client.complete(REQUEST).catch((e) => e);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).not.toContain(TEST_KEY);
    }
  });
});

describe("createAiClient factory", () => {
  it("throws the named auth error when no key is configured", () => {
    const { db } = openDatabase(":memory:");
    expect(() => createAiClient(db)).toThrow(AiAuthError);
  });

  it("decrypts the stored key and records spend after completed calls", async () => {
    const handle = openDatabase(":memory:");
    const { db } = handle;
    setApiKey(db, TEST_KEY);
    const project = createProject(handle, { title: "Spend test" });

    const { impl } = mockFetch([ok("anthropic/claude-sonnet-4.6", 0.05)]);
    const client = createAiClient(db, { fetchImpl: impl });
    await client.complete({ ...REQUEST, projectId: project.id });

    // The project's spend counter increases from OpenRouter's usage data.
    expect(getProjectSpend(db, project.id)).toBeCloseTo(0.05, 6);
  });
});
