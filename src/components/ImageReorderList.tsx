"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  deleteImageAction,
  reorderImagesAction,
  setImageSizeAction,
} from "@/lib/actions/images";

export interface ReorderItem {
  id: string;
  label: string;
  thumbUrl: string;
  sizeOption: "column" | "half" | "full";
  anchorText: string;
  dpiLabel: string;
  /** Printed dpi fell short (or is unknown) — shown as a warning badge. */
  dpiWarning: boolean;
}

const SIZE_LABELS: Record<ReorderItem["sizeOption"], string> = {
  column: "Column width",
  half: "Half page",
  full: "Full page",
};

/**
 * Narrative order of the placed images, editable by drag and drop. Dropping
 * persists the new order (reorderImagesAction) so the next render reflects it.
 */
export function ImageReorderList({
  projectId,
  items,
}: {
  projectId: string;
  items: ReorderItem[];
}) {
  const router = useRouter();
  const [order, setOrder] = useState<ReorderItem[]>(items);
  const [dragId, setDragId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function persist(next: ReorderItem[]) {
    setSaving(true);
    try {
      const form = new FormData();
      form.set("projectId", projectId);
      form.set("orderedIds", next.map((i) => i.id).join(","));
      await reorderImagesAction(form);
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  function onDrop(targetId: string) {
    if (!dragId || dragId === targetId) return;
    const from = order.findIndex((i) => i.id === dragId);
    const to = order.findIndex((i) => i.id === targetId);
    if (from === -1 || to === -1) return;
    const next = order.slice();
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setOrder(next);
    setDragId(null);
    void persist(next);
  }

  if (order.length === 0) {
    return <p className="muted">No images placed yet. Place images from the review grid above.</p>;
  }

  return (
    <ol className="image-reorder" data-testid="image-reorder">
      {order.map((item, index) => (
        <li
          key={item.id}
          data-testid={`placed-image-${item.id}`}
          draggable
          onDragStart={() => setDragId(item.id)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => onDrop(item.id)}
          className="image-reorder-item"
          style={{
            display: "flex",
            gap: "0.75rem",
            alignItems: "center",
            padding: "0.5rem",
            border: "1px solid var(--border, #ccc)",
            borderRadius: 6,
            marginBottom: "0.5rem",
            cursor: "grab",
          }}
        >
          <span className="muted" aria-hidden>⠿</span>
          <span className="muted">{index + 1}.</span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={item.thumbUrl}
            alt={item.label}
            style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 4 }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 500 }}>{item.label}</div>
            <div
              className={item.dpiWarning ? "badge" : "muted"}
              data-testid={`dpi-${item.id}`}
              style={item.dpiWarning ? { background: "#b00", color: "#fff" } : undefined}
            >
              {item.dpiLabel}
            </div>
            {item.anchorText && (
              <div className="muted" style={{ fontSize: "0.8rem" }}>
                anchored to: “{item.anchorText.slice(0, 60)}”
              </div>
            )}
          </div>
          <form
            action={setImageSizeAction}
            onChange={(e) => (e.currentTarget as HTMLFormElement).requestSubmit()}
          >
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="imageId" value={item.id} />
            <select name="sizeOption" defaultValue={item.sizeOption} aria-label="Printed size">
              {(["column", "half", "full"] as const).map((s) => (
                <option key={s} value={s}>
                  {SIZE_LABELS[s]}
                </option>
              ))}
            </select>
          </form>
          <form action={deleteImageAction}>
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="imageId" value={item.id} />
            <button type="submit" title="Remove image">✕</button>
          </form>
        </li>
      ))}
      {saving && <p className="muted">Saving order…</p>}
    </ol>
  );
}
