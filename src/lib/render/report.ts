import fs from "node:fs";
import path from "node:path";
import type { QaReport } from "./qa";

// One readable QA report per compile: machine JSON plus a human markdown
// summary, both versioned next to the PDF artifact they describe.

export interface QaReportFiles {
  jsonPath: string;
  markdownPath: string;
}

export interface QaReportContext {
  projectTitle: string;
  pdfVersion: number;
  textVersion: number;
  formatHash: string;
  recoveredFromCorruption: boolean;
  fontUsed: string;
  fontSubstituted: boolean;
}

export function writeQaReport(
  dir: string,
  report: QaReport,
  ctx: QaReportContext,
): QaReportFiles {
  fs.mkdirSync(dir, { recursive: true });
  const base = `qa-v${ctx.pdfVersion}`;
  const jsonPath = path.join(dir, `${base}.json`);
  const markdownPath = path.join(dir, `${base}.md`);

  fs.writeFileSync(jsonPath, JSON.stringify({ ...ctx, ...report }, null, 2));

  const lines: string[] = [
    `# QA report — ${ctx.projectTitle}, PDF v${ctx.pdfVersion}`,
    "",
    `Overall: ${report.passed ? "✅ PASS" : "❌ FAIL"}`,
    "",
    `- Source: FINAL text v${ctx.textVersion}, format ${ctx.formatHash}`,
    `- Font: ${ctx.fontUsed}${ctx.fontSubstituted ? " (substituted — configured font not installed)" : ""}`,
  ];
  if (ctx.recoveredFromCorruption) {
    lines.push(
      "- Note: a corrupted intermediate state was recovered by cleaning the auxiliary files.",
    );
  }
  lines.push("", "| Check | Result | Pages | Detail |", "| --- | --- | --- | --- |");
  for (const c of report.checks) {
    lines.push(
      `| ${c.title} | ${c.passed ? "✅ pass" : "❌ fail"} | ${
        c.pages.length > 0 ? c.pages.join(", ") : "—"
      } | ${c.detail} |`,
    );
  }
  lines.push("");
  fs.writeFileSync(markdownPath, lines.join("\n"));
  return { jsonPath, markdownPath };
}
