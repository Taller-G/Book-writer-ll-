import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// XeLaTeX compile driver. Always two passes — the first writes the .toc/.aux
// files, the second resolves the table of contents and cross-references. A
// stale or corrupted auxiliary state (the classic "PDF comes out broken after
// an aborted run") is recovered by wiping the auxiliaries and compiling again.

export class CompileError extends Error {
  constructor(
    message: string,
    public readonly log: string,
  ) {
    super(message);
  }
}

const AUX_EXTENSIONS = [".aux", ".toc", ".log", ".out", ".xdv", ".synctex.gz"];

/** Remove intermediate files so the next compile starts from a clean slate. */
export function cleanAuxiliaries(workDir: string, jobName: string): string[] {
  const removed: string[] = [];
  for (const ext of AUX_EXTENSIONS) {
    const file = path.join(workDir, jobName + ext);
    if (fs.existsSync(file)) {
      fs.rmSync(file);
      removed.push(path.basename(file));
    }
  }
  return removed;
}

async function xelatexPass(workDir: string, texFile: string): Promise<void> {
  try {
    await execFileAsync(
      "xelatex",
      ["-interaction=nonstopmode", "-halt-on-error", texFile],
      { cwd: workDir, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
    );
  } catch (err) {
    const jobName = path.basename(texFile, ".tex");
    const logPath = path.join(workDir, jobName + ".log");
    const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
    const errorLines = log
      .split("\n")
      .filter((l) => l.startsWith("!"))
      .slice(0, 5)
      .join("\n");
    throw new CompileError(
      `xelatex failed on ${texFile}${errorLines ? `:\n${errorLines}` : ""}`,
      log || (err instanceof Error ? err.message : String(err)),
    );
  }
}

/** A structurally valid PDF: header magic plus a page count pdfinfo accepts. */
export function isValidPdf(pdfPath: string): boolean {
  if (!fs.existsSync(pdfPath)) return false;
  const fd = fs.openSync(pdfPath, "r");
  const head = Buffer.alloc(5);
  fs.readSync(fd, head, 0, 5, 0);
  fs.closeSync(fd);
  if (head.toString("latin1") !== "%PDF-") return false;
  try {
    const info = execFileSync("pdfinfo", [pdfPath], { encoding: "utf8" });
    const pages = info.match(/^Pages:\s+(\d+)/m);
    return pages !== null && Number(pages[1]) > 0;
  } catch {
    return false;
  }
}

export interface CompileResult {
  pdfPath: string;
  /** True when a corrupted intermediate state forced an auxiliary cleanup. */
  recoveredFromCorruption: boolean;
}

/**
 * Compile book.tex in workDir to a verified PDF: two xelatex passes (TOC),
 * then validation; on a failed or corrupt result, clean the auxiliaries and
 * compile twice again before giving up.
 */
export async function compileBook(
  workDir: string,
  texContent: string,
): Promise<CompileResult> {
  fs.mkdirSync(workDir, { recursive: true });
  const jobName = "book";
  const texFile = jobName + ".tex";
  fs.writeFileSync(path.join(workDir, texFile), texContent);
  const pdfPath = path.join(workDir, jobName + ".pdf");

  const doublePass = async () => {
    await xelatexPass(workDir, texFile);
    await xelatexPass(workDir, texFile);
  };

  let recovered = false;
  try {
    await doublePass();
    if (!isValidPdf(pdfPath)) {
      throw new CompileError("Compile produced a corrupt PDF", "");
    }
  } catch {
    // Corrupted intermediate state (stale .aux/.toc from an aborted run, or a
    // broken output): clean the auxiliaries and compile again from scratch.
    cleanAuxiliaries(workDir, jobName);
    if (fs.existsSync(pdfPath)) fs.rmSync(pdfPath);
    recovered = true;
    await doublePass(); // a CompileError here propagates: the source is bad
    if (!isValidPdf(pdfPath)) {
      throw new CompileError(
        "Compile still produces a corrupt PDF after auxiliary cleanup",
        "",
      );
    }
  }
  return { pdfPath, recoveredFromCorruption: recovered };
}
