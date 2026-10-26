import { saveStyleAction } from "@/lib/actions/content";
import type { Db } from "@/lib/db/client";
import { getStyleProfile } from "@/lib/repo/editorial";

export function Stage3Style({ db, projectId }: { db: Db; projectId: string }) {
  const profile = getStyleProfile(db, projectId);
  return (
    <div className="card">
      <h2>Style profile</h2>
      <p className="muted">
        Captured once, applied in every pass: the voice the book must keep.
      </p>
      <form action={saveStyleAction}>
        <input type="hidden" name="projectId" value={projectId} />
        <div className="row">
          <div className="grow">
            <label htmlFor="tone">Tone</label>
            <input id="tone" type="text" name="tone" defaultValue={profile?.tone ?? ""} placeholder="e.g. warm, direct, unhurried" />
          </div>
          <div className="grow">
            <label htmlFor="register">Register</label>
            <input id="register" type="text" name="register" defaultValue={profile?.register ?? ""} placeholder="e.g. conversational, formal" />
          </div>
          <div className="grow">
            <label htmlFor="person">Narrative person</label>
            <input id="person" type="text" name="person" defaultValue={profile?.person ?? ""} placeholder="e.g. first person singular" />
          </div>
        </div>
        <label htmlFor="style-notes">Voice notes</label>
        <textarea
          id="style-notes"
          name="notes"
          defaultValue={profile?.notes ?? ""}
          placeholder="Idioms to keep, words the author never uses, rhythm…"
        />
        <p>
          <button type="submit" className="primary">
            {profile ? "Update style profile" : "Save style profile"}
          </button>
        </p>
      </form>
    </div>
  );
}
