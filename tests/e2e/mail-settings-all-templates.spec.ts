import { expect, test } from "@playwright/test";
import {
  MAIL_TEMPLATES,
  MAIL_TEMPLATE_DEFAULTS,
} from "../../src/lib/mail-template-catalog";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("verifies every mail template default, edit, save, and persistence", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/settings/mail");
  await expect(page.getByRole("heading", { name: "メール送信設定" })).toBeVisible();

  for (const template of MAIL_TEMPLATES) {
    const defaults = MAIL_TEMPLATE_DEFAULTS[template.key];
    expect(defaults, `missing default for ${template.key}`).toBeTruthy();
    expect(defaults!.subject.trim(), `missing default subject for ${template.key}`).not.toBe("");
    expect(defaults!.body.trim(), `missing default body for ${template.key}`).not.toBe("");

    const button = page.getByRole("button", {
      name: new RegExp(escapeRegExp(template.title)),
    });
    await button.click();

    await expect(page.getByTestId("default-subject")).toHaveValue(defaults!.subject);
    await expect(page.getByTestId("default-body")).toHaveValue(defaults!.body);

    await page.getByRole("button", { name: "基本本文を読み込む" }).click();
    const subjectMarker = `UI_ALL_SUBJECT_${template.key.toUpperCase()}`;
    const bodyMarker = `UI_ALL_BODY_${template.key.toUpperCase()}`;
    await page.getByTestId("override-subject").fill(`${defaults!.subject} [${subjectMarker}]`);
    await page.getByTestId("override-body").fill(`${defaults!.body}\n${bodyMarker}`);

  }

  await page.getByRole("button", { name: "変更を保存" }).click();
  await expect(page.getByText("メール設定を保存しました。")).toBeVisible();
  await page.reload();

  for (const template of MAIL_TEMPLATES) {
    const button = page.getByRole("button", {
      name: new RegExp(escapeRegExp(template.title)),
    });
    await button.click();
    const subjectMarker = `UI_ALL_SUBJECT_${template.key.toUpperCase()}`;
    const bodyMarker = `UI_ALL_BODY_${template.key.toUpperCase()}`;
    await expect(page.getByTestId("override-subject")).toHaveValue(new RegExp(escapeRegExp(subjectMarker)));
    await expect(page.getByTestId("override-body")).toHaveValue(new RegExp(escapeRegExp(bodyMarker)));
    await button.click();
  }
});
