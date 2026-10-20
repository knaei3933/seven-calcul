import { expect, test, type Page } from "@playwright/test";

async function selectFullGravureCandidate(page: Page, sizeKey = "tube-50x90"): Promise<void> {
  await page.goto("/");
  await page.getByLabel("サイズ").selectOption(sizeKey);
  if (sizeKey === "round-60x120") await page.getByLabel("2連").check();
  await page.getByLabel("発注数量 (枚)").fill("50000");
  await page.getByTestId("calculate-desktop").click();

  await expect(page.getByTestId("server-result")).toHaveAttribute("data-state", "calculated");
  const modal = page.getByTestId("recommendation-modal-overlay");
  await expect(modal).toBeVisible();
  await modal.locator(".recommendation-card").filter({ hasText: "Y / 国内調達" }).first().click();

  await expect(page).toHaveURL(/\/(\?|$)/);
  await expect(page.getByTestId("server-result")).toHaveAttribute("data-state", "calculated");
  await expect(page.getByTestId("redacted-snapshot")).toHaveCount(0);
  await expect(page.getByTestId("selected-candidate-summary")).toContainText("グラビア印刷");
}

test("selected gravure candidate carries film planning and cost into the quotation", async ({ page }) => {
  await selectFullGravureCandidate(page);

  await page.locator("header a", { hasText: "見積書発行" }).click();
  await expect(page).toHaveURL(/\/quote$/);
  await expect(page.getByTestId("issue-required-fields")).toContainText("連携済み");

  await expect(page.getByTestId("film-meter-price")).toContainText(/￥[0-9,.]+\s*\/m/);
  await expect(page.getByTestId("film-pouch-price")).toContainText(/￥[0-9,.]+\s*\/枚/);
  await expect(page.getByTestId("film-order-length")).toContainText(/m/);
  await expect(page.getByTestId("stale-quote-warning")).toHaveCount(0);
  await expect(page.getByTestId("issue-required-fields")).toContainText("連携済み");
});

test("selected gravure result hands the authoritative projection to the quotation", async ({ page }) => {
  await selectFullGravureCandidate(page, "round-60x120");

  const draft = JSON.parse(await page.evaluate(() => sessionStorage.getItem("pouch-quotation-draft-v1") ?? "{}")) as {
    printingMethod?: string;
    selectedCandidateId?: string;
    pricingSnapshot?: { publicProjection?: { selectedCandidateId?: string } };
  };
  expect(draft.printingMethod).toBe("gravure");
  expect(draft.selectedCandidateId).not.toBe("");
  expect(draft.pricingSnapshot?.publicProjection?.selectedCandidateId).not.toBe("");
  await page.locator("header a", { hasText: "見積書発行" }).click();
  await expect(page).toHaveURL(/\/quote$/);
  await expect(page.getByTestId("issue-required-fields")).toContainText("連携済み");
  await expect(page.locator("#quote-preview")).toContainText("グラビア印刷");
});
