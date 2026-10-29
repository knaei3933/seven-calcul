import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import QuotePage from "@/app/quote/quote-client";

afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("html2pdf.js", () => ({
  default: vi.fn(),
}));

const fontFetch = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("weight=bold")) return new Response(new Uint8Array([0x01, 0x02]), { status: 200 });
  return new Response(new Uint8Array([0x03, 0x04]), { status: 200 });
});

vi.mock("@pdf-lib/fontkit", () => ({ default: {} }));
vi.mock("pdf-lib", () => ({
  PDFDocument: {
    create: vi.fn(async () => ({
      registerFontkit: vi.fn(),
      setTitle: vi.fn(),
      setAuthor: vi.fn(),
      setProducer: vi.fn(),
      embedFont: vi.fn(async () => ({ widthOfTextAtSize: () => 10 })),
      embedPng: vi.fn(async () => ({ width: 10, height: 10 })),
      addPage: vi.fn(() => ({ drawText: vi.fn(), drawRectangle: vi.fn(), drawLine: vi.fn(), drawCircle: vi.fn(), drawImage: vi.fn() })),
      save: vi.fn(async () => new Uint8Array([0x25, 0x50, 0x44, 0x46])),
    })),
  },
  rgb: (...args: number[]) => args,
}));

const issuancePdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

const fontBytes = new Uint8Array([0x00, 0x01, 0x00, 0x00]);

function withFontFetch(fetchMock: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).includes("/api/fonts/standard-quotation")) {
      return new Response(new Uint8Array(fontBytes), { status: 200 });
    }
    return fetchMock(url, init);
  });
}


async function mockSuccessfulPdfCapture(): Promise<Mock> {
  const pdfModule = await import("html2pdf.js") as unknown as { default: Mock };
  const html2pdf = vi.mocked(pdfModule.default);
  html2pdf.mockImplementation(() => ({
    from: () => ({
      set: () => ({
        outputPdf: () => Promise.resolve(Object.assign(
          new Blob([issuancePdfBytes], { type: "application/pdf" }),
          { arrayBuffer: async () => issuancePdfBytes.buffer },
        )),
      }),
    }),
  }));
  return html2pdf;
}

function atomicIssuanceResponse(record: Record<string, unknown>): Response {
  return new Response(JSON.stringify({
    record,
    created: true,
    pdf: { saved: true, sha256: "a".repeat(64), size: issuancePdfBytes.byteLength },
  }), { status: 201, headers: { "Content-Type": "application/json" } });
}

function issuancePayload(init?: RequestInit): { payload: Record<string, unknown> } & Record<string, unknown> {
  expect(init?.body).toBeInstanceOf(FormData);
  return JSON.parse(String((init?.body as FormData).get("payload")));
}

function latestIssuanceInit(fetchMock: { mock: { calls: Array<[RequestInfo | URL, RequestInit?]> } }): RequestInit | undefined {
  return fetchMock.mock.calls.filter(([url]) => String(url) === "/api/quotations").at(-1)?.[1];
}

