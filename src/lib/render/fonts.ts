import { execFileSync } from "node:child_process";

// Fallback chain: fonts that ship with macOS / TeX Live so a missing
// configured font degrades to a real serif instead of failing the compile.
const FALLBACKS = ["Palatino", "TeX Gyre Pagella", "Times New Roman", "Georgia"];

let cachedFamilies: Set<string> | null = null;

function installedFamilies(): Set<string> {
  if (cachedFamilies) return cachedFamilies;
  const families = new Set<string>();
  try {
    const out = execFileSync("fc-list", [":", "family"], { encoding: "utf8" });
    for (const line of out.split("\n")) {
      for (const fam of line.split(",")) {
        const name = fam.trim();
        if (name) families.add(name.toLowerCase());
      }
    }
  } catch {
    // fc-list unavailable: report nothing installed; resolveFont then keeps
    // the requested family and lets fontspec surface the real error.
    return new Set();
  }
  cachedFamilies = families;
  return families;
}

export interface ResolvedFont {
  family: string;
  /** True when the requested family was not installed and a fallback was used. */
  substituted: boolean;
}

/** Pick the configured font if installed, else the first installed fallback. */
export function resolveFont(requested: string): ResolvedFont {
  const installed = installedFamilies();
  if (installed.size === 0 || installed.has(requested.toLowerCase())) {
    return { family: requested, substituted: false };
  }
  for (const candidate of FALLBACKS) {
    if (installed.has(candidate.toLowerCase())) {
      return { family: candidate, substituted: candidate !== requested };
    }
  }
  return { family: requested, substituted: false };
}
