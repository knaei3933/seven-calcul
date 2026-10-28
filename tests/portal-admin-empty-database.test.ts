import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseDirectory = await mkdtemp(join(tmpdir(), "portal-admin-empty-"));
const previous = {
  databaseUrl: process.env.DATABASE_URL,
  postgresUrl: process.env.POSTGRES_URL,
};

delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.sqlite");
process.env.POUCH_CUSTOMER_DB = join(databaseDirectory, "customers.sqlite");

const { listAdminPortalQuotes } = await import("@/lib/portal/admin-quote-service");

afterAll(async () => {
  const { resetSqlClientForTest } = await import("@/lib/db");
  const { resetPortalQuoteStoreForTest } = await import("@/lib/portal/quote-calculation-store");
  await resetSqlClientForTest();
  await resetPortalQuoteStoreForTest();
  await rm(databaseDirectory, { recursive: true, force: true });
  if (previous.databaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previous.databaseUrl;
  if (previous.postgresUrl === undefined) delete process.env.POSTGRES_URL;
  else process.env.POSTGRES_URL = previous.postgresUrl;
});

describe("admin portal quotes on a fresh database", () => {
  it("initializes the production quote mapping schema and returns an empty first page", async () => {
    await expect(listAdminPortalQuotes({ page: 1, limit: 20 })).resolves.toEqual({
      quotes: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 1, hasNext: false, hasPrevious: false },
    });
    const db = await (await import("@/lib/db")).getSqlClient("quotations");
    const table = await db.get<{ name: string }>(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'portal_quote_mappings'
    `);
    expect(table?.name).toBe("portal_quote_mappings");
  });
});
