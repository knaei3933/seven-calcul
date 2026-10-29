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

  it("matches a decimal-width XRA folder through its 3890 data files", async () => {
    const dir = join(databaseDirectory, "XRA38.590_1");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "XRA3890_1_1_C.ai"), "%AI-xra");
    await writeFile(join(dir, "XRA3890_1_1_C.pdf"), "%PDF-xra");
    const xraRecord = {
      quotationNumber: "KT-XRA",
      sizeSummary: "38.5×90mm / 1連",
      payload: {
        calculationRequest: { spec: { sizeKey: "xra-38.5x90" } },
      },
    } as unknown as QuotationRecord;

    const files = await findCustomerDesignAttachments(xraRecord);
    expect(files.map((file) => file.fileName)).toEqual([
      "XRA3890_1_1_C.ai",
      "XRA3890_1_1_C.pdf",
    ]);
    expect(files.every((file) => file.designLabel === "Xraラウンド型／38.5×90mm")).toBe(true);
  });

  it("does not pair an AI with an unrelated archive PDF when only the latter has a C file", async () => {
    const primary = join(databaseDirectory, "TUA3580_1");
    const archive = join(databaseDirectory, "other");
    await mkdir(primary, { recursive: true });
    await mkdir(archive, { recursive: true });
    await writeFile(join(primary, "TUA3580_1_C.ai"), "%AI-tua");
    await writeFile(join(primary, "TUA3580_1_C.pdf"), "%PDF-tua");
    await writeFile(join(archive, "TUA3580_4_1_C.pdf"), "%PDF-archive-only");
    const tubeRecord = {
      quotationNumber: "KT-TUA",
      sizeSummary: "35×80mm / 1連",
      payload: {
        calculationRequest: { spec: { sizeKey: "tube-35x80" } },
      },
    } as unknown as QuotationRecord;

    const files = await findCustomerDesignAttachments(tubeRecord);
    expect(files.map((file) => file.fileName)).toEqual([
      "TUA3580_1_C.ai",
      "TUA3580_1_C.pdf",
    ]);
  });
});
