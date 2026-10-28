import { expect, test } from "@playwright/test";

test("Kanei users can view, edit, save, and reload mail templates", async ({ page }) => {
  await page.goto("/settings/mail");
  await expect(page.getByRole("heading", { name: "メール送信設定" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "テストモード" })).toBeVisible();

  const templateButton = page.getByRole("button", { name: /필름 입고 데이터 알림/ });
  await expect(templateButton).toBeVisible();
  await templateButton.click();

  const defaultBody = page.getByTestId("default-body");
  await expect(defaultBody).toBeVisible();
  await expect(defaultBody).not.toHaveValue("");

  await page.getByRole("button", { name: "基本本文を読み込む" }).click();
  const overrideBody = page.getByTestId("override-body");
  await expect(overrideBody).not.toHaveValue("");
  const edited = `${await overrideBody.inputValue()}\nUI_LIVE_VERIFIED_FINAL`;

  await overrideBody.fill(edited);
  await page.getByRole("button", { name: "変更を保存" }).click();
  await expect(page.getByText("メール設定を保存しました。")).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: /필름 입고 데이터 알림/ }).click();
  await expect(page.getByTestId("override-body")).toHaveValue(edited);
  await expect(page.getByRole("button", { name: /필름 입고 데이터 알림/ })).toContainText("カスタム");
});
