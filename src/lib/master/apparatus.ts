import type { AiClient } from "../ai";
import type { EditorialContract, StyleProfile } from "../db/schema";
import { APPARATUS_GUIDE } from "../repo/apparatus";
import type { OutlineData } from "./chapters";
import { parseJsonObject } from "./json";

// Editorial apparatus proposal (spec §6): one call that drafts the sections
// the book needs, restricted to the §6 catalog. The plain-language
// explanation shown to the user comes from the catalog (not the model), so
// every proposal always carries one.

export interface ApparatusProposal {
  sectionKey: string;
  title: string;
  content: string;
}

interface RawApparatus {
  sections?: Array<{ key?: string; title?: string; content?: string }>;
}

const APPARATUS_INSTRUCTIONS =
  "You are a book editor proposing the editorial apparatus (front and back " +
  "matter) for a book assembled from spoken material. From the catalog " +
  "below, draft ONLY the sections this book genuinely needs — skip the ones " +
  "that would add nothing. Write each section's full draft in the book's " +
  "language, following the editorial contract and style profile. Respond " +
  "with ONLY a JSON object: {\"sections\": [{\"key\": string (one of the " +
  "catalog keys), \"title\": string (in the book's language), \"content\": " +
  "string (the full draft)}]}.";

export async function proposeApparatus(
  ai: AiClient,
  args: {
    projectId: string;
    jobId: string;
    bookTitle: string;
    author: string;
    contract: EditorialContract;
    styleProfile: StyleProfile;
    outline: OutlineData;
    /** Opening of the generated master text, for grounding. */
    masterTextOpening: string;
  },
): Promise<{ proposals: ApparatusProposal[]; aiCalls: number }> {
  const catalog = APPARATUS_GUIDE.map(
    (g) => `- ${g.key} (${g.placement} matter): ${g.explanation}`,
  ).join("\n");
  const toc = args.outline.chapters
    .map((c, i) => `${i + 1}. ${c.title}${c.part ? ` (${c.part})` : ""} — ${c.summary}`)
    .join("\n");
  const res = await ai.complete({
    role: "large",
    projectId: args.projectId,
    jobId: args.jobId,
    system: {
      instructions: `${APPARATUS_INSTRUCTIONS}\n\nCatalog:\n${catalog}`,
      contract: args.contract,
      styleProfile: args.styleProfile,
    },
    messages: [
      {
        role: "user",
        content:
          `Book: "${args.bookTitle}"${args.author ? ` by ${args.author}` : ""}\n\n` +
          `Table of contents:\n${toc}\n\n` +
          (args.outline.leitmotifs.length > 0
            ? `Leitmotifs: ${args.outline.leitmotifs.join("; ")}\n\n`
            : "") +
          `Opening of the master text:\n\n${args.masterTextOpening}`,
      },
    ],
  });
  const raw = parseJsonObject<RawApparatus>(res.text);
  const validKeys = new Set(APPARATUS_GUIDE.map((g) => g.key));
  const proposals = (raw.sections ?? [])
    .filter(
      (s) =>
        typeof s.key === "string" &&
        validKeys.has(s.key) &&
        typeof s.title === "string" &&
        typeof s.content === "string" &&
        s.content.trim().length > 0,
    )
    .map((s) => ({
      sectionKey: s.key!,
      title: s.title!.trim(),
      content: s.content!.trim(),
    }));
  if (proposals.length === 0) {
    throw new Error(
      "The model proposed no usable apparatus sections. Retry the proposal.",
    );
  }
  return { proposals, aiCalls: 1 };
}
