import { expect, test } from "@playwright/test";

test("prints the simulator UI itself on A4 pages", async ({ page }) => {
  const liveViewportWidth = page.viewportSize()?.width ?? 1440;
  await page.goto("/");
  await page.getByTestId("calculate-desktop").click();
  await expect(page.getByTestId("server-result")).toHaveAttribute("data-state", "calculated");
  await page.getByTestId("recommendation-modal-close").click();

  const printButton = page.getByTestId("simulator-print-pdf");
  await expect(printButton).toBeVisible();
  await expect(printButton).toHaveText("A4出力（UIそのまま）");
  const initialCardState = await page.evaluate(() => ({
    total: document.querySelectorAll(".app-shell details").length,
    open: document.querySelectorAll(".app-shell details[open]").length,
  }));
  expect(initialCardState.total).toBeGreaterThan(0);
  expect(initialCardState.open).toBe(0);
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
  const printState = await page.evaluate(() => {
    return {
      mode: document.body.dataset.simulatorPrint,
      viewportMode: document.body.dataset.simulatorPrintViewport,
      capturedWidth: Number(document.body.dataset.simulatorPrintWidth),
      bodyWidth: document.body.style.width,
      zoom: document.body.style.zoom,
      headerDisplay: getComputedStyle(document.querySelector(".global-header")!).display,
      mainDisplay: getComputedStyle(document.querySelector(".simulator-page")!).display,
      layoutColumns: getComputedStyle(document.querySelector(".layout")!).gridTemplateColumns.split(" ").length,
      printReportCount: document.querySelectorAll(".simulator-a4, .simulator-print-report").length,
      openCardCount: document.querySelectorAll(".app-shell details[open]").length,
      totalCardCount: document.querySelectorAll(".app-shell details").length,
      formPanelBreakInside: getComputedStyle(document.querySelector(".layout > .panel")!).breakInside,
    };
  });
  expect(printState.mode).toBe("ui");
  expect(printState.capturedWidth).toBe(liveViewportWidth > 1100 ? 1440 : 390);
  expect(printState.bodyWidth).toBe(`${printState.capturedWidth}px`);
  expect(Number(printState.zoom)).toBeGreaterThan(0);
  expect(printState.headerDisplay).not.toBe("none");
  expect(printState.mainDisplay).not.toBe("none");
  expect(printState.printReportCount).toBe(0);
  expect(printState.layoutColumns).toBe(liveViewportWidth > 1100 ? 3 : 1);
  expect(printState.openCardCount).toBe(printState.totalCardCount);
  expect(printState.formPanelBreakInside).toBe("auto");
  await expect.poll(() => page.evaluate(async () => {
    await document.fonts.ready;
    return document.fonts.check("16px notoSansJP");
  })).toBe(true);

  await expect(page.locator(".app-header")).toContainText("パウチ参考原価・販売価格シミュレーター");
  await expect(page.locator(".panel", { hasText: "製品情報" })).toBeVisible();
  await expect(page.locator(".panel", { hasText: "原価・利益試算" })).toBeVisible();
  await expect(page.locator(".panel", { hasText: "検証・出力プレビュー" })).toBeVisible();

  const pdf = await page.pdf({
    format: "A4",
    printBackground: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
  });
  const pageCount = pdf.toString("latin1").match(/\/Type\s*\/Page\b/g)?.length ?? 0;
  expect(pageCount).toBeGreaterThan(0);

  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await expect.poll(() => page.evaluate(() => document.querySelectorAll(".app-shell details[open]").length)).toBe(0);
});
