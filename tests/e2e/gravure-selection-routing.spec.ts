import { expect, test, type Page } from "@playwright/test";

async function calculateTube(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("サイズ").selectOption("tube-50x90");
  await page.getByLabel("発注数量 (枚)").fill("50000");
  await page.getByTestId("calculate-desktop").click();
  const result = page.getByTestId("server-result");
  await expect(result).toHaveAttribute("data-state", "calculated");
  const redactedView = page.getByTestId("redacted-snapshot");
  const recommendationModal = page.getByTestId("recommendation-modal-overlay");
  await expect(redactedView.or(recommendationModal)).toBeVisible();
}

test("ordinary account reviews a redacted candidate and switches plans without automatic navigation", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "ordinary-chromium");
  await calculateTube(page);

  await page.getByTestId("recommendation-modal-overlay")
    .locator(".recommendation-card")
    .filter({ hasText: "Y / 国内調達" })
    .first()
    .click();
  await expect(page.getByTestId("recommendation-modal-overlay")).toBeHidden();
  await expect(page.getByTestId("server-result")).toHaveAttribute("data-state", "redacted_calculated");
  const selectedSummary = page.getByTestId("selected-candidate-summary");
  await expect(selectedSummary).toHaveCount(0);
  await expect(page.getByTestId("redacted-selected-summary")).toContainText("選択中");
  await expect(page.locator(".recommendation-list")).toHaveCount(0);

  await expect(page).toHaveURL(/\/(\?|$)/);

  const previousSelectedId = await page.getByTestId("redacted-selected-summary")
    .evaluate((element) => element.querySelector("h3")?.textContent);
  let quoteDocumentRequested = false;
  page.on("request", (request) => {
    quoteDocumentRequested ||= request.resourceType() === "document"
      && new URL(request.url()).pathname === "/quote";
  });

  await page.getByTestId("redacted-compare-toggle").click();
  await page.locator('[data-testid^="redacted-candidate-K-"]:not(.selected) button')
    .first()
    .click();
  const selectedAfterSwitch = page.getByTestId("redacted-selected-summary");
  await expect(selectedAfterSwitch.locator("h3")).toContainText("韓国輸入");
  await expect(selectedAfterSwitch).toContainText("選択中");
  await expect(selectedAfterSwitch).toBeVisible();
  const selectedLabel = await selectedAfterSwitch.locator("h3").innerText();
  expect(selectedLabel).not.toBe(previousSelectedId);
  await expect(page.locator(".recommendation-list")).toHaveCount(0);
  await expect(page).toHaveURL(/\/(\?|$)/);
  await expect(page).not.toHaveURL(/\/quote/);
  expect(quoteDocumentRequested).toBe(false);

  await page.getByTestId("continue-redacted-quote").click();
  await expect(page).toHaveURL(/\/quote$/);
});

test("Kanai account reviews the full gravure result without automatic navigation", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "kanai-chromium");
  await calculateTube(page);

  await page.getByTestId("recommendation-modal-overlay")
    .locator(".recommendation-card")
    .filter({ hasText: "Y / 国内調達" })
    .first()
    .click();
  await expect(page.getByTestId("recommendation-modal-overlay")).toBeHidden();
  await expect(page.getByTestId("server-result")).toHaveAttribute("data-state", "calculated");
  await expect(page.getByTestId("selected-candidate-summary")).toContainText("グラビア印刷");
  await expect(page.getByTestId("redacted-snapshot")).toHaveCount(0);

  await expect(page).toHaveURL(/\/(\?|$)/);
  await page.waitForTimeout(1000);
  await expect(page).toHaveURL(/\/(\?|$)/);
  await expect(page).not.toHaveURL(/\/quote/);
});
