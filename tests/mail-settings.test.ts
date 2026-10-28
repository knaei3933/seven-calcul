import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const databaseDirectory = await mkdtemp(join(tmpdir(), "mail-settings-"));
process.env.POUCH_QUOTATION_DB = join(databaseDirectory, "quotations.sqlite");
process.env.ADMIN_EMAIL = "admin@mail-settings.test";
process.env.ADMIN_PASSWORD = "mail-settings-admin-password";
process.env.ADMIN_NAME = "Mail Settings Admin";

const { ensureAdministratorSeed } = await import("@/lib/auth-store");
const { getMailSettings, resolveMailTemplate, saveMailSettings } = await import("@/lib/mail-settings");

afterAll(async () => {
  await rm(databaseDirectory, { recursive: true, force: true });
});

describe("mail settings", () => {
  it("persists sender, test routing, recipients, and template overrides", async () => {
    await ensureAdministratorSeed();
    const saved = await saveMailSettings({
      testMode: { enabled: true, recipient: "kim@kanei-trade.co.jp" },
      sender: { name: "Package Lab", email: "noreply@package-lab.com" },
      globalCc: ["qa@kanei-trade.co.jp"],
      recipients: {
        design: "design@package-lab.com",
        seven: "seven@727.co.jp",
        kaneiApprovals: "approval@kanei-trade.co.jp",
        supplierKorean: "sejung@example.co.kr",
        supplierJapanese: "maker@example.jp",
      },
      templates: {
        film_proof_request: {
          subject: "[세중산업/이패키지] {{orderNumber}} 교정 요청",
          body: "주문 {{orderNumber}} 확인 후 {{uploadUrl}} 로 제출하세요.",
          cc: ["cc@kanei-trade.co.jp"],
        },
      },
    }, "admin@mail-settings.test");

    const loaded = await getMailSettings();
    expect(loaded.testMode).toEqual({ enabled: true, recipient: "kim@kanei-trade.co.jp" });
    expect(loaded.sender.email).toBe("noreply@package-lab.com");
    expect(loaded.globalCc).toEqual(["qa@kanei-trade.co.jp"]);
    expect(loaded.recipients.supplierKorean).toBe("sejung@example.co.kr");
    expect(loaded.templates.film_proof_request?.subject).toContain("[세중산업/이패키지]");

    const rendered = resolveMailTemplate(loaded, "film_proof_request", {
      subject: "fallback",
      body: "fallback body",
    }, {
      orderNumber: "F-1",
      uploadUrl: "https://example.test/upload",
    });
    expect(rendered.subject).toBe("[세중산업/이패키지] F-1 교정 요청");
    expect(rendered.body).toBe("주문 F-1 확인 후 https://example.test/upload 로 제출하세요.");
    expect(rendered.cc).toEqual(["cc@kanei-trade.co.jp"]);
  });

  it("rejects invalid addresses", async () => {
    await expect(saveMailSettings({
      testMode: { enabled: true, recipient: "not-an-email" },
    }, "admin@mail-settings.test")).rejects.toThrow("invalid_test_recipient");
  });
});
