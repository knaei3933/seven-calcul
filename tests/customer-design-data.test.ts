import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QuotationRecord } from "@/lib/quotation-shared";

const databaseDirectory = await mkdtemp(join(tmpdir(), "customer-design-data-"));
process.env.DESIGN_DATA_ROOT = databaseDirectory;

const { findCustomerDesignAttachments } = await import("@/lib/customer-design-data");

const record = {
  quotationNumber: "KT-TEST",
  sizeSummary: "60×80mm / 1連",
  payload: {
    calculationRequest: { spec: { sizeKey: "round-60x80" } },
  },
} as unknown as QuotationRecord;

afterAll(async () => {
  await rm(databaseDirectory, { recursive: true, force: true });
});

describe("customer design data lookup", () => {
  beforeAll(async () => {
    const dir = join(databaseDirectory, "RDA6080_1");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "RDA6080_1_3_C.ai"), "%AI");
    await writeFile(join(dir, "RDA6080_1_3_C.pdf"), "%PDF-low");
    await writeFile(join(dir, "RDA6080_1_4_C.ai"), "%AI-latest");
    await writeFile(join(dir, "RDA6080_1_4_C.pdf"), "%PDF-latest");
    await writeFile(join(dir, "RDA6080_1_2_A.pdf"), "%PDF-not-c");
  });

  it("selects the highest revision C AI and PDF files", async () => {
    const files = await findCustomerDesignAttachments(record);
    expect(files).toHaveLength(2);
    expect(files.map((file) => file.fileName)).toEqual([
      "RDA6080_1_4_C.ai",
      "RDA6080_1_4_C.pdf",
    ]);
    expect(files.every((file) => file.revision === 4)).toBe(true);
  });
});
