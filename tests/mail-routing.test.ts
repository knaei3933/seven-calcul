// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

const original = { ...process.env };

afterEach(() => {
  process.env = { ...original };
  vi.restoreAllMocks();
});

describe("mail routing override", () => {
  it("uses the business address when no global test override is configured", async () => {
    delete process.env.MAIL_RECIPIENT_OVERRIDE;
    const { resolveMailRoute } = await import("@/lib/mail-routing");
    expect(resolveMailRoute("customer@example.test")).toEqual({
      to: "customer@example.test",
      overridden: false,
    });
  });

  it("forces every mailer route to the configured test recipient", async () => {
    process.env.MAIL_RECIPIENT_OVERRIDE = "kim@kanei-trade.co.jp";
    const { resolveMailRoute } = await import("@/lib/mail-routing");
    expect(resolveMailRoute("customer@example.test")).toEqual({
      to: "kim@kanei-trade.co.jp",
      overridden: true,
    });
  });

  it("rejects an invalid test override instead of falling back to the customer", async () => {
    process.env.MAIL_RECIPIENT_OVERRIDE = "not-an-email";
    const { resolveMailRoute } = await import("@/lib/mail-routing");
    expect(() => resolveMailRoute("customer@example.test")).toThrow("invalid_mail_recipient_override");
  });

  it("prefers enabled settings test mode over the environment override", async () => {
    process.env.MAIL_RECIPIENT_OVERRIDE = "env@example.test";
    const { resolveMailRoute } = await import("@/lib/mail-routing");
    expect(resolveMailRoute("customer@example.test", {
      enabled: true,
      recipient: "kim@kanei-trade.co.jp",
    })).toEqual({
      to: "kim@kanei-trade.co.jp",
      overridden: true,
    });
  });

  it("returns the business recipient when settings test mode is disabled and no environment override remains", async () => {
    delete process.env.MAIL_RECIPIENT_OVERRIDE;
    const { resolveMailRoute } = await import("@/lib/mail-routing");
    expect(resolveMailRoute("supplier@example.co.kr", { enabled: false, recipient: "" })).toEqual({
      to: "supplier@example.co.kr",
      overridden: false,
    });
  });

  it("passes attachments and reports the actual recipient in the quotation mailer", async () => {
    process.env.MAIL_RECIPIENT_OVERRIDE = "kim@kanei-trade.co.jp";
    process.env.SMTP_HOST = "smtp.test";
    process.env.SMTP_USER = "sender@test";
    process.env.SMTP_PASS = "password";
    process.env.MAIL_DRY_RUN = "";
    const delivered: any[] = [];
    vi.doMock("nodemailer", () => ({
      default: {
        createTransport: () => ({
          sendMail: async (options: unknown) => {
            delivered.push(options);
            return { messageId: "quotation-mail-1" };
          },
        }),
      },
    }));
    const { sendMail } = await import("@/lib/mail-sender");
    const pdf = Buffer.from("%PDF-test");
    const result = await sendMail({
      to: "customer@example.test",
      subject: "quotation",
      body: "body",
      attachments: [{ filename: "S7-TEST-001.pdf", content: pdf, contentType: "application/pdf" }],
    });

    expect(result).toEqual({
      messageId: "quotation-mail-1",
      recipient: "kim@kanei-trade.co.jp",
      recipientOverridden: true,
    });
    expect(delivered[0].to).toBe("kim@kanei-trade.co.jp");
    expect(delivered[0].subject).toBe("[お客様]quotation");
    expect(delivered[0].cc).toEqual([]);
    expect(Buffer.from(delivered[0].attachments[0].content)).toEqual(pdf);
  });

  it("applies the global override before film-workflow dry-run routing", async () => {
    process.env.MAIL_RECIPIENT_OVERRIDE = "kim@kanei-trade.co.jp";
    process.env.MAIL_DRY_RUN = "true";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { sendMail } = await import("@/lib/mailer");
    const result = await sendMail({ to: "supplier@example.test", subject: "film", text: "body" });
    expect(result.to).toBe("kim@kanei-trade.co.jp");
    expect(result.requestedTo).toBe("supplier@example.test");
    expect(result.recipientOverridden).toBe(true);
    expect(logSpy.mock.calls[0]?.[1]).toContain("kim@kanei-trade.co.jp");
  });
});
