import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { normalizationRules, type NormalizationRule } from "../db/schema";
import { newId } from "../util";
import { appendChange } from "./changeLog";

// Orthotypographic rule list (spec §4, stage 4): preloaded per language,
// visible and adjustable in the UI. 'mechanical' rules are applied as
// deterministic post-processing by the master-text engine; 'prompt' rules are
// injected into the generation instructions (the model applies them while
// writing, e.g. italics for foreign terms).

export interface RuleSeed {
  ruleKey: string;
  label: string;
  explanation: string;
  kind: "mechanical" | "prompt";
}

/** Language-pluggable rule sets. Spanish (RAE) is the default. */
export const RULE_SETS: Record<string, RuleSeed[]> = {
  es: [
    {
      ruleKey: "angular-quotes",
      label: "Comillas angulares «»",
      explanation:
        'Las comillas rectas ("…") y tipográficas (“…”) se convierten en ' +
        "comillas angulares españolas («…»), como pide la RAE.",
      kind: "mechanical",
    },
    {
      ruleKey: "dialogue-dash",
      label: "Raya de diálogo (—)",
      explanation:
        "Las intervenciones de diálogo abren con raya (—), no con guion (-) " +
        "ni semirraya (–), pegada a la primera palabra.",
      kind: "mechanical",
    },
    {
      ruleKey: "ellipsis",
      label: "Puntos suspensivos (…)",
      explanation:
        "Tres puntos seguidos (...) se sustituyen por el carácter de puntos " +
        "suspensivos (…).",
      kind: "mechanical",
    },
    {
      ruleKey: "spacing",
      label: "Espaciado y puntuación",
      explanation:
        "Se eliminan espacios dobles y espacios antes de coma, punto y demás " +
        "signos de puntuación.",
      kind: "mechanical",
    },
    {
      ruleKey: "foreign-italics",
      label: "Extranjerismos en cursiva",
      explanation:
        "Los términos en otros idiomas (anglicismos, latinismos no adaptados) " +
        "se escriben en cursiva, marcada como *término*.",
      kind: "prompt",
    },
    {
      ruleKey: "rae-numbers",
      label: "Cifras y números (RAE)",
      explanation:
        "Los números del uno al nueve se escriben con letra; las cifras " +
        "mayores, con número, salvo al inicio de oración.",
      kind: "prompt",
    },
  ],
  en: [
    {
      ruleKey: "curly-quotes",
      label: "Curly quotes “”",
      explanation:
        "Straight quotes (\"…\") become typographic curly quotes (“…”), the " +
        "convention in English book typesetting.",
      kind: "mechanical",
    },
    {
      ruleKey: "ellipsis",
      label: "Ellipsis character (…)",
      explanation: "Three consecutive periods (...) become the ellipsis character (…).",
      kind: "mechanical",
    },
    {
      ruleKey: "spacing",
      label: "Spacing and punctuation",
      explanation:
        "Double spaces and spaces before punctuation marks are removed.",
      kind: "mechanical",
    },
    {
      ruleKey: "foreign-italics",
      label: "Foreign terms in italics",
      explanation: "Terms in other languages are set in italics, marked as *term*.",
      kind: "prompt",
    },
  ],
};

export function listRules(db: Db, projectId: string): NormalizationRule[] {
  return db
    .select()
    .from(normalizationRules)
    .where(eq(normalizationRules.projectId, projectId))
    .orderBy(asc(normalizationRules.position))
    .all();
}

export function enabledRules(db: Db, projectId: string): NormalizationRule[] {
  return listRules(db, projectId).filter((r) => r.enabled === 1);
}

/**
 * Load the rule set for `language`, replacing whatever the project had.
 * Idempotent when called with the language already loaded and untouched.
 */
export function loadRuleSet(db: Db, projectId: string, language: string): void {
  const seeds = RULE_SETS[language];
  if (!seeds) throw new Error(`No normalization rule set for language "${language}"`);
  const had = listRules(db, projectId).length > 0;
  db.delete(normalizationRules)
    .where(eq(normalizationRules.projectId, projectId))
    .run();
  seeds.forEach((seed, i) => {
    db.insert(normalizationRules)
      .values({
        id: newId(),
        projectId,
        language,
        ruleKey: seed.ruleKey,
        label: seed.label,
        explanation: seed.explanation,
        kind: seed.kind,
        enabled: 1,
        position: i,
      })
      .run();
  });
  if (had) {
    appendChange(db, {
      projectId,
      what: `Normalization rule set switched to "${language}" (${seeds.length} rules)`,
      where: "stage 5 · normalization rules",
      why: "user loaded the rule set for another language",
      authorizedBy: "user",
    });
  }
}

/** Make sure the project has a rule set; seed the Spanish defaults once. */
export function ensureRules(db: Db, projectId: string): NormalizationRule[] {
  const existing = listRules(db, projectId);
  if (existing.length > 0) return existing;
  loadRuleSet(db, projectId, "es");
  return listRules(db, projectId);
}

export function setRuleEnabled(
  db: Db,
  projectId: string,
  ruleKey: string,
  enabled: boolean,
): void {
  const rule = db
    .select()
    .from(normalizationRules)
    .where(
      and(
        eq(normalizationRules.projectId, projectId),
        eq(normalizationRules.ruleKey, ruleKey),
      ),
    )
    .get();
  if (!rule) return;
  db.update(normalizationRules)
    .set({ enabled: enabled ? 1 : 0 })
    .where(eq(normalizationRules.id, rule.id))
    .run();
  appendChange(db, {
    projectId,
    what: `Normalization rule "${rule.label}" ${enabled ? "enabled" : "disabled"}`,
    where: "stage 5 · normalization rules",
    why: "user adjusted the orthotypography rule list",
    authorizedBy: "user",
  });
}
