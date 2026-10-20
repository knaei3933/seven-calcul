import { expect, test, type Browser } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const accounts = [
  {
    email: "admin@pouch-e2e.test",
    name: "E2E Administrator",
    password: "admin-e2e-password",
    role: "admin" as const,
    statePath: join(tmpdir(), "pouch-playwright-admin-state.json"),
  },
  {
    email: "kanai-admin@kanei-trade.co.jp",
    name: "Kanai E2E Administrator",
    password: "kanai-e2e-password",
    role: "admin" as const,
    statePath: join(tmpdir(), "pouch-playwright-kanai-state.json"),
  },
] as const;

  test("signs in ordinary and privileged users and saves isolated browser states", async ({ browser }) => {
  for (const account of accounts) {
    const context = await (browser as Browser).newContext();
    const page = await context.newPage();
    await page.goto("/login?next=%2F");
    await expect(page.getByRole("heading", { name: "ログイン" })).toBeVisible();
    await page.getByTestId("login-email").fill(account.email);
    await page.getByTestId("login-password").fill(account.password);
    await page.getByTestId("login-submit").click();
    await expect(page).toHaveURL(/:\d{4}\/$/);
    await expect(page.getByTestId("current-user")).toContainText(account.name);
    await expect(page.getByTestId("current-user")).toContainText(account.email);
    await page.context().storageState({ path: account.statePath });
    await context.close();
  }
});
