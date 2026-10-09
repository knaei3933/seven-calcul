import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/api-auth";
import { getQuotation, updateQuotationStatus } from "@/lib/quotation-store";
import { sendMail, isSmtpConfigured } from "@/lib/mail-sender";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: Request, context: Context): Promise<NextResponse> {
  try {
    const user = await getSessionUser(request);
    if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    if (!isSmtpConfigured()) return NextResponse.json({ error: "smtp_not_configured" }, { status: 503 });

    const { id } = await context.params;
    const quotationId = Number(id);
    if (!Number.isInteger(quotationId) || quotationId <= 0) {
      return NextResponse.json({ error: "invalid_quotation_id" }, { status: 400 });
    }
    const record = await getQuotation(quotationId);
    if (!record) return NextResponse.json({ error: "quotation_not_found" }, { status: 404 });

    const email = typeof record.payload.customerEmail === "string" ? record.payload.customerEmail.trim() : "";
    if (!email) return NextResponse.json({ error: "customer_email_required" }, { status: 400 });

    const subject = `お見積書 ${record.quotationNumber} のご案内`;
    const body = [
      `${record.customerName} 御中`,
      ``,
      `お世話になっております。パッケージラボです。`,
      `お見積書 ${record.quotationNumber} をご案内いたします。`,
      ``,
      `品名：${record.productName}`,
      `数量：${Number(record.quantity).toLocaleString("ja-JP")} 枚`,
      `税込合計：¥${Number(record.grandTotal).toLocaleString("ja-JP")}`,
      `有効期限：${record.validUntil || "-"}`,
      ``,
      `ご確認のほどよろしくお願いいたします。`,
      `何かご不明な点がございましたら、お気軽にお問い合わせください。`,
      ``,
      `--`,
      `パッケージラボ`,
      `shapepouch@package-lab.com`,
    ].join("\n");

    await sendMail({ to: email, subject, body });
    const updated = await updateQuotationStatus(quotationId, "sent", user.id);
    if (!updated) return NextResponse.json({ error: "status_update_failed" }, { status: 500 });
    return NextResponse.json({ record: updated, sentTo: email });
  } catch (error) {
    if (error instanceof Error && error.message === "smtp_not_configured") {
      return NextResponse.json({ error: "smtp_not_configured" }, { status: 503 });
    }
    return NextResponse.json({ error: "send_failed" }, { status: 500 });
  }
}
