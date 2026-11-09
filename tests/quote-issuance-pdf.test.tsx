import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import QuotePage from "@/app/quote/quote-client";
import { quotationOwnerProfile } from "@/lib/quote-owner-profiles";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0xa4, 0xff]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function fillRequiredIssueFields(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByTestId("fill-test-data"));
  await waitFor(() => expect(screen.getByTestId("save-history")).toBeEnabled());
}

async function issueQuotation(
  user: ReturnType<typeof userEvent.setup>,
  response: Response = jsonResponse({
    record: { id: 456, quotationNumber: "KT-TEST-PERSISTED-001" },
    created: true,
    pdf: { saved: true, sha256: "a".repeat(64), size: 1024 },
  }, 201),
): Promise<void> {
  render(<QuotePage
      approverName="Canonical Author"
      initialQuotationNumber="KT-PREPARE"
      ownerDomain="kanei"
      ownerProfile={quotationOwnerProfile("kanei")!}
      issuerContact={{
        companyName: "金井貿易株式会社",
        contactName: "Canonical Author",
        email: "author@kanei-trade.co.jp",
        telephone: "",
      }}
    />);
  await fillRequiredIssueFields(user);
  await user.click(screen.getByTestId("save-history"));
  await waitFor(() => expect(screen.getByTestId("issue-success")).toBeVisible());
  void response;
}

