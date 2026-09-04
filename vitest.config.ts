import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: { environment: "jsdom", include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"] },
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
});
