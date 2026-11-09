import { withLegacySevenQuotationSave } from "./helpers/legacy-quotation-fixture";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlClient } from "@/lib/db";
import type { AuthenticatedUser } from "@/lib/auth-store";
import type { QuotationRecordInput } from "@/lib/quotation-shared";
import { quotationOwnerProfile } from "@/lib/quote-owner-profiles";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));


const databaseDirectory = await mkdtemp(join(tmpdir(), "g006-owner-boundary-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.MAIL_DRY_RUN = "true";
process.env.ADMIN_EMAIL = "neutral-admin@example.test";
process.env.ADMIN_PASSWORD = "neutral-admin-password";
process.env.ADMIN_NAME = "Neutral Admin";

const {
  backfillPortalQuotationOwnersForTest,
} = await import("@/lib/portal/quote-calculation-store");
const { createUser, authenticate, createSession } = await import("@/lib/auth-store");
const { getDatabaseForTest, saveQuotation: directSaveQuotation } = await import("@/lib/quotation-store");
const saveQuotation = withLegacySevenQuotationSave(directSaveQuotation);
const {
  syncFilmOrdersFromQuotations,
  listFilmOrderSummaries,
  getDatabaseForFilmMakerStore,
  resetFilmOrderSchemaForTest,
} = await import("@/lib/film-orders");
const { createFilmMaker } = await import("@/lib/film-maker-store");
const { canPerformFilmOrderAction } = await import("@/lib/film-order-access");
const { prepareFilmOrderMail } = await import("@/lib/film-order-mail-lifecycle");
const { GET: filmOrderListRoute } = await import("@/app/api/film-orders/route");
const { GET: filmOrderDetailRoute } = await import("@/app/api/film-orders/[id]/route");
const QuotePage = (await import("@/app/quote/quote-client")).default;
const HistoryClient = (await import("@/app/history/history-client")).default;

afterAll(async () => {
  cleanup();
  await rm(databaseDirectory, { recursive: true, force: true });
});

beforeEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function request(url: string, init: RequestInit = {}, token?: string): Request {
  return new Request(url, {
    ...init,
    headers: { ...(init.headers ?? {}), ...(token ? { cookie: `pouch_session=${token}` } : {}) },
  });
}

async function quotation(input: Partial<QuotationRecordInput>, creatorEmail: string): Promise<number> {
  const creator = await createUser({
    email: creatorEmail,
    name: creatorEmail.split("@")[0]!,
    password: `${creatorEmail.split("@")[0]!}-password`,
    role: "user",
  });
  const record: QuotationRecordInput = {
    quotationNumber: creatorEmail.endsWith("@727.co.jp")
      ? `S7-G006-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
      : creatorEmail.endsWith("@kanei-trade.co.jp")
        ? `KT-G006-${Math.random().toString(36).slice(2, 8).toUpperCase()}`
        : `G006-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    status: "approved",
    issueDate: "2026-11-04",
    validUntil: "2026-12-04",
    customerName: "Owner Boundary Customer",
    customerContact: "",
    productName: "Boundary Pouch",
    sizeSummary: "60×80mm",
    quantity: "10000",
    fillingCostPerPiece: "4",
    filmCostPerPiece: "5",
    filmMeterPrice: "180",
    filmOrderLengthM: "500",
    targetMargin: "0.3",
    taxRatePercent: "10",
    pricePerPiece: "20",
    subtotal: "200000",
    tax: "20000",
    grandTotal: "220000",
    deliveryDate: "",
    paymentTerms: "",
    notes: "",
    calculationVersion: "g006",
    resultHash: "",
    payload: {
      customerCode: "G006-CUSTOMER",
      customerEmail: "g006-customer@example.test",
      purchaseOrder: { printingMethod: "digital", orderLengthM: "500", webWidthMm: 556 },
    },
    ...input,
  };
  const saved = await saveQuotation(record, creator.id, creator.role);
  return saved.id;
}

describe("G006 owner-boundary regressions", () => {
  it("quarantines an explicitly unresolved quotation during portal backfill", async () => {
    const statements: string[] = [];
    const db: SqlClient = {
      dialect: "sqlite",
      all: async () => [],
      get: async () => undefined,
      run: async (sql: string) => {
        statements.push(sql);
        return { changes: 0, lastInsertRowid: null };
      },
      exec: async () => undefined,
      transaction: async (operation) => operation(db),
      close: async () => undefined,
    };
    await backfillPortalQuotationOwnersForTest(db);
    const backfill = statements.join("\n");
    expect(backfill).toContain("quotations.owner_domain IS NULL");
    expect(backfill).not.toContain("quotations.owner_domain = 'unresolved'");
  });

  it("does not create a film order for an approved unresolved quotation", async () => {
    const id = await quotation({}, "unresolved-creator@example.test");
    const db = await getDatabaseForTest();
    await db.run("UPDATE quotations SET owner_domain='unresolved' WHERE id=?", [id]);
    await expect(syncFilmOrdersFromQuotations("unresolved-creator@example.test")).resolves.toBe(0);
    const created = await db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM film_orders WHERE quotation_id=?",
      [id],
    );
    expect(Number(created?.count)).toBe(0);
  });

  it("preserves an invalid existing buyer instead of coercing it to Kanei", async () => {
    const id = await quotation({}, "legacy-kanei@kanei-trade.co.jp");
    await syncFilmOrdersFromQuotations("legacy-kanei@kanei-trade.co.jp");
    const db = await getDatabaseForTest();
    await db.run("UPDATE film_orders SET buyer_domain='invalid-owner' WHERE quotation_id=?", [id]);
    await listFilmOrderSummaries("legacy-kanei@kanei-trade.co.jp");
    const row = await db.get<{ buyer_domain: string }>(
      "SELECT buyer_domain FROM film_orders WHERE quotation_id=?",
      [id],
    );
    expect(row?.buyer_domain).toBe("invalid-owner");
  });

  it("preserves unresolved and invalid film ownership across a schema restart", async () => {
    const resolvedId = await quotation({}, "restart-kanei@kanei-trade.co.jp");
    const unresolvedEmptyId = await quotation({}, "restart-unknown-1@example.test");
    const unresolvedInvalidId = await quotation({}, "restart-unknown-2@example.test");
    const db = await getDatabaseForTest();

    await syncFilmOrdersFromQuotations("restart-kanei@kanei-trade.co.jp");
    for (const quotationId of [unresolvedEmptyId, unresolvedInvalidId]) {
      await db.run("UPDATE quotations SET owner_domain='kanei' WHERE id=?", [quotationId]);
    }
    await syncFilmOrdersFromQuotations("restart-kanei@kanei-trade.co.jp");
    for (const quotationId of [unresolvedEmptyId, unresolvedInvalidId]) {
      await db.run("UPDATE quotations SET owner_domain='unresolved' WHERE id=?", [quotationId]);
    }
    await db.run("UPDATE film_orders SET buyer_domain='invalid-owner' WHERE quotation_id=?", [resolvedId]);
    await db.run("UPDATE film_orders SET buyer_domain='' WHERE quotation_id=?", [unresolvedEmptyId]);
    await db.run("UPDATE film_orders SET buyer_domain='invalid-owner' WHERE quotation_id=?", [unresolvedInvalidId]);

    resetFilmOrderSchemaForTest();
    await getDatabaseForFilmMakerStore();

    const rows = await db.all<{ quotation_id: number; buyer_domain: string }>(
      "SELECT quotation_id,buyer_domain FROM film_orders WHERE quotation_id IN (?,?,?) ORDER BY quotation_id",
      [resolvedId, unresolvedEmptyId, unresolvedInvalidId],
    );
    expect(rows).toEqual([
      expect.objectContaining({ quotation_id: resolvedId, buyer_domain: "invalid-owner" }),
      expect.objectContaining({ quotation_id: unresolvedEmptyId, buyer_domain: "" }),
      expect.objectContaining({ quotation_id: unresolvedInvalidId, buyer_domain: "invalid-owner" }),
    ]);
  });

  it("gives Seven customer workflow authority only on Seven-owned orders", () => {
    const customerActions = [
      "request-customer-design-upload",
      "confirm-customer-design",
      "request-customer-design-correction",
    ] as const;
    for (const action of customerActions) {
      expect(canPerformFilmOrderAction(action, "seven@727.co.jp", "727.co.jp")).toBe(true);
      expect(canPerformFilmOrderAction(action, "kanei@kanei-trade.co.jp", "727.co.jp")).toBe(false);
      expect(canPerformFilmOrderAction(action, "seven@727.co.jp", "kanei-trade.co.jp")).toBe(false);
      expect(canPerformFilmOrderAction(action, "kanei@kanei-trade.co.jp", "kanei-trade.co.jp")).toBe(true);
    }
    expect(canPerformFilmOrderAction("record-customer-proof-approval", "seven@727.co.jp", "727.co.jp")).toBe(false);
    expect(canPerformFilmOrderAction("record-customer-proof-approval", "kanei@kanei-trade.co.jp", "727.co.jp")).toBe(true);
    expect(canPerformFilmOrderAction("approve", "seven@727.co.jp", "727.co.jp")).toBe(true);
    expect(canPerformFilmOrderAction("approve", "kanei@kanei-trade.co.jp", "727.co.jp")).toBe(false);
    expect(canPerformFilmOrderAction("set-supplier", "seven@727.co.jp", "727.co.jp")).toBe(false);
    expect(canPerformFilmOrderAction("set-supplier", "kanei@kanei-trade.co.jp", "727.co.jp")).toBe(true);
    for (const lookalike of ["evil727.co.jp", "notkanei-trade.co.jp", "invalid-owner", ""]) {
      expect(canPerformFilmOrderAction("mark-ordered", "seven@727.co.jp", lookalike)).toBe(false);
      expect(canPerformFilmOrderAction("mark-ordered", "kanei@kanei-trade.co.jp", lookalike)).toBe(false);
    }
  });

  it("auto-selects the unique matching film maker from the approved projection", async () => {
    const quoteId = await quotation({}, "auto-kanei@kanei-trade.co.jp");
    await createFilmMaker({
      makerCode: "AUTO-K-DIG",
      companyName: "Auto Korean Film Maker",
      contactName: "Auto Contact",
      email: "auto-maker@example.test",
      language: "ko",
      printMethod: "digital",
      procurementRoute: "K",
    }, "auto-kanei@kanei-trade.co.jp");
    await expect(syncFilmOrdersFromQuotations("auto-kanei@kanei-trade.co.jp")).resolves.toBe(1);

    const db = await getDatabaseForTest();
    const order = await db.get<{ supplier_resolution: string; film_maker_snapshot_json: string }>(
      "SELECT supplier_resolution,film_maker_snapshot_json FROM film_orders WHERE quotation_id=?",
      [quoteId],
    );
    expect(order?.supplier_resolution).toBe("master_selected");
    const snapshot = JSON.parse(order?.film_maker_snapshot_json ?? "{}") as { makerCode?: string; selectedByEmail?: string };
    expect(snapshot).toMatchObject({ makerCode: "AUTO-K-DIG", selectedByEmail: "auto-kanei@kanei-trade.co.jp" });
  });

  it("keeps ownership unresolved when more than one maker matches the fixed projection", async () => {
    const quoteId = await quotation({}, "ambiguous-kanei@kanei-trade.co.jp");
    for (const code of ["AMBIG-K-DIG-1", "AMBIG-K-DIG-2"]) {
      await createFilmMaker({
        makerCode: code,
        companyName: `Ambiguous Maker ${code}`,
        contactName: "Contact",
        email: `${code.toLowerCase()}@example.test`,
        language: "ko",
        printMethod: "digital",
        procurementRoute: "K",
      }, "ambiguous-kanei@kanei-trade.co.jp");
    }
    await expect(syncFilmOrdersFromQuotations("ambiguous-kanei@kanei-trade.co.jp")).resolves.toBe(1);
    const db = await getDatabaseForTest();
    await expect(db.get<{ supplier_resolution: string }>(
      "SELECT supplier_resolution FROM film_orders WHERE quotation_id=?",
      [quoteId],
    )).resolves.toEqual({ supplier_resolution: "legacy_unresolved" });
  });

  it("identifies Seven-owned customer mail as Seven while keeping maker mail Kanei", async () => {
    const id = await quotation({}, "mail-seven@727.co.jp");
    await syncFilmOrdersFromQuotations("mail-seven@727.co.jp");
    const db = await getDatabaseForTest();
    const order = await db.get<{ id: number }>(
      "SELECT id FROM film_orders WHERE quotation_id=?",
      [id],
    );
    const preview = await prepareFilmOrderMail({
      orderId: Number(order!.id),
      action: "request-customer-design-upload",
      actorEmail: "mail-seven@727.co.jp",
      origin: "http://localhost:3000",
      customerEmail: "g006-customer@example.test",
    });
    const customerMail = preview.envelopes.find((envelope) => envelope.audience === "customer");
    expect(customerMail?.intendedTo).toBe("g006-customer@example.test");
    expect(customerMail?.body).toContain("発行者：Seven Chemical Film Workflow");
  });

  it("permits a neutral role-admin film-order read but keeps mutations company-scoped", async () => {
    const admin = await createUser({
      email: "machine-admin@example.test",
      name: "Machine Admin",
      password: "machine-admin-password",
      role: "admin",
    });
    const authenticated = await authenticate("machine-admin@example.test", "machine-admin-password");
    expect(authenticated).toBeTruthy();
    const token = authenticated ? (await createSession(authenticated.id)).token : undefined;
    expect(token).toBeTruthy();
    const listResponse = await filmOrderListRoute(
      request("http://localhost/api/film-orders", {}, token),
    );
    expect(listResponse.status).toBe(200);
    const list = await listResponse.json() as { orders: Array<{ id: number }> };
    expect(list.orders.length).toBeGreaterThan(0);
    const detailResponse = await filmOrderDetailRoute(
      request(`http://localhost/api/film-orders/${list.orders[0]!.id}`, {}, token),
      { params: Promise.resolve({ id: String(list.orders[0]!.id) }) } as never,
    );
    expect(detailResponse.status).toBe(200);
    expect(canPerformFilmOrderAction("mark-ordered", admin.email, "kanei-trade.co.jp")).toBe(false);
  });

  it("uses owner defaults and removes Seven sample responsibility from Kanei quotes", () => {
    const kaneiProfile = quotationOwnerProfile("kanei")!;
    const sevenProfile = quotationOwnerProfile("seven")!;
    const sevenSampleNote = "初回製作時は、バルクサンプルを株式会社セブン化学 責任技術者：福井　健二 宛にご送付ください。";

    render(<QuotePage ownerDomain="kanei" ownerProfile={kaneiProfile} />);
    expect(screen.getByTestId("quote-owner-logo")).toHaveAttribute("src", kaneiProfile.logoUrl);
    expect(screen.getByTestId("issuer-party")).toHaveTextContent(kaneiProfile.legalName);
    expect(document.body.textContent).not.toContain(sevenSampleNote);
    cleanup();

    render(<QuotePage ownerDomain="seven" ownerProfile={sevenProfile} />);
    expect(document.body.textContent).toContain(sevenSampleNote);
    cleanup();

    render(<QuotePage ownerDomain="unresolved" ownerProfile={undefined} />);
    expect(screen.getByTestId("unresolved-quote-owner")).toHaveTextContent("unresolved_quote_owner");
  });

  it("reconciles exact legacy Seven branding but preserves custom issuer values", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ records: [] })));
    vi.stubGlobal("matchMedia", vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    })));
    const viewer: AuthenticatedUser = {
      id: 991,
      email: "viewer@example.test",
      name: "Viewer",
      role: "admin",
      isActive: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      sessionId: 1,
    };
    const base = {
      status: "approved" as const,
      issueDate: "2026-11-04",
      validUntil: "2026-12-04",
      customerName: "Legacy Customer",
      customerContact: "",
      productName: "Legacy Pouch",
      sizeSummary: "50×80mm",
      quantity: "10000",
      fillingCostPerPiece: "4",
      filmCostPerPiece: "5",
      filmMeterPrice: "180",
      filmOrderLengthM: "500",
      targetMargin: "0.3",
      taxRatePercent: "10",
      pricePerPiece: "20",
      subtotal: "200000",
      tax: "20000",
      grandTotal: "220000",
      deliveryDate: "",
      paymentTerms: "",
      notes: "",
      calculationVersion: "g006",
      resultHash: "",
      createdAt: "2026-11-04T00:00:00.000Z",
      updatedAt: "2026-11-04T00:00:00.000Z",
      createdBy: viewer,
      updatedBy: null,
      internalApproval: null,
      customerApproval: null,
    };
    const records = [
      {
        ...base,
        id: 1,
        quotationNumber: "KT-LEGACY-DEFAULT",
        ownerDomain: "kanei" as const,
        payload: {
          issuerName: "株式会社セブン化学",
          issuerEnglishName: "SEVEN CHEMICAL CO., LTD.",
          issuerPostalCode: "〒582-0017",
          issuerAddress: "大阪府柏原市太平寺1丁目12番1号",
        },
      },
      {
        ...base,
        id: 2,
        quotationNumber: "KT-CUSTOM-ISSUER",
        ownerDomain: "kanei" as const,
        payload: { issuerName: "手入力発行者株式会社" },
      },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ records })));
    const user = userEvent.setup();
    render(<HistoryClient currentUser={viewer} />);
    const details = await screen.findAllByRole("button", { name: "詳細" });
    await user.click(details[0]!);
    await user.click(screen.getByRole("button", { name: "詳細データ" }));
    expect(await screen.findByTestId("data-report-a4")).toHaveTextContent("金井貿易株式会社");
    await user.click(screen.getByRole("button", { name: "閉じる" }));
    await user.click(details[1]!);
    await user.click(screen.getByRole("button", { name: "詳細データ" }));
    expect(screen.getByTestId("data-report-a4")).toHaveTextContent("手入力発行者株式会社");
    vi.unstubAllGlobals();
  });
});