describe("quotation page stale draft", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.stubGlobal("fetch", vi.fn());
    fontFetch.mockClear();
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

  it("uses the server-provided next quotation number", async () => {
    render(<QuotePage initialQuotationNumber="S7-202610-007" />);
    await waitFor(() => expect(screen.getByTestId("quote-spec")).toBeVisible());
    expect(document.getElementById("quote-preview")?.textContent).toContain("S7-202610-007");
  });

  it("keeps direct manual entry actions available when no stale marker exists", async () => {
    render(<QuotePage />);

    // 発行には会社名・郵便番号・電話番号・住所・メールが必須。
    await userEvent.setup().type(screen.getByLabelText("会社名 ★"), "手入力株式会社");
    await userEvent.setup().type(screen.getByLabelText("郵便番号 ★"), "123-4567");
    await userEvent.setup().type(screen.getByLabelText("電話番号 ★"), "03-1234-5678");
    await userEvent.setup().type(screen.getByLabelText("住所 ★"), "東京都千代田区テスト1-1");
    await userEvent.setup().type(screen.getByLabelText("製品名（SKU-1）★"), "手入力製品");

    await waitFor(() => {
      expect(screen.getByTestId("save-history")).toBeDisabled();
      expect(screen.getByTestId("issue-required-fields")).toHaveTextContent("メールアドレス");
    });
    await userEvent.setup().type(screen.getByTestId("customer-email-input"), "purchase@example.co.jp");

    await waitFor(() => {
      expect(screen.getByTestId("save-history")).toBeEnabled();
      expect(screen.getByTestId("print-pdf")).toBeEnabled();
      expect(screen.getByTestId("open-checklist")).toBeEnabled();
    });
    expect(screen.queryByTestId("stale-quote-warning")).not.toBeInTheDocument();
    expect(vi.mocked(global.fetch).mock.calls.every(([url]) => String(url).startsWith("/api/customers?"))).toBe(true);
  });

  it("shows pouch specifications, film printing method, and standard notes on the A4 sheet", async () => {
    render(<QuotePage />);

    await waitFor(() => expect(screen.getByTestId("quote-spec")).toBeVisible());
    expect(screen.getByTestId("quote-spec")).toHaveTextContent("お見積製品仕様");
    expect(screen.getByTestId("quote-spec")).toHaveTextContent("品名");
    expect(screen.getByTestId("quote-spec")).toHaveTextContent("パウチ仕様");
    expect(screen.getByTestId("quote-spec")).toHaveTextContent("50×60mm / 1連");
    expect(screen.getByTestId("quote-spec")).toHaveTextContent("充填仕様");
    expect(screen.getByTestId("quote-spec")).toHaveTextContent("フィルム構成");
    // 印刷方式は右上ではなくフィルム費用の行に表示する。
    expect(screen.getByTestId("film-printing-method")).toHaveTextContent("印刷方式：デジタル印刷");
    const preview = within(document.getElementById("quote-preview")!);
    expect(preview.queryByText("発注ロットに応じた単価を適用したフィルム製作・物流の一式")).not.toBeInTheDocument();
    expect(preview.queryByText(/^構成：PET12\+AL7\+PET12\+LLDPE50μ/)).not.toBeInTheDocument();
    expect(preview.queryByText("フィルム金額は円未満を四捨五入します。")).not.toBeInTheDocument();
    expect(screen.queryByTestId("quote-printing-method")).not.toBeInTheDocument();
    expect(screen.getByAltText("セブン化學ロゴ")).toBeVisible();
    expect(screen.queryByText("代表取締役社長 吾藤 靖")).not.toBeInTheDocument();
    // 標準備考（入金・容器処分・振込手数料・保管・出来高±10%）を含む。
    const sheet = within(document.getElementById("quote-preview")!);
    expect(sheet.getAllByText(/ご入金およびデータ入稿後に正式受注処理/).length).toBeGreaterThan(0);
    expect(sheet.getAllByText(/バルク支給時の容器処分費用/).length).toBeGreaterThan(0);
    expect(sheet.getAllByText(/お振込手数料は御社負担/).length).toBeGreaterThan(0);
    expect(sheet.getAllByText(/金型・版は受注より1年間保管/).length).toBeGreaterThan(0);
    expect(sheet.getAllByText(/【出来高について】/).length).toBeGreaterThan(0);
    expect(sheet.getAllByText(/±10%程度の過不足/).length).toBeGreaterThan(0);
    expect(sheet.getAllByText(/超過分×充填単価/).length).toBeGreaterThan(0);
    const terms = within(document.getElementById("quote-preview")!);
    expect(terms.getByText("データ校了後約２か月")).toBeVisible();
    expect(terms.getByText("従来通り")).toBeVisible();
    expect(terms.getByText("運送条件")).toBeVisible();
    expect(terms.getByText("御社1か所納品")).toBeVisible();
    expect(sheet.getAllByText(/初回製作時は、バルクサンプルを株式会社セブン化学/).length).toBeGreaterThan(0);
    expect(sheet.getAllByText(/責任技術者：福井/).length).toBeGreaterThan(0);
  });

  it("shows the simulator pouch design in plain Japanese next to the size", async () => {
    sessionStorage.setItem("pouch-quotation-draft-v1", JSON.stringify({
      productSummary: "レディエイドルプリカント",
      sizeSummary: "50×90mm / 1連",
      quantity: "20000",
      targetMargin: "0.4",
      fillingCostPerPiece: "8",
      filmCostPerPiece: "12",
      filmMeterPrice: "252",
      filmOrderLengthM: "1200",
      totalCostPerPiece: "20",
      calculationVersion: "simulator-linked",
      resultHash: "shape-check",
      calculationFilmTotal: "302400",
      calculationRequest: { spec: { sizeKey: "bottle-50x90" } },
    }));
    render(<QuotePage />);

    await waitFor(() => expect(screen.getByTestId("quote-spec")).toBeVisible());
    expect(screen.getByTestId("pouch-shape")).toHaveTextContent("ボトル型");
    expect(screen.getByTestId("quote-spec")).toHaveTextContent("50×90mm / 1連");
  });

  it("shows the calculated bulk amount as a customer-supplied quantity", () => {
    sessionStorage.setItem("pouch-quotation-draft-v1", JSON.stringify({
      productSummary: "バルク支給品",
      sizeSummary: "50×60mm / 1連",
      quantity: "10000",
      targetMargin: "0.4",
      fillingCostPerPiece: "0",
      filmCostPerPiece: "10",
      filmMeterPrice: "400",
      filmOrderLengthM: "500",
      totalCostPerPiece: "10",
      calculationVersion: "simulator-linked",
      resultHash: "bulk-usage-check",
      calculationFilmTotal: "200000",
      calculationChecklistSnapshot: {
        bulkUsageMl: "722000",
        fillMlPerChamber: "3",
        connectedChambers: 1,
        totalFillMlPerPouch: "3",
        fillingMethod: "hopper",
      },
    }));
    render(<QuotePage />);

    expect(screen.getByTestId("bulk-supply-amount")).toHaveTextContent("722,000g（貴社ご支給ください）");
  });

  it("shows a warning and blocks linked quotation actions while the simulator draft is stale", async () => {
    sessionStorage.setItem("pouch-simulator-stale-status-v1", "input-changed");
    render(<QuotePage />);

    await waitFor(() => expect(screen.getByTestId("stale-quote-warning")).toBeVisible());
    expect(screen.getByTestId("stale-quote-warning")).toHaveTextContent("この見積書は古くなっています");
    expect(screen.getByTestId("stale-quote-warning")).toHaveTextContent("シミュレーターの条件が変わったため");
    expect(screen.getByTestId("stale-quote-warning")).toHaveTextContent("再計算してください");
    expect(screen.getByTestId("save-history")).toBeDisabled();
    expect(screen.getByTestId("print-pdf")).toBeDisabled();
    expect(screen.getByTestId("open-checklist")).toBeDisabled();
    expect(vi.mocked(global.fetch).mock.calls.every(([url]) => String(url).startsWith("/api/customers?"))).toBe(true);
  });

  it("keeps adjusted-plan quotation output available while showing its basis", async () => {
    sessionStorage.setItem("pouch-quotation-draft-v1", JSON.stringify({
      productSummary: "不足参考プラン",
      sizeSummary: "60×120mm / 2連",
      quantity: "49000",
      targetMargin: "0.4",
      fillingCostPerPiece: "5",
      filmCostPerPiece: "10",
      filmMeterPrice: "280",
      filmOrderLengthM: "3500",
      totalCostPerPiece: "16.7",
      calculationVersion: "simulator-linked",
      resultHash: "shortage-reference",
      calculationFilmTotal: "495096",
      originalQuantity: "50000",
      selectedCandidateShortage: true,
    }));
    render(<QuotePage />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("会社名 ★"), "調整プラン株式会社");
    await user.type(screen.getByLabelText("郵便番号 ★"), "100-0001");
    await user.type(screen.getByLabelText("電話番号 ★"), "06-1234-5678");
    await user.type(screen.getByLabelText("住所 ★"), "大阪府テスト市1-2-3");
    await user.type(screen.getByLabelText("製品名（SKU-1）★"), "数量調整製品");
    await user.type(screen.getByTestId("customer-email-input"), "adjusted@example.co.jp");

    await waitFor(() => expect(screen.getByTestId("shortage-quote-warning")).toBeVisible());
    expect(screen.getByTestId("shortage-quote-warning")).toHaveTextContent("数量調整プラン");
    expect(screen.getByTestId("shortage-quote-warning")).toHaveTextContent("元の数量へ戻る");
    expect(screen.getByTestId("save-history")).toBeEnabled();
    expect(screen.getByTestId("print-pdf")).toBeEnabled();
    expect(screen.getByTestId("open-checklist")).toBeEnabled();
  });

	  it("does not expose purchase and selling price guidance", async () => {
	    render(<QuotePage />);

	    const a4Sheet = screen.getByLabelText("お見積書A4プレビュー");
	    expect(screen.queryByTestId("purchase-selling-guide")).not.toBeInTheDocument();
	    expect(screen.queryByText("仕入価格と販売価格の見方")).not.toBeInTheDocument();
	    expect(screen.queryByText(/PDF掲載金額に12%/)).not.toBeInTheDocument();
	    expect(within(a4Sheet).queryByTestId("purchase-selling-guide")).not.toBeInTheDocument();
	    expect(a4Sheet).not.toHaveTextContent("仕入価格と販売価格の見方");
	    expect(a4Sheet).not.toHaveTextContent("PDF掲載金額に12%の販売マージン");
	  });

  it("stores a manually edited filling unit and its recalculated totals into history", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("/api/quotations");
      return atomicIssuanceResponse({ id: 71, quotationNumber: "S7-MANUAL-EDIT" });
    });
    vi.stubGlobal("fetch", withFontFetch(fetchMock));
    sessionStorage.setItem("pouch-quotation-draft-v1", JSON.stringify({
      productSummary: "充填物1",
      sizeSummary: "60×80mm / 1連",
      quantity: "10000",
      targetMargin: "0.4",
      fillingCostPerPiece: "53.8",
      setupCost: "0",
      setupQuantity: "",
      filmCostPerPiece: "20.1",
      filmMeterPrice: "402",
      filmOrderLengthM: "500",
      totalCostPerPiece: "73.9",
      calculationVersion: "simulator-linked",
      resultHash: "manual-edit-check",
      calculationFilmTotal: "201000",
    }));
    render(<QuotePage />);

    await user.type(screen.getByLabelText("会社名 ★"), "単価修正株式会社");
    await user.type(screen.getByLabelText("郵便番号 ★"), "530-0001");
    await user.type(screen.getByLabelText("電話番号 ★"), "06-9999-9999");
    await user.type(screen.getByLabelText("住所 ★"), "大阪府修正市テスト3-4");
    await user.type(screen.getByLabelText("製品名（SKU-1）★"), "手動修正製品");
    await user.type(screen.getByTestId("customer-email-input"), "manual@example.co.jp");

    await waitFor(() => expect(screen.getByTestId("save-history")).toBeEnabled());
    const fillingUnit = screen.getByLabelText("充填・加工単価");
    await user.clear(fillingUnit);
    await user.type(fillingUnit, "90");
    await user.tab();

    // 90엔×10,000매＝900,000엔, 필름 450엔/m×500m＝225,000엔 유지.
    expect(screen.getByLabelText("充填・加工金額")).toHaveTextContent("900,000");
    expect(screen.getByLabelText("税込合計")).toHaveTextContent("1,237,500");

    await mockSuccessfulPdfCapture();
    await user.click(screen.getByTestId("save-history"));
    await waitFor(() => expect(screen.getByTestId("issue-success")).toBeVisible());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = issuancePayload(latestIssuanceInit(fetchMock));
    expect(body.payload.fillingUnitDisplay).toBe("90");
    expect(body.payload.fillingAmountDisplay).toBe("900000");
    expect(body.payload.filmAmountDisplay).toBe("225000");
    expect(body.payload.subtotalDisplay).toBe("1125000");
    expect(body.payload.taxDisplay).toBe("112500");
    expect(body.payload.grandTotalDisplay).toBe("1237500");
    // 원가 기준은 수동 수정의 영향을 받지 않는다.
    expect(body.fillingCostPerPiece).toBe("53.8");
  });

  it("carries simulator SKU product names into the quotation and history record", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe("/api/quotations");
      return atomicIssuanceResponse({
        id: 81,
        quotationNumber: "S7-SKU-NAME",
        productName: "レモン琺瑯 / 充填物2",
      });
    });
    vi.stubGlobal("fetch", withFontFetch(fetchMock));
    sessionStorage.setItem("pouch-quotation-draft-v1", JSON.stringify({
      productSummary: "レモン琺瑯 / 充填物2",
      sizeSummary: "60×80mm / 2連",
      quantity: "10000",
      targetMargin: "0.4",
      fillingCostPerPiece: "53.8",
      filmCostPerPiece: "20.1",
      filmMeterPrice: "402",
      filmOrderLengthM: "500",
      totalCostPerPiece: "73.9",
      calculationVersion: "simulator-linked",
      resultHash: "sku-name-transfer-check",
      calculationFilmTotal: "201000",
      skuNamesRaw: ["レモン琺瑯", "充填物2"],
    }));
    render(<QuotePage />);

    await user.type(screen.getByLabelText("会社名 ★"), "SKU名称株式会社");
    await user.type(screen.getByLabelText("郵便番号 ★"), "650-0001");
    await user.type(screen.getByLabelText("電話番号 ★"), "078-000-0000");
    await user.type(screen.getByLabelText("住所 ★"), "兵庫県神戸市テスト1-2-3");
    await user.type(screen.getByTestId("customer-email-input"), "sku@example.co.jp");

    expect(screen.getByLabelText("製品名（SKU-1）★")).toHaveValue("レモン琺瑯");
    expect(screen.getByLabelText("製品名（SKU-2）★")).toHaveValue("充填物2");
    expect(screen.getByTestId("quote-spec")).toHaveTextContent("レモン琺瑯 / 充填物2");

    await waitFor(() => expect(screen.getByTestId("save-history")).toBeEnabled());
    await mockSuccessfulPdfCapture();
    await user.click(screen.getByTestId("save-history"));
    await waitFor(() => expect(screen.getByTestId("issue-success")).toBeVisible());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = issuancePayload(latestIssuanceInit(fetchMock));
    expect(body.productName).toBe("レモン琺瑯 / 充填物2");
    expect(body.payload.skuNames).toEqual(["レモン琺瑯", "充填物2"]);
  });

  it("shows the bulk line only when bulk is sold", async () => {
    sessionStorage.setItem("pouch-quotation-draft-v1", JSON.stringify({
      productSummary: "充填物1",
      sizeSummary: "60×80mm / 1連",
      quantity: "10000",
      targetMargin: "0.4",
      fillingCostPerPiece: "5.2",
      bulkCostPerPiece: "48.6",
      filmCostPerPiece: "20.1",
      filmMeterPrice: "402",
      filmOrderLengthM: "500",
      totalCostPerPiece: "73.9",
      calculationVersion: "simulator-linked",
      resultHash: "bulk-line-test",
      calculationFilmTotal: "201000",
      calculationChecklistSnapshot: { bulkUsageMl: "486000" },
    }));
    render(<QuotePage />);
    await waitFor(() => expect(screen.getByTestId("bulk-line")).toBeVisible());
    expect(screen.getByTestId("bulk-unit-price")).toBeVisible();
    // バルク総額48.6×10000×1.4÷486000g＝1.4/g。
    expect(screen.getByTestId("bulk-unit-price")).toHaveTextContent("1.4");

    cleanup();
    sessionStorage.setItem("pouch-quotation-draft-v1", JSON.stringify({
      productSummary: "充填物1",
      sizeSummary: "60×80mm / 1連",
      quantity: "10000",
      targetMargin: "0.4",
      fillingCostPerPiece: "53.8",
      filmCostPerPiece: "20.1",
      filmMeterPrice: "402",
      filmOrderLengthM: "500",
      totalCostPerPiece: "73.9",
      calculationVersion: "simulator-linked",
      resultHash: "bulk-line-test-zero",
      calculationFilmTotal: "201000",
    }));
    render(<QuotePage />);
    await waitFor(() => expect(screen.getByTestId("filling-unit-price")).toBeVisible());
    // 客給（バルク原価なし）の場合はバルクラインを表示しない。
    expect(screen.queryByTestId("bulk-line")).not.toBeInTheDocument();
    // セットアップなしの場合は数量が空でも金額計算を妨げない。
    expect(screen.queryByTestId("calc-invalid-fields")).not.toBeInTheDocument();
    expect(screen.queryByTestId("setup-line")).not.toBeInTheDocument();
  });

  it("adds a target-margin setup line from simulator inputs", async () => {
    sessionStorage.setItem("pouch-quotation-draft-v1", JSON.stringify({
      productSummary: "充填物1",
      sizeSummary: "60×80mm / 1連",
      quantity: "10000",
      targetMargin: "0.4",
      fillingCostPerPiece: "5.2",
      bulkCostPerPiece: "48.6",
      setupCost: "100",
      setupQuantity: "2",
      filmCostPerPiece: "20.1",
      filmMeterPrice: "402",
      filmOrderLengthM: "500",
      totalCostPerPiece: "73.9",
      calculationVersion: "simulator-linked",
      resultHash: "setup-line-test",
      calculationFilmTotal: "201000",
      calculationChecklistSnapshot: { bulkUsageMl: "486000" },
    }));
    render(<QuotePage />);

    await waitFor(() => expect(screen.getByTestId("setup-line")).toBeVisible());
    // 原価 100円×2式÷(1-0.4)=333円。1式販売単価は166.5円。
    expect(screen.getByTestId("setup-unit-price")).toHaveTextContent("166.5");
    expect(screen.getByTestId("setup-line")).toHaveTextContent("2 個");
    expect(screen.getByTestId("setup-line")).toHaveTextContent("￥333");
  });

  it("keeps the issue panel fixed, restores saved customers, and fills test data", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const target = String(url);
      if (target.startsWith("/api/customers?")) {
        return new Response(JSON.stringify({
          customers: [{
            customerCode: "C-001",
            customerName: "既存顧客株式会社",
            customerPostalCode: "650-0001",
            customerAddress: "兵庫県神戸市テスト1-2-3",
            customerContact: "既存担当",
            customerTelephone: "078-000-0000",
            customerEmail: "existing@example.co.jp",
          }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({}), { status: 404 });
    });
    vi.stubGlobal("fetch", withFontFetch(fetchMock));

    render(<QuotePage />);
    await user.type(screen.getByTestId("customer-search-input"), "既存");
    await waitFor(() => expect(screen.getByTestId("customer-search-results")).toBeInTheDocument());
    await waitFor(() => {
      const request = fetchMock.mock.calls.find(([requestedUrl]) => {
        const parsed = new URL(String(requestedUrl), "http://localhost");
        return parsed.pathname === "/api/customers"
          && parsed.searchParams.get("q") === "既存"
          && parsed.searchParams.get("limit") === "500";
      });
      expect(request).toBeTruthy();
    });
    expect(screen.getByTestId("issue-required-fields")).toBeVisible();

    await user.click(screen.getByRole("button", { name: /既存顧客株式会社/ }));
    expect(screen.getByLabelText("会社名 ★")).toHaveValue("既存顧客株式会社");
    expect(screen.getByLabelText("住所 ★")).toHaveValue("兵庫県神戸市テスト1-2-3");
    expect(screen.getByTestId("customer-email-input")).toHaveValue("existing@example.co.jp");

    await user.click(screen.getByTestId("fill-test-data"));
    expect((screen.getByLabelText("会社名 ★") as HTMLInputElement).value).toMatch("テスト顧客株式会社");
    expect(screen.getByLabelText("FAX")).toHaveValue("");
    expect(screen.getByLabelText("お支払い条件")).toHaveTextContent("従来通り");
    expect(screen.queryByTestId("calc-invalid-fields")).not.toBeInTheDocument();
    expect(screen.getByTestId("issue-required-fields")).toBeVisible();
    expect(screen.getByRole("button", { name: "見積書を発行" })).toBeEnabled();
  });

  it("renders long customer lists in pages instead of mounting every row", async () => {
    const user = userEvent.setup();
    const customers = Array.from({ length: 120 }, (_, index) => ({
      customerCode: `C-${String(index + 1).padStart(4, "0")}`,
      customerName: `大量顧客${index + 1}株式会社`,
      customerPostalCode: "",
      customerAddress: "",
      customerContact: "",
      customerTelephone: "",
      customerEmail: "",
    }));
    vi.stubGlobal("fetch", withFontFetch(vi.fn(async () => new Response(
      JSON.stringify({ customers }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ))));

    const { container } = render(<QuotePage />);
    await user.click(screen.getByTestId("customer-search-input"));
    await waitFor(() => expect(screen.getByTestId("customer-search-count")).toHaveTextContent("120件"));
    expect(container.querySelectorAll(".customer-search-result-row")).toHaveLength(50);

    await user.click(screen.getByRole("button", { name: /続きを表示/ }));
    expect(container.querySelectorAll(".customer-search-result-row")).toHaveLength(100);
    expect(screen.getByRole("button", { name: /残り 20件/ })).toBeVisible();
    // blur遅延後にドロップダウンが勝手に閉じないことを回帰として抑止する。
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(screen.getByTestId("customer-search-results")).toBeVisible();
    expect(container.querySelectorAll(".customer-search-result-row")).toHaveLength(100);
  });

  it("keeps an active restored revision across quote page navigation", async () => {
    const user = userEvent.setup();
    sessionStorage.setItem("pouch-quotation-restore-v1", JSON.stringify({
      customerCode: "C-001",
      customerName: "保持株式会社",
      customerPostalCode: "650-0001",
      customerAddress: "兵庫県保持市1-2-3",
      customerTelephone: "078-111-2222",
      customerEmail: "keep@example.co.jp",
      productName: "保持製品",
      revisionOf: "KT-202610-002",
      quantity: "12345",
      targetMargin: "0.35",
      fillingCostPerPiece: "10",
      filmCostPerPiece: "20",
      filmMeterPrice: "400",
      filmOrderLengthM: "500",
      calculationVersion: "simulator-linked",
      resultHash: "keep-check",
      calculationFilmTotal: "10000",
    }));

    const first = render(<QuotePage />);
    await waitFor(() => expect(screen.getByLabelText("会社名 ★")).toHaveValue("保持株式会社"));
    first.unmount();

    const second = render(<QuotePage />);
    await waitFor(() => expect(screen.getByLabelText("会社名 ★")).toHaveValue("保持株式会社"));
    expect(screen.getByLabelText("住所 ★")).toHaveValue("兵庫県保持市1-2-3");
    expect(screen.getByTestId("customer-email-input")).toHaveValue("keep@example.co.jp");
    expect(screen.getByLabelText("製品名（SKU-1）★")).toHaveValue("");
    await user.type(screen.getByLabelText("製品名（SKU-1）★"), "保持SKU");
    second.unmount();
  });
});

