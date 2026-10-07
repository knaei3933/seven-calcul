import { expect, test } from "@playwright/test";
import { QUOTATION_DRAFT_KEY } from "../../src/lib/quotation-draft";

const longText = "LongProductName検証".repeat(6);

test.describe("quote PDF single-page fit", () => {
  test("default quotation prints on one A4 page", async ({ page }) => {
    await page.goto("/quote");
    await expect(page.locator("#quote-preview")).toBeVisible();
    const pdf = await page.pdf({ format: "A4", printBackground: true });
    const pages = countPdfPages(pdf);
    console.log("[default] pdf pages:", pages);
    expect(pages).toBe(1);
  });

  test("long quotation content still prints on one A4 page", async ({ page }) => {
    const draft = JSON.stringify({
      productSummary: longText,
      sizeSummary: `60×80mm / 2連 / ${longText}`,
      quantity: "50000",
      targetMargin: "0.3",
      fillingCostPerPiece: "4",
      filmCostPerPiece: "1",
      filmMeterPrice: "200",
      filmOrderLengthM: "3500",
      totalCostPerPiece: "10",
      calculationVersion: "verify",
      resultHash: "hash",
      calculationFilmTotal: "1000000",
      customerName: "非常に長い顧客名株式会社検証用",
      customerAddress: `東京都千代田区非常に長い住所検証 ${longText}`,
    });
    await page.addInitScript(([key, value]) => {
      window.sessionStorage.setItem(key!, value!);
    }, [QUOTATION_DRAFT_KEY, draft]);
    await page.goto("/quote");
    await expect(page.locator("#quote-preview")).toBeVisible();

    // A4 시트의 비고(contentEditable)를 길게 채워 최악 상황을 만든다.
    await page.locator('[aria-label="備考"]').fill(`備考検証。`.repeat(40));

    // 인쇄 CSS가 적용되지 않은 화면 상태에서 beforeprint가 불려도
    // (Firefox/Safari 등의 타이밍) 올바른 축소율이 계산되어야 한다.
    const screenDispatchedScale = await page.evaluate(() => {
      window.dispatchEvent(new Event("beforeprint"));
      const fit = document.querySelector<HTMLElement>(".quote-a4-fit");
      return Number(fit?.style.getPropertyValue("--quote-a4-fit-scale") ?? "1");
    });
    console.log("[long] screen-dispatched scale:", screenDispatchedScale);
    expect(screenDispatchedScale).toBeGreaterThan(0);
    expect(screenDispatchedScale).toBeLessThan(1);

    const pdf = await page.pdf({ format: "A4", printBackground: true });
    const pages = countPdfPages(pdf);
    console.log("[long] pdf pages:", pages);
    expect(pages).toBe(1);

    // 인쇄 미디어에서 beforeprint 핸들러가 실제로 내용을 시트 안에 맞추는지 확인한다.
    await page.emulateMedia({ media: "print" });
    const printFit = await page.evaluate(() => {
      window.dispatchEvent(new Event("beforeprint"));
      const fit = document.querySelector<HTMLElement>(".quote-a4-fit");
      const sheet = document.querySelector<HTMLElement>(".a4-sheet");
      const footer = document.querySelector<HTMLElement>(".sheet-footer");
      if (!fit || !sheet || !footer) return null;
      return {
        scale: fit.style.getPropertyValue("--quote-a4-fit-scale"),
        footerBottom: footer.getBoundingClientRect().bottom,
        sheetBottom: sheet.getBoundingClientRect().bottom,
      };
    });
    console.log("[long] print fit:", JSON.stringify(printFit));
    expect(printFit).not.toBeNull();
    expect(printFit!.footerBottom).toBeLessThanOrEqual(printFit!.sheetBottom + 0.5);
    await page.emulateMedia({ media: null });
  });
});

function countPdfPages(pdf: Buffer): number {
  const text = pdf.toString("latin1");
  const matches = text.match(/\/Type\s*\/Page(?![s/])/g);
  return matches ? matches.length : 0;
}
