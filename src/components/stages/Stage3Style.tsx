import { confirmStyleAction, removeStyleRefAction } from "@/lib/actions/content";
import type { Db } from "@/lib/db/client";
import { getStyleProfile, parseExcerpts } from "@/lib/repo/editorial";
import { latestJobOfType } from "@/lib/repo/jobs";
import { hasApiKey } from "@/lib/repo/prefs";
import { listStyleRefs } from "@/lib/repo/styleRefs";
import { JobPanel } from "../JobPanel";
import { StyleRefDropzone } from "../StyleRefDropzone";
import { ProfileChangePanel } from "./ProfileChangePanel";

export function Stage3Style({ db, projectId }: { db: Db; projectId: string }) {
  const profile = getStyleProfile(db, projectId);
  const refs = listStyleRefs(db, projectId);
  const keySet = hasApiKey(db);
  const extractJob = latestJobOfType(db, projectId, "extract_style");
  const sampleJob = latestJobOfType(db, projectId, "style_sample");
  const excerptsText = profile ? parseExcerpts(profile).join("\n\n") : "";

  return (
    <>
      <div className="card">
        <h2>Reference files</h2>
        <p className="muted">
          Attach texts whose style the book should keep — an author&apos;s
          chapters, your own writing, a house style. The AI reads them and
          proposes the profile below.
        </p>
        <StyleRefDropzone projectId={projectId} />
        {refs.length > 0 && (
          <table className="plain" data-testid="style-ref-list">
            <tbody>
              {refs.map((r) => (
                <tr key={r.id}>
                  <td>{r.name}</td>
                  <td className="muted">{r.wordCount} words</td>
                  <td>
                    <form action={removeStyleRefAction}>
                      <input type="hidden" name="projectId" value={projectId} />
                      <input type="hidden" name="refId" value={r.id} />
                      <button type="submit">Remove</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <JobPanel
          projectId={projectId}
          stage={3}
          jobType="extract_style"
          runLabel="Extract style profile"
          latestJob={extractJob}
          disabled={refs.length === 0 || !keySet}
          disabledReason={
            refs.length === 0
              ? "Attach at least one reference file first."
              : keySet
                ? undefined
                : "Add your OpenRouter API key in Settings first."
          }
        />
      </div>

      <div className="card">
        <h2>Style profile</h2>
        <p className="muted">
          Captured once, applied in every pass: the voice the book must keep.
          Adjust any field in plain language, then confirm.
        </p>
        {profile && (
          <p>
            <span
              className={`badge ${profile.status === "confirmed" ? "succeeded" : "queued"}`}
              data-testid="profile-status"
            >
              {profile.status === "confirmed"
                ? `Confirmed · v${profile.version}`
                : "Draft — review and confirm below"}
            </span>
          </p>
        )}
        <form action={confirmStyleAction}>
          <input type="hidden" name="projectId" value={projectId} />
          <label htmlFor="voice">Voice</label>
          <input id="voice" type="text" name="voice" defaultValue={profile?.voice ?? ""} placeholder="e.g. close and conversational, talks straight to the reader" />
          <div className="row">
            <div className="grow">
              <label htmlFor="tone">Tone</label>
              <input id="tone" type="text" name="tone" defaultValue={profile?.tone ?? ""} placeholder="e.g. warm, direct, unhurried" />
            </div>
            <div className="grow">
              <label htmlFor="register">Vocabulary &amp; register</label>
              <input id="register" type="text" name="register" defaultValue={profile?.register ?? ""} placeholder="e.g. everyday words, conversational" />
            </div>
            <div className="grow">
              <label htmlFor="person">Narrative person</label>
              <input id="person" type="text" name="person" defaultValue={profile?.person ?? ""} placeholder="e.g. second person" />
            </div>
          </div>
          <div className="row">
            <div className="grow">
              <label htmlFor="rhythm">Sentence rhythm</label>
              <input id="rhythm" type="text" name="rhythm" defaultValue={profile?.rhythm ?? ""} placeholder="e.g. short sentences, almost no subordinate clauses" />
            </div>
            <div className="grow">
              <label htmlFor="punctuation">Punctuation</label>
              <input id="punctuation" type="text" name="punctuation" defaultValue={profile?.punctuation ?? ""} placeholder="e.g. dashes over parentheses, few semicolons" />
            </div>
          </div>
          <div className="row">
            <div className="grow">
              <label htmlFor="metaphors">Metaphors &amp; examples</label>
              <input id="metaphors" type="text" name="metaphors" defaultValue={profile?.metaphors ?? ""} placeholder="e.g. everyday examples, almost no metaphors" />
            </div>
            <div className="grow">
              <label htmlFor="openings">How sections open &amp; close</label>
              <input id="openings" type="text" name="openings" defaultValue={profile?.openings ?? ""} placeholder="e.g. opens with an anecdote, closes with one takeaway" />
            </div>
          </div>
          <label htmlFor="style-notes">Voice notes</label>
          <textarea
            id="style-notes"
            name="notes"
            defaultValue={profile?.notes ?? ""}
            placeholder="Idioms to keep, words the author never uses…"
          />
          <label htmlFor="excerpts">
            Representative excerpts (few-shot examples, one per block, blank
            line between them, max 5)
          </label>
          <textarea
            id="excerpts"
            name="excerpts"
            rows={8}
            defaultValue={excerptsText}
            placeholder={"A short verbatim passage in the target voice.\n\nAnother one."}
          />
          <p>
            <button type="submit" className="primary" data-testid="confirm-profile">
              {profile?.status === "confirmed"
                ? `Confirm changes (creates v${profile.version + 1})`
                : "Confirm style profile"}
            </button>
          </p>
          <p className="muted">
            Once confirmed, the profile and its excerpts are injected into
            every AI call in every stage — also after closing and reopening
            the project.
          </p>
        </form>
      </div>

      <div className="card">
        <h2>Sample passage</h2>
        <p className="muted">
          Try the profile on your own material before applying it to
          everything: a passage of your sources, rewritten in this voice.
        </p>
        <JobPanel
          projectId={projectId}
          stage={3}
          jobType="style_sample"
          runLabel="Generate sample passage"
          latestJob={sampleJob}
          disabled={!profile || !keySet}
          disabledReason={
            !profile
              ? "Extract or fill in a style profile first."
              : keySet
                ? undefined
                : "Add your OpenRouter API key in Settings first."
          }
        />
        {profile?.sample ? (
          <pre className="text-preview" data-testid="style-sample">
            {profile.sample}
          </pre>
        ) : null}
      </div>

      <ProfileChangePanel db={db} projectId={projectId} />
    </>
  );
}
