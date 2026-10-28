import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import QuotePage from "@/app/quote/quote-client";
import { buildQuotationPdfFileName } from "@/lib/film-quotation";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("html2pdf.js", () => ({
  default: vi.fn(),
}));

const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0xa4, 0xff]);
const pdfBlob = Object.assign(new Blob([pdfBytes], { type: "application/pdf" }), {
  arrayBuffer: async () => pdfBytes.buffer,
});
let captureControl: { resolve: (blob: Blob) => void; reject: (error: unknown) => void };
let fromMock: Mock;

async function html2pdfMock(): Promise<Mock> {
  const pdfModule = await import("html2pdf.js") as unknown as { default: Mock };
  return vi.mocked(pdfModule.default);
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
    fromMock = vi.fn();
    fromMock.mockImplementation(() => ({
      set: (options: Record<string, unknown>) => {
        expect(options.jsPDF).toEqual({
          unit: "mm",
          format: "a4",
          orientation: "portrait",
        });
        expect(options.html2canvas).toMatchObject({ scale: 2 });
        return {
          outputPdf: (format: string) => {
            expect(format).toBe("blob");
            return new Promise<Blob>((resolve, reject) => {
              captureControl = { resolve, reject };
            });
          },
        };
      },
    }));
    (await html2pdfMock()).mockImplementation(() => ({ from: fromMock }));
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
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<QuotePage />);
    await fillRequiredIssueFields(user);

    fireEvent.click(screen.getByTestId("save-history"));
    await waitFor(() => expect(fromMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId("save-history"));
    captureControl.resolve(pdfBlob);

    await waitFor(() => expect(screen.getByTestId("issue-success")).toBeVisible());
    expect(screen.queryByTestId("save-error")).not.toBeInTheDocument();
    expect(fromMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("uses a transform-scaled offscreen clone without CSS zoom for issuance capture", async () => {
    let capturedElement: HTMLElement | null = null;
    fromMock.mockImplementationOnce((element: HTMLElement) => {
      capturedElement = element;
      return {
        set: () => ({
          outputPdf: () => new Promise<Blob>((resolve, reject) => {
            captureControl = { resolve, reject };
          }),
        }),
      };
    });

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
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<QuotePage />);
    await fillRequiredIssueFields(user);

    const visibleFit = screen.getByLabelText("お見積書A4プレビュー").querySelector<HTMLElement>(".quote-a4-fit");
    expect(visibleFit).not.toBeNull();

    await user.click(screen.getByTestId("save-history"));
    await waitFor(() => expect(capturedElement).not.toBeNull());

    const capture = capturedElement as unknown as HTMLElement;
    const captureFit = capture.querySelector<HTMLElement>(".quote-a4-fit");
    expect(capture.parentElement).toHaveAttribute("id", "quote-pdf-capture-host");
    expect(capture).not.toBe(visibleFit);
    expect(capture.style.width).toBe("210mm");
    expect(capture.style.height).toBe("288mm");
    expect(capture.style.minHeight).toBe("288mm");
    expect(capture.style.overflow).toBe("hidden");
    expect(captureFit?.style.transform).toBe("scale(1.00000)");
    expect(captureFit?.style.transformOrigin).toBe("top left");
    expect(captureFit?.style.getPropertyValue("zoom")).toBe("");
    expect(visibleFit?.style.getPropertyValue("zoom")).toBe("");
    expect(visibleFit?.style.transform).toBe("");
    expect(visibleFit?.style.height).toBe("");

    captureControl.resolve(pdfBlob);
    await waitFor(() => expect(screen.getByTestId("issue-success")).toBeVisible());
    await waitFor(() => expect(document.getElementById("quote-pdf-capture-host")).toBeNull());
    expect(document.body.hasAttribute("data-quote-pdf-capture")).toBe(false);
    expect(visibleFit?.style.getPropertyValue("zoom")).toBe("");
    expect(visibleFit?.style.transform).toBe("");
  });

  it("shows a Japanese generation error without creating a quotation", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<QuotePage />);
    await fillRequiredIssueFields(user);

    await user.click(screen.getByTestId("save-history"));
    captureControl.reject(new Error("renderer failed"));

    await waitFor(() => expect(screen.getByTestId("save-error")).toHaveTextContent(
      "見積書のA4 PDFを作成できませんでした。もう一度お試しください。",
    ));
    expect(document.getElementById("quote-pdf-capture-host")).toBeNull();
    expect(document.body.hasAttribute("data-quote-pdf-capture")).toBe(false);
    expect(screen.queryByTestId("issue-success")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
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
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<QuotePage />);
    await fillRequiredIssueFields(user);

    await user.click(screen.getByTestId("save-history"));
    captureControl.resolve(pdfBlob);

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
    vi.stubGlobal("fetch", fetchMock);
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
    vi.stubGlobal("fetch", fetchMock);
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
