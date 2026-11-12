import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import QuotePage from "@/app/quote/quote-client";
import { buildQuotationPdfFileName } from "@/lib/film-quotation";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const { pdfDocumentCreateMock } = vi.hoisted(() => ({
  pdfDocumentCreateMock: vi.fn(),
}));

vi.mock("@pdf-lib/fontkit", () => ({
  default: {
    create: () => ({
      glyphForCodePoint: () => ({ id: 1 }),
      createSubset: () => ({
        includeGlyph: () => 1,
        encodeStream: () => ({
          on: (event: string, callback: () => void) => {
            if (event === "end") queueMicrotask(callback);
          },
        }),
      }),
    }),
  },
}));
vi.mock("pdf-lib", () => ({
  PDFDocument: { create: (...args: unknown[]) => pdfDocumentCreateMock(...args) },
  rgb: (...args: number[]) => args,
}));

const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0xa4, 0xff]);
const pdfBlob = Object.assign(new Blob([pdfBytes], { type: "application/pdf" }), {
  arrayBuffer: async () => pdfBytes.buffer,
});
let captureControl: { resolve: (output: Blob | Uint8Array) => void; reject: (error: unknown) => void };
let fromMock: Mock;

function withFontFetch(fetchMock: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).includes("/api/fonts/standard-quotation")) {
      return new Response(new Uint8Array([0x00, 0x01, 0x00, 0x00]), { status: 200 });
    }
    return fetchMock(url, init);
  });
}

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

async function issueQuotation(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  render(<QuotePage />);
  await fillRequiredIssueFields(user);
  await user.click(screen.getByTestId("save-history"));
  await waitFor(() => expect(fromMock).toHaveBeenCalledTimes(1));
  captureControl.resolve(pdfBlob);
  await waitFor(() => expect(screen.getByTestId("issue-success")).toBeVisible());
  expect(screen.getByTestId("save-history")).toHaveTextContent("発行済");
}

