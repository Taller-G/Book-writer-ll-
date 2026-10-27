// Models are asked for pure JSON but may wrap it in code fences or prose.
// Extract and parse the first JSON object in a completion, or throw a
// retry-friendly error (the job fails visibly and can be retried).

export class AiOutputFormatError extends Error {}

export function parseJsonObject<T>(text: string): T {
  const unfenced = text.replace(/```(?:json)?/gi, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new AiOutputFormatError(
      "The model's response did not contain a JSON object. Retry the job.",
    );
  }
  try {
    return JSON.parse(unfenced.slice(start, end + 1)) as T;
  } catch {
    throw new AiOutputFormatError(
      "The model's response contained malformed JSON. Retry the job.",
    );
  }
}
