import { describe, expect, it } from "vitest";
import { fileNameFromContentDisposition } from "@/lib/content-disposition";

describe("fileNameFromContentDisposition", () => {
  it("prefers an RFC 5987 UTF-8 filename and falls back safely", () => {
    const encoded = `inline; filename="fallback.pdf"; filename*=UTF-8''${
      encodeURIComponent("見積書.pdf")
    }`;
    expect(fileNameFromContentDisposition(encoded, "known.pdf")).toBe("見積書.pdf");
    expect(fileNameFromContentDisposition(
      "attachment; filename=\"S7-TEST-001.pdf\"",
      "known.pdf",
    )).toBe("S7-TEST-001.pdf");
    expect(fileNameFromContentDisposition(
      "inline; filename*=UTF-8''%E3%81%82",
      "known.pdf",
    )).toBe("あ");
    expect(fileNameFromContentDisposition(
      "inline; filename*=UTF-8''%FF-invalid",
      "known.pdf",
    )).toBe("known.pdf");
  });
});
