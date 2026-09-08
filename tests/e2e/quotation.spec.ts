import { expect, test } from "@playwright/test";

test("Japanese quotation UI calculates, validates, and separates customer output", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "パウチ参考原価・販売価格シミュレーター" })).toBeVisible();
  await expect(page.getByTestId("quote-gate")).toContainText("参考見積・色数別単価は参考入力（印刷色数とは未連動）・仕入先確認待ち");
  await expect(page.getByTestId("calculate-desktop")).toBeEnabled();
  await expect(page.getByTestId("bulk-usage")).toHaveCount(0);
  await page.getByTestId("calculate-desktop").click();
  await expect(page.getByTestId("server-result")).toHaveAttribute("data-state", "calculated");
  await expect(page.getByTestId("bulk-usage")).toContainText("41,000 ml");
  await expect(page.getByTestId("customer-total")).toContainText("￥");
  await expect(page.locator(".quote-sheet")).not.toContainText("総原価");
  await expect(page.locator(".quote-sheet")).not.toContainText("成功報酬");
  await expect(page.getByTestId("server-result")).toHaveAttribute("data-state", "calculated");
  await expect(page.getByTestId("input-summary")).toContainText("50×60 / 1連 / 10,000枚 / SKU 1件（充填物1 10,000枚）");
  await page.locator('[data-testid="parameters"] > summary').click();
  await expect(page.getByLabel("海外配送費 / 回 (円)")).toBeVisible();
  await page.locator('[data-testid="calculation-formula"] > summary').click();
  await expect(page.getByText(/配送回数＝ceil/)).toBeVisible();
  expect(await page.evaluate(() => Array.from(document.body.querySelectorAll("*")).reduce((worst, element) => Math.max(worst, element.getBoundingClientRect().right), 0)))
    .toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth));
});

test("A4 quotation page imports simulator costs and prepares PDF printing", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("customer-total")).toHaveText("-");
  await page.getByTestId("calculate-desktop").click();
  await expect(page.getByTestId("server-result")).toHaveAttribute("data-state", "calculated");
  await page.getByRole("link", { name: "見積書発行" }).click();
  await expect(page).toHaveURL(/\/quote$/);
  await expect(page.getByRole("heading", { name: "お見積書" })).toBeVisible();
  await expect(page.getByTestId("quote-source")).toContainText("原価計算結果連携済み");
  const mobile = (page.viewportSize()?.width ?? 1280) <= 1200;
  if (mobile) {
    await page.getByRole("button", { name: "基本" }).click();
    await page.getByTestId("quote-editor-left").getByLabel("得意先名").fill("E2E株式会社");
    await page.getByTestId("quote-editor-left").getByRole("button", { name: "閉じる" }).click();
    await page.getByRole("button", { name: "金額" }).click();
    await page.getByTestId("quote-editor-right").getByLabel("充填・加工 単価（空欄=自動）").fill("99");
    await page.getByTestId("quote-editor-right").getByRole("button", { name: "閉じる" }).click();
  } else {
    await page.getByTestId("quote-editor-left").getByLabel("得意先名").fill("E2E株式会社");
    await page.getByTestId("quote-editor-right").locator("summary", { hasText: "明細・金額" }).click();
    await page.getByTestId("quote-editor-right").getByLabel("充填・加工 単価（空欄=自動）").fill("99");
  }

  await page.evaluate(() => {
    (window as Window & { printCalls?: number }).printCalls = 0;
    window.print = () => {
      const scopedWindow = window as Window & { printCalls?: number };
      scopedWindow.printCalls = (scopedWindow.printCalls ?? 0) + 1;
    };
  });
  await page.getByTestId("print-pdf").click();
  await expect.poll(() => page.evaluate(() => (window as Window & { printCalls?: number }).printCalls)).toBe(1);

  await expect(page.getByTestId("quote-price-per-piece")).toContainText("￥");
  await expect(page.getByTestId("filling-unit-price")).toContainText("￥99");
  await expect(page.getByTestId("film-meter-price")).toContainText("/m");
  await expect(page.getByTestId("film-pouch-price")).toContainText("パウチ換算");
  await expect(page.getByTestId("film-pouch-price")).toContainText("/枚");
  await expect(page.getByTestId("film-order-length")).toContainText("m");
  await expect(page.getByTestId("rounding-adjustment")).toHaveText("-");
  await expect(page.getByText("充填・加工費", { exact: true })).toBeVisible();
  await expect(page.getByText("フィルム費用", { exact: true })).toBeVisible();
  await expect(page.locator(".a4-sheet")).not.toContainText("適用利益率");
  await expect(page.locator(".a4-sheet")).not.toContainText("総原価");

  await page.getByRole("link", { name: "見積履歴" }).click();
  await expect(page).toHaveURL(/\/history$/);
  await page.getByTestId("history-search").fill("E2E株式会社");
  await expect(page.getByTestId("history-table")).toContainText("E2E株式会社");
  await expect(page.getByTestId("history-table")).toContainText("税込合計");
});

test("PDF output continues when test history storage fails", async ({ page }) => {
  await page.route("**/api/quotations", (route) => route.abort());
  await page.goto("/quote");
  await page.evaluate(() => {
    (window as Window & { printCalls?: number }).printCalls = 0;
    window.print = () => {
      const scopedWindow = window as Window & { printCalls?: number };
      scopedWindow.printCalls = (scopedWindow.printCalls ?? 0) + 1;
    };
  });
  await page.getByTestId("print-pdf").click();
  await expect.poll(() => page.evaluate(() => (window as Window & { printCalls?: number }).printCalls)).toBe(1);
  await expect(page.getByTestId("save-error")).toContainText("テスト環境ではデータが保持されない場合があります");
});
