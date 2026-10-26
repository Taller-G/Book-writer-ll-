import { saveFormatAction } from "@/lib/actions/content";
import type { Db } from "@/lib/db/client";
import { getFormatConfig } from "@/lib/repo/output";

export function Stage7Format({ db, projectId }: { db: Db; projectId: string }) {
  const config = getFormatConfig(db, projectId);
  return (
    <div className="card">
      <h2>Print format</h2>
      <p className="muted">
        These settings drive every export. Sensible print defaults are
        pre-filled; adjust and save.
      </p>
      <form action={saveFormatAction}>
        <input type="hidden" name="projectId" value={projectId} />
        <div className="row">
          <div className="grow">
            <label htmlFor="trimSize">Trim size</label>
            <select id="trimSize" name="trimSize" defaultValue={config.trimSize}>
              <option value="5x8in">5 × 8 in</option>
              <option value="5.5x8.5in">5.5 × 8.5 in</option>
              <option value="6x9in">6 × 9 in</option>
              <option value="A5">A5</option>
            </select>
          </div>
          <div className="grow">
            <label htmlFor="fontFamily">Font</label>
            <select id="fontFamily" name="fontFamily" defaultValue={config.fontFamily}>
              <option value="Garamond">Garamond</option>
              <option value="Baskerville">Baskerville</option>
              <option value="Palatino">Palatino</option>
              <option value="Georgia">Georgia</option>
            </select>
          </div>
          <div>
            <label htmlFor="fontSizePt">Size (pt)</label>
            <input
              id="fontSizePt"
              type="text"
              name="fontSizePt"
              defaultValue={String(config.fontSizePt)}
              style={{ width: "5rem" }}
            />
          </div>
          <div>
            <label htmlFor="lineHeight">Line height</label>
            <input
              id="lineHeight"
              type="text"
              name="lineHeight"
              defaultValue={String(config.lineHeight)}
              style={{ width: "5rem" }}
            />
          </div>
        </div>
        <label htmlFor="margins">Margins (JSON)</label>
        <input id="margins" type="text" name="margins" defaultValue={config.margins} />
        <p>
          <button type="submit" className="primary">Save format</button>
          <span className="muted" style={{ marginLeft: "0.8rem" }}>
            Last saved {new Date(config.updatedAt).toLocaleString()}
          </span>
        </p>
      </form>
    </div>
  );
}
