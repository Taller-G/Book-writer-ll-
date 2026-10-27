import { execFileSync } from "node:child_process";
import fs from "node:fs";

// PDF/X variant for print (CMYK) destinations. A genuine PDF/X-1a stream needs
// an output-intent ICC profile the printer specifies, so we do the substantive,
// portable part here — convert to a CMYK, prepress-grade PDF via Ghostscript —
// and leave final PDF/X compliance to be confirmed with the printer. Best
// effort by design: if Ghostscript is absent or the conversion fails, the
// caller flags PDF/X as a printer action instead of failing the export.

function gsBinary(): string | null {
  for (const bin of ["gs", "gswin64c", "gswin32c"]) {
    try {
      execFileSync(bin, ["--version"], { stdio: "ignore" });
      return bin;
    } catch {
      // keep looking
    }
  }
  return null;
}

/**
 * Convert the interior PDF to a CMYK, prepress-grade PDF at `outPath`.
 * Returns true only when the file was actually produced.
 */
export function toCmykPressPdf(interiorPath: string, outPath: string): boolean {
  const gs = gsBinary();
  if (!gs) return false;
  try {
    execFileSync(
      gs,
      [
        "-dBATCH",
        "-dNOPAUSE",
        "-dSAFER",
        "-sDEVICE=pdfwrite",
        "-dPDFSETTINGS=/prepress",
        "-sColorConversionStrategy=CMYK",
        "-sProcessColorModel=DeviceCMYK",
        "-dEmbedAllFonts=true",
        "-dSubsetFonts=true",
        `-sOutputFile=${outPath}`,
        interiorPath,
      ],
      { stdio: "ignore", timeout: 120_000 },
    );
    return fs.existsSync(outPath);
  } catch {
    return false;
  }
}
