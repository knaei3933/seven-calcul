import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";

export type StandardQuotePdfRow = {
  name: string;
  description: string;
  unit: string;
  quantity: string;
  amount: string;
};

export type StandardQuotePdfModel = {
  issuerName: string;
  issuerEnglishName: string;
  issuerPostalCode: string;
  issuerAddress: string;
  issuerTelephone: string;
  issuerWebsite: string;
  documentEnglish: string;
  documentHeading: string;
  quotationNumber: string;
  issueDate: string;
  customerPostalCode: string;
  customerAddress: string;
  customerName: string;
  customerContact: string;
  customerCode: string;
  customerEmail: string;
  greeting: string;
  productName: string;
  sizeSummary: string;
  quantity: string;
  fillingSpec: string;
  bulkUsage: string | null;
  filmComposition: string;
  skuSummary: string;
  priceUnitLabel: string;
  priceUnit: string;
  taxIncludedLabel: string;
  taxIncluded: string;
  rows: StandardQuotePdfRow[];
  subtotalLabel: string;
  subtotal: string;
  taxLabel: string;
  tax: string;
  grandTotalLabel: string;
  grandTotal: string;
  deliveryDate: string;
  paymentTerms: string;
  validUntil: string;
  notes: string;
  footerNote: string;
  footerCompanyName: string;
  footerEmail: string;
  footerTelephone: string;
  approverName: string;
  sealText: string;
};

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MARGIN_X = 42;
const TOP_MARGIN = 42;
const CONTENT_WIDTH = A4_WIDTH - MARGIN_X * 2;

const INK = rgb(0.12, 0.16, 0.22);
const MUTED = rgb(0.34, 0.39, 0.45);
const PRIMARY = rgb(0.09, 0.28, 0.48);
const LINE = rgb(0.8, 0.84, 0.89);
const PANEL = rgb(0.97, 0.98, 0.99);

type FontPair = { regular: PDFFont; bold: PDFFont };
type DrawPage = { page: PDFPage; y: number; newPage: () => void };

function text(value: string | undefined | null, fallback = ""): string {
  const normalized = (value ?? "").replace(/\r\n?/g, "\n").trim();
  return normalized || fallback;
}

function drawWrapped(
  drawPage: DrawPage,
  font: PDFFont,
  value: string,
  options: {
    x: number;
    width: number;
    size: number;
    color?: ReturnType<typeof rgb>;
    lineHeight?: number;
    fallback?: string;
  },
): void {
  const lineHeight = options.lineHeight ?? options.size * 1.6;
  const lines = text(value, options.fallback).split("\n");
  for (const sourceLine of lines) {
    let current = "";
    if (drawPage.y - lineHeight < 52) drawPage.newPage();
    for (const character of Array.from(sourceLine)) {
      const candidate = current + character;
      if (current && font.widthOfTextAtSize(candidate, options.size) > options.width) {
        drawPage.page.drawText(current, {
          x: options.x,
          y: drawPage.y,
          size: options.size,
          font,
          color: options.color ?? INK,
        });
        drawPage.y -= lineHeight;
        drawPage.newPage();
        current = character;
      } else {
        current = candidate;
      }
    }
    if (current) {
      drawPage.page.drawText(current, {
        x: options.x,
        y: drawPage.y,
        size: options.size,
        font,
        color: options.color ?? INK,
      });
    }
    drawPage.y -= lineHeight;
  }
}

function ensureSpace(drawPage: DrawPage, required: number): void {
  if (drawPage.y - required < 52) drawPage.newPage();
}

function drawSectionHeading(drawPage: DrawPage, bold: PDFFont, label: string): void {
  ensureSpace(drawPage, 38);
  drawPage.page.drawRectangle({
    x: MARGIN_X,
    y: drawPage.y - 3,
    width: CONTENT_WIDTH,
    height: 22,
    color: PANEL,
    borderColor: LINE,
    borderWidth: 0.6,
  });
  drawPage.page.drawRectangle({
    x: MARGIN_X,
    y: drawPage.y - 3,
    width: 3,
    height: 22,
    color: PRIMARY,
  });
  drawPage.page.drawText(label, {
    x: MARGIN_X + 10,
    y: drawPage.y + 2,
    size: 11.5,
    font: bold,
    color: PRIMARY,
  });
  drawPage.y -= 34;
}

