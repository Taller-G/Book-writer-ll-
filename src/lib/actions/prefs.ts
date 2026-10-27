"use server";

import { revalidatePath } from "next/cache";
import { OPENROUTER_TOPUP_URL } from "../ai/errors";
import { validateOpenRouterKey } from "../ai/validateKey";
import { getDb } from "../db/client";
import { clearApiKey, savePreferences, setApiKey } from "../repo/prefs";

export interface ApiKeyFormState {
  status: "idle" | "saved" | "error";
  /** User-facing message; never contains the key. */
  message?: string;
}

export async function savePreferencesAction(formData: FormData): Promise<void> {
  savePreferences(getDb(), {
    displayName: String(formData.get("displayName") ?? ""),
    language: String(formData.get("language") ?? ""),
  });
  revalidatePath("/settings");
}

/**
 * Validate-then-save (spec §9): the key is only stored after a successful
 * test call against OpenRouter. The named errors — "invalid key", "no
 * credit" — come back as state for the form; the key itself never appears in
 * any returned payload.
 */
export async function setApiKeyAction(
  _prev: ApiKeyFormState,
  formData: FormData,
): Promise<ApiKeyFormState> {
  const key = String(formData.get("apiKey") ?? "").trim();
  if (!key) {
    return { status: "error", message: "Paste your OpenRouter API key first." };
  }
  const result = await validateOpenRouterKey(key);
  if (!result.ok) {
    switch (result.error) {
      case "invalid key":
        return {
          status: "error",
          message: "Invalid key: OpenRouter rejected this API key. Check it and try again.",
        };
      case "no credit":
        return {
          status: "error",
          message: `No credit: this key has no remaining credit. Top up at ${OPENROUTER_TOPUP_URL} and save again.`,
        };
      default:
        return {
          status: "error",
          message: "Could not reach OpenRouter to validate the key. Check your connection and retry.",
        };
    }
  }
  setApiKey(getDb(), key);
  revalidatePath("/settings");
  return { status: "saved", message: "Key validated and saved." };
}

export async function clearApiKeyAction(): Promise<void> {
  clearApiKey(getDb());
  revalidatePath("/settings");
}
