import { expect, test, type Page } from "@playwright/test";

type CandidateFigures = {
  orderLengthM: string;
  filmTotal: string;
};

async function prepareSelectedGravureCandidate(page: Page): Promise<CandidateFigures> {
  await page.goto("/");
  await page.getByLabel("サイズ").selectOption("tube-50x90");
  await page.getByLabel("発注数量 (枚)").fill("50000");
  await page.getByTestId("calculate-desktop").click();
  await expect(page.getByTestId("server-result")).toHaveAttribute("data-state", "calculated");

  const modal = page.getByTestId("recommendation-modal");
  await expect(modal).toBeVisible();
  await expect(modal).toHaveAttribute("role", "dialog");
  await expect(modal).toHaveAttribute("aria-modal", "true");
  await expect(modal).toHaveAttribute("aria-labelledby", "recommendation-modal-title");
  await expect(page.getByTestId("recommendation-modal-close")).toBeFocused();
  await expect(modal.getByTestId("modal-input-basis")).toBeVisible();
  await expect(modal.getByTestId("all-in-comparison")).toBeVisible();
  await expect(modal.getByTestId("all-in-comparison")).toHaveText(/すべて合算/);

  const candidate = modal.getByRole("button", { name: /Y \/ 国内調達/ }).first();
  await expect(candidate).toBeEnabled();
  const candidateText = await candidate.innerText();
  const orderLengthM = /([0-9,]+)m\s*／\s*￥/.exec(candidateText)?.[1];
  const filmTotal = /フィルム\s*￥([0-9,]+)/.exec(candidateText)?.[1];
  if (!orderLengthM || !filmTotal) throw new Error("Unable to parse candidate film figures");

  await candidate.click();
  await expect(modal).toBeHidden();
  await expect(page.getByTestId("active-candidate-note")).toContainText("選択候補（グラビア印刷）");
  await expect(page.getByTestId("server-result")).toHaveAttribute("data-state", "calculated");
  const summary = page.getByTestId("selected-candidate-summary");
  await expect(summary).toContainText("Y / 国内調達（グラビア印刷）");
  await expect(summary).toContainText("総原価");
  return { orderLengthM, filmTotal };
}

test("fresh selected gravure candidate carries film planning and cost into the quotation", async ({ page }) => {
  const { orderLengthM, filmTotal } = await prepareSelectedGravureCandidate(page);

  const filmCost = page.getByTestId("cost-film");
  await filmCost.scrollIntoViewIfNeeded();
  await expect(filmCost).toContainText(`￥${filmTotal}`);
  await expect(filmCost).toContainText(`${orderLengthM} m`);

  await page.getByRole("link", { name: "見積書発行" }).click();
  await expect(page).toHaveURL(/\/quote$/);
  await expect(page.getByTestId("quote-source")).toContainText("原価計算結果連携済み");
  await expect(page.getByTestId("film-meter-price")).toContainText(/￥[0-9,]+\s*\/m/);
  await expect(page.getByTestId("film-pouch-price")).toContainText(/￥[0-9,.]+\s*\/枚/);
  await expect(page.getByTestId("film-order-length")).toContainText(`${orderLengthM.replace(/,/g, "")} m`);
  await expect(page.getByTestId("stale-quote-warning")).toHaveCount(0);
  await expect(page.getByTestId("save-history")).toBeEnabled();
});

test("changing the selected candidate input makes linked quotation actions stale-safe", async ({ page }) => {
  await prepareSelectedGravureCandidate(page);
  await page.getByLabel("発注数量 (枚)").fill("50001");
  await expect(page.getByTestId("server-result")).toHaveAttribute("data-state", "stale");
  await expect(page.getByTestId("calculate-desktop")).toContainText("再計算して候補を見る");
  await page.getByRole("link", { name: "見積書発行" }).click();
  await expect(page).toHaveURL(/\/quote$/);
  await expect(page.getByTestId("stale-quote-warning")).toBeVisible();
  await expect(page.getByTestId("save-history")).toBeDisabled();
  await expect(page.getByTestId("print-pdf")).toBeDisabled();
  await expect(page.getByTestId("open-checklist")).toBeDisabled();
});

test("explicit recalculation returns to the digital input basis and reopens the modal", async ({ page }) => {
  await prepareSelectedGravureCandidate(page);

  await page.getByTestId("calculate-desktop").click();
  const modal = page.getByTestId("recommendation-modal");
  await expect(page.getByTestId("server-result")).toHaveAttribute("data-state", "calculated");
  await expect(modal).toBeVisible();
  await expect(modal.getByTestId("input-basis-card")).toHaveClass(/selected/);
  if (test.info().project.name === "mobile-chrome") {
    const comparison = modal.getByTestId("all-in-comparison");
    await expect(comparison).toBeVisible();
    await comparison.focus();
    await expect(comparison).toBeFocused();
    const overflow = await comparison.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    );
    expect(overflow).toBe(true);
    await comparison.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    const maxScrollLeft = await comparison.evaluate(
      (element) => element.scrollLeft,
    );
    expect(maxScrollLeft).toBeGreaterThan(0);
    await comparison.evaluate((element) => {
      element.scrollLeft = 0;
    });
    await expect(comparison.evaluate((element) => element.scrollLeft)).resolves.toBe(0);
  }

  await modal.getByTestId("recommendation-modal-close").click();
  await expect(modal).toBeHidden();
  await expect(page.getByTestId("input-summary")).toContainText("デジタル印刷");
  await expect(page.getByTestId("active-candidate-note")).toHaveCount(0);
  await expect(page.getByTestId("selected-candidate-summary")).toContainText("デジタル");
});
