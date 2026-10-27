import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  // Match the app's automatic JSX runtime (React 19, no React imports) so
  // server components can be rendered in tests.
  esbuild: { jsx: "automatic", jsxImportSource: "react" },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
