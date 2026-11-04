import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const sessionUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-auth", () => ({ getSessionUser: sessionUser }));

const databaseDirectory = await mkdtemp(join(tmpdir(), "film-maker-api-"));
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
});

afterAll(async () => {
  const { resetSqlClientForTest } = await import("@/lib/db");
  await resetSqlClientForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});

describe("film maker API authorization", () => {
  it("allows contact CRUD only to Kanei admins and exposes only minimal selection to Kanei workflow", async () => {
    const admin = { email: "admin@kanei-trade.co.jp", role: "admin" };
    const workflow = { email: "workflow@kanei-trade.co.jp", role: "user" };
    const sevenAdmin = { email: "seven@727.co.jp", role: "admin" };
    const customer = { email: "customer@example.test", role: "user" };
    const request = new Request("http://localhost/api/film-makers");
    const selectionRequest = new Request("http://localhost/api/film-makers/selection?procurementRoute=K&printMethod=gravure");
    const { GET: listGet, POST: createPost } = await import("@/app/api/film-makers/route");
    const { DELETE: deleteMaker, PATCH: updateMaker } = await import("@/app/api/film-makers/[id]/route");
    const { GET: selectionGet } = await import("@/app/api/film-makers/selection/route");

    sessionUser.mockResolvedValue(null);
    await expect(listGet(request)).resolves.toMatchObject({ status: 401 });

    sessionUser.mockResolvedValue(sevenAdmin);
    await expect(listGet(request)).resolves.toMatchObject({ status: 403 });

    sessionUser.mockResolvedValue(workflow);
    await expect(listGet(request)).resolves.toMatchObject({ status: 403 });

    sessionUser.mockResolvedValue(admin);
    const created = await createPost(new Request("http://localhost/api/film-makers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        makerCode: "API-KOR-001",
        companyName: "APIフィルムメーカー",
        email: "api-maker@example.test",
        contactName: "API担当",
        language: "ko",
        printMethod: "gravure",
        procurementRoute: "K",
      }),
    }));
    expect(created.status).toBe(201);
    const maker = ((await created.json()) as { maker: { id: number; email: string } }).maker;
    expect(maker.email).toBe("api-maker@example.test");

    sessionUser.mockResolvedValue(sevenAdmin);
    await expect(createPost(new Request("http://localhost/api/film-makers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ makerCode: "NO", companyName: "x", email: "x@example.test", language: "ko", printMethod: "gravure", procurementRoute: "K" }),
    }))).resolves.toMatchObject({ status: 403 });

    sessionUser.mockResolvedValue(customer);
    await expect(selectionGet(selectionRequest)).resolves.toMatchObject({ status: 403 });

    sessionUser.mockResolvedValue(workflow);
    const selections = await selectionGet(selectionRequest);
    expect(selections.status).toBe(200);
    const payload = await selections.json();
    expect(payload.selections).toEqual([{
      id: maker.id,
      makerCode: "API-KOR-001",
      companyName: "APIフィルムメーカー",
      language: "ko",
    }]);
    expect(JSON.stringify(payload)).not.toContain("api-maker@example.test");

    sessionUser.mockResolvedValue(admin);
    const listed = await listGet(request);
    expect(listed.status).toBe(200);
    expect(JSON.stringify(await listed.json())).toContain("api-maker@example.test");

    const context = { params: Promise.resolve({ id: String(maker.id) }) };
    const updateRequest = new Request(`http://localhost/api/film-makers/${maker.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ makerCode: "HIJACK", companyName: "x", email: "x@example.test", language: "ko", printMethod: "gravure", procurementRoute: "K" }),
    });
    const deleteRequest = new Request(`http://localhost/api/film-makers/${maker.id}`, { method: "DELETE" });
    for (const actor of [null, sevenAdmin, customer]) {
      sessionUser.mockResolvedValue(actor);
      await expect(updateMaker(updateRequest, context)).resolves.toMatchObject({ status: actor ? 403 : 401 });
      await expect(deleteMaker(deleteRequest, context)).resolves.toMatchObject({ status: actor ? 403 : 401 });
    }
    await expect(listGet(request)).resolves.toMatchObject({ status: 403 });
  });

  it("restricts legacy reconciliation and explicit select/exempt actions to Kanei admins", async () => {
    const admin = { email: "reconcile-admin@kanei-trade.co.jp", role: "admin" };
    const sevenAdmin = { email: "seven@727.co.jp", role: "admin" };
    const customer = { email: "customer@example.test", role: "user" };
    const request = new Request("http://localhost/api/film-makers/legacy-reconciliation");
    const post = (body: Record<string, unknown>, actor = admin) => {
      sessionUser.mockResolvedValue(actor);
      return new Request("http://localhost/api/film-makers/legacy-reconciliation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    };
    const { GET, POST } = await import("@/app/api/film-makers/legacy-reconciliation/route");

    sessionUser.mockResolvedValue(null);
    await expect(GET(request)).resolves.toMatchObject({ status: 401 });
    for (const actor of [sevenAdmin, customer]) {
      sessionUser.mockResolvedValue(actor);
      await expect(GET(request)).resolves.toMatchObject({ status: 403 });
    }

    const db = await (await import("@/lib/db")).getSqlClient("quotations");
    const now = new Date().toISOString();
    await db.run("INSERT INTO quotations (status,payload_json) VALUES ('approved','{}')");
    const quotation = await db.get<{ id: number }>("SELECT id FROM quotations ORDER BY id DESC LIMIT 1");
    const { createFilmMaker } = await import("@/lib/film-maker-store");
    const maker = await createFilmMaker({
      makerCode: "API-RECONCILE-001",
      companyName: "API Exact Maker",
      email: "api-exact@example.test",
      language: "ko",
      printMethod: "gravure",
      procurementRoute: "K",
    }, admin.email);
    await db.run(`
      INSERT INTO film_orders (
        quotation_id,order_number,quotation_number,product_name,customer_name,printing_method,
        procurement_route,supplier_name,supplier_email,status,purchase_order_json,created_at,updated_at
      ) VALUES (?, 'F-202611-API-RECONCILE','legacy','API pouch','API customer','gravure','K',
                'API Exact Maker','api-exact@example.test','pending','{}',?,?)
    `, [quotation!.id, now, now]);
    const unresolved = await db.get<{ id: number }>(
      "SELECT id FROM film_orders WHERE order_number='F-202611-API-RECONCILE'",
    );
    const orderId = Number(unresolved!.id);

    sessionUser.mockResolvedValue(admin);
    const listed = await GET(request);
    expect(listed.status).toBe(200);
    const listPayload = await listed.json() as { orders: Array<{ orderId: number; suggestedMaker?: { makerId: number } }> };
    const suggested = listPayload.orders.find((order) => order.orderId === orderId);
    expect(suggested?.suggestedMaker?.makerId).toBe(maker.id);

    const forbiddenSelect = await POST(post({ action: "select", orderId, makerId: maker.id }, sevenAdmin));
    await expect(Promise.resolve(forbiddenSelect)).resolves.toMatchObject({ status: 403 });
    const selected = await POST(post({ action: "select", orderId, makerId: maker.id }));
    expect(selected.status).toBe(200);
    expect(((await selected.json()) as { orders: unknown[] }).orders).toHaveLength(0);
    expect(await db.get<{ supplier_resolution: string; film_maker_snapshot_json: string; supplier_email: string }>(
      "SELECT supplier_resolution,film_maker_snapshot_json,supplier_email FROM film_orders WHERE id=?", [orderId],
    )).toMatchObject({
      supplier_resolution: "master_selected",
      supplier_email: "api-exact@example.test",
    });
    expect(JSON.parse((await db.get<{ film_maker_snapshot_json: string }>(
      "SELECT film_maker_snapshot_json FROM film_orders WHERE id=?", [orderId],
    ))!.film_maker_snapshot_json)).toMatchObject({ email: "api-exact@example.test", selectedByEmail: admin.email });

    await db.run(`
      INSERT INTO film_orders (
        quotation_id,order_number,quotation_number,product_name,customer_name,printing_method,
        procurement_route,supplier_name,supplier_email,status,purchase_order_json,created_at,updated_at
      ) VALUES (?, 'F-202611-API-INTERNAL','legacy','Internal API pouch','API customer','gravure','K',
                'Package Lab','design@package-lab.com','pending','{}',?,?)
    `, [quotation!.id, now, now]);
    const internalRow = await db.get<{ id: number }>(
      "SELECT id FROM film_orders WHERE order_number='F-202611-API-INTERNAL'",
    );
    const internalId = Number(internalRow!.id);
    await expect(POST(post({
      action: "exempt", orderId: internalId, classification: "internal", reason: "",
    }))).resolves.toMatchObject({ status: 400 });
    await expect(POST(post({
      action: "exempt", orderId: internalId, classification: "ambiguous", reason: "stale classification",
    }))).resolves.toMatchObject({ status: 400 });
    const exempted = await POST(post({
      action: "exempt", orderId: internalId, classification: "internal", reason: "既存案件対象外",
    }));
    expect(exempted.status).toBe(200);
    expect(((await exempted.json()) as { orders: unknown[] }).orders).toHaveLength(0);
    expect(await db.get<{ supplier_resolution: string; supplier_name: string; supplier_email: string }>(
      "SELECT supplier_resolution,supplier_name,supplier_email FROM film_orders WHERE id=?", [internalId],
    )).toEqual({
      supplier_resolution: "legacy_exempt",
      supplier_name: "Package Lab",
      supplier_email: "design@package-lab.com",
    });
    expect(await db.get<{ type: string; detail: string }>(
      "SELECT type,detail FROM film_order_events WHERE order_id=? ORDER BY id DESC LIMIT 1", [internalId],
    )).toMatchObject({ type: "legacy_supplier_reconciliation", detail: expect.stringContaining("既存案件対象外") });
  });
});
