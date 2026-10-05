import { expect, test } from "@playwright/test";

test("simulator results print as a two-page A4 report", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("calculate-desktop").click();
  await expect(page.getByTestId("server-result")).toHaveAttribute("data-state", "calculated");
  await page.getByTestId("recommendation-modal-close").click();

  const printButton = page.getByTestId("simulator-print-pdf");
  await expect(printButton).toBeVisible();
  await page.evaluate(() => {
    const scopedWindow = window as Window & { printCalls?: number };
    scopedWindow.printCalls = 0;
    window.print = () => {
      scopedWindow.printCalls = (scopedWindow.printCalls ?? 0) + 1;
    };
  });
  await printButton.click();
  await expect.poll(() => page.evaluate(() => (window as Window & { printCalls?: number }).printCalls)).toBe(1);

  await page.emulateMedia({ media: "print" });
  await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
  await expect(page.locator(".simulator-a4")).toHaveCount(2);
  await expect(page.locator(".simulator-a4").first()).toContainText("参考原価・販売価格シミュレーション");
  await expect(page.locator(".simulator-a4").nth(1)).toContainText("フィルム・製造計画");

  const pdf = await page.pdf({
    format: "A4",
    printBackground: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
  });
  expect(pdf.toString("latin1").match(/\/Type\s*\/Page\b/g)).toHaveLength(2);
});
