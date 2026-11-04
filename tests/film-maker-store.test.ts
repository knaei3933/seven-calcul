import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseDirectory = await mkdtemp(join(tmpdir(), "film-maker-store-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.POUCH_CUSTOMER_DB = join(databaseDirectory, "customers.db");
process.env.MAIL_DRY_RUN = "true";

beforeAll(async () => {
  const { getSqlClient } = await import("@/lib/db");
  const schemaDb = await getSqlClient("quotations");
  await schemaDb.exec(`
    CREATE TABLE IF NOT EXISTS quotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL DEFAULT 'approved',
      created_by INTEGER,
      payload_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'user'
    );
  `);
  const { listFilmOrders } = await import("@/lib/film-orders");
  await listFilmOrders("seven@727.co.jp");
  const db = await schemaDb;
  await db.exec(`
    INSERT INTO quotations (id, status, payload_json) VALUES (1, 'approved', '{}');
    INSERT INTO film_orders (
      id, quotation_id, order_number, quotation_number, product_name, customer_name,
      printing_method, procurement_route, status, purchase_order_json, created_at, updated_at
    ) VALUES (1, 1, 'F-202611-001', 'S7-001', 'Test Pouch', 'Customer', 'gravure', 'K', 'pending', '{}', '2026-11-04T00:00:00.000Z', '2026-11-04T00:00:00.000Z');
  `);
});

afterAll(async () => {
  const { resetSqlClientForTest } = await import("@/lib/db");
  await resetSqlClientForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});

describe("film maker master store", () => {
  it("validates codes, languages, route/print values, and internal identities", async () => {
    const { createFilmMaker } = await import("@/lib/film-maker-store");
    const base = {
      makerCode: "KOR-GRA-001",
      companyName: "外部フィルムメーカー",
      contactName: "担当",
      email: "maker@example.test",
      language: "ko" as const,
      printMethod: "gravure" as const,
      procurementRoute: "K" as const,
    };
    await expect(createFilmMaker({ ...base, makerCode: "AB" }, "admin@kanei-trade.co.jp")).rejects.toThrow("invalid_film_maker_maker_code");
    await expect(createFilmMaker({ ...base, language: "en" as never }, "admin@kanei-trade.co.jp")).rejects.toThrow("invalid_film_maker_language");
    await expect(createFilmMaker({ ...base, printMethod: "offset" as never }, "admin@kanei-trade.co.jp")).rejects.toThrow("invalid_film_maker_print_method");
    await expect(createFilmMaker({ ...base, procurementRoute: "A" as never }, "admin@kanei-trade.co.jp")).rejects.toThrow("invalid_film_maker_procurement_route");
    await expect(createFilmMaker({ ...base, email: "design@package-lab.com" }, "admin@kanei-trade.co.jp")).rejects.toThrow("internal_film_maker_rejected");
    await expect(createFilmMaker({ ...base, companyName: "Package Lab" }, "admin@kanei-trade.co.jp")).rejects.toThrow("internal_film_maker_rejected");
    await expect(createFilmMaker({ ...base, email: "someone@727.co.jp" }, "admin@kanei-trade.co.jp")).rejects.toThrow("internal_film_maker_rejected");
    await expect(createFilmMaker({ ...base, email: "someone@kanei-trade.co.jp" }, "admin@kanei-trade.co.jp")).rejects.toThrow("internal_film_maker_rejected");

    const created = await createFilmMaker(base, "admin@kanei-trade.co.jp");
    expect(created.makerCode).toBe("KOR-GRA-001");
    await expect(createFilmMaker({ ...base, makerCode: "kor-gra-001" }, "admin@kanei-trade.co.jp")).rejects.toThrow("duplicate_film_maker_code");
  });

  it("returns only active route/print selections without contact fields", async () => {
    const { createFilmMaker, deactivateFilmMaker, listActiveFilmMakerSelections } = await import("@/lib/film-maker-store");
    const active = await createFilmMaker({
      makerCode: "KOR-GRA-002",
      companyName: "두 번째 필름 제조사",
      email: "second@example.test",
      contactName: "contact@example.test",
      language: "ko",
      printMethod: "gravure",
      procurementRoute: "K",
    }, "admin@kanei-trade.co.jp");
    await createFilmMaker({
      makerCode: "KOR-DIG-001",
      companyName: "디지털 필름 제조사",
      email: "digital@example.test",
      language: "ko",
      printMethod: "digital",
      procurementRoute: "K",
    }, "admin@kanei-trade.co.jp");
    await deactivateFilmMaker(active.id, "admin@kanei-trade.co.jp");
    const selections = await listActiveFilmMakerSelections("K", "gravure");
    expect(selections.map((maker) => maker.makerCode)).toEqual(["KOR-GRA-001"]);
    expect(Object.keys(selections[0])).not.toContain("email");
    expect(await listActiveFilmMakerSelections("K", "digital")).toHaveLength(1);
  });

  it("creates an immutable snapshot and explicitly reports unresolved/master-selected state", async () => {
    const { createFilmMaker, filmOrderMakerResolution, selectFilmMakerForOrder, updateFilmMaker } = await import("@/lib/film-maker-store");
    expect(await filmOrderMakerResolution(1)).toMatchObject({
      resolution: "legacy_unresolved",
      makerId: null,
      snapshot: null,
    });
    const maker = await createFilmMaker({
      makerCode: "KOR-GRA-003",
      companyName: "변경 전 필름 제조사",
      email: "snapshot@example.test",
      language: "ko",
      printMethod: "gravure",
      procurementRoute: "K",
    }, "admin@kanei-trade.co.jp");
    const selected = await selectFilmMakerForOrder(1, maker.id, "workflow@kanei-trade.co.jp");
    expect(selected.resolution).toBe("master_selected");
    expect(Object.isFrozen(selected.snapshot)).toBe(true);
    expect(selected.snapshot.email).toBe("snapshot@example.test");
    await updateFilmMaker(maker.id, {
      ...maker,
      makerCode: "KOR-GRA-003",
      companyName: "変更後フィルムメーカー",
      email: "changed@example.test",
      contactName: "",
      language: "ko",
      printMethod: "gravure",
      procurementRoute: "K",
      isActive: true,
      note: "",
    }, "admin@kanei-trade.co.jp");
    const resolution = await filmOrderMakerResolution(1);
    expect(resolution).toMatchObject({ resolution: "master_selected", makerId: maker.id });
    expect(resolution.snapshot?.companyName).toBe("변경 전 필름 제조사");
    expect(resolution.snapshot?.email).toBe("snapshot@example.test");
    const { getSqlClient } = await import("@/lib/db");
    const db = await getSqlClient("quotations");
    const raw = await db.get<{ film_maker_snapshot_json: string }>(
      "SELECT film_maker_snapshot_json FROM film_orders WHERE id=1",
    );
    expect(JSON.parse(raw!.film_maker_snapshot_json).email).toBe("snapshot@example.test");
  });

  it("classifies legacy suppliers and requires an explicit classified reason to exempt", async () => {
    const db = await (await import("@/lib/db")).getSqlClient("quotations");
    const now = new Date().toISOString();
    const insertOrder = async (
      orderNumber: string,
      supplierName: string,
      supplierEmail: string,
    ): Promise<number> => {
      await db.run(`
        INSERT INTO film_orders (
          quotation_id,order_number,quotation_number,product_name,customer_name,printing_method,
          procurement_route,supplier_name,supplier_email,status,purchase_order_json,created_at,updated_at
        ) VALUES (1,?,'legacy','Legacy pouch','Legacy customer','gravure','K',?,?, 'pending','{}',?,?)
      `, [orderNumber, supplierName, supplierEmail, now, now]);
      const row = await db.get<{ id: number }>("SELECT id FROM film_orders WHERE order_number=?", [orderNumber]);
      return Number(row!.id);
    };
    const exactId = await insertOrder("F-202611-LEGACY-EXACT", "External Maker", "exact-reconcile@example.test");
    const internalId = await insertOrder("F-202611-LEGACY-INTERNAL", "Seven Chemical", "seven@727.co.jp");
    const ambiguousId = await insertOrder("F-202611-LEGACY-AMBIGUOUS", "", "");

    const { createFilmMaker, backfillLegacySupplierSuggestions, exemptLegacyOrder, listLegacyReconciliations } =
      await import("@/lib/film-maker-store");
    const maker = await createFilmMaker({
      makerCode: "KOR-GRA-RECONCILE",
      companyName: "External Maker",
      email: "exact-reconcile@example.test",
      language: "ko",
      printMethod: "gravure",
      procurementRoute: "K",
    }, "admin@kanei-trade.co.jp");
    const backfill = await backfillLegacySupplierSuggestions([exactId, internalId, ambiguousId]);
    expect(backfill).toEqual({ scanned: 3, suggested: 1 });

    let listed = await listLegacyReconciliations();
    const exact = listed.find((order) => order.orderId === exactId)!;
    expect(exact).toMatchObject({
      supplierName: "External Maker",
      supplierEmail: "exact-reconcile@example.test",
      procurementRoute: "K",
      printMethod: "gravure",
      classification: "external_exact",
      resolution: "legacy_unresolved",
    });
    expect(exact.suggestedMaker).toMatchObject({ makerId: maker.id, confidence: "exact" });
    expect(listed.find((order) => order.orderId === internalId)?.classification).toBe("internal");
    expect(listed.find((order) => order.orderId === ambiguousId)?.classification).toBe("ambiguous");

    await expect(exemptLegacyOrder(internalId, "", "internal", "admin@kanei-trade.co.jp"))
      .rejects.toThrow("legacy_exempt_reason_required");
    await expect(exemptLegacyOrder(internalId, "reason", "ambiguous", "admin@kanei-trade.co.jp"))
      .rejects.toThrow("legacy_classification_conflict");
    await exemptLegacyOrder(internalId, "既存案件のため明示対象外", "internal", "admin@kanei-trade.co.jp");
    listed = await listLegacyReconciliations();
    expect(listed.some((order) => order.orderId === internalId)).toBe(false);
    const internal = await db.get<{
      supplier_name: string;
      supplier_email: string;
      supplier_resolution: string;
      film_maker_id: number | null;
    }>("SELECT supplier_name,supplier_email,supplier_resolution,film_maker_id FROM film_orders WHERE id=?", [internalId]);
    expect(internal).toEqual({
      supplier_name: "Seven Chemical",
      supplier_email: "seven@727.co.jp",
      supplier_resolution: "legacy_exempt",
      film_maker_id: null,
    });
    const audit = await db.get<{ type: string; detail: string; actor_email: string }>(
      "SELECT type,detail,actor_email FROM film_order_events WHERE order_id=? ORDER BY id DESC LIMIT 1",
      [internalId],
    );
    expect(audit).toMatchObject({
      type: "legacy_supplier_reconciliation",
      detail: expect.stringContaining("既存案件のため明示対象外"),
      actor_email: "admin@kanei-trade.co.jp",
    });

    // Explicit selection is the only path from a suggestion to master_selected.
    const { selectFilmMakerForOrder, filmOrderMakerResolution } = await import("@/lib/film-maker-store");
    await selectFilmMakerForOrder(exactId, maker.id, "admin@kanei-trade.co.jp");
    expect(await filmOrderMakerResolution(exactId)).toMatchObject({
      resolution: "master_selected",
      makerId: maker.id,
      snapshot: { email: "exact-reconcile@example.test" },
    });
    expect(await db.get<{ supplier_email: string }>(
      "SELECT supplier_email FROM film_orders WHERE id=?", [exactId],
    )).toEqual({ supplier_email: "exact-reconcile@example.test" });
    expect(await db.get<{ type: string }>(
      "SELECT type FROM film_order_events WHERE order_id=? ORDER BY id DESC LIMIT 1", [exactId],
    )).toEqual({ type: "film_maker" });
    expect((await listLegacyReconciliations()).some((order) => order.orderId === exactId)).toBe(false);
    expect((await listLegacyReconciliations()).some((order) => order.orderId === ambiguousId)).toBe(true);
  });
});
