import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(HTMLInputElement.prototype, "dispatchDebugError", { value: (message: string) => console.error(message) });
  });
});

test("calculates and validates a Japanese quotation with output separation", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "パウチ見積計算" })).toBeVisible();
  await expect(page.getByLabel("充填量 (ml/室)")).toHaveValue("30");
  await expect(page.getByLabel("発注数量 (枚)")).toHaveValue("10000");
  await expect(page.getByText("Decimal計算コア 2026-09.1")).toBeVisible();

  await page.getByLabel("SKU2必要長さ (m)").fill("300");
  await expect(page.getByText("合計800m（最低500m・各SKU300m）")).toBeVisible();
  await page.getByRole("button", { name: "計算して確定" }).click();
  await expect(page.getByText("サーバー確定")).toBeVisible();
  await expect(page.getByText("検算差額").locator("..").getByText("￥0")).toBeVisible();
  await expect(page.getByLabel("品名", { exact: false })).toBeHidden();

  const customer = page.locator(".quote-sheet");
  await expect(customer.getByText("税抜金額")).toBeVisible();
  await expect(customer).not.toContainText(/原価|仕入|利益率|成功報酬/);

  const internal = page.locator(".panel", { hasText: "原価・利益試算" });
  await expect(internal.getByText("フィルム")).toBeVisible();
  await expect(internal.getByText("バルク")).toBeVisible();
  await expect(internal.getByText("カスタム")).toBeVisible();
});

test("blocks invalid digital minimums and proposes corrections", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("SKU1必要長さ (m)").fill("450");
  await page.getByLabel("SKU2必要長さ (m)").fill("50");
  await expect(page.getByText("SKU 2が300m未満")).toBeVisible();
  await expect(page.getByRole("button", { name: "計算して確定" })).toBeDisabled();
  await expect(page.getByText("各SKUを300m以上に切り上げます。")).toBeVisible();
});

test("blocks custom dimensions until mapping is configured", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("カスタム区分").check();
  await expect(page.getByText("列数・原反幅・価格帯の変換ルール未設定のため確定見積禁止です。")).toBeVisible();
  await expect(page.getByRole("button", { name: "計算して確定" })).toBeDisabled();
});
