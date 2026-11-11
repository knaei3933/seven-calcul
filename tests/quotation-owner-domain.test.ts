import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { quotationOwnerDomainOf, type QuotationRecordInput } from "@/lib/quotation-shared";

const databaseDirectory = await mkdtemp(join(tmpdir(), "quotation-owner-migration-test-"));
const databasePath = join(databaseDirectory, "quotations.db");
process.env.POUCH_QUOTATION_DB = databasePath;
process.env.ADMIN_EMAIL = "fallback-admin@kanei-trade.co.jp";
process.env.ADMIN_PASSWORD = "legacy-admin-password";
process.env.ADMIN_NAME = "Legacy Admin";

const legacyPdf = Buffer.from("%PDF-legacy-owner-backfill", "utf8");
const legacyPdfSha256 = createHash("sha256").update(legacyPdf).digest("hex");
const kaneiCreatedAt = "2025-11-01T00:00:00.000Z";
const sevenCreatedAt = "2025-11-02T00:00:00.000Z";
const unresolvedCreatedAt = "2025-11-03T00:00:00.000Z";

const preMigration = new DatabaseSync(databasePath);
preMigration.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','user')),
    is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0,1)),
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE quotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quotation_number TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK(status IN ('draft','sent','approved','rejected','expired')),
    issue_date TEXT NOT NULL,
    valid_until TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    customer_contact TEXT NOT NULL,
    product_name TEXT NOT NULL,
    size_summary TEXT NOT NULL,
    quantity TEXT NOT NULL,
    filling_cost_per_piece TEXT NOT NULL,
    film_cost_per_piece TEXT NOT NULL,
    film_meter_price TEXT NOT NULL,
    film_order_length_m TEXT NOT NULL,
    target_margin TEXT NOT NULL,
    tax_rate_percent TEXT NOT NULL,
    price_per_piece TEXT NOT NULL,
    subtotal TEXT NOT NULL,
    tax TEXT NOT NULL,
    grand_total TEXT NOT NULL,
    delivery_date TEXT NOT NULL,
    payment_terms TEXT NOT NULL,
    notes TEXT NOT NULL,
    calculation_version TEXT NOT NULL,
    result_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    pdf_data BLOB,
    pdf_file_name TEXT,
    pdf_uploaded_at TEXT,
    pdf_sha256 TEXT,
    internal_approved_at TEXT,
    internal_approved_by INTEGER REFERENCES users(id),
    customer_approved_at TEXT,
    customer_approved_by INTEGER REFERENCES users(id),
    customer_approval_ip_hash TEXT,
    customer_approval_user_agent TEXT,
    created_by INTEGER REFERENCES users(id),
    updated_by INTEGER REFERENCES users(id)
  );
  CREATE TABLE quotation_checklists (
    quotation_id INTEGER NOT NULL,
    audience TEXT NOT NULL CHECK(audience IN ('CUSTOMER','INTERNAL_QA')),
    checklist_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('in_progress','completed')),
    snapshot_json TEXT NOT NULL,
    items_json TEXT NOT NULL,
    checked_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (quotation_id, audience),
    FOREIGN KEY (quotation_id) REFERENCES quotations(id)
  );
  INSERT INTO users (id,email,name,role,is_active,password_hash,created_at,updated_at) VALUES
    (1,'fallback-admin@kanei-trade.co.jp','Kanei Fallback Admin','admin',1,'pre-existing','2025-01-01','2025-01-01'),
    (2,'kanei@kanei-trade.co.jp','Kanei Creator','user',1,'pre-existing','2025-01-01','2025-01-01'),
    (3,'seven@727.co.jp','Seven Creator','user',1,'pre-existing','2025-01-01','2025-01-01'),
    (4,'contractor@example.test','Unclassified Creator','user',1,'pre-existing','2025-01-01','2025-01-01');
