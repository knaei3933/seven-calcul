import { expect, test } from "@playwright/test";

test("gravure candidate selection stays in the simulator for every account", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("サイズ").selectOption("tube-50x90");
  await page.getByLabel("発注数量 (枚)").fill("50000");
  await page.getByTestId("calculate-desktop").click();

  const result = page.getByTestId("server-result");
  await expect(result).toHaveAttribute("data-state", /calculated|redacted_calculated/);
  const redactedView = page.getByTestId("redacted-snapshot");
  const recommendationModal = page.getByTestId("recommendation-modal-overlay");

  const initialRedacted = await redactedView.isVisible();
  if (initialRedacted) {
    const selectable = page.locator(
      '[data-testid^="redacted-candidate-"]:not(.selected) button',
    ).first();
    await selectable.click();
    await expect(page.locator('[data-testid^="redacted-candidate-"].selected')).toBeVisible();
  } else {
    await recommendationModal.locator(".recommendation-card").filter({ hasText: "Y / 国内調達" }).first().click();
    await expect(recommendationModal).toBeHidden();
  }

  const selectedSummary = page.getByTestId("selected-candidate-summary");
  await expect(redactedView.or(selectedSummary)).toBeVisible();
  const isRedacted = await redactedView.isVisible();
  if (!isRedacted) {
    await expect(selectedSummary).toContainText("グラビア印刷");
  }

  await expect(page).toHaveURL(/\/(\?|$)/);
  await page.waitForTimeout(1000);
  await expect(page).toHaveURL(/\/(\?|$)/);
  await expect(page).not.toHaveURL(/\/quote/);

  if (isRedacted) {
    await page.getByTestId("continue-redacted-quote").click();
    await expect(page).toHaveURL(/\/quote$/);
  }
});
