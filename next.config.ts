import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse (pdfjs), mammoth and music-metadata break when webpack bundles
  // them server-side; load them from node_modules at runtime instead.
  serverExternalPackages: [
    "better-sqlite3",
    "pdf-parse",
    "mammoth",
    "music-metadata",
  ],
};

export default nextConfig;