function drawLabelValueRow(
  drawPage: DrawPage,
  fonts: FontPair,
  label: string,
  value: string,
  labelWidth = 95,
): void {
  ensureSpace(drawPage, 22);
  drawPage.page.drawText(label, {
    x: MARGIN_X + 6,
    y: drawPage.y,
    size: 10.2,
    font: fonts.regular,
    color: MUTED,
  });
  drawWrapped(drawPage, fonts.bold, value, {
    x: MARGIN_X + labelWidth,
    width: CONTENT_WIDTH - labelWidth - 8,
    size: 10.8,
    lineHeight: 16,
  });
  drawPage.page.drawLine({
    start: { x: MARGIN_X, y: drawPage.y - 6 },
    end: { x: MARGIN_X + CONTENT_WIDTH, y: drawPage.y - 6 },
    color: LINE,
    thickness: 0.5,
  });
  drawPage.y -= 21;
}

function drawTableRow(
  drawPage: DrawPage,
  fonts: FontPair,
  row: StandardQuotePdfRow,
): void {
  drawWrapped(drawPage, fonts.bold, row.name, {
    x: MARGIN_X + 5,
    width: 210,
    size: 10.6,
    lineHeight: 15,
  });
  const bodyY = drawPage.y;
  drawWrapped(drawPage, fonts.regular, row.description, {
    x: MARGIN_X + 5,
    width: 210,
    size: 9.4,
    color: MUTED,
    lineHeight: 14,
    fallback: " ",
  });
  const required = Math.max(drawPage.y - bodyY, 34) + 12;
  drawPage.y = bodyY;
  ensureSpace(drawPage, required);
  drawPage.page.drawText(row.unit, {
    x: MARGIN_X + 225,
    y: bodyY,
    size: 10.6,
    font: fonts.bold,
    color: INK,
  });
  drawPage.page.drawText(row.quantity, {
    x: MARGIN_X + 325,
    y: bodyY,
    size: 10.6,
    font: fonts.regular,
    color: INK,
  });
  drawPage.page.drawText(row.amount, {
    x: MARGIN_X + CONTENT_WIDTH - 5 - fonts.bold.widthOfTextAtSize(row.amount, 10.6),
    y: bodyY,
    size: 10.6,
    font: fonts.bold,
    color: INK,
  });
  drawPage.page.drawLine({
    start: { x: MARGIN_X, y: bodyY - 18 },
    end: { x: MARGIN_X + CONTENT_WIDTH, y: bodyY - 18 },
    color: LINE,
    thickness: 0.5,
  });
  drawPage.y = bodyY - 33;
}

