import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const sendMailMock = vi.fn(async (input: Record<string, unknown>) => ({
  to: String(input.to),
  recipientOverridden: false,
  subject: String(input.subject ?? ""),
  dryRun: true,
  messageId: "g012-message",
}));
vi.mock("@/lib/mailer", () => ({ sendMail: (input: Parameters<typeof import("@/lib/mailer").sendMail>[0]) => sendMailMock(input as unknown as Record<string, unknown>) }));

const databaseDirectory = await mkdtemp(join(tmpdir(), "g012-review-fixes-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.POUCH_CUSTOMER_DB = join(databaseDirectory, "customers.db");
process.env.MAIL_DRY_RUN = "true";
delete process.env.MAIL_RECIPIENT_OVERRIDE;

const strictSettings = {
  version: 1,
  testMode: { enabled: false, recipient: "" },
  sender: { name: "Package Lab", email: "workflow-sender@example.test" },
  globalCc: [] as string[],
  recipients: {
    design: "",
    seven: "",
    kaneiApprovals: "",
    supplierKorean: "",
    supplierJapanese: "",
  },
  templates: {},
};

function snapshotJson(companyName = "G012 Maker"): string {
  return JSON.stringify({
    id: 901,
    makerCode: "G012-KOR-001",
    companyName,
    contactName: "G012 Contact",
    email: "g012-maker@example.test",
    language: "ko",
    isActive: true,
    procurementRoute: "K",
    printMethod: "gravure",
    selectedAt: "2026-01-01T00:00:00.000Z",
    selectedByEmail: "kanei@kanei-trade.co.jp",
  });
}

async function insertOrder(orderNumber: string): Promise<number> {
  const db = await (await import("@/lib/film-orders")).getDatabaseForFilmMakerStore();
  await db.run("INSERT INTO quotations (status,payload_json) VALUES ('approved',?)", [
    JSON.stringify({ customerCode: "G012-CUSTOMER", customerEmail: "g012-customer@example.test" }),
  ]);
  const quotation = await db.get<{ id: number }>("SELECT id FROM quotations ORDER BY id DESC LIMIT 1");
  const now = "2026-01-01T00:00:00.000Z";
  await db.run(`
    INSERT INTO film_orders (
      quotation_id,order_number,quotation_number,product_name,customer_name,printing_method,procurement_route,
      film_composition,order_length_m,web_width_mm,pouch_quantity,supplier_name,supplier_email,seven_contact_email,
      film_maker_id,film_maker_snapshot_json,supplier_resolution,status,customer_design_status,ship_to_status,
      purchase_order_json,ordered_at,created_at,updated_at
    ) VALUES (?, ?, ?, 'G012 pouch','G012 customer','gravure','K','PET','300','400','1000',
              'G012 Maker','g012-maker@example.test','seven@727.co.jp',901,?,
              'master_selected','ordered','pending','confirmed','{}',?,?,?)
  `, [quotation!.id, orderNumber, `Q-${orderNumber}`, snapshotJson(), now, now, now]);
  const order = await db.get<{ id: number }>("SELECT id FROM film_orders WHERE order_number=?", [orderNumber]);
  return Number(order!.id);
}

async function assertNoConfirmationMutation(orderId: number, dispatchGroupId: string, before: Record<string, unknown>, stagedTokenCount: number) {
  const db = await (await import("@/lib/film-orders")).getDatabaseForFilmMakerStore();
  const after = await db.get<Record<string, unknown>>(
    `SELECT status,customer_design_status,customer_design_requested_at,updated_at,updated_by_email,
            film_maker_id,film_maker_snapshot_json,supplier_resolution
     FROM film_orders WHERE id=?`, [orderId],
  );
  expect(after).toEqual(before);
  const files = await db.all<{ id: number }>("SELECT id FROM film_order_files WHERE order_id=?", [orderId]);
  expect(files).toHaveLength(0);
  const tokens = await db.all<{ token_state: string }>(
    "SELECT token_state FROM film_order_external_tokens WHERE film_order_id=? AND dispatch_group_id=?",
    [orderId, dispatchGroupId],
  );
  expect(tokens).toHaveLength(stagedTokenCount);
  expect(tokens.every((token) => token.token_state === "staged")).toBe(true);
  const envelopes = await db.all<{ envelope_status: string }>(
    "SELECT envelope_status FROM film_order_mail_outbox WHERE order_id=? AND dispatch_group_id=?",
    [orderId, dispatchGroupId],
  );
  expect(envelopes).toHaveLength(3);
  expect(envelopes.every((envelope) => envelope.envelope_status === "draft")).toBe(true);
  const attempts = await db.all<{ id: number }>(`
    SELECT a.id FROM film_order_mail_attempts a
    JOIN film_order_mail_outbox o ON o.id=a.outbox_id
    WHERE o.order_id=? AND o.dispatch_group_id=?
  `, [orderId, dispatchGroupId]);
  expect(attempts).toHaveLength(0);
  const audits = await db.all<{ id: number }>(
    "SELECT id FROM film_order_events WHERE order_id=? AND type='mail_audit' AND detail=?",
    [orderId, `dispatch intent ${dispatchGroupId}`],
  );
  expect(audits).toHaveLength(0);
}

beforeAll(async () => {
  const { getSqlClient } = await import("@/lib/db");
  const raw = await getSqlClient("quotations");
  await raw.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'user'
    );
    CREATE TABLE IF NOT EXISTS mail_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      settings_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS quotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL DEFAULT 'approved',
      created_by INTEGER,
      payload_json TEXT NOT NULL DEFAULT '{}'
    );
  `);
  await (await import("@/lib/film-orders")).getDatabaseForFilmMakerStore();
  await raw.run(`
    INSERT INTO film_makers (
      id,maker_code,company_name,contact_name,email,language,print_method,procurement_route,is_active,
      created_at,updated_at
    ) VALUES (901,'G012-KOR-001','G012 Maker','G012 Contact','g012-maker@example.test','ko','gravure','K',1,
      '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')
  `);
  await raw.run("INSERT INTO mail_settings (id,settings_json,updated_at,updated_by) VALUES (1,?,?,?)", [
    JSON.stringify(strictSettings), "2026-01-01T00:00:00.000Z", "seed",
  ]);
});

afterAll(async () => {
  const { resetSqlClientForTest } = await import("@/lib/db");
  await resetSqlClientForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});

describe("G012 final review fixes", () => {
  it("uses the selected maker snapshot, not route inference or legacy supplier fallback, in the legacy PO preview", async () => {
    const { buildSupplierPurchaseOrderPreview, getFilmOrder } = await import("@/lib/film-orders");
    const db = await (await import("@/lib/film-orders")).getDatabaseForFilmMakerStore();
    const orderId = await insertOrder("G012-PO-PREVIEW");
    const jaSnapshot = JSON.parse(snapshotJson("Japanese G012 Maker"));
    jaSnapshot.language = "ja";
    jaSnapshot.email = "japanese-g012-maker@example.test";
    await db.run(
      "UPDATE film_orders SET film_maker_snapshot_json=?, supplier_name='Legacy G012 Supplier', supplier_email='legacy-g012@example.test' WHERE id=?",
      [JSON.stringify(jaSnapshot), orderId],
    );
    const order = await getFilmOrder(orderId);
    const preview = await buildSupplierPurchaseOrderPreview(order!, "http://localhost:3000", "");
    expect(preview.to).toBe("japanese-g012-maker@example.test");
    expect(preview.subject).toContain("フィルム発注");
    expect(preview.subject).not.toContain("필름 발주");
    expect(preview.body).not.toContain("Legacy G012 Supplier");
    expect(preview.body).not.toContain("legacy-g012@example.test");
  });

  it("versions lifecycle-inserted AI and PDF files consistently from prior file versions", async () => {
    const { prepareFilmOrderMail, confirmFilmOrderMail } = await import("@/lib/film-order-mail-lifecycle");
    const db = await (await import("@/lib/film-orders")).getDatabaseForFilmMakerStore();
    const orderId = await insertOrder("G012-FILE-VERSIONS");
    const now = "2026-01-01T00:00:00.000Z";
    await db.run("UPDATE film_orders SET customer_design_status='not_required' WHERE id=?", [orderId]);
    for (const [category, fileName, version] of [
      ["proof", "old-proof.ai", 4],
      ["proof", "old-proof.pdf", 2],
    ] as const) {
      await db.run(
        "INSERT INTO film_order_files (order_id,category,file_name,url,version,uploaded_by_email,created_at) VALUES (?,?,?,?,?,?,?)",
        [orderId, category, fileName, `https://example.test/${fileName}`, version, "legacy", now],
      );
    }
    const receiving = await prepareFilmOrderMail({
      orderId,
      action: "register-receiving",
      actorEmail: "seven@727.co.jp",
      origin: "http://localhost:3000",
      aiFileName: "new-receiving.ai",
      aiFileUrl: "https://example.test/new-receiving.ai",
      pdfFileName: "new-receiving.pdf",
      pdfFileUrl: "https://example.test/new-receiving.pdf",
    });
    await confirmFilmOrderMail(receiving, receiving.envelopes.map((envelope) => envelope.contentHash));
    await db.run("UPDATE film_order_files SET version=5 WHERE order_id=? AND category='receiving'", [orderId]);
    let files = await db.all<{ category: string; file_name: string; version: number }>(
      "SELECT category,file_name,version FROM film_order_files WHERE order_id=? AND category='receiving' ORDER BY id",
      [orderId],
    );
    expect(files.at(-2)).toMatchObject({ file_name: "new-receiving.ai", version: 5 });
    expect(files.at(-1)).toMatchObject({ file_name: "new-receiving.pdf", version: 5 });
    const proof = await prepareFilmOrderMail({
      orderId,
      action: "register-proof",
      actorEmail: "kanei@kanei-trade.co.jp",
      origin: "http://localhost:3000",
      proofFileName: "new-proof.ai",
      proofFileUrl: "https://example.test/new-proof.ai",
      proofPdfFileName: "new-proof.pdf",
      proofPdfFileUrl: "https://example.test/new-proof.pdf",
    });
    await confirmFilmOrderMail(proof, proof.envelopes.map((envelope) => envelope.contentHash));
    files = await db.all<{ category: string; file_name: string; version: number }>(
      "SELECT category,file_name,version FROM film_order_files WHERE order_id=? AND category='proof' ORDER BY id",
      [orderId],
    );
    expect(files.at(-2)).toMatchObject({ file_name: "new-proof.ai", version: 5 });
    expect(files.at(-1)).toMatchObject({ file_name: "new-proof.pdf", version: 5 });
  });

  it("rejects confirmation after the persisted maker snapshot changes and rolls back atomically", async () => {
    const { prepareFilmOrderMail, confirmFilmOrderMail } = await import("@/lib/film-order-mail-lifecycle");
    const db = await (await import("@/lib/film-orders")).getDatabaseForFilmMakerStore();
    const orderId = await insertOrder("G012-SNAPSHOT");
    const command = {
      orderId,
      action: "request-customer-design-upload" as const,
      actorEmail: "kanei@kanei-trade.co.jp",
      origin: "http://localhost:3000" as const,
    };
    const preview = await prepareFilmOrderMail(command);
    let before = await db.get<Record<string, unknown>>(
      `SELECT status,customer_design_status,customer_design_requested_at,updated_at,updated_by_email,
              film_maker_id,film_maker_snapshot_json,supplier_resolution
       FROM film_orders WHERE id=?`, [orderId],
    ) as Record<string, unknown>;
    await db.run("UPDATE film_orders SET film_maker_snapshot_json=? WHERE id=?", [snapshotJson("Changed G012 Maker"), orderId]);
    before = await db.get<Record<string, unknown>>(
      `SELECT status,customer_design_status,customer_design_requested_at,updated_at,updated_by_email,
              film_maker_id,film_maker_snapshot_json,supplier_resolution
       FROM film_orders WHERE id=?`, [orderId],
    ) as Record<string, unknown>;
    sendMailMock.mockClear();
    await expect(confirmFilmOrderMail(preview, preview.envelopes.map((envelope) => envelope.contentHash)))
      .rejects.toThrow("film_order_mail_preview_stale");
    expect(sendMailMock).not.toHaveBeenCalled();
    await assertNoConfirmationMutation(orderId, preview.dispatchGroupId, before, 1);
  });

  it("rejects confirmation after effective template settings change and rolls back atomically", async () => {
    const { prepareFilmOrderMail, confirmFilmOrderMail } = await import("@/lib/film-order-mail-lifecycle");
    const db = await (await import("@/lib/film-orders")).getDatabaseForFilmMakerStore();
    const orderId = await insertOrder("G012-TEMPLATE");
    const command = {
      orderId,
      action: "request-customer-design-upload" as const,
      actorEmail: "kanei@kanei-trade.co.jp",
      origin: "http://localhost:3000" as const,
    };
    const preview = await prepareFilmOrderMail(command);
    const before = await db.get<Record<string, unknown>>(
      `SELECT status,customer_design_status,customer_design_requested_at,updated_at,updated_by_email,
              film_maker_id,film_maker_snapshot_json,supplier_resolution
       FROM film_orders WHERE id=?`, [orderId],
    ) as Record<string, unknown>;
    const settings = JSON.parse((await db.get<{ settings_json: string }>(
      "SELECT settings_json FROM mail_settings WHERE id=1",
    ))!.settings_json);
    settings.templates.customer_design_upload_supplier = {
      subject: "변경된 G012 발주 템플릿 {orderNumber}",
      body: "변경된 본문\n{orderDetails}",
    };
    await db.run("UPDATE mail_settings SET settings_json=? WHERE id=1", [JSON.stringify(settings)]);
    sendMailMock.mockClear();
    await expect(confirmFilmOrderMail(preview, preview.envelopes.map((envelope) => envelope.contentHash)))
      .rejects.toThrow("film_order_mail_preview_stale");
    expect(sendMailMock).not.toHaveBeenCalled();
    await assertNoConfirmationMutation(orderId, preview.dispatchGroupId, before, 1);
  });

  it("rejects confirmation after effective SMTP sender changes and rolls back atomically", async () => {
    const { prepareFilmOrderMail, confirmFilmOrderMail } = await import("@/lib/film-order-mail-lifecycle");
    const db = await (await import("@/lib/film-orders")).getDatabaseForFilmMakerStore();
    const orderId = await insertOrder("G012-SENDER");
    const command = {
      orderId,
      action: "request-customer-design-upload" as const,
      actorEmail: "kanei@kanei-trade.co.jp",
      origin: "http://localhost:3000" as const,
    };
    const preview = await prepareFilmOrderMail(command);
    const before = await db.get<Record<string, unknown>>(
      `SELECT status,customer_design_status,customer_design_requested_at,updated_at,updated_by_email,
              film_maker_id,film_maker_snapshot_json,supplier_resolution
       FROM film_orders WHERE id=?`, [orderId],
    ) as Record<string, unknown>;
    const settings = JSON.parse((await db.get<{ settings_json: string }>(
      "SELECT settings_json FROM mail_settings WHERE id=1",
    ))!.settings_json);
    settings.sender.email = "changed-sender@example.test";
    await db.run("UPDATE mail_settings SET settings_json=? WHERE id=1", [JSON.stringify(settings)]);
    sendMailMock.mockClear();
    await expect(confirmFilmOrderMail(preview, preview.envelopes.map((envelope) => envelope.contentHash)))
      .rejects.toThrow("film_order_mail_preview_stale");
    expect(sendMailMock).not.toHaveBeenCalled();
    await assertNoConfirmationMutation(orderId, preview.dispatchGroupId, before, 1);
  });

  it("serializes concurrent SQLite maker selections and rejects the loser without an audit event", async () => {
    const { selectFilmMakerForOrder } = await import("@/lib/film-maker-store");
    const orderId = await (await import("@/lib/film-orders")).getDatabaseForFilmMakerStore().then(async (db) => {
      await db.run("INSERT INTO quotations (status,payload_json) VALUES ('approved','{}')");
      const quotation = await db.get<{ id: number }>("SELECT id FROM quotations ORDER BY id DESC LIMIT 1");
      const now = "2026-01-01T00:00:00.000Z";
      await db.run(`
        INSERT INTO film_orders (
          quotation_id,order_number,quotation_number,printing_method,procurement_route,status,
          supplier_resolution,purchase_order_json,created_at,updated_at
        ) VALUES (?, 'G012-CONCURRENT', 'Q-G012-CONCURRENT','gravure','K','ordered','legacy_unresolved','{}',?,?)
      `, [quotation!.id, now, now]);
      const order = await db.get<{ id: number }>("SELECT id FROM film_orders WHERE order_number='G012-CONCURRENT'");
      return Number(order!.id);
    });
    const results = await Promise.allSettled([
      selectFilmMakerForOrder(orderId, 901, "first@kanei-trade.co.jp"),
      selectFilmMakerForOrder(orderId, 901, "second@kanei-trade.co.jp"),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (rejected[0]?.status === "rejected") expect((rejected[0].reason as Error).message).toBe("film_maker_selection_conflict");
    const winnerActor = fulfilled[0]?.status === "fulfilled" ? fulfilled[0].value.snapshot.selectedByEmail : "";
    const db = await (await import("@/lib/film-orders")).getDatabaseForFilmMakerStore();
    const row = await db.get<{ film_maker_id: number; updated_by_email: string }>(
      "SELECT film_maker_id,updated_by_email FROM film_orders WHERE id=?", [orderId],
    );
    expect(row).toMatchObject({ film_maker_id: 901, updated_by_email: winnerActor });
    const audits = await db.all<{ actor_email: string }>(
      "SELECT actor_email FROM film_order_events WHERE order_id=? AND type='film_maker'", [orderId],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.actor_email).toBe(winnerActor);
  });
});
