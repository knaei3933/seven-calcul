import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

async function specFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? specFiles(path) : path;
  })).then((paths) => paths.flat()).then((paths) => paths.filter((path) => /\.spec\.ts$/.test(path)));
}

describe("Playwright production URL guard", () => {
  it("does not allow hardcoded non-local browser URLs in executable specs", async () => {
    const files = [
      ...(await specFiles("tests/e2e")),
      "playwright.config.ts",
    ];
    const productionUrlPattern = /https?:\/\/(?!127\.0\.0\.1|localhost)[A-Za-z0-9.-]+/gi;
    const violations: string[] = [];
    for (const file of files) {
      const content = await readFile(file, "utf8");
      for (const match of content.matchAll(productionUrlPattern)) {
        violations.push(`${file}: ${match[0]}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it("keeps temporary credential-bearing verification specs out of Playwright discovery", async () => {
    const entries = await readdir("tests/e2e", { withFileTypes: true });
    expect(entries.filter((entry) => entry.name.includes(".tmp."))).toEqual([]);
  });
});
