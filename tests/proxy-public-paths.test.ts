import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "@/proxy";

function request(path: string): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"));
}

describe("public external token paths", () => {
  it("does not redirect supplier purchase-order token pages to login", () => {
    const response = proxy(request("/film-orders/purchase-order/4.supplier_po.123.nonce.signature"));
    expect(response.headers.get("location")).toBeNull();
  });

  it("keeps the internal film-order list protected", () => {
    const response = proxy(request("/film-orders"));
    expect(response.headers.get("location")).toBe("http://localhost:3000/login?next=%2Ffilm-orders");
  });
});
