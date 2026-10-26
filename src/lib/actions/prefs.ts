"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "../db/client";
import { clearApiKey, savePreferences, setApiKey } from "../repo/prefs";

export async function savePreferencesAction(formData: FormData): Promise<void> {
  savePreferences(getDb(), {
    displayName: String(formData.get("displayName") ?? ""),
    language: String(formData.get("language") ?? ""),
  });
  revalidatePath("/settings");
}

export async function setApiKeyAction(formData: FormData): Promise<void> {
  const key = String(formData.get("apiKey") ?? "").trim();
  if (key) setApiKey(getDb(), key);
  revalidatePath("/settings");
}

export async function clearApiKeyAction(): Promise<void> {
  clearApiKey(getDb());
  revalidatePath("/settings");
}