describe("quotation issuance canonical PDF", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
    vi.stubGlobal("matchMedia", vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("sends JSON only and reports success from one atomic issuance request", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      if (target === "/api/quotations") {
        expect(init?.method).toBe("POST");
        expect(typeof init?.body).toBe("string");
        expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
        const payload = JSON.parse(String(init?.body));
        expect(String(payload.quotationNumber)).toBe("");
        expect(payload.payload.ownerDomain).toBe("kanei");
        return jsonResponse({
          record: { id: 123, quotationNumber: "KT-TEST-PERSISTED-001" },
          created: true,
          pdf: { saved: true, sha256: "a".repeat(64), size: 1024 },
        }, 201);
      }
      throw new Error(`unexpected fetch: ${target}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<QuotePage
      approverName="Canonical Author"
      initialQuotationNumber="KT-PREPARE"
      ownerDomain="kanei"
      ownerProfile={quotationOwnerProfile("kanei")!}
      issuerContact={{
        companyName: "金井貿易株式会社",
        contactName: "Canonical Author",
        email: "author@kanei-trade.co.jp",
        telephone: "",
      }}
    />);
    await fillRequiredIssueFields(user);

    fireEvent.click(screen.getByTestId("save-history"));
    fireEvent.click(screen.getByTestId("save-history"));

    await waitFor(() => expect(screen.getByTestId("issue-success")).toBeVisible());
    expect(screen.queryByTestId("save-error")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not create a client-visible record when atomic issuance is rejected", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      if (target === "/api/quotations") {
        return jsonResponse({
          error: "canonical_pdf_already_exists",
          message: "この見積番号のPDFは既に確定しています。修正見積は別の見積番号で発行してください。",
        }, 409);
      }
      throw new Error(`unexpected fetch: ${target} ${init?.method ?? "GET"}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<QuotePage
      approverName="Canonical Author"
      initialQuotationNumber="KT-PREPARE"
      ownerDomain="kanei"
      ownerProfile={quotationOwnerProfile("kanei")!}
      issuerContact={{
        companyName: "金井貿易株式会社",
        contactName: "Canonical Author",
        email: "author@kanei-trade.co.jp",
        telephone: "",
      }}
    />);
    await fillRequiredIssueFields(user);

    await user.click(screen.getByTestId("save-history"));
    await waitFor(() => expect(screen.getByTestId("save-error")).toHaveTextContent(
      "この見積番号のPDFは既に確定しています。修正見積は別の見積番号で発行してください。",
    ));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(screen.queryByTestId("issue-success")).not.toBeInTheDocument();
    expect(screen.getByTestId("save-history")).toBeEnabled();
  });

  it("invalidates the prior download association when a later issuance fails", async () => {
    let resolveStoredDownload: (response: Response) => void = () => {};
    let issuanceCount = 0;
    let storedDownloadCount = 0;
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      if (target === "/api/quotations" && init?.method === "POST") {
        issuanceCount += 1;
        if (issuanceCount === 1) {
          return jsonResponse({
            record: { id: 456, quotationNumber: "KT-STALE-001" },
            created: true,
          }, 201);
        }
        return jsonResponse({
          error: "canonical_pdf_already_exists",
          message: "この見積番号のPDFは既に確定しています。",
        }, 409);
      }
      if (target === "/api/quotations/456/pdf" && !init?.method) {
        storedDownloadCount += 1;
        return new Promise<Response>((resolve) => {
          resolveStoredDownload = resolve;
        });
      }
      throw new Error(`unexpected fetch: ${target} ${init?.method ?? "GET"}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    await issueQuotation(user);

    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    Object.defineProperty(URL, "createObjectURL", {
      value: vi.fn(() => "blob:first-success"),
      configurable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
    try {
      fireEvent.click(screen.getByTestId("print-pdf"));
      resolveStoredDownload(new Response(pdfBytes, {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent("KT-STALE-001.pdf")}`,
        },
      }));
      await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(1));
    } finally {
      anchorClick.mockRestore();
      Object.defineProperty(URL, "createObjectURL", { value: originalCreateObjectURL, configurable: true });
      Object.defineProperty(URL, "revokeObjectURL", { value: originalRevokeObjectURL, configurable: true });
    }

    await user.click(screen.getByTestId("save-history"));
    expect(sessionStorage.getItem("pouch-last-checklist-url-v1")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("save-error")).toHaveTextContent(
      "この見積番号のPDFは既に確定しています。",
    ));

    await user.click(screen.getByTestId("print-pdf"));
    await waitFor(() => expect(screen.getByTestId("save-error")).toHaveTextContent(
      "PDFは発行後に保存されます。先に「見積書を発行」してください。",
    ));
    expect(issuanceCount).toBe(2);
    expect(storedDownloadCount).toBe(1);
  });

  it("downloads the exact issuance PDF after later quote edits without regenerating it", async () => {
    let resolveStoredDownload: (response: Response) => void = () => {};
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      if (target === "/api/quotations") {
        return jsonResponse({
          record: { id: 789, quotationNumber: "KT-CANONICAL-004" },
          created: true,
        }, 201);
      }
      if (target === "/api/quotations/789/pdf" && !init?.method) {
        return new Promise<Response>((resolve) => {
          resolveStoredDownload = resolve;
        });
      }
      throw new Error(`unexpected fetch: ${target} ${init?.method ?? "GET"}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    await issueQuotation(user);

    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    const createObjectURL = vi.fn((_blob: Blob) => "blob:issued-pdf");
    const revokeObjectURL = vi.fn();
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, configurable: true });
    try {
      await user.clear(screen.getByLabelText("会社名 ★"));
      await user.type(screen.getByLabelText("会社名 ★"), "編集後株式会社");
      fireEvent.click(screen.getByTestId("print-pdf"));
      fireEvent.click(screen.getByTestId("print-pdf"));
      expect(fetchMock.mock.calls.filter(([url, init]) =>
        String(url) === "/api/quotations/789/pdf" && (init as RequestInit | undefined)?.cache === "default",
      )).toHaveLength(1);
      resolveStoredDownload(new Response(pdfBytes, {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent("KT-CANONICAL-004.pdf")}`,
        },
      }));
      await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(1));
      await expect(new Response(createObjectURL.mock.calls[0]?.[0]).arrayBuffer()).resolves.toEqual(pdfBytes.buffer);
      expect(anchorClick.mock.instances[0]).toMatchObject({
        download: "KT-CANONICAL-004.pdf",
        href: "blob:issued-pdf",
      });
      await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:issued-pdf"));
      expect(screen.queryByTestId("save-error")).not.toBeInTheDocument();
    } finally {
      anchorClick.mockRestore();
      Object.defineProperty(URL, "createObjectURL", { value: originalCreateObjectURL, configurable: true });
      Object.defineProperty(URL, "revokeObjectURL", { value: originalRevokeObjectURL, configurable: true });
    }
  });

  it("uses a clear Japanese error when no issued PDF is available", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const windowPrint = vi.fn();
    vi.stubGlobal("print", windowPrint);
    const user = userEvent.setup();
    render(<QuotePage
      approverName="Canonical Author"
      initialQuotationNumber="KT-PREPARE"
      ownerDomain="kanei"
      ownerProfile={quotationOwnerProfile("kanei")!}
      issuerContact={{
        companyName: "金井貿易株式会社",
        contactName: "Canonical Author",
        email: "author@kanei-trade.co.jp",
        telephone: "",
      }}
    />);
    await fillRequiredIssueFields(user);

    await user.click(screen.getByTestId("print-pdf"));
    await waitFor(() => expect(screen.getByTestId("save-error")).toHaveTextContent(
      "PDFは発行後に保存されます。先に「見積書を発行」してください。",
    ));
    expect(windowPrint).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not regenerate or browser-print when the stored canonical PDF is missing", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      if (target === "/api/quotations") {
        return jsonResponse({
          record: { id: 987, quotationNumber: "KT-CANONICAL-005" },
          created: true,
        }, 201);
      }
      if (target.startsWith("/api/quotations/987/pdf") && !init?.method) {
        return jsonResponse({ error: "pdf_not_found" }, 404);
      }
      throw new Error(`unexpected fetch: ${target} ${init?.method ?? "GET"}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const windowPrint = vi.fn();
    vi.stubGlobal("print", windowPrint);
    const user = userEvent.setup();
    await issueQuotation(user);

    await user.click(screen.getByTestId("print-pdf"));
    await waitFor(() => expect(screen.getByTestId("save-error")).toHaveTextContent(
      "発行済みPDFが見つかりません。見積書を再度発行してください。",
    ));
    expect(windowPrint).not.toHaveBeenCalled();
  });
});
