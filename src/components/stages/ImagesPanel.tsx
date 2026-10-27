import {
  deleteImageAction,
  discardImageAction,
  generateImageAction,
  placeImageAction,
  regenerateCreditsAction,
  setCreditsStatusAction,
  setImageOriginAction,
} from "@/lib/actions/images";
import type { Db } from "@/lib/db/client";
import { parseFormatData } from "@/lib/format/config";
import { imageDpi, MIN_PRINT_DPI } from "@/lib/images/dpi";
import { getFormatConfig } from "@/lib/repo/output";
import {
  getImageCreditsSection,
  hasImages,
  listPlacedImages,
  listReviewImages,
} from "@/lib/repo/images";
import { ImageDropzone } from "../ImageDropzone";
import { ImageReorderList, type ReorderItem } from "../ImageReorderList";

const ORIGIN_LABELS: Record<string, string> = {
  own: "Own (author)",
  ai: "AI-generated",
  third_party: "Third party",
};

/**
 * Stage 7 images management (spec §4 Stage 6.4): upload or AI-generate, review
 * early to catch artifacts, place against a passage at a printed size with a
 * dpi check, reorder by narrative order, and manage the automatic credits.
 */
export function ImagesPanel({ db, projectId }: { db: Db; projectId: string }) {
  const review = listReviewImages(db, projectId);
  const placed = listPlacedImages(db, projectId);
  const format = parseFormatData(getFormatConfig(db, projectId).data);
  const credits = getImageCreditsSection(db, projectId);
  const bookHasImages = hasImages(db, projectId);
  const thumb = (id: string) => `/api/projects/${projectId}/images/${id}`;

  const reorderItems: ReorderItem[] = placed.map((img) => {
    const dpi = imageDpi(img, format);
    const unknown = dpi === 0;
    const short = !unknown && dpi < MIN_PRINT_DPI;
    return {
      id: img.id,
      label: img.caption.trim() || img.originalName || "image",
      thumbUrl: thumb(img.id),
      sizeOption: img.sizeOption,
      anchorText: img.anchorText,
      dpiLabel: unknown
        ? "dpi unknown"
        : short
          ? `~${dpi} dpi — below ${MIN_PRINT_DPI}`
          : `~${dpi} dpi`,
      dpiWarning: unknown || short,
    };
  });

  return (
    <div className="card" data-testid="images-panel">
      <h2>Images</h2>
      <p className="muted">
        Add illustrations — upload your own or generate them with AI — then
        review them, place each one next to a passage at a printed size, set the
        narrative order, and the credits are generated automatically by origin.
      </p>

      <h3>Add images</h3>
      <ImageDropzone projectId={projectId} />
      <form action={generateImageAction} style={{ marginTop: "0.75rem" }}>
        <input type="hidden" name="projectId" value={projectId} />
        <div className="row" style={{ gap: "0.5rem", alignItems: "flex-start" }}>
          <textarea
            name="prompt"
            placeholder="Describe an image to generate with AI…"
            rows={2}
            style={{ flex: 1 }}
            required
          />
          <button type="submit" className="primary">Generate with AI</button>
        </div>
      </form>

      <h3>Review grid {review.length > 0 ? `(${review.length})` : ""}</h3>
      <p className="muted">
        New images land here first so artifacts are caught before they are placed.
      </p>
      {review.length === 0 ? (
        <p className="muted">No images waiting for review.</p>
      ) : (
        <div
          className="image-grid"
          data-testid="image-review-grid"
          style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(220px,1fr))", gap: "1rem" }}
        >
          {review.map((img) => (
            <div
              key={img.id}
              data-testid={`review-image-${img.id}`}
              style={{ border: "1px solid var(--border,#ccc)", borderRadius: 6, padding: "0.5rem" }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={thumb(img.id)}
                alt={img.altText || img.originalName}
                style={{ width: "100%", height: 140, objectFit: "contain", background: "#f3f3f3" }}
              />
              <div className="muted" style={{ fontSize: "0.8rem" }}>
                {img.widthPx > 0 ? `${img.widthPx}×${img.heightPx}px` : "size unknown"} ·{" "}
                {ORIGIN_LABELS[img.origin]}
              </div>

              <form action={setImageOriginAction} style={{ marginTop: "0.4rem" }}>
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="imageId" value={img.id} />
                <label className="muted" style={{ fontSize: "0.8rem" }}>Origin</label>
                <select name="origin" defaultValue={img.origin} aria-label="Image origin">
                  <option value="own">Own (author)</option>
                  <option value="ai">AI-generated</option>
                  <option value="third_party">Third party</option>
                </select>
                {img.origin === "third_party" && (
                  <input
                    name="sourceCredit"
                    placeholder="Source / attribution"
                    defaultValue={img.sourceCredit}
                    style={{ width: "100%", marginTop: "0.25rem" }}
                  />
                )}
                <button type="submit" style={{ marginTop: "0.25rem" }}>Save origin</button>
              </form>

              <form action={placeImageAction} style={{ marginTop: "0.4rem" }}>
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="imageId" value={img.id} />
                <textarea
                  name="anchorText"
                  placeholder="Passage to anchor the image to (a few words of the paragraph)"
                  rows={2}
                  style={{ width: "100%" }}
                />
                <select name="sizeOption" defaultValue={img.sizeOption} aria-label="Printed size">
                  <option value="column">Column width</option>
                  <option value="half">Half page</option>
                  <option value="full">Full page</option>
                </select>
                <button type="submit" className="primary" style={{ marginTop: "0.25rem" }}>
                  Place
                </button>
              </form>

              <div className="row" style={{ marginTop: "0.4rem", gap: "0.5rem" }}>
                <form action={discardImageAction}>
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="imageId" value={img.id} />
                  <button type="submit" title="Mark as an artifact and leave it out">Discard</button>
                </form>
                <form action={deleteImageAction}>
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="imageId" value={img.id} />
                  <button type="submit" title="Delete the file">Delete</button>
                </form>
              </div>
            </div>
          ))}
        </div>
      )}

      <h3>Placement &amp; narrative order {placed.length > 0 ? `(${placed.length})` : ""}</h3>
      <p className="muted">
        Drag to set the order images appear in the book. A dpi warning means the
        image prints below {MIN_PRINT_DPI} dpi at its size — swap it or shrink the placement
        before rendering.
      </p>
      <ImageReorderList projectId={projectId} items={reorderItems} />

      <h3>Image credits</h3>
      {!bookHasImages ? (
        <p className="muted">Credits appear here once the book has images.</p>
      ) : !credits ? (
        <form action={regenerateCreditsAction}>
          <input type="hidden" name="projectId" value={projectId} />
          <button type="submit">Generate image credits</button>
        </form>
      ) : (
        <div data-testid="image-credits">
          <p className="muted">
            Mandatory while the book has images. Status:{" "}
            <span className={`badge ${credits.status === "accepted" ? "done" : ""}`}>
              {credits.status}
            </span>
          </p>
          <pre
            style={{ whiteSpace: "pre-wrap", background: "#f6f6f6", padding: "0.75rem", borderRadius: 6 }}
          >
            {credits.content}
          </pre>
          <div className="row" style={{ gap: "0.5rem" }}>
            <form action={setCreditsStatusAction}>
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="status" value="accepted" />
              <button type="submit" className="primary">Accept credits</button>
            </form>
            <form action={setCreditsStatusAction}>
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="status" value="discarded" />
              <button type="submit">Discard</button>
            </form>
            <form action={regenerateCreditsAction}>
              <input type="hidden" name="projectId" value={projectId} />
              <button type="submit">Regenerate from images</button>
            </form>
          </div>
          {credits.status !== "accepted" && (
            <p className="muted" data-testid="credits-warning">
              ⚠ A book with images needs an accepted credits section — export is
              blocked until this is accepted.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