`);
  const insertLegacyQuotation = preMigration.prepare(`
    INSERT INTO quotations (
      id,quotation_number,status,issue_date,valid_until,customer_name,customer_contact,product_name,size_summary,
      quantity,filling_cost_per_piece,film_cost_per_piece,film_meter_price,film_order_length_m,target_margin,
      tax_rate_percent,price_per_piece,subtotal,tax,grand_total,delivery_date,payment_terms,notes,
      calculation_version,result_hash,payload_json,created_at,updated_at,created_by,updated_by
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  insertLegacyQuotation.run(
    101,'KT-LEGACY-001','sent','2025-11-01','2025-12-01','Kanei Legacy','Contact','Pouch','50x60',
    '1000','4','1','200','500','0.4','10','10','10000','1000','11000','','','legacy','v1','hash','{}',
    kaneiCreatedAt,kaneiCreatedAt,2,2,
  );
  insertLegacyQuotation.run(
    202,'S7-LEGACY-002','draft','2025-11-02','2025-12-02','Seven Legacy','Contact','Pouch','50x60',
    '2000','4','1','200','500','0.4','10','10','20000','2000','22000','','','legacy','v1','hash','{}',
    sevenCreatedAt,sevenCreatedAt,3,3,
  );
  insertLegacyQuotation.run(
    303,'UN-LEGACY-003','approved','2025-11-03','2025-12-03','Unknown Legacy','Contact','Pouch','50x60',
    '3000','4','1','200','500','0.4','10','10','30000','3000','33000','','','legacy','v1','hash','{}',
    unresolvedCreatedAt,unresolvedCreatedAt,4,4,
  );
  insertLegacyQuotation.run(
    404,'UN-LEGACY-NO-CREATOR','draft','2025-11-04','2025-12-04','No Creator Legacy','Contact','Pouch','50x60',
    '4000','4','1','200','500','0.4','10','10','40000','4000','44000','','','legacy','v1','hash','{}',
    '2025-11-04T00:00:00.000Z','2025-11-04T00:00:00.000Z',null,null,
  );
  const updateLegacyWorkflow = preMigration.prepare(`
    UPDATE quotations SET
      pdf_data=?,pdf_file_name=?,pdf_uploaded_at=?,pdf_sha256=?,
      internal_approved_at=?,internal_approved_by=?,customer_approved_at=?,customer_approved_by=?,
      customer_approval_ip_hash=?,customer_approval_user_agent=?
    WHERE id=?
  `);
  updateLegacyWorkflow.run(
    legacyPdf,'legacy.pdf','2025-11-01T01:00:00.000Z',legacyPdfSha256,
    '2025-11-05T00:00:00.000Z',2,null,null,'ip-hash','legacy-agent',101,
  );
  updateLegacyWorkflow.run(
    legacyPdf,'legacy-seven.pdf','2025-11-02T01:00:00.000Z',legacyPdfSha256,
    null,null,null,null,null,null,202,
  );
  updateLegacyWorkflow.run(
    legacyPdf,'legacy-unclassified.pdf','2025-11-03T01:00:00.000Z',legacyPdfSha256,
    '2025-11-06T00:00:00.000Z',4,'2025-11-07T00:00:00.000Z',4,'unknown-ip','unknown-agent',303,
  );
  preMigration.exec(`
    INSERT INTO quotation_checklists VALUES
      (101,'INTERNAL_QA','legacy-v1','completed','{}','[]','Legacy QA','2025-11-01T02:00:00.000Z','2025-11-01T02:00:00.000Z'),
      (202,'CUSTOMER','legacy-v1','in_progress','{}','[]','Seven Legacy','2025-11-02T02:00:00.000Z','2025-11-02T02:00:00.000Z');
  `);
preMigration.close();

const {
  getUserByEmail,
} = await import("@/lib/auth-store");

const {
  getDatabaseForTest,
  listQuotations,
  rerunQuotationOwnerDomainMigrationForTest,
  saveIssuedQuotation,
  saveQuotation,
  UnresolvedQuotationOwnerError,
  updateQuotationStatus,
} = await import("@/lib/quotation-store");

const kaneiCreator = await getUserByEmail("kanei@kanei-trade.co.jp");
const sevenCreator = await getUserByEmail("seven@727.co.jp");
const unclassifiedCreator = await getUserByEmail("contractor@example.test");
const admin = await getUserByEmail("fallback-admin@kanei-trade.co.jp");

function issuedInput(quotationNumber: string): QuotationRecordInput {
  return {
    quotationNumber,
    status: "sent",
    issueDate: "2026-11-04",
    validUntil: "2026-12-04",
    customerName: "Issued Owner Test",
    customerContact: "担当",
    productName: "Pouch",
    sizeSummary: "50x60",
    quantity: "1000",
    fillingCostPerPiece: "4",
    filmCostPerPiece: "1",
    filmMeterPrice: "200",
    filmOrderLengthM: "500",
    targetMargin: "0.4",
    taxRatePercent: "10",
    pricePerPiece: "10",
    subtotal: "10000",
    tax: "1000",
    grandTotal: "11000",
    deliveryDate: "",
    paymentTerms: "",
    notes: "",
    calculationVersion: "owner-test",
    resultHash: "owner-test-hash",
    payload: {},
  };
}

afterAll(async () => {
  const { closeDatabaseForTest } = await import("@/lib/auth-store");
  await closeDatabaseForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
});

describe("quotation owner derivation and legacy backfill", () => {
  it("classifies only the two authenticated creator domains", () => {
    expect(quotationOwnerDomainOf("KANEI@KANEI-TRADE.CO.JP")).toBe("kanei");
    expect(quotationOwnerDomainOf("seven@727.co.jp")).toBe("seven");
    expect(quotationOwnerDomainOf("other@example.com")).toBe("unresolved");
    expect(quotationOwnerDomainOf("")).toBe("unresolved");
    expect(quotationOwnerDomainOf(null)).toBe("unresolved");
  });

  it("backfills legacy rows by creator while preserving durable quotation data", async () => {
    const records = await listQuotations({ limit: 500 });
    const owners = new Map(records.map((record) => [record.id, record]));
    expect(owners.get(101)?.ownerDomain).toBe("kanei");
    expect(owners.get(202)?.ownerDomain).toBe("seven");
    expect(owners.get(303)?.ownerDomain).toBe("unresolved");
    expect(owners.get(404)?.ownerDomain).toBe("unresolved");

    const db = await getDatabaseForTest();
    const rows = await db.all<{
      id: number;
      quotation_number: string;
      created_at: string;
      pdf_data: Uint8Array;
      pdf_file_name: string | null;
      pdf_sha256: string | null;
      internal_approved_at: string | null;
      internal_approved_by: number | null;
      customer_approval_ip_hash: string | null;
      customer_approval_user_agent: string | null;
      checklist_count: number;
    }>(`
      SELECT q.id,q.quotation_number,q.created_at,q.pdf_data,q.pdf_file_name,q.pdf_sha256,
             q.internal_approved_at,q.internal_approved_by,q.customer_approval_ip_hash,
             q.customer_approval_user_agent,
             (SELECT COUNT(*) FROM quotation_checklists c WHERE c.quotation_id=q.id) AS checklist_count
      FROM quotations q ORDER BY q.id
    `);
    const [kanei, seven, unresolved] = rows.slice(0, 3);
    expect(kanei).toMatchObject({
      id: 101,
      quotation_number: "KT-LEGACY-001",
      created_at: kaneiCreatedAt,
      pdf_file_name: "legacy.pdf",
      pdf_sha256: legacyPdfSha256,
      internal_approved_at: "2025-11-05T00:00:00.000Z",
      internal_approved_by: 2,
      customer_approval_ip_hash: "ip-hash",
      customer_approval_user_agent: "legacy-agent",
      checklist_count: 1,
    });
    expect(Buffer.from(kanei!.pdf_data).equals(legacyPdf)).toBe(true);
    expect(seven).toMatchObject({
      id: 202,
      quotation_number: "S7-LEGACY-002",
      created_at: sevenCreatedAt,
      pdf_file_name: "legacy-seven.pdf",
      checklist_count: 1,
    });
    expect(unresolved).toMatchObject({
      id: 303,
      quotation_number: "UN-LEGACY-003",
      created_at: unresolvedCreatedAt,
      internal_approved_at: "2025-11-06T00:00:00.000Z",
      customer_approval_ip_hash: "unknown-ip",
    });
  });

  it("keeps repeated owner backfill idempotent", async () => {
    const db = await getDatabaseForTest();
    const before = await db.all("SELECT id,owner_domain,created_at,updated_at FROM quotations ORDER BY id");
    await rerunQuotationOwnerDomainMigrationForTest();
    const after = await db.all("SELECT id,owner_domain,created_at,updated_at FROM quotations ORDER BY id");
    expect(after).toEqual(before);
  });

  it("persists Seven ownership at issuance and normalizes preparer prefixes", async () => {
    const pdf = Buffer.from("%PDF-owner-issuance", "utf8");
    const preparedByKanei = await saveIssuedQuotation(
      issuedInput("KT-OWNER-NEW-001"), kaneiCreator!.id, "user", pdf, "kanei.pdf", null,
    );
    const sevenIssued = await saveIssuedQuotation(
      issuedInput("S7-OWNER-NEW-002"), sevenCreator!.id, "user", pdf, "seven.pdf", null,
    );
    expect(preparedByKanei.created).toBe(true);
    expect(preparedByKanei.record.ownerDomain).toBe("seven");
    expect(preparedByKanei.record.quotationNumber).toMatch(/^S7-/);
    expect(sevenIssued.record.ownerDomain).toBe("seven");
    const db = await getDatabaseForTest();
    const unresolvedRows = await db.all<{ quotation_number: string }>(
      "SELECT quotation_number FROM quotations WHERE quotation_number LIKE 'UN-OWNER-NEW-%'",
    );
    expect(unresolvedRows).toEqual([]);
    const records = await listQuotations({ q: "OWNER-NEW" });
    expect(records.map((record) => record.ownerDomain)).toEqual(["seven"]);
  });

  it("keeps owner stable when a later admin updates the record", async () => {
    await updateQuotationStatus(101, "approved", admin!.id);
    await saveQuotation({ ...issuedInput("KT-LEGACY-001"), status: "approved" }, admin!.id, "admin");
    const record = (await listQuotations({ q: "KT-LEGACY-001" })).at(0);
    expect(record?.ownerDomain).toBe("kanei");
    expect(record?.createdBy.email).toBe("kanei@kanei-trade.co.jp");
  });
});

