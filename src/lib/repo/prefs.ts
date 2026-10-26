import { eq } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "../crypto";
import type { Db } from "../db/client";
import { userPrefs } from "../db/schema";
import { now } from "../util";

export interface Preferences {
  displayName?: string;
  language?: string;
}

export function getPreferences(db: Db): Preferences {
  const row = db.select().from(userPrefs).where(eq(userPrefs.id, 1)).get();
  try {
    return row ? (JSON.parse(row.preferences) as Preferences) : {};
  } catch {
    return {};
  }
}

export function savePreferences(db: Db, prefs: Preferences): void {
  db.update(userPrefs)
    .set({ preferences: JSON.stringify(prefs), updatedAt: now() })
    .where(eq(userPrefs.id, 1))
    .run();
}

export function hasApiKey(db: Db): boolean {
  const row = db.select().from(userPrefs).where(eq(userPrefs.id, 1)).get();
  return Boolean(row?.apiKeyCiphertext);
}

export function setApiKey(db: Db, plaintextKey: string): void {
  const enc = encryptSecret(plaintextKey);
  db.update(userPrefs)
    .set({
      apiKeyCiphertext: enc.ciphertext,
      apiKeyIv: enc.iv,
      apiKeyTag: enc.tag,
      updatedAt: now(),
    })
    .where(eq(userPrefs.id, 1))
    .run();
}

export function clearApiKey(db: Db): void {
  db.update(userPrefs)
    .set({
      apiKeyCiphertext: null,
      apiKeyIv: null,
      apiKeyTag: null,
      updatedAt: now(),
    })
    .where(eq(userPrefs.id, 1))
    .run();
}

/** Server-side only: used by stage executors that call the Claude API. */
export function getApiKey(db: Db): string | undefined {
  const row = db.select().from(userPrefs).where(eq(userPrefs.id, 1)).get();
  if (!row?.apiKeyCiphertext || !row.apiKeyIv || !row.apiKeyTag) return undefined;
  return decryptSecret({
    ciphertext: row.apiKeyCiphertext,
    iv: row.apiKeyIv,
    tag: row.apiKeyTag,
  });
}
