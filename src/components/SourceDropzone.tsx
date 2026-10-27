"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { UploadResponseItem } from "@/app/api/projects/[id]/sources/route";

const ACCEPT =
  ".mp3,.m4a,.wav,.mp4,.mov,.webm,.docx,.pdf,.txt,.md,.png,.jpg,.jpeg";

export function SourceDropzone({ projectId }: { projectId: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<UploadResponseItem[]>([]);

  async function upload(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0 || busy) return;
    setBusy(true);
    setResults([]);
    try {
      const form = new FormData();
      for (const f of list) form.append("files", f);
      const res = await fetch(`/api/projects/${projectId}/sources`, {
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
        setResults(body.results as UploadResponseItem[]);
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
        data-testid="source-dropzone"
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
          <p>Uploading & extracting…</p>
        ) : (
          <>
            <p>
              <strong>Drop files here</strong> or click to choose
            </p>
            <p className="muted">
              Audio (mp3, m4a, wav) · video (mp4, mov, webm) · documents (docx,
              pdf, txt, md) · images (png, jpg) — in any combination
            </p>
          </>
        )}
      </div>
      {results.length > 0 && (
        <ul className="upload-results" data-testid="upload-results">
          {results.map((r) => (
            <li key={r.filename} className={r.ok ? "ok" : "fail"}>
              {r.ok ? `✓ ${r.filename} added` : `✕ ${r.error}`}
              {r.ok && r.note ? <span className="muted"> — {r.note}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
