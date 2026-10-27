"use client";

import { useEffect, useRef, useState } from "react";
import { sendCorrectionAction } from "@/lib/actions/correction";

interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * In-app PDF preview with spread mode (facing pages, like an open book). The
 * user drags a box over a problem area; the marked region is captured as a PNG
 * and sent to the correction agent together with its page number. A screenshot
 * can be attached instead. This is the friction the terminal workflow lacked:
 * pointing at the problem instead of describing where it is in words.
 */
export function PdfCorrectionViewer({
  projectId,
  pages,
  aspect,
  version,
}: {
  projectId: string;
  pages: string[];
  /** page height / width, for the canvas aspect ratio. */
  aspect: number;
  version: number | null;
}) {
  const [spread, setSpread] = useState(0); // index of the left page of the spread
  const [selPage, setSelPage] = useState<number | null>(null);
  const [region, setRegion] = useState<Region | null>(null);
  const [image, setImage] = useState<string | null>(null);

  const leftRef = useRef<HTMLCanvasElement>(null);
  const rightRef = useRef<HTMLCanvasElement>(null);

  const CANVAS_W = 320;
  const CANVAS_H = Math.round(CANVAS_W * aspect);

  const totalPages = pages.length;
  const leftPage = spread; // 0-based
  const rightPage = spread + 1;

  function draw(canvas: HTMLCanvasElement | null, pageIndex: number) {
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.strokeStyle = "#ddd";
    ctx.strokeRect(0.5, 0.5, CANVAS_W - 1, CANVAS_H - 1);
    const text = pages[pageIndex];
    if (text === undefined) {
      ctx.fillStyle = "#bbb";
      ctx.font = "12px sans-serif";
      ctx.fillText("—", CANVAS_W / 2 - 4, CANVAS_H / 2);
      return;
    }
    ctx.fillStyle = "#222";
    ctx.font = "7px Georgia, serif";
    const lines = text.split("\n");
    const marginX = 24;
    let y = 28;
    const lineH = 9;
    for (const line of lines) {
      if (y > CANVAS_H - 20) break;
      ctx.fillText(line.slice(0, 70), marginX, y);
      y += lineH;
    }
    ctx.fillStyle = "#999";
    ctx.font = "7px sans-serif";
    ctx.fillText(String(pageIndex + 1), CANVAS_W / 2 - 3, CANVAS_H - 10);
  }

  useEffect(() => {
    draw(leftRef.current, leftPage);
    draw(rightRef.current, rightPage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spread, pages]);

  function captureRegion(
    canvas: HTMLCanvasElement,
    pageIndex: number,
    r: Region,
  ) {
    const sx = r.x * CANVAS_W;
    const sy = r.y * CANVAS_H;
    const sw = Math.max(1, r.w * CANVAS_W);
    const sh = Math.max(1, r.h * CANVAS_H);
    const crop = document.createElement("canvas");
    crop.width = Math.round(sw);
    crop.height = Math.round(sh);
    const cctx = crop.getContext("2d");
    if (!cctx) return;
    cctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, crop.width, crop.height);
    setImage(crop.toDataURL("image/png"));
    setSelPage(pageIndex + 1);
    setRegion(r);
  }

  function onCanvasSelect(
    e: React.MouseEvent<HTMLCanvasElement>,
    pageIndex: number,
  ) {
    const canvas = e.currentTarget;
    const rect = canvas.getBoundingClientRect();
    const startX = (e.clientX - rect.left) / rect.width;
    const startY = (e.clientY - rect.top) / rect.height;

    function move(ev: MouseEvent) {
      const curX = (ev.clientX - rect.left) / rect.width;
      const curY = (ev.clientY - rect.top) / rect.height;
      const r = {
        x: Math.min(startX, curX),
        y: Math.min(startY, curY),
        w: Math.abs(curX - startX),
        h: Math.abs(curY - startY),
      };
      draw(canvas, pageIndex);
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.strokeStyle = "#c0392b";
        ctx.lineWidth = 2;
        ctx.strokeRect(r.x * CANVAS_W, r.y * CANVAS_H, r.w * CANVAS_W, r.h * CANVAS_H);
      }
    }
    function up(ev: MouseEvent) {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      const curX = (ev.clientX - rect.left) / rect.width;
      const curY = (ev.clientY - rect.top) / rect.height;
      const r = {
        x: Math.min(startX, curX),
        y: Math.min(startY, curY),
        w: Math.abs(curX - startX),
        h: Math.abs(curY - startY),
      };
      if (r.w > 0.02 && r.h > 0.02) captureRegion(canvas, pageIndex, r);
    }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  function onScreenshot(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setImage(typeof reader.result === "string" ? reader.result : null);
      setSelPage(null);
      setRegion(null);
    };
    reader.readAsDataURL(file);
  }

  function clearAnnotation() {
    setImage(null);
    setSelPage(null);
    setRegion(null);
    draw(leftRef.current, leftPage);
    draw(rightRef.current, rightPage);
  }

  if (totalPages === 0) {
    return (
      <p className="muted">
        No preview yet — generate an export above to start the correction cycle.
      </p>
    );
  }

  return (
    <div>
      <p className="muted" style={{ fontSize: "0.85rem" }}>
        Drag a box over a problem area to mark it{version ? ` (preview v${version})` : ""}.
        The marked region and its page number go to the agent as an image.
      </p>
      <div className="row" style={{ justifyContent: "center", gap: "0.25rem" }}>
        <canvas
          ref={leftRef}
          width={CANVAS_W}
          height={CANVAS_H}
          style={{ cursor: "crosshair", boxShadow: "0 1px 4px rgba(0,0,0,0.2)" }}
          onMouseDown={(e) => onCanvasSelect(e, leftPage)}
        />
        {rightPage < totalPages && (
          <canvas
            ref={rightRef}
            width={CANVAS_W}
            height={CANVAS_H}
            style={{ cursor: "crosshair", boxShadow: "0 1px 4px rgba(0,0,0,0.2)" }}
            onMouseDown={(e) => onCanvasSelect(e, rightPage)}
          />
        )}
      </div>
      <div className="row" style={{ justifyContent: "center", marginTop: "0.5rem" }}>
        <button type="button" onClick={() => setSpread(Math.max(0, spread - 2))} disabled={spread === 0}>
          ← Previous
        </button>
        <span className="muted" style={{ fontSize: "0.85rem" }}>
          Pages {leftPage + 1}
          {rightPage < totalPages ? `–${rightPage + 1}` : ""} of {totalPages}
        </span>
        <button
          type="button"
          onClick={() => setSpread(Math.min(totalPages - 1, spread + 2))}
          disabled={rightPage >= totalPages - 1}
        >
          Next →
        </button>
      </div>

      <form action={sendCorrectionAction} className="card" style={{ marginTop: "0.8rem" }}>
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="pageNumber" value={selPage ?? ""} />
        <input type="hidden" name="region" value={region ? JSON.stringify(region) : ""} />
        <input type="hidden" name="image" value={image ?? ""} />
        {image && (
          <div className="row" style={{ alignItems: "center" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={image}
              alt="marked region"
              style={{ maxHeight: 60, border: "1px solid #ccc" }}
            />
            <span className="muted" style={{ fontSize: "0.8rem" }}>
              {selPage ? `Annotation on page ${selPage}` : "Attached screenshot"}
            </span>
            <button type="button" onClick={clearAnnotation}>
              Clear
            </button>
          </div>
        )}
        <textarea
          name="userText"
          required
          rows={2}
          placeholder="Describe the problem — the agent decides if it's a content or a layout change…"
          style={{ width: "100%", marginTop: "0.5rem" }}
        />
        <div className="row" style={{ justifyContent: "space-between", marginTop: "0.4rem" }}>
          <label className="muted" style={{ fontSize: "0.8rem" }}>
            Attach screenshot:{" "}
            <input type="file" accept="image/*" onChange={onScreenshot} />
          </label>
          <button type="submit" className="primary">
            Send to agent
          </button>
        </div>
      </form>
    </div>
  );
}
