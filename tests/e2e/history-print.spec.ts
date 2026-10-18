import { expect, test } from "@playwright/test";

test("history detail uses the stored canonical quotation PDF", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("calculate-desktop").click();
  await expect(page.getByTestId("server-result")).toHaveAttribute("data-state", "calculated");
  await page.getByTestId("recommendation-modal-close").click();
  await page.getByRole("link", { name: "見積書発行" }).click();
  await page.getByTestId("fill-test-data").click();
  await page.getByPlaceholder("株式会社◯◯").fill("History E2E KK");
  await expect(page.getByTestId("save-history")).toBeEnabled();
  await page.getByTestId("save-history").click();
  await page.getByRole("link", { name: "見積履歴" }).click();
  await page.getByRole("button", { name: "詳細" }).first().click();
  const storedPdf = page.getByTestId("stored-quotation-pdf");
  await expect(storedPdf).toBeVisible();
  await expect(storedPdf).toHaveAttribute("src", /^blob:/);
  await expect(page.getByRole("article", { name: "見積書A4" })).toHaveCount(0);

  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("detail-download-current").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.pdf$/u);
});
