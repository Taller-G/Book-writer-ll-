# config

Setup and configuration — env vars, flags, how to run the project.

## better-sqlite3 must stay in serverExternalPackages

What: next.config.ts declares better-sqlite3 in serverExternalPackages · Why: it is a native module — webpack tries to bundle it and the build breaks without this · Where: next.config.ts

## pdf-parse, mammoth and music-metadata must stay in serverExternalPackages

What: next.config.ts declares pdf-parse, mammoth and music-metadata in serverExternalPackages · Why: webpack-bundled pdfjs fails at runtime with "Object.defineProperty called on non-object" while working fine under vitest — the failure only shows up in the running Next app · Where: next.config.ts · Learned: test server-side parser libraries inside the real Next server, not only in vitest

## BOOK_WRITER_DATA_DIR controls where all state lives

What: The SQLite file, the AES key file and exports live under data/ by default; the BOOK_WRITER_DATA_DIR env var overrides it (tests point it at a temp dir) · Why: keeps every bit of mutable state in one gitignored place and makes tests hermetic · Where: src/lib/db/client.ts (dataDir())
