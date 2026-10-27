import { redactSecrets } from "./errors";
import { OPENROUTER_APP_HEADERS, OPENROUTER_BASE_URL } from "./openrouter";

// Key validation on save (spec §9): a free test call to GET /api/v1/key.
// 401 means the key itself is bad ("invalid key"); a key whose remaining
// credit is already spent gets "no credit" so the user isn't surprised by the
// first real completion failing. Network trouble is reported as such — the
// key is NOT saved in that case, the user can simply retry.

export type KeyValidation =
  | { ok: true }
  | { ok: false; error: "invalid key" | "no credit" | "network" ; detail?: string };

interface KeyInfo {
  data?: {
    limit?: number | null;
    limit_remaining?: number | null;
  };
}

export async function validateOpenRouterKey(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<KeyValidation> {
  let res: Response;
  try {
    res = await fetchImpl(`${OPENROUTER_BASE_URL}/key`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...OPENROUTER_APP_HEADERS,
      },
    });
  } catch (err) {
    return {
      ok: false,
      error: "network",
      detail: redactSecrets(err instanceof Error ? err.message : String(err)),
    };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: "invalid key" };
  }
  if (res.status === 402) {
    return { ok: false, error: "no credit" };
  }
  if (!res.ok) {
    return { ok: false, error: "network", detail: `HTTP ${res.status}` };
  }
  try {
    const info = (await res.json()) as KeyInfo;
    const remaining = info.data?.limit_remaining;
    // limit is null for unlimited keys; only a known-exhausted limit blocks.
    if (typeof remaining === "number" && remaining <= 0) {
      return { ok: false, error: "no credit" };
    }
  } catch {
    // An unparseable body on a 200 still proves the key authenticates.
  }
  return { ok: true };
}
