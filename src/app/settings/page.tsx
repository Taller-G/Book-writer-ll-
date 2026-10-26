import Link from "next/link";
import {
  clearApiKeyAction,
  savePreferencesAction,
  setApiKeyAction,
} from "@/lib/actions/prefs";
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
        <h2>Claude API key</h2>
        <p className="muted">
          Stored encrypted (AES-256-GCM) with a key that never leaves this
          machine. Used by the AI-powered stages.
        </p>
        {keySet ? (
          <div className="row">
            <span className="badge done">API key configured</span>
            <form action={clearApiKeyAction}>
              <button type="submit" className="danger">Remove key</button>
            </form>
          </div>
        ) : (
          <form action={setApiKeyAction} className="row">
            <div className="grow">
              <input type="password" name="apiKey" placeholder="sk-ant-…" required />
            </div>
            <button type="submit" className="primary">Save key</button>
          </form>
        )}
      </div>
    </div>
  );
}
