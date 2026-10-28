import { describe, expect, it } from "vitest";
import {
  MAIL_TEMPLATES,
  MAIL_TEMPLATE_DEFAULTS,
} from "@/lib/mail-template-catalog";

describe("mail template catalog", () => {
  it("has editable defaults for every registered template", () => {
    for (const template of MAIL_TEMPLATES) {
      const defaults = MAIL_TEMPLATE_DEFAULTS[template.key];
      expect(defaults, template.key).toBeTruthy();
      expect(defaults!.subject.trim(), `${template.key} subject`).not.toBe("");
      expect(defaults!.body.trim(), `${template.key} body`).not.toBe("");
      expect(defaults!.body).toContain("\n");
    }
  });

  it("has unique template keys and titles", () => {
    expect(new Set(MAIL_TEMPLATES.map((item) => item.key)).size).toBe(MAIL_TEMPLATES.length);
    expect(new Set(MAIL_TEMPLATES.map((item) => item.title)).size).toBe(MAIL_TEMPLATES.length);
  });
});
