import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const databaseDirectory = await mkdtemp(join(tmpdir(), "neon-database-guard-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.db");
process.env.VERCEL = "1";

const { assertNeonDatabase, getSqlClient } = await import("@/lib/db");

function withDatabaseUrl<T>(value: string | undefined, callback: () => Promise<T>): Promise<T> {
  const previous = process.env.DATABASE_URL;
  if (value === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = value;
  return callback().finally(() => {
    if (previous === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previous;
  });
}

afterEach(async () => {
  await import("@/lib/db").then(({ resetSqlClientForTest }) => resetSqlClientForTest());
});

describe("Neon database guard", () => {
  it("requires a Neon PostgreSQL URL on hosted runtimes", async () => {
    await expect(withDatabaseUrl(undefined, () => getSqlClient("quotations")))
      .rejects.toThrow("neon_database_url_required");
    expect(() => assertNeonDatabase("postgres://user:pass@aws-0.ap-northeast-1.aws.neon.tech/neondb")).not.toThrow();
  });

  it("rejects hosted runtime connections that are not Neon", async () => {
    await expect(withDatabaseUrl("postgres://user:pass@db.example.com/app", () => getSqlClient("quotations")))
      .rejects.toThrow("neon_database_required");
  });
});
