import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseDirectory = await mkdtemp(join(tmpdir(), "customer-store-test-"));
process.env.POUCH_CUSTOMER_DB = join(databaseDirectory, "customers.db");

const { deleteCustomer, getCustomer, listCustomers, recordCustomerSelection, saveCustomer, validateCustomerInput } = await import("@/lib/customer-store");

afterAll(async () => {
  await rm(databaseDirectory, { recursive: true, force: true });
});

describe("customer master validation", () => {
  it("trims fields and accepts a well-formed customer", () => {
    const input = validateCustomerInput({
      customerCode: "  C-001  ",
      customerName: " 검증고객주식회사 ",
      customerPostalCode: " 100-0001 ",
      customerAddress: " 도쿄도 ",
      customerContact: " 담당자 ",
      customerTelephone: " 03-0000-0000 ",
      customerEmail: " Order@Example.Co.jp ",
    });
    expect(input).toEqual({
      customerCode: "C-001",
      customerName: "검증고객주식회사",
      customerPostalCode: "100-0001",
      customerAddress: "도쿄도",
      customerContact: "담당자",
      customerTelephone: "03-0000-0000",
      customerEmail: "Order@Example.Co.jp",
    });
  });

  it("rejects missing identifiers, oversized fields, and malformed emails", () => {
    expect(validateCustomerInput({ customerCode: "C-002" })).toBeNull();
    expect(validateCustomerInput({ customerName: "이름만" })).toBeNull();
    expect(validateCustomerInput({ customerCode: "C".repeat(65), customerName: "이름" })).toBeNull();
    expect(validateCustomerInput({ customerCode: "C-003", customerName: "이름", customerEmail: "not-an-email" })).toBeNull();
    expect(validateCustomerInput({ customerCode: "C-003", customerName: "이름", customerAddress: "a".repeat(501) })).toBeNull();
    expect(validateCustomerInput(null)).toBeNull();
    expect(validateCustomerInput("text")).toBeNull();
  });
});

describe("customer master persistence and search", () => {
  beforeAll(async () => {
    await saveCustomer("seven", {
      customerCode: "CA%A",
      customerName: "와일드카드주식회사",
      customerPostalCode: "",
      customerAddress: "퍼센트 도시",
      customerContact: "",
      customerTelephone: "",
      customerEmail: "",
    });
    await saveCustomer("seven", {
      customerCode: "CA-B",
      customerName: "일반주식회사",
      customerPostalCode: "",
      customerAddress: "",
      customerContact: "",
      customerTelephone: "",
      customerEmail: "",
    });
  });

  it("stores and reads back the same customer code", async () => {
    const stored = await getCustomer("seven", "CA%A");
    expect(stored?.customerName).toBe("와일드카드주식회사");
    expect(await getCustomer("seven", "  CA-B  ")).not.toBeNull();
  });

  it("treats LIKE wildcards in searches as literal characters", async () => {
    // % 리터럴 검색: %를 포함한 코드 1건만 (와일드카드라면 2건 전부)
    expect(await listCustomers("%", 100, "seven")).toHaveLength(1);
    // _ 리터럴 검색: _를 포함한 고객은 없음 (와일드카드라면 2건 전부)
    expect(await listCustomers("_", 100, "seven")).toHaveLength(0);
    expect(await listCustomers("A%", 100, "seven")).toHaveLength(1);
    expect(await listCustomers("CA%", 100, "seven")).toHaveLength(1);
    expect(await listCustomers("퍼센트 도시", 100, "seven")).toHaveLength(1);
    expect(await listCustomers("주식회사", 100, "seven")).toHaveLength(2);
  });

  it("deletes by code and reports unknown codes", async () => {
    await saveCustomer("seven", {
      customerCode: "CA-DEL",
      customerName: "삭제대상주식회사",
      customerPostalCode: "",
      customerAddress: "",
      customerContact: "",
      customerTelephone: "",
      customerEmail: "",
    });
    expect(await deleteCustomer("seven", "  CA-DEL  ")).toBe(true);
    expect(await getCustomer("seven", "CA-DEL")).toBeNull();
    expect(await deleteCustomer("seven", "CA-DEL")).toBe(false);
    expect(await deleteCustomer("seven", "   ")).toBe(false);
  });

  it("isolates the same customer code by owner domain", async () => {
    await saveCustomer("kanei", {
      customerCode: "C-001",
      customerName: "カネイC-001",
      customerPostalCode: "",
      customerAddress: "",
      customerContact: "",
      customerTelephone: "",
      customerEmail: "kanei-c001@example.test",
    });
    await saveCustomer("seven", {
      customerCode: "C-001",
      customerName: "セブンC-001",
      customerPostalCode: "",
      customerAddress: "",
      customerContact: "",
      customerTelephone: "",
      customerEmail: "seven-c001@example.test",
    });

    expect((await getCustomer("kanei", "C-001"))?.customerName).toBe("カネイC-001");
    expect((await getCustomer("seven", "C-001"))?.customerName).toBe("セブンC-001");
    expect(await listCustomers("C-001", 100, "kanei")).toHaveLength(1);
    expect(await listCustomers("C-001", 100, "seven")).toHaveLength(1);
    expect(await deleteCustomer("kanei", "C-001")).toBe(true);
    expect((await getCustomer("seven", "C-001"))?.customerName).toBe("セブンC-001");
    await deleteCustomer("seven", "C-001");
    expect(await getCustomer("seven", "C-001")).toBeNull();
  });

  it("ranks customers by each user's own selection count", async () => {
    // Kim often uses CA-B; Ishii often uses CA%A. Neither affects the other's order.
    await recordCustomerSelection("seven", "Kim@kanei-trade.co.jp", "CA-B");
    await recordCustomerSelection("seven", "kim@kanei-trade.co.jp", "CA-B");
    await recordCustomerSelection("seven", "ishii@727.co.jp", "CA%A");

    expect((await listCustomers("", 100, "seven", "kim@kanei-trade.co.jp")).map((item) => item.customerCode))
      .toEqual(["CA-B", "CA%A"]);
    expect((await listCustomers("", 100, "seven", "ISHII@727.co.jp")).map((item) => item.customerCode))
      .toEqual(["CA%A", "CA-B"]);
    expect((await listCustomers("", 100, "seven", "other@example.test")).map((item) => item.customerCode))
      .toEqual(["CA%A", "CA-B"]);
  });
});
