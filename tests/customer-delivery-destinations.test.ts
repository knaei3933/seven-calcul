import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseDirectory = await mkdtemp(join(tmpdir(), "customer-delivery-destinations-"));
process.env.POUCH_CUSTOMER_DB = join(databaseDirectory, "customers.db");

const { ensureAdministratorSeed } = await import("@/lib/auth-store");
const {
  listDeliveryDestinations,
  saveCustomer,
  setDefaultDeliveryDestination,
  upsertDeliveryDestination,
  validateDeliveryDestinationInput,
} = await import("@/lib/customer-store");

const validInput = {
  label: "大阪工場",
  companyName: "テスト物流株式会社",
  department: "大阪倉庫",
  contactName: "納品担当",
  postalCode: "550-0001",
  address: "大阪府大阪市テスト1-1-1",
  building: "物流センター2F",
  phone: "06-0000-0000",
  email: "warehouse@example.test",
  note: "大型車不可",
  isDefault: true,
};

afterAll(async () => {
  await rm(databaseDirectory, { recursive: true, force: true });
});

describe("customer delivery destinations", () => {
  beforeAll(async () => {
    await ensureAdministratorSeed();
    await saveCustomer("seven", {
      customerCode: "DEST-CUSTOMER-001",
      customerName: "配送先テスト株式会社",
      customerPostalCode: "650-0001",
      customerAddress: "兵庫県神戸市テスト1-2-3",
      customerContact: "担当",
      customerTelephone: "078-000-0000",
      customerEmail: "customer@example.test",
    });
  });

  it("validates required logistics fields", () => {
    expect(validateDeliveryDestinationInput({ ...validInput, companyName: "" })).toBeNull();
    expect(validateDeliveryDestinationInput({ ...validInput, phone: "" })).toBeNull();
    expect(validateDeliveryDestinationInput({ ...validInput, email: "invalid" })).toBeNull();
    expect(validateDeliveryDestinationInput(validInput)).toMatchObject({ companyName: "テスト物流株式会社" });
  });

  it("auto-saves a new destination and makes the first destination default", async () => {
    const saved = await upsertDeliveryDestination("seven", "DEST-CUSTOMER-001", validInput);
    expect(saved.isDefault).toBe(true);
    expect(saved.useCount).toBe(0);
    const destinations = await listDeliveryDestinations("seven", "DEST-CUSTOMER-001");
    expect(destinations).toHaveLength(1);
  });

  it("updates the same address instead of creating a duplicate", async () => {
    const first = await upsertDeliveryDestination("seven", "DEST-CUSTOMER-001", validInput);
    const second = await upsertDeliveryDestination("seven", "DEST-CUSTOMER-001", {
      ...validInput,
      contactName: "新しい担当者",
      note: "更新済み",
    });
    expect(second.id).toBe(first.id);
    expect(second.contactName).toBe("新しい担当者");
    expect(await listDeliveryDestinations("seven", "DEST-CUSTOMER-001")).toHaveLength(1);
  });

  it("saves another destination and switches the default on request", async () => {
    await upsertDeliveryDestination("seven", "DEST-CUSTOMER-001", {
      ...validInput,
      label: "東京倉庫",
      companyName: "東京物流株式会社",
      postalCode: "100-0001",
      address: "東京都千代田区テスト2-2-2",
      phone: "03-0000-0000",
      isDefault: false,
    });
    const destinations = await listDeliveryDestinations("seven", "DEST-CUSTOMER-001");
    expect(destinations).toHaveLength(2);
    const tokyo = destinations.find((destination) => destination.label === "東京倉庫")!;
    const switched = await setDefaultDeliveryDestination("seven", "DEST-CUSTOMER-001", tokyo.id);
    expect(switched?.isDefault).toBe(true);
    const reloaded = await listDeliveryDestinations("seven", "DEST-CUSTOMER-001");
    expect(reloaded[0]?.id).toBe(tokyo.id);
  });
});