export async function generateStandardQuotationPdf(
  model: StandardQuotePdfModel,
  fontRegular: ArrayBuffer,
  fontBold: ArrayBuffer,
  logo: ArrayBuffer | null,
): Promise<Blob> {
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  document.setTitle(`お見積書 ${model.quotationNumber}`);
  document.setAuthor(model.issuerName);
  document.setProducer("Seven Chemical Quotation Suite");
  // CJK subset embedding can drop glyphs in fontkit; embed the complete quote font.
  const regular = await document.embedFont(new Uint8Array(fontRegular), { subset: false });
  const bold = await document.embedFont(new Uint8Array(fontBold), { subset: false });
  const flow: DrawPage = {
    page: document.addPage([A4_WIDTH, A4_HEIGHT]),
    y: A4_HEIGHT - TOP_MARGIN,
    newPage: () => {
      flow.page = document.addPage([A4_WIDTH, A4_HEIGHT]);
      flow.y = A4_HEIGHT - TOP_MARGIN;
    },
  };

  if (logo) {
    try {
      const png = await document.embedPng(logo);
      const width = 82;
      const height = (png.height / png.width) * width;
      flow.page.drawImage(png, { x: MARGIN_X, y: flow.y - height + 12, width, height });
    } catch {
      // ロゴが不正でも本文PDF生成は止めない。
    }
  }
  flow.page.drawText(text(model.issuerName), {
    x: MARGIN_X + 84,
    y: flow.y,
    size: 15.5,
    font: bold,
    color: INK,
  });
  flow.page.drawText(text(model.issuerEnglishName), {
    x: MARGIN_X + 84,
    y: flow.y - 17,
    size: 9.5,
    font: regular,
    color: MUTED,
  });
  flow.y -= 34;
  drawWrapped(flow, regular, `${text(model.issuerPostalCode)} ${text(model.issuerAddress)}`, {
    x: MARGIN_X + 84,
    width: 260,
    size: 9.8,
    color: MUTED,
    lineHeight: 15,
  });
  drawWrapped(flow, regular, `${text(model.issuerTelephone)}／${text(model.issuerWebsite)}`, {
    x: MARGIN_X + 84,
    width: 260,
    size: 9.8,
    color: MUTED,
    lineHeight: 15,
  });
  flow.page.drawText(text(model.documentEnglish, "QUOTATION"), {
    x: A4_WIDTH - MARGIN_X - regular.widthOfTextAtSize(text(model.documentEnglish, "QUOTATION"), 10),
    y: flow.y,
    size: 10,
    font: regular,
    color: PRIMARY,
  });
  flow.page.drawText(text(model.documentHeading, "お見積書"), {
    x: A4_WIDTH - MARGIN_X - bold.widthOfTextAtSize(text(model.documentHeading, "お見積書"), 23),
    y: flow.y - 29,
    size: 23,
    font: bold,
    color: INK,
  });
  flow.page.drawText(`見積番号 ${text(model.quotationNumber, "-")}`, {
    x: A4_WIDTH - MARGIN_X - bold.widthOfTextAtSize(`見積番号 ${text(model.quotationNumber, "-")}`, 11),
    y: flow.y - 56,
    size: 11,
    font: bold,
    color: INK,
  });
  flow.page.drawText(`発行日 ${text(model.issueDate, "-")}`, {
    x: A4_WIDTH - MARGIN_X - regular.widthOfTextAtSize(`発行日 ${text(model.issueDate, "-")}`, 10.5),
    y: flow.y - 75,
    size: 10.5,
    font: regular,
    color: MUTED,
  });
  flow.page.drawLine({
    start: { x: MARGIN_X, y: flow.y - 94 },
    end: { x: A4_WIDTH - MARGIN_X, y: flow.y - 94 },
    color: PRIMARY,
    thickness: 1.4,
  });
  flow.y -= 118;

  flow.page.drawRectangle({
    x: MARGIN_X,
    y: flow.y - 96,
    width: CONTENT_WIDTH,
    height: 112,
    color: PANEL,
    borderColor: LINE,
    borderWidth: 0.7,
  });
  flow.y -= 16;
  drawWrapped(flow, regular, text(model.customerPostalCode), { x: MARGIN_X + 14, width: CONTENT_WIDTH - 28, size: 9.8, color: MUTED, lineHeight: 15, fallback: "〒" });
  drawWrapped(flow, bold, text(model.customerAddress), { x: MARGIN_X + 14, width: CONTENT_WIDTH - 28, size: 11.8, lineHeight: 17, fallback: "得意先住所未入力" });
  drawWrapped(flow, bold, text(model.customerName, "得意先名未入力"), { x: MARGIN_X + 14, width: CONTENT_WIDTH - 28, size: 15.5, lineHeight: 21, fallback: "得意先名未入力" });
  drawWrapped(flow, regular, `${text(model.customerContact) ? `${text(model.customerContact)} 御中` : "御中"}`, { x: MARGIN_X + 14, width: CONTENT_WIDTH - 28, size: 11.4, lineHeight: 17, fallback: "御中" });
  drawWrapped(flow, regular, `顧客コード：${text(model.customerCode, "-")}　メール：${text(model.customerEmail, "-")}`, { x: MARGIN_X + 14, width: CONTENT_WIDTH - 28, size: 9.4, color: MUTED, lineHeight: 14 });
  flow.y -= 116;

  drawWrapped(flow, regular, text(model.greeting), { x: MARGIN_X, width: CONTENT_WIDTH, size: 11, lineHeight: 18 });
  drawSectionHeading(flow, bold, "お見積製品仕様");
  drawLabelValueRow(flow, { regular, bold }, "品名", text(model.productName, "-"), 84);
  drawLabelValueRow(flow, { regular, bold }, "パウチ仕様", text(model.sizeSummary, "-"), 84);
  drawLabelValueRow(flow, { regular, bold }, "数量", `${model.quantity} 枚`, 84);
  drawLabelValueRow(flow, { regular, bold }, "充填仕様", text(model.fillingSpec, "-"), 84);
  if (model.bulkUsage) drawLabelValueRow(flow, { regular, bold }, "バルク量", model.bulkUsage, 84);
  drawLabelValueRow(flow, { regular, bold }, "フィルム構成", text(model.filmComposition, "-"), 84);
  if (model.skuSummary) drawLabelValueRow(flow, { regular, bold }, "SKU", model.skuSummary, 84);

  flow.y -= 8;
  flow.page.drawRectangle({ x: MARGIN_X, y: flow.y - 62, width: CONTENT_WIDTH, height: 74, color: PANEL, borderColor: LINE, borderWidth: 0.7 });
  flow.page.drawRectangle({ x: MARGIN_X, y: flow.y - 62, width: 4, height: 74, color: PRIMARY });
  flow.page.drawText("お見積単価（税抜）", { x: MARGIN_X + 14, y: flow.y - 14, size: 10.5, font: regular, color: MUTED });
  flow.page.drawText(model.priceUnit, { x: MARGIN_X + 14, y: flow.y - 42, size: 16, font: bold, color: INK });
  flow.page.drawText("数量", { x: MARGIN_X + 230, y: flow.y - 14, size: 10.5, font: regular, color: MUTED });
  flow.page.drawText(model.quantity, { x: MARGIN_X + 230, y: flow.y - 42, size: 16, font: bold, color: INK });
  flow.page.drawText("税込合計", { x: MARGIN_X + 352, y: flow.y - 14, size: 10.5, font: regular, color: MUTED });
  flow.page.drawText(model.taxIncluded, { x: MARGIN_X + 352, y: flow.y - 42, size: 16, font: bold, color: INK });
  flow.y -= 88;

  drawSectionHeading(flow, bold, "お見積内容");
  flow.page.drawText("品名・仕様", { x: MARGIN_X + 5, y: flow.y, size: 11, font: bold, color: MUTED });
  flow.page.drawText("単価", { x: MARGIN_X + 240, y: flow.y, size: 11, font: bold, color: MUTED });
  flow.page.drawText("数量", { x: MARGIN_X + 342, y: flow.y, size: 11, font: bold, color: MUTED });
  flow.page.drawText("金額", { x: A4_WIDTH - MARGIN_X - 38, y: flow.y, size: 11, font: bold, color: MUTED });
  flow.y -= 24;
  flow.page.drawLine({ start: { x: MARGIN_X, y: flow.y + 8 }, end: { x: A4_WIDTH - MARGIN_X, y: flow.y + 8 }, color: LINE, thickness: 0.6 });

  for (const row of model.rows) {
    ensureSpace(flow, 72);
    const bodyY = flow.y;
    drawWrapped(flow, bold, row.name, { x: MARGIN_X + 5, width: 210, size: 11.2, lineHeight: 16 });
    const nameBottom = flow.y;
    flow.y = bodyY;
    drawWrapped(flow, regular, row.description, { x: MARGIN_X + 5, width: 210, size: 10, color: MUTED, lineHeight: 15, fallback: " " });
    const contentBottom = flow.y;
    flow.y = Math.min(bodyY, contentBottom);
    flow.page.drawText(row.unit, { x: MARGIN_X + 240, y: bodyY, size: 11, font: bold, color: INK });
    flow.page.drawText(row.quantity, { x: MARGIN_X + 342, y: bodyY, size: 11, font: regular, color: INK });
    flow.page.drawText(row.amount, { x: A4_WIDTH - MARGIN_X - 38 - bold.widthOfTextAtSize(row.amount, 11), y: bodyY, size: 11, font: bold, color: INK });
    flow.page.drawLine({ start: { x: MARGIN_X, y: flow.y - 8 }, end: { x: A4_WIDTH - MARGIN_X, y: flow.y - 8 }, color: LINE, thickness: 0.5 });
    flow.y = flow.y - 28;
  }

  flow.y -= 12;
  for (const [label, value, emphasized] of [
    [model.subtotalLabel, model.subtotal, false],
    [model.taxLabel, model.tax, false],
    [model.grandTotalLabel, model.grandTotal, true],
  ] as Array<[string, string, boolean]>) {
    ensureSpace(flow, 40);
    flow.page.drawRectangle({ x: A4_WIDTH - MARGIN_X - 272, y: flow.y - 10, width: 272, height: 30, color: emphasized ? PRIMARY : PANEL, borderColor: LINE, borderWidth: emphasized ? 0 : 0.5 });
    flow.page.drawText(label, { x: A4_WIDTH - MARGIN_X - 260, y: flow.y, size: 11, font: emphasized ? bold : regular, color: emphasized ? rgb(1, 1, 1) : MUTED });
    const font = emphasized ? bold : regular;
    flow.page.drawText(value, { x: A4_WIDTH - MARGIN_X - 14 - font.widthOfTextAtSize(value, emphasized ? 13 : 11), y: flow.y, size: emphasized ? 13 : 11, font, color: emphasized ? rgb(1, 1, 1) : INK });
    flow.y -= 37;
  }

  drawSectionHeading(flow, bold, "納期・お支払い条件");
  drawLabelValueRow(flow, { regular, bold }, "納期", text(model.deliveryDate, "-"), 108);
  drawLabelValueRow(flow, { regular, bold }, "お支払い条件", text(model.paymentTerms, "-"), 108);
  drawLabelValueRow(flow, { regular, bold }, "見積有効期限", text(model.validUntil, "-"), 108);
  drawWrapped(flow, regular, text(model.notes), { x: MARGIN_X, width: CONTENT_WIDTH, size: 10.4, color: INK, lineHeight: 17 });

  ensureSpace(flow, 122);
  flow.page.drawRectangle({ x: MARGIN_X, y: 62, width: CONTENT_WIDTH, height: 90, color: PANEL, borderColor: LINE, borderWidth: 0.7 });
  drawWrapped(flow, regular, text(model.footerNote), { x: MARGIN_X + 12, width: 318, size: 9.8, color: INK, lineHeight: 16 });
  flow.page.drawText(text(model.footerCompanyName), { x: A4_WIDTH - MARGIN_X - 12 - bold.widthOfTextAtSize(text(model.footerCompanyName), 10.2), y: 124, size: 10.2, font: bold, color: INK });
  flow.page.drawText(text(model.footerEmail), { x: A4_WIDTH - MARGIN_X - 12 - regular.widthOfTextAtSize(text(model.footerEmail), 9.8), y: 107, size: 9.8, font: regular, color: INK });
  flow.page.drawText(text(model.footerTelephone), { x: A4_WIDTH - MARGIN_X - 12 - regular.widthOfTextAtSize(text(model.footerTelephone), 9.8), y: 91, size: 9.8, font: regular, color: INK });
  flow.page.drawCircle({ x: A4_WIDTH - MARGIN_X - 74, y: 82, size: 28, borderColor: rgb(0.72, 0.11, 0.11), borderWidth: 1.8 });
  flow.page.drawText(text(model.approverName), { x: A4_WIDTH - MARGIN_X - 74 - bold.widthOfTextAtSize(text(model.approverName), 7.2) / 2 + 14, y: 91, size: 7.2, font: bold, color: rgb(0.72, 0.11, 0.11) });
  flow.page.drawText(text(model.sealText), { x: A4_WIDTH - MARGIN_X - 74 - bold.widthOfTextAtSize(text(model.sealText), 7.2) / 2 + 14, y: 78, size: 7.2, font: bold, color: rgb(0.72, 0.11, 0.11) });

  const bytes = await document.save({ useObjectStreams: true });
  return new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
}
