import { expect, test, type Page } from "@playwright/test";

type CandidateFigures = {
  orderLengthM: string;
  filmTotal: string;
};

function numericText(value: string): string {
  return value.replace(/[^\d.-]/g, "");
}

async function prepareRedactedGravureCandidate(page: Page, sizeKey = "tube-50x90"): Promise<CandidateFigures> {
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

  await expect(result).toHaveAttribute("data-state", "redacted_calculated");
  await expect(page.getByTestId("redacted-snapshot")).toHaveText(/スナップショット [0-9a-f-]{8}… ／ asOf \d{4}-\d{2}-\d{2}/);
  const candidate = page.getByTestId("redacted-candidate-Y").and(page.locator(".selected"));
  await expect(candidate).toContainText(/国内 \d+mm/);
  const dds = candidate.locator("dd");
  const orderLengthM = numericText(await dds.nth(1).innerText());
  const filmTotal = numericText(await dds.nth(2).innerText());
  expect(Number(orderLengthM)).toBeGreaterThan(0);
  expect(Number(filmTotal)).toBeGreaterThan(0);

  await expect(candidate).toContainText("選択中");
  await expect(result).toHaveAttribute("data-state", "redacted_calculated");
  await expect(page.getByTestId("redacted-snapshot")).toHaveText(/スナップショット [0-9a-f-]{8}… ／ asOf \d{4}-\d{2}-\d{2}/);
  await expect(page.getByTestId("continue-redacted-quote")).toBeEnabled();
  return { orderLengthM, filmTotal };
}

async function expectNoFullResultLeak(page: Page): Promise<void> {
  const text = await page.getByTestId("server-result").innerText();
  for (const forbidden of ["supplier", "sellerMarkup", "plateUnitPrice", "sourceRows", "rowId", "unitPriceYenPerM"]) {
    expect(text).not.toContain(forbidden);
  }
}

test("fresh selected redacted candidate carries film planning and cost into the quotation", async ({ page }) => {
  const { orderLengthM, filmTotal } = await prepareRedactedGravureCandidate(page);
  await expectNoFullResultLeak(page);

  await page.getByTestId("continue-redacted-quote").click();
  await expect(page).toHaveURL(/\/quote$/);
  await expect(page.getByTestId("issue-required-fields")).toContainText("連携済み");
  await expect(page.getByTestId("film-meter-price")).toContainText(/￥[0-9,.]+\s*\/m/);
  await expect(page.getByTestId("film-pouch-price")).toContainText(/￥[0-9,.]+\s*\/枚/);
  await expect(page.getByTestId("film-order-length")).toContainText(`${orderLengthM.replace(/,/g, "")} m`);
  await expect(page.getByTestId("stale-quote-warning")).toHaveCount(0);
  await expect(page.getByTestId("save-history")).toBeDisabled();
  await expect(page.getByTestId("issue-required-fields")).toContainText("入力不足");
});

test("redacted recalculation returns to the input basis and disables continuation", async ({ page }) => {
  await prepareRedactedGravureCandidate(page);
  await page.getByTestId("recalculate-redacted").click();
  await expect(page.getByTestId("server-result")).toHaveAttribute("data-state", "calculated");
  await expect(page.getByTestId("recommendation-modal-overlay")).toBeVisible();
  await expect(page.getByTestId("continue-redacted-quote")).toHaveCount(0);
  await expectNoFullResultLeak(page);
});

test("selected redacted plan hands the authoritative projection to the quotation", async ({ page }) => {
  await prepareRedactedGravureCandidate(page, "round-60x120");
  await expect(page.locator('[data-testid="redacted-candidate-Y"].selected')).toContainText("選択中");
  await expectNoFullResultLeak(page);

  await page.getByTestId("continue-redacted-quote").click();
  await expect(page).toHaveURL(/\/quote$/);
  const draft = JSON.parse(await page.evaluate(() => sessionStorage.getItem("pouch-quotation-draft-v1") ?? "{}")) as {
    printingMethod?: string;
    pricingSnapshot?: { publicProjection?: { selectedCandidateId?: string } };
  };
  expect(draft.printingMethod).toBe("gravure");
  expect(draft.pricingSnapshot?.publicProjection?.selectedCandidateId).not.toBe("");
  await expect(page.locator("#quote-preview")).toContainText("グラビア印刷");
  await expect(page.getByTestId("issue-required-fields")).toContainText("連携済み");
});

test("switches redacted Korean patterns from the original input basis", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("サイズ").selectOption("tube-50x90");
  await page.getByLabel("発注数量 (枚)").fill("524000");
  await page.getByTestId("calculate-desktop").click();

  const result = page.getByTestId("server-result");
  await expect(result).toHaveAttribute("data-state", "calculated");
  const modal = page.getByTestId("recommendation-modal-overlay");
  await expect(modal).toBeVisible();
  await modal.locator(".recommendation-card")
    .filter({ hasText: "K / 韓国輸入" })
    .filter({ hasText: "パターン 2" })
    .first()
    .click();

  await expect(result).toHaveAttribute("data-state", "redacted_calculated");
  await expect(page.locator('[data-testid="redacted-candidate-K"].selected')).toContainText("パターン 2");

  await page.locator('[data-testid="redacted-candidate-K"]:not(.selected) button').first().click();

  await expect(page.locator('[data-testid="redacted-candidate-K"].selected')).toContainText("パターン 1");
  await expect(page.getByTestId("candidate-selection-error")).toHaveCount(0);
  await expect(page.getByTestId("continue-redacted-quote")).toBeEnabled();
});
