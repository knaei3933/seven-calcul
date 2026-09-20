import { expect, test } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("signs in the seeded administrator and saves an authenticated browser state", async ({ page }) => {
  await page.goto("/history");
  await expect(page).toHaveURL(/\/login\?next=%2Fhistory$/);
  await expect(page.getByRole("heading", { name: "ログイン" })).toBeVisible();
  await page.getByTestId("login-email").fill("admin@pouch-e2e.test");
  await page.getByTestId("login-password").fill("admin-e2e-password");
  await page.getByTestId("login-submit").click();
  await expect(page).toHaveURL(/\/history$/);
  await expect(page.getByTestId("current-user")).toContainText("E2E Administrator");
  await expect(page.getByTestId("current-user")).toContainText("admin@pouch-e2e.test");
  await page.context().storageState({ path: join(tmpdir(), "pouch-playwright-admin-state.json") });
});
