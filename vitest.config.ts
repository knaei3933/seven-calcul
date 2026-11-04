import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    testTimeout: 15_000,
    setupFiles: ["tests/setup.ts"],
    env: {
      FILM_EXTERNAL_TOKEN_SECRET: "test-film-external-token-secret-32-bytes!",
      FILM_EXTERNAL_LINK_ORIGINS: "http://localhost,http://localhost:3000,http://127.0.0.1:3000",
      FILM_DEFAULT_EXTERNAL_LINK_ORIGIN: "http://localhost:3000",
      FILM_MAIL_SENDER_EMAIL: "workflow-sender@example.test",
    },
  },
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
});
