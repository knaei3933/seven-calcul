import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProofUploadClient from "@/app/film-orders/upload/[token]/proof-upload-client";

afterEach(cleanup);

describe("supplier proof upload filename", () => {
  it("suggests a base filename immediately and includes the order number", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      order: {
        order_number: "F-202610-002",
        product_name: "ARESステムCクリームプラス1g サッシェ",
        files: [],
        proofs: [],
        status: "receiving_registered",
      },
    })));

    render(
      <ProofUploadClient
        token="token"
        orderNumber="F-202610-002"
        productName="ARESステムCクリームプラス1g サッシェ"
        locale="ko"
      />,
    );

    const filename = screen.getByLabelText("공통 파일명(발주번호를 포함해 주십시오)") as HTMLInputElement;
    await waitFor(() => expect(filename.value).toContain("F-202610-002"));
  });
});
