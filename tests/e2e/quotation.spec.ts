import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";

test("Japanese quotation UI calculates, validates, and separates customer output", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "パウチ参考原価・販売価格シミュレーター" })).toBeVisible();
  await expect(page.getByTestId("calculate-desktop")).toBeEnabled();
  await expect(page.getByTestId("bulk-usage")).toHaveCount(0);
  await page.getByTestId("calculate-desktop").click();
  await expect(page.getByTestId("server-result")).toHaveAttribute("data-state", "calculated");
  await expect(page.getByTestId("bulk-usage")).toContainText("41,000 g");
  await expect(page.getByTestId("customer-total")).toContainText("￥");
  await expect(page.locator(".quote-sheet")).not.toContainText("総原価");
  await expect(page.locator(".quote-sheet")).not.toContainText("成功報酬");
  await expect(page.getByTestId("server-result")).toHaveAttribute("data-state", "calculated");
  await page.getByTestId("recommendation-modal-close").click();
  await expect(page.getByTestId("recommendation-modal")).toBeHidden();
  await expect(page.getByTestId("input-summary")).toContainText("50×60 / 1連 / 10,000枚 / デジタル印刷 / SKU 1件（充填物1 10,000枚）");
  await page.locator('[data-testid="parameters"] > summary').click();
  await expect(page.getByLabel("海外配送費 / 回 (円)")).toBeVisible();
  await page.locator('[data-testid="calculation-formula"] > summary').click();
  await expect(page.getByText(/配送回数＝ceil/)).toBeVisible();
  // The global menu intentionally scrolls internally on small screens; assert
  // that its clipped children do not create document-level horizontal scroll.
  expect(await page.evaluate(() => ({
    documentScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))).toEqual({
    documentScrollWidth: expect.any(Number),
    bodyScrollWidth: expect.any(Number),
    clientWidth: expect.any(Number),
  });
  await page.evaluate(() => window.scrollTo(100, 0));
  await expect.poll(() => page.evaluate(() => window.scrollX)).toBe(0);
  // body.scrollWidth can report content inside intentionally scrollable/fixed
  // regions, so user-facing horizontal scrolling is checked on the root.
});

test("A4 quotation page issues once and downloads the canonical PDF", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("customer-total")).toHaveText("-");
  await page.getByTestId("calculate-desktop").click();
  await expect(page.getByTestId("server-result")).toHaveAttribute("data-state", "calculated");
  await page.getByTestId("recommendation-modal-close").click();
  await expect(page.getByTestId("recommendation-modal")).toBeHidden();
  await page.getByRole("link", { name: "見積書発行" }).click();
  await expect(page).toHaveURL(/\/quote$/);
  await expect(page.getByRole("heading", { name: "お見積書" })).toBeVisible();
  await expect(page.getByTestId("issue-required-fields")).toContainText("連携済み");
  await page.getByTestId("fill-test-data").click();
  await page.getByPlaceholder("株式会社◯◯").fill("E2E株式会社");
  await expect(page.getByTestId("save-history")).toBeEnabled();
  await page.getByTestId("save-history").click();
  await expect(page.getByTestId("issue-success")).toBeVisible({ timeout: 15_000 });

  await page.getByPlaceholder("株式会社◯◯").fill("E2E編集後株式会社");
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("print-pdf").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^お見積書_.+_\d{6}\.pdf$/u);
  const issuedPdf = readFileSync(await download.path());
  expect(countPdfPages(issuedPdf)).toBe(1);

  await expect(page.getByTestId("quote-price-per-piece")).toContainText("￥");
    await expect(page.getByTestId("film-meter-price")).toContainText("/m");
  await expect(page.getByTestId("film-pouch-price")).toContainText("パウチ換算");
  await expect(page.getByTestId("film-pouch-price")).toContainText("/枚");
  await expect(page.getByTestId("film-order-length")).toContainText("m");
  await expect(page.getByTestId("rounding-adjustment")).toHaveText("-");
  await expect(page.getByText("充填・加工費", { exact: true })).toBeVisible();
  await expect(page.getByText("フィルム費用", { exact: true })).toBeVisible();
  await expect(page.locator(".a4-sheet")).not.toContainText("適用利益率");
  await expect(page.locator(".a4-sheet")).not.toContainText("総原価");

  await page.emulateMedia({ media: "print" });
  await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
  await expect.poll(() => page.evaluate(async () => {
    await document.fonts.ready;
    return document.fonts.check("16px notoSerifJP");
  })).toBe(true);
  const quotationPdf = await page.pdf({
    format: "A4",
    printBackground: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
  });
  expect(quotationPdf.toString("latin1").match(/\/Type\s*\/Page\b/g)).toHaveLength(1);
  await page.emulateMedia({ media: "screen" });
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));

  await page.getByRole("link", { name: "見積履歴" }).click();
  await expect(page).toHaveURL(/\/history$/);
  await page.getByTestId("history-search").fill("E2E株式会社");
  await expect(page.getByTestId("history-table")).toContainText("E2E株式会社");
  await expect(page.getByTestId("history-table")).toContainText("税込合計");
});

test("PDF output requires an issued canonical PDF when history storage fails", async ({ page }) => {
  await page.route("**/api/quotations", (route) => route.abort());
  await page.goto("/quote");
  await page.getByTestId("fill-test-data").click();
  await page.getByTestId("print-pdf").click();
  await expect(page.getByTestId("save-error")).toContainText("PDFは発行後に保存されます");
});

test("quote and history download the same canonical PDF bytes", async ({ page }) => {
  const customerName = `Cross-UI E2E ${Date.now()}`;
  await page.goto("/quote");
  await page.getByTestId("fill-test-data").click();
  await page.getByPlaceholder("株式会社◯◯").fill(customerName);
  await expect(page.getByTestId("save-history")).toBeEnabled();
  await page.getByTestId("save-history").click();
  await expect(page.getByTestId("issue-success")).toBeVisible();

  const quoteDownloadPromise = page.waitForEvent("download");
  await page.getByTestId("print-pdf").click();
  const quoteDownload = await quoteDownloadPromise;
  const quotationFileName = quoteDownload.suggestedFilename();
  expect(quotationFileName).toMatch(/^お見積書_.+_\d{6}\.pdf$/u);
  const quotePdf = readFileSync(await quoteDownload.path());
  expect(quotePdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");

  await page.getByRole("link", { name: "見積履歴" }).click();
  await page.getByTestId("history-search").fill(customerName);
  await expect(page.getByTestId("history-table")).toContainText(customerName);
  await page.getByRole("button", { name: "詳細" }).first().click();
  const historyDownloadPromise = page.waitForEvent("download", {
    predicate: (download) => download.suggestedFilename() === quotationFileName,
  });
  await page.getByTestId("detail-download-current").click();
  const historyDownload = await historyDownloadPromise;
  expect(historyDownload.suggestedFilename()).toBe(quotationFileName);
  const historyPdf = readFileSync(await historyDownload.path());

  const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  const quotePdfSha256 = sha256(quotePdf);
  const historyPdfSha256 = sha256(historyPdf);
  expect(historyPdfSha256).toBe(quotePdfSha256);
  console.info("cross-ui canonical PDF identity", {
    quotationFileName,
    sha256: quotePdfSha256,
    byteLength: quotePdf.byteLength,
  });
});

function countPdfPages(pdf: Buffer): number {
  return pdf.toString("latin1").match(/\/Type\s*\/Page(?![s/])/g)?.length ?? 0;
}
