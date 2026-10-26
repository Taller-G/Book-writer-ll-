# config

Setup and configuration — env vars, flags, how to run the project.

## better-sqlite3 must stay in serverExternalPackages

What: next.config.ts declares better-sqlite3 in serverExternalPackages · Why: it is a native module — webpack tries to bundle it and the build breaks without this · Where: next.config.ts

## BOOK_WRITER_DATA_DIR controls where all state lives

What: The SQLite file, the AES key file and exports live under data/ by default; the BOOK_WRITER_DATA_DIR env var overrides it (tests point it at a temp dir) · Why: keeps every bit of mutable state in one gitignored place and makes tests hermetic · Where: src/lib/db/client.ts (dataDir())
