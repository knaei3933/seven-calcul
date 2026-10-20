import { expect, test, type Page } from "@playwright/test";

async function calculateTube(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByLabel("サイズ").selectOption("tube-50x90");
  await page.getByLabel("発注数量 (枚)").fill("50000");
  await page.getByTestId("calculate-desktop").click();
  await expect(page.getByTestId("server-result")).toHaveAttribute("data-state", "calculated");
  await page.getByTestId("recommendation-modal-overlay").waitFor();
}

test("every account reviews the full gravure result without automatic navigation", async ({ page }) => {
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
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(/\/(\?|$)/);
  await expect(page).not.toHaveURL(/\/quote/);
});
