// Acoustic audience-reaction detection — server-side DSP, NO AI (spec §4
// stage 3.4). The signal is cut into fixed 50 ms frames; each frame yields two
// classic features: RMS energy (how loud) and the zero-crossing rate (how
// noise-like vs tonal). Applause and laughter are broadband, noise-like and
// sustained — high RMS *and* high ZCR over several consecutive frames — which
// separates them from voiced speech (loud but low ZCR) and from a quiet room
// (low RMS everywhere). Thresholds are conservative so a quiet room yields
// nothing; every number is overridable for tuning against a real corpus.

export interface ReactionDspOptions {
  /** Frame length in milliseconds (spec: 50 ms). */
  frameMs?: number;
  /** Minimum reaction duration — shorter loud blips are ignored. */
  minDurationMs?: number;
  /** Mean RMS a segment must exceed to count as a reaction (0..1). */
  rmsThreshold?: number;
  /** Mean ZCR a segment must exceed (fraction of sign changes per sample). */
  zcrThreshold?: number;
  /** Below this envelope modulation the reaction is a steady wash (applause);
   *  at/above it the envelope is syllabic/bursty (laughter). */
  modulationSplit?: number;
  /** Bridge gaps no longer than this between active frames (one segment). */
  gapMs?: number;
}

export const DEFAULT_DSP: Required<ReactionDspOptions> = {
  frameMs: 50,
  minDurationMs: 350,
  rmsThreshold: 0.08,
  zcrThreshold: 0.12,
  modulationSplit: 0.35,
  gapMs: 150,
};

export interface FrameFeature {
  index: number;
  startMs: number;
  rms: number;
  zcr: number;
}

export interface DetectedReaction {
  kind: "laughter" | "applause";
  startMs: number;
  endMs: number;
  /** Mean RMS energy over the segment. */
  rms: number;
  /** Mean zero-crossing rate over the segment. */
  zcr: number;
  /** Envelope modulation (RMS coefficient of variation) — high for laughter. */
  modulation: number;
  frameCount: number;
}

/** Per-frame RMS energy and zero-crossing rate over the whole signal. */
export function frameFeatures(
  samples: Float32Array,
  sampleRate: number,
  frameMs: number,
): FrameFeature[] {
  const frameLen = Math.max(1, Math.round((frameMs / 1000) * sampleRate));
  const frames: FrameFeature[] = [];
  for (let start = 0, index = 0; start < samples.length; start += frameLen, index++) {
    const end = Math.min(start + frameLen, samples.length);
    let sumSq = 0;
    let crossings = 0;
    let prevSign = 0;
    for (let i = start; i < end; i++) {
      const v = samples[i];
      sumSq += v * v;
      const sign = v > 0 ? 1 : v < 0 ? -1 : 0;
      if (sign !== 0 && prevSign !== 0 && sign !== prevSign) crossings++;
      if (sign !== 0) prevSign = sign;
    }
    const n = end - start;
    frames.push({
      index,
      startMs: (start / sampleRate) * 1000,
      rms: Math.sqrt(sumSq / n),
      zcr: crossings / n,
    });
  }
  return frames;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/**
 * Detect audience reactions in a mono signal. Returns the qualifying segments
 * in time order; an empty array means nothing crossed the thresholds (the
 * quiet-room case). No AI, fully deterministic.
 */
export function detectReactions(
  samples: Float32Array,
  sampleRate: number,
  options: ReactionDspOptions = {},
): DetectedReaction[] {
  const opt = { ...DEFAULT_DSP, ...options };
  const frames = frameFeatures(samples, sampleRate, opt.frameMs);
  if (frames.length === 0) return [];

  // A frame is "active" when it is both loud and noise-like. Requiring both
  // keeps loud voiced speech (low ZCR) out.
  const active = frames.map(
    (f) => f.rms >= opt.rmsThreshold && f.zcr >= opt.zcrThreshold,
  );

  const maxGapFrames = Math.max(0, Math.round(opt.gapMs / opt.frameMs));
  const reactions: DetectedReaction[] = [];

  let i = 0;
  while (i < frames.length) {
    if (!active[i]) {
      i++;
      continue;
    }
    // Grow a segment, allowing short inactive gaps to bridge.
    let j = i;
    let gap = 0;
    let lastActive = i;
    while (j + 1 < frames.length) {
      j++;
      if (active[j]) {
        gap = 0;
        lastActive = j;
      } else if (++gap > maxGapFrames) {
        break;
      }
    }
    const segFrames = frames.slice(i, lastActive + 1);
    const startMs = segFrames[0].startMs;
    const endMs = segFrames[segFrames.length - 1].startMs + opt.frameMs;
    const durationMs = endMs - startMs;
    const rmsValues = segFrames.map((f) => f.rms);
    const segRms = mean(rmsValues);
    const segZcr = mean(segFrames.map((f) => f.zcr));
    const rmsSd = Math.sqrt(mean(rmsValues.map((r) => (r - segRms) ** 2)));
    const modulation = segRms > 0 ? rmsSd / segRms : 0;

    if (durationMs >= opt.minDurationMs && segRms >= opt.rmsThreshold) {
      // Both are broadband noise (the ZCR gate already confirmed that); the
      // envelope tells them apart. Applause is a flat, sustained wash (low
      // modulation); laughter is syllabic — a strongly modulated envelope.
      const kind = modulation >= opt.modulationSplit ? "laughter" : "applause";
      reactions.push({
        kind,
        startMs: Math.round(startMs),
        endMs: Math.round(endMs),
        rms: segRms,
        zcr: segZcr,
        modulation,
        frameCount: segFrames.length,
      });
    }
    i = lastActive + 1;
  }
  return reactions;
}