it("shows the authenticated approver directly above the internal review seal", () => {
  cleanup();
  render(<QuotePage approverName="石井" />);

  const approval = screen.getByText("石井").closest<HTMLElement>(".approval-seal-group");
  expect(approval).not.toBeNull();
  expect(within(approval!).getByText("検討済")).toBeVisible();
});

it("renders issuer contact details, fax, and unique personal contact names", async () => {
  const { unmount: unmount1 } = render(<QuotePage
    approverName="石井"
    issuerContact={{
      companyName: "金井貿易株式会社",
      contactName: "Kim Admin",
      email: "kim@kanei-trade.co.jp",
      telephone: "TEL 050-3613-9673",
    }}
  />);
  await waitFor(() => expect(screen.getByTestId("footer-contact")).toBeInTheDocument());
  expect(screen.getByTestId("footer-contact")).toHaveTextContent("金井貿易株式会社");
  unmount1();

  const { unmount: unmount2 } = render(<QuotePage
    approverName="石井"
    issuerContact={{
      companyName: "",
      contactName: "石井（金井貿易株式会社）",
      email: "shapepouch@package-lab.com",
      telephone: "TEL 050-3613-9673",
    }}
  />);
  await waitFor(() => expect(screen.getByTestId("issuer-telephone-fax")).toBeInTheDocument());
  expect(screen.getByTestId("issuer-telephone-fax")).toHaveTextContent("TEL 072-971-0726 / FAX 072-971-5800");
  expect(screen.getByTestId("issuer-contact-name")).toHaveTextContent("石井");
  unmount2();

  const { unmount: unmount3 } = render(<QuotePage
    approverName="吾藤"
    issuerContact={{
      companyName: "株式会社セブン化学",
      contactName: "吾藤",
      email: "gotou@727.co.jp",
      telephone: "TEL 072-971-0726",
    }}
  />);
  await waitFor(() => expect(screen.getByTestId("issuer-party-contact-list")).toBeInTheDocument());
  expect(screen.getByTestId("issuer-party-contact-list")).toHaveTextContent("gotou@727.co.jp");
  expect(screen.queryByTestId("issuer-party-telephone")).not.toBeInTheDocument();
  unmount3();
});
