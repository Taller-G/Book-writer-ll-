"use client";

import { useRef, useState } from "react";

/**
 * Plays the located audio clip — not the whole recording. The window was found
 * by text anchors server-side (so a 30 s timestamp drift doesn't matter); here
 * we just clamp playback to [start, end], so pressing play always lands on the
 * doubtful moment with ~±12 s of context around it.
 */
export function ReviewClipPlayer({
  src,
  start,
  end,
  locatedBy,
}: {
  src: string;
  start: number;
  end: number;
  locatedBy: "anchor" | "timestamp" | "none";
}) {
  const ref = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);

  function playClip() {
    const audio = ref.current;
    if (!audio) return;
    audio.currentTime = start;
    void audio.play();
  }

  function onTimeUpdate() {
    const audio = ref.current;
    if (!audio) return;
    // Stop at the end of the located window — keeps the clip "trimmed".
    if (audio.currentTime >= end) {
      audio.pause();
      audio.currentTime = start;
    }
  }

  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  return (
    <div className="clip-player">
      <audio
        ref={ref}
        src={src}
        preload="metadata"
        controls
        onTimeUpdate={onTimeUpdate}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
      <div className="row" style={{ alignItems: "center", gap: "0.5rem" }}>
        <button type="button" onClick={playClip}>
          {playing ? "↻ Replay clip" : "▶ Play clip"} ({fmt(start)}–{fmt(end)})
        </button>
        <span className="muted" style={{ fontSize: "0.8rem" }}>
          {locatedBy === "anchor"
            ? "located by text anchor (timestamp-drift-proof)"
            : locatedBy === "timestamp"
              ? "located by raw timestamp (no anchor matched — may drift)"
              : "no clip location available"}
        </span>
      </div>
    </div>
  );
}
