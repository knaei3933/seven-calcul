import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: { environment: "jsdom", include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"], env: { FILM_EXTERNAL_TOKEN_SECRET: "test-film-external-token-secret-32-bytes!" } },
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
});
