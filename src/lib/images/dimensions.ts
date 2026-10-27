// Read an image's natural pixel dimensions straight from its file header, with
// no native dependency. Only the handful of raster formats a book uses are
// understood (PNG, JPEG, GIF, WEBP); anything else returns null so the caller
// can store the image but flag that its printed dpi cannot be verified.
//
// Dimensions matter here for exactly one reason: the printed-dpi check divides
// the pixel size by the printed size at the chosen layout option, so a picture
// that looks fine on screen but is too small for a full page is caught before
// it ever reaches the layout engine.

export interface ImageDimensions {
  width: number;
  height: number;
  format: "png" | "jpeg" | "gif" | "webp";
}

export function readImageDimensions(buf: Buffer): ImageDimensions | null {
  return (
    readPng(buf) ?? readGif(buf) ?? readWebp(buf) ?? readJpeg(buf) ?? null
  );
}

// PNG: 8-byte signature, then the IHDR chunk whose data starts at byte 16 with
// big-endian width and height.
function readPng(buf: Buffer): ImageDimensions | null {
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) {
    return null;
  }
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: "png" };
}

// GIF: "GIF87a"/"GIF89a" then little-endian logical screen width/height.
function readGif(buf: Buffer): ImageDimensions | null {
  if (buf.length < 10) return null;
  const sig = buf.toString("ascii", 0, 6);
  if (sig !== "GIF87a" && sig !== "GIF89a") return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), format: "gif" };
}

// WEBP: RIFF container; the dimensions live in the VP8/VP8L/VP8X sub-chunk.
function readWebp(buf: Buffer): ImageDimensions | null {
  if (buf.length < 30) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") {
    return null;
  }
  const chunk = buf.toString("ascii", 12, 16);
  if (chunk === "VP8 ") {
    // Lossy: 16-bit width/height (14 low bits) after the 3-byte start code.
    const width = buf.readUInt16LE(26) & 0x3fff;
    const height = buf.readUInt16LE(28) & 0x3fff;
    return { width, height, format: "webp" };
  }
  if (chunk === "VP8L") {
    // Lossless: 14-bit dimensions packed into 4 bytes after the 0x2f marker.
    const b0 = buf[21];
    const b1 = buf[22];
    const b2 = buf[23];
    const b3 = buf[24];
    const width = 1 + (((b1 & 0x3f) << 8) | b0);
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    return { width, height, format: "webp" };
  }
  if (chunk === "VP8X") {
    // Extended: 24-bit (minus one) canvas width/height at byte 24.
    const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { width, height, format: "webp" };
  }
  return null;
}

// JPEG: scan the marker segments for a Start-Of-Frame (SOFn) marker, whose
// payload carries the height then width (both big-endian 16-bit).
function readJpeg(buf: Buffer): ImageDimensions | null {
  if (buf.length < 4 || buf.readUInt16BE(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buf[offset + 1];
    // SOF0..SOF15 carry the frame dimensions; C4/C8/CC are not frame starts.
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isSof) {
      const height = buf.readUInt16BE(offset + 5);
      const width = buf.readUInt16BE(offset + 7);
      return { width, height, format: "jpeg" };
    }
    // Standalone markers (RSTn, SOI, EOI, TEM) carry no length; everything
    // else is followed by a 2-byte segment length to skip over.
    if (
      (marker >= 0xd0 && marker <= 0xd9) ||
      marker === 0x01 ||
      marker === 0xff
    ) {
      offset += 2;
      continue;
    }
    const segmentLength = buf.readUInt16BE(offset + 2);
    if (segmentLength < 2) return null;
    offset += 2 + segmentLength;
  }
  return null;
}