describe("quotation issuance canonical PDF", () => {
  beforeEach(async () => {
    sessionStorage.clear();
    vi.clearAllMocks();
    fromMock = pdfDocumentCreateMock;
    fromMock.mockImplementation(async () => ({
      registerFontkit: vi.fn(),
      setTitle: vi.fn(),
      setAuthor: vi.fn(),
      setProducer: vi.fn(),
      embedFont: vi.fn(async () => ({ widthOfTextAtSize: () => 10 })),
      embedPng: vi.fn(async () => ({ width: 10, height: 10 })),
      addPage: vi.fn(() => ({
        drawText: vi.fn(),
        drawRectangle: vi.fn(),
        drawLine: vi.fn(),
        drawCircle: vi.fn(),
        drawImage: vi.fn(),
      })),
      save: vi.fn(() => new Promise<Uint8Array>((resolve, reject) => {
        captureControl = { resolve: (output) => resolve(output as Uint8Array), reject };
      })),
    }));
    captureControl = {
      resolve: () => {
        throw new Error("PDF capture was not awaited");
      },
      reject: () => {
        throw new Error("PDF capture failure was not awaited");
      },
    };
    vi.stubGlobal("fetch", vi.fn());
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

  it("sends and reports success only from one atomic multipart issuance request", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      if (target === "/api/quotations") {
        expect(init?.method).toBe("POST");
        expect(init?.body).toBeInstanceOf(FormData);
        const formData = init?.body as FormData;
        const payload = JSON.parse(String(formData.get("payload")));
        expect(String(payload.quotationNumber)).toMatch(/^S7-[A-Z0-9]+$/);
        const quotationNumber = String(payload.quotationNumber);
        const file = formData.get("pdf") as File;
        expect(file.name).toBe(buildQuotationPdfFileName({
          issueDate: String(payload.issueDate),
          productName: String(payload.productName),
          customerName: String(payload.customerName),
        }));
        expect(file.name).toContain(quotationNumber === "" ? "無題" : "お見積書_");
        await expect(new Response(file).arrayBuffer()).resolves.toEqual(pdfBytes.buffer);
        return jsonResponse({
          record: { id: 123, quotationNumber },
          created: true,
          pdf: { saved: true, sha256: "a".repeat(64), size: pdfBytes.byteLength },
        }, 201);
      }
      throw new Error(`unexpected fetch: ${target}`);
    });
    vi.stubGlobal("fetch", withFontFetch(fetchMock));
    const user = userEvent.setup();
    render(<QuotePage />);
    await fillRequiredIssueFields(user);

    fireEvent.click(screen.getByTestId("save-history"));
    await waitFor(() => expect(fromMock).toHaveBeenCalledTimes(1));
    captureControl.resolve(pdfBlob);

    await waitFor(() => expect(screen.getByTestId("issue-success")).toBeVisible());
    expect(screen.queryByTestId("save-error")).not.toBeInTheDocument();
    expect(fromMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/quotations")).toHaveLength(1);
  });
  it("uses the embedded-font vector generator without offscreen raster capture", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      if (target === "/api/quotations") {
        return jsonResponse({
          record: { id: 321, quotationNumber: "S7-TRANSFORM-001" },
          created: true,
        }, 201);
      }
      if (target.startsWith("/api/quotations/321/pdf") && init?.method === "POST") {
        return jsonResponse({ saved: true, size: pdfBytes.byteLength });
      }
      if (target.startsWith("/api/quotations/321/pdf")) {
        return new Response(pdfBytes, { status: 200, headers: { "Content-Type": "application/pdf" } });
      }
      throw new Error(`unexpected fetch: ${target}`);
    });
    vi.stubGlobal("fetch", withFontFetch(fetchMock));
    const user = userEvent.setup();
    render(<QuotePage />);
    await fillRequiredIssueFields(user);

    await user.click(screen.getByTestId("save-history"));
    await waitFor(() => expect(fromMock).toHaveBeenCalledTimes(1));

    captureControl.resolve(pdfBlob);
    await waitFor(() => expect(screen.getByTestId("issue-success")).toBeVisible());
    await waitFor(() => expect(document.getElementById("quote-pdf-capture-host")).toBeNull());
    expect(document.body.hasAttribute("data-quote-pdf-capture")).toBe(false);
  });

  it("shows a Japanese generation error without creating a quotation", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", withFontFetch(fetchMock));
    const user = userEvent.setup();
    render(<QuotePage />);
    await fillRequiredIssueFields(user);

    await user.click(screen.getByTestId("save-history"));
    captureControl.reject(new Error("vector generation failed"));

    await waitFor(() => expect(screen.getByTestId("save-error")).toHaveTextContent(
      "見積書のA4 PDFを作成できませんでした。もう一度お試しください。",
    ));
    expect(document.getElementById("quote-pdf-capture-host")).toBeNull();
    expect(document.body.hasAttribute("data-quote-pdf-capture")).toBe(false);
    expect(screen.queryByTestId("issue-success")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/quotations")).toHaveLength(0);
    expect(screen.getByTestId("save-history")).toBeEnabled();
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
    vi.stubGlobal("fetch", withFontFetch(fetchMock));
    const user = userEvent.setup();
    render(<QuotePage />);
    await fillRequiredIssueFields(user);

    await user.click(screen.getByTestId("save-history"));
    captureControl.resolve(pdfBlob);

    await waitFor(() => expect(screen.getByTestId("save-error")).toHaveTextContent(
      "この見積番号のPDFは既に確定しています。修正見積は別の見積番号で発行してください。",
    ));
    const issuanceCalls = fetchMock.mock.calls.filter(([url]) => String(url) === "/api/quotations");
    expect(issuanceCalls).toHaveLength(1);
    expect(issuanceCalls[0]?.[1]?.method).toBe("POST");
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
            record: { id: 456, quotationNumber: "S7-STALE-001" },
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
    vi.stubGlobal("fetch", withFontFetch(fetchMock));
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
          "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent("S7-STALE-001.pdf")}`,
        },
      }));
      await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(1));
    } finally {
      anchorClick.mockRestore();
      Object.defineProperty(URL, "createObjectURL", {
        value: originalCreateObjectURL,
        configurable: true,
      });
      Object.defineProperty(URL, "revokeObjectURL", {
        value: originalRevokeObjectURL,
        configurable: true,
      });
    }

    await user.click(screen.getByTestId("save-history"));
    expect(sessionStorage.getItem("pouch-last-checklist-url-v1")).toBeNull();
    await waitFor(() => expect(fromMock).toHaveBeenCalledTimes(2));
    captureControl.resolve(pdfBlob);
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
          record: { id: 789, quotationNumber: "S7-CANONICAL-004" },
          created: true,
        }, 201);
      }
      if (target.startsWith("/api/quotations/789/pdf") && !init?.method) {
        return new Promise<Response>((resolve) => {
          resolveStoredDownload = resolve;
        });
      }
      throw new Error(`unexpected fetch: ${target} ${init?.method ?? "GET"}`);
    });
    vi.stubGlobal("fetch", withFontFetch(fetchMock));
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
      const getRequest = fetchMock.mock.calls.find(([url, init]) =>
        String(url) === "/api/quotations/789/pdf" && (init as RequestInit | undefined)?.cache === "default",
      );
      expect(getRequest).toBeDefined();
      expect(fetchMock.mock.calls.filter(([url, init]) =>
        String(url) === "/api/quotations/789/pdf" && (init as RequestInit | undefined)?.cache === "default",
      )).toHaveLength(1);
      resolveStoredDownload(new Response(pdfBytes, {
        status: 200,
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent("S7-CANONICAL-004.pdf")}`,
        },
      }));
      await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(1));
      expect(fromMock).toHaveBeenCalledTimes(1);
      await expect(new Response(createObjectURL.mock.calls[0]?.[0]).arrayBuffer()).resolves.toEqual(pdfBytes.buffer);
      expect(anchorClick.mock.instances[0]).toMatchObject({
        download: "S7-CANONICAL-004.pdf",
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
    vi.stubGlobal("fetch", withFontFetch(fetchMock));
    const windowPrint = vi.fn();
    vi.stubGlobal("print", windowPrint);
    const user = userEvent.setup();
    render(<QuotePage />);
    await fillRequiredIssueFields(user);

    await user.click(screen.getByTestId("print-pdf"));
    await waitFor(() => expect(screen.getByTestId("save-error")).toHaveTextContent(
      "PDFは発行後に保存されます。先に「見積書を発行」してください。",
    ));
    expect(fromMock).not.toHaveBeenCalled();
    expect(windowPrint).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not regenerate or browser-print when the stored canonical PDF is missing", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      if (target === "/api/quotations") {
        return jsonResponse({
          record: { id: 987, quotationNumber: "S7-CANONICAL-005" },
          created: true,
        }, 201);
      }
      if (target.startsWith("/api/quotations/987/pdf") && !init?.method) {
        return jsonResponse({ error: "pdf_not_found" }, 404);
      }
      throw new Error(`unexpected fetch: ${target} ${init?.method ?? "GET"}`);
    });
    vi.stubGlobal("fetch", withFontFetch(fetchMock));
    const windowPrint = vi.fn();
    vi.stubGlobal("print", windowPrint);
    const user = userEvent.setup();
    await issueQuotation(user);

    await user.click(screen.getByTestId("print-pdf"));
    await waitFor(() => expect(screen.getByTestId("save-error")).toHaveTextContent(
      "発行済みPDFが見つかりません。見積書を再度発行してください。",
    ));
    expect(fromMock).toHaveBeenCalledTimes(1);
    expect(windowPrint).not.toHaveBeenCalled();
  });
});
