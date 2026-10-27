"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { addCoverAnnotationAction } from "@/lib/actions/covers";

// The interactive cover preview (client island). It draws the full flat spread
// — back cover, spine, front cover — with the 3 mm bleed and trim guides, lets
// the user mark a region on the front cover and send it to the agent, shows a
// lightweight pseudo-3D of the closed book, and uploads a PNG design.

export interface PreviewConcept {
  id: string;
  approach: string;
  approachLabel: string;
  title: string;
  subtitle: string;
  tagline: string;
  palette: string[];
  imagery: string;
  source: "ai" | "upload";
  hasImage: boolean;
  status: string;
}

export interface SpreadInfo {
  pageWidthMm: number;
  pageHeightMm: number;
  spineWidthMm: number;
  bleedMm: number;
  totalWidthMm: number;
  totalHeightMm: number;
  totalWidthPx: number;
  totalHeightPx: number;
}

interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0.5;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

export function CoverPreview({
  projectId,
  concepts,
  spread,
}: {
  projectId: string;
  concepts: PreviewConcept[];
  spread: SpreadInfo;
}) {
  const router = useRouter();
  const [activeId, setActiveId] = useState(concepts[0]?.id ?? "");
  const [region, setRegion] = useState<Region | null>(null);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const frontRef = useRef<HTMLDivElement | null>(null);

  const active = concepts.find((c) => c.id === activeId) ?? concepts[0] ?? null;
  const base = active?.palette?.[0] ?? "#f3efe6";
  const accent = active?.palette?.[1] ?? "#6b5b4a";
  const ink = luminance(base) > 0.55 ? "#1a1a1a" : "#f7f3ec";

  // Scale the whole spread to a comfortable on-screen width.
  const screenW = 640;
  const scale = screenW / spread.totalWidthMm;
  const px = (mm: number) => mm * scale;
  const bleed = px(spread.bleedMm);
  const pageW = px(spread.pageWidthMm);
  const spineW = px(spread.spineWidthMm);
  const pageH = px(spread.pageHeightMm);

  function pointerToFraction(e: React.PointerEvent): { x: number; y: number } {
    const el = frontRef.current!;
    const rect = el.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  }

  function onPointerDown(e: React.PointerEvent) {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const p = pointerToFraction(e);
    setDrag(p);
    setRegion({ x: p.x, y: p.y, w: 0, h: 0 });
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!drag) return;
    const p = pointerToFraction(e);
    setRegion({
      x: Math.min(drag.x, p.x),
      y: Math.min(drag.y, p.y),
      w: Math.abs(p.x - drag.x),
      h: Math.abs(p.y - drag.y),
    });
  }
  function onPointerUp() {
    setDrag(null);
    setRegion((r) => (r && r.w < 0.02 && r.h < 0.02 ? null : r));
  }

  async function handleUpload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const input = form.elements.namedItem("file") as HTMLInputElement;
    if (!input.files?.[0]) return;
    const fd = new FormData();
    fd.set("file", input.files[0]);
    setUploading(true);
    setUploadMsg(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/covers`, {
        method: "POST",
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) {
        setUploadMsg(data.error ?? "Upload failed.");
      } else if (data.fit?.ok) {
        setUploadMsg(
          `Uploaded. Matches the ${data.spread.totalWidthPx}×${data.spread.totalHeightPx}px spread (incl. bleed).`,
        );
        form.reset();
        router.refresh();
      } else {
        setUploadMsg(
          `Uploaded, but check the fit: ${(data.fit?.reasons ?? []).join(" ")}`,
        );
        form.reset();
        router.refresh();
      }
    } catch {
      setUploadMsg("Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  const imageUrl =
    active?.source === "upload" && active.hasImage
      ? `/api/projects/${projectId}/covers/${active.id}/image`
      : null;

  const frontFace = (interactive: boolean) => (
    <div
      ref={interactive ? frontRef : undefined}
      onPointerDown={interactive ? onPointerDown : undefined}
      onPointerMove={interactive ? onPointerMove : undefined}
      onPointerUp={interactive ? onPointerUp : undefined}
      style={{
        position: "relative",
        width: pageW,
        height: pageH,
        background: imageUrl ? "#222" : base,
        color: ink,
        overflow: "hidden",
        cursor: interactive ? "crosshair" : "default",
        touchAction: "none",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: px(12),
        boxSizing: "border-box",
      }}
      data-testid={interactive ? "cover-front-annotatable" : undefined}
    >
      {imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl}
          alt={active?.title ?? "cover"}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
        />
      )}
      <div style={{ position: "relative", fontSize: px(5), letterSpacing: "0.1em", opacity: 0.8 }}>
        {active?.tagline}
      </div>
      <div style={{ position: "relative" }}>
        <div style={{ fontSize: px(13), fontWeight: 700, lineHeight: 1.1 }}>
          {active?.title}
        </div>
        {active?.subtitle && (
          <div style={{ fontSize: px(6), marginTop: px(3), color: accent }}>
            {active.subtitle}
          </div>
        )}
      </div>
      {interactive && region && region.w > 0 && region.h > 0 && (
        <div
          style={{
            position: "absolute",
            left: `${region.x * 100}%`,
            top: `${region.y * 100}%`,
            width: `${region.w * 100}%`,
            height: `${region.h * 100}%`,
            border: "2px solid #e5484d",
            background: "rgba(229,72,77,0.15)",
            pointerEvents: "none",
          }}
          data-testid="annotation-region"
        />
      )}
    </div>
  );

  return (
    <div>
      {concepts.length > 1 && (
        <div className="row" style={{ flexWrap: "wrap", marginBottom: "0.6rem" }}>
          {concepts.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => {
                setActiveId(c.id);
                setRegion(null);
              }}
              className={c.id === activeId ? "primary" : undefined}
            >
              {c.approachLabel}
              {c.source === "upload" ? " (yours)" : ""}
            </button>
          ))}
        </div>
      )}

      {active ? (
        <>
          {/* Flat full spread with bleed + trim guides -------------------- */}
          <div style={{ overflowX: "auto" }}>
            <div
              data-testid="cover-spread"
              style={{
                position: "relative",
                display: "inline-flex",
                padding: bleed,
                background:
                  "repeating-linear-gradient(45deg,#eee,#eee 6px,#e3e3e3 6px,#e3e3e3 12px)",
                outline: "1px dashed #b00",
              }}
              title="The hatched border is the 3 mm bleed; the solid inner edge is the trim line."
            >
              {/* Back cover */}
              <div
                style={{
                  width: pageW,
                  height: pageH,
                  background: base,
                  color: ink,
                  padding: px(12),
                  boxSizing: "border-box",
                  fontSize: px(5),
                  borderRight: "1px solid rgba(0,0,0,0.15)",
                }}
              >
                <div style={{ opacity: 0.7 }}>Back cover</div>
              </div>
              {/* Spine */}
              <div
                style={{
                  width: spineW,
                  height: pageH,
                  background: accent,
                  color: luminance(accent) > 0.55 ? "#1a1a1a" : "#f7f3ec",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
                title={`Spine ${spread.spineWidthMm.toFixed(1)} mm`}
              >
                <span
                  style={{
                    writingMode: "vertical-rl",
                    fontSize: px(5),
                    whiteSpace: "nowrap",
                  }}
                >
                  {active.title}
                </span>
              </div>
              {/* Front cover (annotatable) */}
              {frontFace(true)}
            </div>
          </div>
          <p className="muted preview-caption">
            Full print spread — back · spine ({spread.spineWidthMm.toFixed(1)} mm) ·
            front — at {spread.totalWidthMm.toFixed(0)} × {spread.totalHeightMm.toFixed(0)} mm
            including {spread.bleedMm} mm bleed. Drag on the front cover to mark a
            region for the agent.
          </p>

          {/* Pseudo-3D closed book --------------------------------------- */}
          <div
            style={{
              perspective: "1200px",
              margin: "1rem 0",
              display: "flex",
              justifyContent: "center",
            }}
          >
            <div
              style={{
                transform: "rotateY(-28deg)",
                transformStyle: "preserve-3d",
                boxShadow: "14px 18px 30px rgba(0,0,0,0.28)",
                position: "relative",
              }}
              data-testid="cover-3d"
            >
              {frontFace(false)}
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  left: -spineW,
                  width: spineW,
                  height: pageH,
                  background: accent,
                  transform: `rotateY(90deg) translateX(-${spineW / 2}px)`,
                  transformOrigin: "right center",
                }}
              />
            </div>
          </div>

          {/* Annotation → agent ------------------------------------------ */}
          <form action={addCoverAnnotationAction} className="card">
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="conceptId" value={active.id} />
            <input type="hidden" name="target" value="front" />
            <input
              type="hidden"
              name="region"
              value={region ? JSON.stringify(region) : ""}
            />
            <label htmlFor="annotation-note">
              {region
                ? "Annotation on the marked region"
                : "Comment to the cover agent (or drag a region above first)"}
            </label>
            <textarea
              id="annotation-note"
              name="note"
              rows={2}
              placeholder="e.g. make the title bigger and move it up here"
              required
            />
            <button type="submit" className="primary" data-testid="send-annotation">
              Send to agent{region ? " with region" : ""}
            </button>
          </form>
        </>
      ) : (
        <p className="muted">
          No cover concept yet — propose one, or upload your own PNG below.
        </p>
      )}

      {/* Upload your own design ---------------------------------------- */}
      <form onSubmit={handleUpload} className="card" style={{ marginTop: "0.6rem" }}>
        <label htmlFor="cover-file">Upload your own cover (print-ready PNG)</label>
        <p className="muted" style={{ marginTop: 0 }}>
          Target: {spread.totalWidthPx} × {spread.totalHeightPx} px — the full
          spread (back + spine + front) at 300 DPI, including {spread.bleedMm} mm
          bleed on every side.
        </p>
        <div className="row">
          <input id="cover-file" type="file" name="file" accept="image/png" />
          <button type="submit" disabled={uploading}>
            {uploading ? "Uploading…" : "Upload PNG"}
          </button>
        </div>
        {uploadMsg && (
          <p className="muted" data-testid="upload-msg" style={{ marginBottom: 0 }}>
            {uploadMsg}
          </p>
        )}
      </form>
    </div>
  );
}
