import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase } from "@/lib/db/client";
import { clearApiKey, getApiKey, hasApiKey, setApiKey } from "@/lib/repo/prefs";

// The crypto helper keeps its key under the data dir — point it at a temp dir.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "book-writer-test-"));
process.env.BOOK_WRITER_DATA_DIR = tmp;

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("encrypted API key slot", () => {
  it("stores the key encrypted and round-trips it", () => {
    const { db, sqlite } = openDatabase(":memory:");
    expect(hasApiKey(db)).toBe(false);

    setApiKey(db, "sk-ant-test-123");
    expect(hasApiKey(db)).toBe(true);
    expect(getApiKey(db)).toBe("sk-ant-test-123");

    // The plaintext never appears in the database.
    const row = sqlite
      .prepare("SELECT api_key_ciphertext FROM user_prefs WHERE id = 1")
      .get() as { api_key_ciphertext: string };
    expect(row.api_key_ciphertext).not.toContain("sk-ant");

    clearApiKey(db);
    expect(hasApiKey(db)).toBe(false);
    expect(getApiKey(db)).toBeUndefined();
  });
});
