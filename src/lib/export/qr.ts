// QR detection over the book's own FINAL text. In both real projects the QR
// codes were printed with their caption ("scan this QR to hear…"), so the
// deterministic signal that a book ships QR codes is a QR mention in the text
// that will be typeset. Detecting it here drives the print-test reminder: a QR
// that prints too small or too low-contrast fails silently, so it must be
// test-printed before the run.

// Word-boundary "QR" (English and Spanish "código QR"); case-insensitive.
const QR_RE = /\bQR\b/i;

export function detectQrCodes(finalText: string): boolean {
  return QR_RE.test(finalText);
}
