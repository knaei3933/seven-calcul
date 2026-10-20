import { expect, test, type Page } from "@playwright/test";

function numericText(value: string): string {
  return value.replace(/[^\d.-]/g, "");
}

async function selectRedactedGravureCandidate(page: Page, sizeKey = "tube-50x90"): Promise<{ orderLengthM: string; filmTotal: string }> {
  await page.goto("/");
  await page.getByLabel("サイズ").selectOption(sizeKey);
  if (sizeKey === "round-60x120") await page.getByLabel("2連").check();
  await page.getByLabel("発注数量 (枚)").fill("50000");
  await page.getByTestId("calculate-desktop").click();

  const result = page.getByTestId("server-result");
  await expect(result).toHaveAttribute("data-state", "calculated");
  const modal = page.getByTestId("recommendation-modal-overlay");
  await expect(modal).toBeVisible();
  await modal.locator(".recommendation-card").filter({ hasText: "Y / 国内調達" }).first().click();

  // Candidate selection stays in the simulator so the calculated plan can be
  // reviewed before the user explicitly advances to quotation issuance.
  await expect(page).toHaveURL(/\/(\?|$)/);
  await expect(page.getByTestId("server-result")).toHaveAttribute("data-state", "redacted_calculated");
  await expect(page.getByTestId("redacted-snapshot")).toBeVisible();
  await expect(page.getByTestId("redacted-selected-summary")).toContainText("選択中");
  await expectNoFullResultLeak(page);

  const selectedCandidate = page.getByTestId("redacted-selected-summary");
  const orderLengthM = numericText(await selectedCandidate.locator("dd").nth(1).innerText());
  const filmTotal = numericText(await selectedCandidate.locator("dd").nth(2).innerText());
  expect(Number(orderLengthM)).toBeGreaterThan(0);
  expect(Number(filmTotal)).toBeGreaterThan(0);

  await page.getByTestId("continue-redacted-quote").click();
  await expect(page).toHaveURL(/\/quote$/, { timeout: 30000 });
  await expect(page.getByTestId("issue-required-fields")).toContainText("連携済み");
  return { orderLengthM, filmTotal };
}

async function expectNoFullResultLeak(page: Page): Promise<void> {
  const text = await page.getByTestId("server-result").innerText();
  for (const forbidden of ["supplier", "sellerMarkup", "plateUnitPrice", "sourceRows", "rowId", "unitPriceYenPerM"]) {
    expect(text).not.toContain(forbidden);
  }
}

test("fresh selected redacted candidate carries film planning and cost into the quotation", async ({ page }) => {
  const { orderLengthM } = await selectRedactedGravureCandidate(page);

  await expect(page.getByTestId("film-meter-price")).toContainText(/￥[0-9,.]+\s*\/m/);
  await expect(page.getByTestId("film-pouch-price")).toContainText(/￥[0-9,.]+\s*\/枚/);
  await expect(page.getByTestId("film-order-length")).toContainText(`${orderLengthM.replace(/,/g, "")} m`);
  await expect(page.getByTestId("stale-quote-warning")).toHaveCount(0);
  await expect(page.getByTestId("save-history")).toBeDisabled();
  await expect(page.getByTestId("issue-required-fields")).toContainText("入力不足");
});

test("selected redacted plan explicitly hands the projection to the quotation", async ({ page }) => {
  await selectRedactedGravureCandidate(page, "round-60x120");

  const draft = JSON.parse(await page.evaluate(() => sessionStorage.getItem("pouch-quotation-draft-v1") ?? "{}")) as {
    printingMethod?: string;
    pricingSnapshot?: { publicProjection?: { selectedCandidateId?: string } };
  };
  expect(draft.printingMethod).toBe("gravure");
  expect(draft.pricingSnapshot?.publicProjection?.selectedCandidateId).not.toBe("");
  await expect(page.locator("#quote-preview")).toContainText("グラビア印刷");
  await expect(page.getByTestId("issue-required-fields")).toContainText("連携済み");
});
