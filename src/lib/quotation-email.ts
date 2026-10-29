import { formatCurrency, formatNumber } from "./serialization";
import type { QuotationRecord } from "./quotation-shared";

export interface QuotationEmailDocument {
  subject: string;
  body: string;
}

function recipientGreeting(record: QuotationRecord): string {
  const contact = record.customerContact.trim();
  return contact ? `${record.customerName}\n${contact} 様` : `${record.customerName} 御中`;
}

function displayDate(value: string): string {
  return value || "-";
}

export function buildCustomerQuotationEmail(
  record: QuotationRecord,
  approvalUrl: string,
  attachmentName: string,
  designAttachmentNames: string[] = [],
): QuotationEmailDocument {
  const subject = `お見積書 ${record.quotationNumber}（${record.productName || "お見積り"}）のご送付とご承認のお願い`;
  const body = [
    recipientGreeting(record),
    "",
    "いつも大変お世話になっております。パッケージラボでございます。",
    "",
    "このたびはお見積りのご依頼を賜り、誠にありがとうございます。",
    "下記の通りお見積書を作成いたしましたので、添付ファイルにてご送付申し上げます。",
    "",
    "【お見積り概要】",
    `見積番号：${record.quotationNumber}`,
    `品名：${record.productName || "-"}`,
    `仕様：${record.sizeSummary || "-"}`,
    `数量：${formatNumber(Number(record.quantity))} 枚`,
    `税込合計：${formatCurrency(record.grandTotal, 0)}`,
    `有効期限：${displayDate(record.validUntil)}`,
    "",
    "【お見積書PDF】",
    `添付ファイル：${attachmentName}`,
    "お手数ですが、金額・数量・仕様・納期条件は添付のお見積書をご確認ください。",
    ...(designAttachmentNames.length ? [
      "",
      "【入庫用データ（版下データ）】",
      ...designAttachmentNames.map((name) => `添付ファイル：${name}`),
      "デザイン・サイズがご依頼内容どおりか、入庫用データでご確認ください。",
      "入庫用データのご確認後、正式発注時にアップロード用URLを別途ご案内いたします。",
    ] : []),
    "",
    "【ご承認のお願い】",
    "ご内容をご確認のうえ、承認いただける場合は下記専用ページよりお手続きください。",
    approvalUrl,
    "",
    "※上記ページは、本メール添付のお見積書に対応した専用リンクです。",
    "※有効期限経過後、またはお見積内容変更後は承認できない場合がございます。",
    "※本メールに心当たりがない場合は、お手数ですが本メールを削除し、下記連絡先までご一報ください。",
    "",
    "ご不明な点がございましたら、お気軽にお問い合わせください。",
    "今後とも何卒よろしくお願い申し上げます。",
    "",
    "--",
    "パッケージラボ",
    "shapepouch@package-lab.com",
  ].join("\n");
  return { subject, body };
}
