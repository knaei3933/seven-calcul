import { expect, test } from "@playwright/test";

const routes = [
  { path: "/", heading: "パウチ参考原価・販売価格シミュレーター" },
  { path: "/quote", heading: "見積書発行" },
  { path: "/history", heading: "見積履歴" },
  { path: "/film-orders", heading: "データ受入" },
  { path: "/film-makers", heading: "フィルムメーカー管理" },
  { path: "/film-makers/legacy-reconciliation", heading: "レガシー供給者整理" },
  { path: "/settings/mail", heading: "メール送信設定" },
];

test.beforeEach(async ({ }, testInfo) => {
  test.skip(testInfo.project.name !== "kanai-chromium", "Full desktop audit runs once as Kanei.");
});

test("audits all authenticated Kanei UI routes", async ({ page }) => {
  for (const route of routes) {
    const response = await page.goto(route.path);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: route.heading })).toBeVisible();
    await expect(page.getByTestId("current-user")).toContainText("kanai-admin@kanei-trade.co.jp");
    await expect(page.getByRole("button", { name: "ログアウト" })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Application error");
  }
});

test("audits film-maker create, edit, deactivate, and reconciliation guard", async ({ page }) => {
  const code = `AUDIT-${Date.now()}`;
  await page.goto("/film-makers");
  await expect(page.getByRole("heading", { name: "フィルムメーカー管理" })).toBeVisible();

  await page.getByLabel("フィルムメーカーコード").fill(code);
  await page.getByLabel("会社名").fill("UI Full Audit KK");
  await page.getByLabel("担当者（任意）").fill("Audit Taro");
  await page.getByLabel("メールアドレス").fill(`audit-${Date.now()}@example.test`);
  await page.getByLabel("言語").selectOption("ko");
  await page.getByLabel("印刷方式").selectOption("digital");
  await page.getByLabel("調達経路").selectOption("K");
  await page.getByLabel("備考").fill("UI full audit");
  await page.getByRole("button", { name: "登録する" }).click();
  await expect(page.getByText("フィルムメーカーを登録しました。")).toBeVisible();

  const row = page.getByTestId(`film-maker-${code}`);
  await expect(row).toContainText("UI Full Audit KK");
  await expect(row).toContainText("한국어");
  await expect(row).toContainText("デジタル");
  await expect(row).toContainText("韓国輸入");

  await row.getByRole("button", { name: "編集" }).click();
  await page.getByLabel("会社名").fill("UI Full Audit Updated KK");
  await page.getByRole("button", { name: "更新する" }).click();
  await expect(page.getByText("フィルムメーカーを更新しました。")).toBeVisible();
  await expect(page.getByTestId(`film-maker-${code}`)).toContainText("UI Full Audit Updated KK");

  await page.getByTestId(`film-maker-${code}`).getByRole("button", { name: "停止" }).click();
  await expect(page.getByText(`${code} を非活性化しました。`)).toBeVisible();
  await expect(page.getByTestId(`film-maker-${code}`)).toContainText("停止");

  await page.goto("/film-makers/legacy-reconciliation");
  await expect(page.getByRole("heading", { name: "レガシー供給者整理" })).toBeVisible();
  await expect(page.getByText("正規化メール・調達ルート・印刷方式が有効メーカーと完全一致する場合のみ提案します。提案は代入ではありません。")).toBeVisible();
});

test("audits data-intake shell and workflow terminology", async ({ page }) => {
  await page.goto("/film-orders");
  await expect(page.getByRole("heading", { name: "データ受入" })).toBeVisible();
  await expect(page.getByText("成約・内部承認後の案件を、入稿から納品書まで順番に管理します。")).toBeVisible();
  await expect(page.getByRole("heading", { name: "作業の順番" })).toBeVisible();
  const guide = page.getByTestId("intake-guide");
  await expect(guide.getByText("データ入稿")).toBeVisible();
  await expect(guide.getByText("納品先確定", { exact: true })).toBeVisible();
  await expect(page.getByText("Six件").or(page.getByText(/\d+ 件/)).first()).toBeVisible();
  await expect(page.getByTestId("intake-table").or(page.getByText("対象データはありません"))).toBeVisible();
  await expect(page.getByRole("button", { name: "データ入稿" }).first()).toBeVisible();
});
