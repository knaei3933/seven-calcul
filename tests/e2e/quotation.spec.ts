import { expect, test } from "@playwright/test";

test("Japanese quotation UI calculates, validates, and separates customer output", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "パウチ見積計算" })).toBeVisible();
  await page.getByRole("button", { name: "計算して確定" }).click();
  await expect(page.getByText("サーバー確定")).toBeVisible();
  await expect(page.getByTestId("bulk-usage")).toContainText("392,000 ml");
  await expect(page.getByTestId("customer-total")).toContainText("¥");
  await expect(page.locator(".quote-sheet")).not.toContainText("総原価");
  await expect(page.locator(".quote-sheet")).not.toContainText("成功報酬");
});
