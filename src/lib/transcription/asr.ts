// Automatic speech recognition seam (spec §4 stage 3.1). Like the AiClient
// seam, the rest of the app talks to this interface only — never a provider
// SDK — so the hosted ASR backend (Whisper large-v3 or an equivalent) can
// change without touching the executors. Every transcription carries
// word-level timestamps, which later stages use to resolve clips back to the
// recording.

/** One recognized word with its position in the recording, in seconds. */
export interface TranscriptionWord {
  word: string;
  start: number;
  end: number;
}

export interface TranscriptionResult {
  /** The full transcript text as the ASR produced it (no cleanup). */
  text: string;
  words: TranscriptionWord[];
  /** ISO language code the ASR detected (or was told), when available. */
  language: string | null;
  /** Model slug that served the call, for the audit trail. */
  model: string;
}

export interface TranscriptionRequest {
  audio: Buffer;
  mimeType: string;
  filename: string;
  /** Optional language hint; omitted lets the ASR auto-detect. */
  language?: string | null;
}

export interface TranscriptionClient {
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}

/** Thrown when no ASR backend is configured — surfaced as a clear job error. */
export class AsrNotConfiguredError extends Error {}
/** Thrown when the backend replies but the body is unusable. */
export class AsrProviderError extends Error {}

interface VerboseJson {
  text?: string;
  language?: string;
  words?: Array<{ word?: string; start?: number; end?: number }>;
  segments?: Array<{
    words?: Array<{ word?: string; start?: number; end?: number }>;
  }>;
}

/**
 * Hosted Whisper-compatible client against an OpenAI-style audio
 * transcriptions endpoint (`response_format=verbose_json`,
 * `timestamp_granularities[]=word`). Configured entirely from the environment
 * so no key ever lands in the database or a request body:
 *
 *   BOOK_WRITER_ASR_URL    full transcriptions endpoint URL (required)
 *   BOOK_WRITER_ASR_KEY    bearer token for the endpoint (optional)
 *   BOOK_WRITER_ASR_MODEL  model slug (defaults to whisper-large-v3)
 */
export class HostedWhisperClient implements TranscriptionClient {
  constructor(
    private readonly opts: {
      url: string;
      apiKey?: string;
      model?: string;
      fetchImpl?: typeof fetch;
    },
  ) {}

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const model = this.opts.model ?? "whisper-large-v3";
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(request.audio)], { type: request.mimeType }),
      request.filename,
    );
    form.append("model", model);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");
    if (request.language) form.append("language", request.language);

    let res: Response;
    try {
      res = await fetchImpl(this.opts.url, {
        method: "POST",
        headers: this.opts.apiKey
          ? { Authorization: `Bearer ${this.opts.apiKey}` }
          : undefined,
        body: form,
      });
    } catch (e) {
      throw new AsrProviderError(
        `The transcription service could not be reached: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    if (!res.ok) {
      throw new AsrProviderError(
        `The transcription service returned HTTP ${res.status}. ` +
          "The recording was not transcribed; try again.",
      );
    }
    let body: VerboseJson;
    try {
      body = (await res.json()) as VerboseJson;
    } catch {
      throw new AsrProviderError(
        "The transcription service returned an unreadable response.",
      );
    }
    const rawWords = body.words ?? body.segments?.flatMap((s) => s.words ?? []) ?? [];
    const words: TranscriptionWord[] = rawWords
      .filter((w): w is { word: string; start: number; end: number } =>
        typeof w.word === "string" &&
        typeof w.start === "number" &&
        typeof w.end === "number",
      )
      .map((w) => ({ word: w.word, start: w.start, end: w.end }));
    const text =
      typeof body.text === "string" && body.text.trim() !== ""
        ? body.text
        : words.map((w) => w.word).join(" ").trim();
    if (text === "") {
      throw new AsrProviderError(
        "The transcription came back empty. The recording may be silent or corrupt.",
      );
    }
    return {
      text,
      words,
      language: typeof body.language === "string" ? body.language : request.language ?? null,
      model,
    };
  }
}

// Swappable factory so the transcribe_audio executor is testable with a fake
// client, mirroring setAiFactoryForTests in executors.ts.
let transcriptionFactory: () => TranscriptionClient = defaultFactory;

function defaultFactory(): TranscriptionClient {
  const url = process.env.BOOK_WRITER_ASR_URL;
  if (!url) {
    throw new AsrNotConfiguredError(
      "No transcription service configured. Set BOOK_WRITER_ASR_URL (and " +
        "BOOK_WRITER_ASR_KEY) to a hosted Whisper large-v3 endpoint, or paste " +
        "the transcript in as a text source instead.",
    );
  }
  return new HostedWhisperClient({
    url,
    apiKey: process.env.BOOK_WRITER_ASR_KEY,
    model: process.env.BOOK_WRITER_ASR_MODEL,
  });
}

/** Test seam: replace the ASR client used by the transcribe_audio executor. */
export function setTranscriptionFactoryForTests(
  factory?: () => TranscriptionClient,
): void {
  transcriptionFactory = factory ?? defaultFactory;
}

export function createTranscriptionClient(): TranscriptionClient {
  return transcriptionFactory();
}
