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

  const candidate = page.getByRole("button", { name: /Y \/ 国内調達/ }).first();
  await expect(candidate).toBeEnabled();
  const candidateText = await candidate.innerText();
  const orderLengthM = /([0-9,]+)m\s*／\s*￥/.exec(candidateText)?.[1];
  const filmTotal = /フィルム\s*￥([0-9,]+)/.exec(candidateText)?.[1];
  if (!orderLengthM || !filmTotal) throw new Error("Unable to parse candidate film figures");

  await candidate.click();
  await expect(page.getByTestId("active-candidate-note")).toContainText("選択候補（グラビア印刷）");
  await expect(page.getByTestId("server-result")).toHaveAttribute("data-state", "calculated");
  return { orderLengthM, filmTotal };
}

test("fresh selected gravure candidate carries film planning and cost into the quotation", async ({ page }) => {
  const { orderLengthM, filmTotal } = await prepareSelectedGravureCandidate(page);

  const filmCost = page.getByTestId("cost-film");
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
  await page.getByRole("link", { name: "見積書発行" }).click();
  await expect(page).toHaveURL(/\/quote$/);
  await expect(page.getByTestId("stale-quote-warning")).toBeVisible();
  await expect(page.getByTestId("save-history")).toBeDisabled();
  await expect(page.getByTestId("print-pdf")).toBeDisabled();
  await expect(page.getByTestId("open-checklist")).toBeDisabled();
});

test("explicit recalculation returns to the digital input basis", async ({ page }) => {
  await prepareSelectedGravureCandidate(page);

  await page.getByTestId("calculate-desktop").click();
  await expect(page.getByTestId("server-result")).toHaveAttribute("data-state", "calculated");
  await expect(page.getByTestId("input-summary")).toContainText("デジタル印刷");
  await expect(page.getByTestId("active-candidate-note")).toHaveCount(0);
  await expect(page.getByTestId("input-basis-card")).toHaveClass(/selected/);
});
