import { describe, expect, it } from "vitest";
import { translateSqlToPostgres } from "@/lib/db/sql-translation";

describe("SQLite to PostgreSQL SQL translation", () => {
  it("converts positional placeholders in order", () => {
    expect(translateSqlToPostgres("SELECT * FROM users WHERE id = ? AND role = ?"))
      .toBe("SELECT * FROM users WHERE id = $1 AND role = $2");
  });

  it("converts LIKE to ILIKE to preserve case-insensitive searches", () => {
    expect(translateSqlToPostgres("SELECT * FROM customers WHERE customer_name LIKE ?"))
      .toBe("SELECT * FROM customers WHERE customer_name ILIKE $1");
  });

  it("keeps string literals untouched", () => {
    expect(translateSqlToPostgres("SELECT 'LIKE ?' AS literal WHERE id = ?"))
      .toBe("SELECT 'LIKE ?' AS literal WHERE id = $1");
  });

  it("keeps quoted identifiers and escaped quotes untouched", () => {
    expect(translateSqlToPostgres(`SELECT "like?" AS "id" WHERE note = 'it''s ?'`))
      .toBe(`SELECT "like?" AS "id" WHERE note = 'it''s ?'`);
  });

  it("keeps comments untouched", () => {
    expect(translateSqlToPostgres("SELECT 1 -- LIKE ?\n/* LIKE ? */ WHERE id = ?"))
      .toBe("SELECT 1 -- LIKE ?\n/* LIKE ? */ WHERE id = $1");
  });

  it("keeps dollar-quoted strings untouched", () => {
    expect(translateSqlToPostgres("SELECT $doc$LIKE ?$doc$ WHERE id = ?"))
      .toBe("SELECT $doc$LIKE ?$doc$ WHERE id = $1");
  });

  it("does not rename columns that contain like as a substring", () => {
    expect(translateSqlToPostgres("SELECT likely_name FROM t WHERE likely_name LIKE ?"))
      .toBe("SELECT likely_name FROM t WHERE likely_name ILIKE $1");
  });
});
