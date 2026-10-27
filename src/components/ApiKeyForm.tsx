"use client";

import { useActionState } from "react";
import { setApiKeyAction, type ApiKeyFormState } from "@/lib/actions/prefs";

const IDLE: ApiKeyFormState = { status: "idle" };

/**
 * The paste-your-key form. The key is sent once to the server action for
 * validation + encrypted storage and never comes back: after save the page
 * only knows the boolean "a key is configured".
 */
export function ApiKeyForm() {
  const [state, formAction, pending] = useActionState(setApiKeyAction, IDLE);

  return (
    <form action={formAction}>
      <div className="row">
        <div className="grow">
          <input
            type="password"
            name="apiKey"
            placeholder="sk-or-…"
            autoComplete="off"
            required
          />
        </div>
        <button type="submit" className="primary" disabled={pending}>
          {pending ? "Validating…" : "Validate & save"}
        </button>
      </div>
      {state.status === "error" && (
        <p className="error-box" data-testid="api-key-error">
          {state.message}
        </p>
      )}
      {state.status === "saved" && (
        <p className="muted" data-testid="api-key-saved">
          {state.message}
        </p>
      )}
    </form>
  );
}
