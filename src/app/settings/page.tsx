import Link from "next/link";
import { ApiKeyForm } from "@/components/ApiKeyForm";
import { clearApiKeyAction, savePreferencesAction } from "@/lib/actions/prefs";
import { getDb } from "@/lib/db/client";
import { getPreferences, hasApiKey } from "@/lib/repo/prefs";

export const dynamic = "force-dynamic";

export default function SettingsPage() {
  const db = getDb();
  const prefs = getPreferences(db);
  const keySet = hasApiKey(db);

  return (
    <div>
      <p>
        <Link href="/">← All projects</Link>
      </p>
      <h1>Settings</h1>

      <div className="card">
        <h2>Preferences</h2>
        <form action={savePreferencesAction}>
          <div className="row">
            <div className="grow">
              <label htmlFor="displayName">Display name</label>
              <input
                id="displayName"
                type="text"
                name="displayName"
                defaultValue={prefs.displayName ?? ""}
              />
            </div>
            <div className="grow">
              <label htmlFor="language">Working language</label>
              <input
                id="language"
                type="text"
                name="language"
                defaultValue={prefs.language ?? ""}
                placeholder="e.g. es-AR"
              />
            </div>
          </div>
          <p>
            <button type="submit" className="primary">Save preferences</button>
          </p>
        </form>
      </div>

      <div className="card">
        <h2>OpenRouter API key</h2>
        <p className="muted">
          Paste your OpenRouter API key — it&apos;s the only technical setup
          the app needs. The key is validated with a test call on save, stored
          encrypted (AES-256-GCM) with a key that never leaves this machine,
          and never shown again. Models are chosen by the app automatically.
        </p>
        {keySet ? (
          <div className="row">
            <span className="badge done">API key configured</span>
            <form action={clearApiKeyAction}>
              <button type="submit" className="danger">Remove key</button>
            </form>
          </div>
        ) : (
          <ApiKeyForm />
        )}
      </div>
    </div>
  );
}
