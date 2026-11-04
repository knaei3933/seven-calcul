import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FilmMakersClient from "@/app/film-makers/film-makers-client";

const maker = {
  id: 1,
  makerCode: "KOR-GRA-001",
  companyName: "테스트 필름 제조사",
  contactName: "担当",
  email: "maker@example.test",
  language: "ko",
  printMethod: "gravure",
  procurementRoute: "K",
  isActive: true,
  note: "",
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === "/api/film-makers") {
      return Response.json({ makers: [maker] });
    }
    throw new Error(`unexpected fetch: ${String(input)}`);
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("film maker management UI", () => {
  it("uses film-maker terminology and does not expose a generic maker label", async () => {
    render(<FilmMakersClient userEmail="admin@kanei-trade.co.jp" />);
    expect(screen.getByRole("heading", { name: "フィルムメーカー管理" })).toBeInTheDocument();
    expect(screen.getByLabelText("フィルムメーカーコード")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("테스트 필름 제조사")).toBeInTheDocument());
    expect(screen.queryByLabelText("メーカーコード")).not.toBeInTheDocument();
  });
});
