"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { ImageUploadResponseItem } from "@/app/api/projects/[id]/images/route";

const ACCEPT = ".png,.jpg,.jpeg,.gif,.webp";

/** Upload book images to the review grid (spec §4 Stage 6.4). */
export function ImageDropzone({ projectId }: { projectId: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<ImageUploadResponseItem[]>([]);

  async function upload(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0 || busy) return;
    setBusy(true);
    setResults([]);
    try {
      const form = new FormData();
      for (const f of list) form.append("files", f);
      const res = await fetch(`/api/projects/${projectId}/images`, {
        method: "POST",
        body: form,
      });
      const body = await res.json();
      if (!res.ok) {
        setResults(
          list.map((f) => ({
            filename: f.name,
            ok: false,
            error: body.error ?? `Upload failed (${res.status}).`,
          })),
        );
      } else {
        setResults(body.results as ImageUploadResponseItem[]);
        router.refresh();
      }
    } catch (e) {
      setResults(
        list.map((f) => ({
          filename: f.name,
          ok: false,
          error: `Upload failed: ${e instanceof Error ? e.message : String(e)}`,
        })),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div
        className={`dropzone${dragging ? " drag" : ""}`}
        data-testid="image-dropzone"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void upload(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") inputRef.current?.click();
        }}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          style={{ display: "none" }}
          onChange={(e) => {
            if (e.target.files) void upload(e.target.files);
            e.target.value = "";
          }}
        />
        {busy ? (
          <p>Uploading…</p>
        ) : (
          <>
            <p>
              <strong>Drop images here</strong> or click to choose
            </p>
            <p className="muted">PNG, JPEG, GIF or WEBP — they land in the review grid first</p>
          </>
        )}
      </div>
      {results.length > 0 && (
        <ul className="upload-results" data-testid="image-upload-results">
          {results.map((r) => (
            <li key={r.filename} className={r.ok ? "ok" : "fail"}>
              {r.ok
                ? `✓ ${r.filename} added${r.width ? ` (${r.width}×${r.height}px)` : ""}`
                : `✕ ${r.error}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
