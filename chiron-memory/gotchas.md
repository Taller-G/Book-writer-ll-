# gotcha

A non-obvious pitfall or trap, learned the hard way.

## Provider error text must be redacted before it reaches an error message

What: The OpenRouter client passes any provider-echoed text through redactSecrets (strips sk-or-*/sk-ant-*/Bearer tokens) before building an error message · Why: job errors are persisted in jobs.error and rendered in the UI — a provider echoing the key back would otherwise leak it into both · Where: src/lib/ai/errors.ts, src/lib/ai/openrouter.ts · Learned: treat provider error bodies as untrusted output that may contain your own secrets
