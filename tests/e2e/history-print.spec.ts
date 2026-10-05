import { expect, test } from "@playwright/test";

test("history detail PDF keeps long content on two A4 pages", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("calculate-desktop").click();
  await expect(page.getByTestId("server-result")).toHaveAttribute("data-state", "calculated");
  await page.getByTestId("recommendation-modal-close").click();
  await page.getByRole("link", { name: "見積書発行" }).click();
  await page.getByTestId("save-history").click();
  await page.getByRole("link", { name: "見積履歴" }).click();
  await page.getByRole("button", { name: "詳細" }).first().click();
  await expect(page.getByLabel("見積詳細A4帳票")).toBeVisible();
  await expect(page.getByLabel("見積原価詳細A4帳票")).toBeVisible();

  await page.evaluate(() => {
    document.querySelectorAll(".history-a4-fit").forEach((fit, pageIndex) => {
      for (let index = 0; index < 40; index += 1) {
        const paragraph = document.createElement("p");
        paragraph.textContent = `印刷範囲検証 ${pageIndex + 1}-${index + 1}：長い保存データでもA4からはみ出しません。`;
        paragraph.style.cssText = "margin:0;font-size:9pt;line-height:1.5;";
        fit.appendChild(paragraph);
      }
    });
  });
  await page.emulateMedia({ media: "print" });
  await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));

  const fitResults = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>(".history-a4-fit")).map((element) => {
    const scale = Number(element.style.getPropertyValue("--history-a4-fit-scale") || "1");
    return {
      scale,
      zoom: getComputedStyle(element).zoom,
      requiredHeight: element.scrollHeight,
    };
  }));
  expect(fitResults).toHaveLength(2);
  for (const result of fitResults) {
    expect(result.scale).toBeGreaterThan(0);
    expect(result.scale).toBeLessThan(1);
    expect(result.requiredHeight * result.scale).toBeLessThan(result.requiredHeight);
    expect(result.zoom).toContain(String(result.scale).slice(0, 4));
  }

  const pdf = await page.pdf({
    format: "A4",
    printBackground: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
  });
  expect(pdf.toString("latin1").match(/\/Type\s*\/Page\b/g)).toHaveLength(2);
});
