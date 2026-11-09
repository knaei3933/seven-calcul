import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { QuotationRecordInput } from "./quotation-shared";
import { quotationOwnerProfile, type QuoteOwnerProfile } from "./quote-owner-profiles";

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

export const CANONICAL_QUOTATION_PDF_RENDERER_VERSION = "standard-quotation-pdf/2";
const CANONICAL_QUOTATION_PDF_SAVE_OPTIONS = {
  useObjectStreams: true,
  addDefaultPage: false,
  updateFieldAppearances: false,
} as const;

const PINNED_FONT_FILES = {
  regular: { path: "src/fonts/NotoSansJP-Quotation-Regular.ttf", sha256: "3ca8c2d4d31ad7d19b53e96f6c8454ba0fe160861efd8aee4fe942f4a5b538d4" },
  bold: { path: "src/fonts/NotoSansJP-Quotation-Bold.ttf", sha256: "f4c37b6c907599a31df90cc532e40b6f9233c5b744dfdcbe35de61fc677819b2" },
} as const;

const PINNED_BRAND_ASSET_FILES = {
  kanei: {
    logo: { path: "assets/brand/kanei-trade-logo.png", sha256: "d16e0d426493556dad733776a6e7094c73a828b0f764eed7036c3517d44341b5" },
    seal: { path: "assets/brand/kanei-trade-seal.png", sha256: "2fda5252f42b562fa8ca25c3366e09df4110b22bbbc7cef12060a1fc4d0fa29d" },
  },
  seven: {
    logo: { path: "public/seven-chemical-logo.png", sha256: "4b10c1518616c26e73bd03a2a5c606f59dc2de0bc3d43148a24d2a120c21f4e0" },
    seal: null,
  },
} as const;

export class CanonicalQuotationPdfAssetError extends Error {
  readonly role: string;
  readonly path: string;
  readonly expectedSha256: string;
  readonly actualSha256?: string;

  constructor(role: string, assetPath: string, expectedSha256: string, actualSha256?: string) {
    super(`canonical_quotation_pdf_asset_mismatch:${role}`);
    this.name = "CanonicalQuotationPdfAssetError";
    this.role = role;
    this.path = assetPath;
    this.expectedSha256 = expectedSha256;
    this.actualSha256 = actualSha256;
  }
}

export type CanonicalQuotationPdfProvenance = {
  rendererVersion: string;
  saveOptions: typeof CANONICAL_QUOTATION_PDF_SAVE_OPTIONS;
  fonts: Record<"regular" | "bold", { sha256: string }>;
  assets: Record<"logo" | "seal", { sha256: string } | null>;
  outputSha256: string;
};

export type CanonicalQuotationPdf = {
  bytes: Buffer;
  provenance: CanonicalQuotationPdfProvenance;
};

type AssetReader = (assetPath: string) => Promise<Uint8Array>;

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readPinnedAsset(
  role: string,
  pinned: { path: string; sha256: string },
  readFileAsset: AssetReader,
): Promise<Uint8Array> {
  let bytes: Uint8Array;
  try {
    bytes = await readFileAsset(pinned.path);
  } catch (error) {
    if (error instanceof CanonicalQuotationPdfAssetError) throw error;
    throw new CanonicalQuotationPdfAssetError(role, pinned.path, pinned.sha256);
  }
  const actualSha256 = sha256Bytes(bytes);
  if (actualSha256 !== pinned.sha256) {
    throw new CanonicalQuotationPdfAssetError(role, pinned.path, pinned.sha256, actualSha256);
  }
  return bytes;
}

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
    maxLines?: number;
  },
): void {
  const lineHeight = options.lineHeight ?? options.size * 1.6;
  let lines = text(value, options.fallback).split("\n");
  const wrappedLines: string[] = [];
  for (const sourceLine of lines) {
    let current = "";
    for (const character of Array.from(sourceLine)) {
      const candidate = current + character;
      if (current && font.widthOfTextAtSize(candidate, options.size) > options.width) {
        wrappedLines.push(current);
        current = character;
      } else current = candidate;
    }
    if (current) wrappedLines.push(current);
  }
  if (options.maxLines != null && wrappedLines.length > options.maxLines) {
    lines = wrappedLines.slice(0, options.maxLines);
    lines[lines.length - 1] = `${lines[lines.length - 1].slice(0, Math.max(0, lines[lines.length - 1].length - 1))}…`;
  }
  for (const sourceLine of lines) {
    if (drawPage.y - lineHeight < 52) drawPage.newPage();
    drawPage.page.drawText(sourceLine, {
      x: options.x,
      y: drawPage.y,
      size: options.size,
      font,
      color: options.color ?? INK,
    });
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
  fontRegular: Uint8Array,
  fontBold: Uint8Array,
  logo: Uint8Array | null,
  seal: Uint8Array | null = null,
): Promise<Buffer> {
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  document.setTitle(`お見積書 ${model.quotationNumber}`);
  document.setAuthor(model.issuerName);
  document.setSubject("お見積書");
  document.setProducer(`pouch ${CANONICAL_QUOTATION_PDF_RENDERER_VERSION}`);
  document.setCreator("pouch canonical quotation renderer");
  const businessTime = new Date(`${model.issueDate}T00:00:00+09:00`);
  if (Number.isNaN(businessTime.getTime())) throw new Error("invalid_quotation_issue_date");
  document.setCreationDate(businessTime);
  document.setModificationDate(businessTime);
  // CJK subset embedding can drop glyphs in fontkit; embed the complete quote font.
  const regular = await document.embedFont(new Uint8Array(fontRegular), { subset: true });
  const bold = await document.embedFont(new Uint8Array(fontBold), { subset: true });
  const flow: DrawPage = {
    page: document.addPage([A4_WIDTH, A4_HEIGHT]),
    y: A4_HEIGHT - TOP_MARGIN,
    newPage: () => {
      flow.page = document.addPage([A4_WIDTH, A4_HEIGHT]);
      flow.y = A4_HEIGHT - TOP_MARGIN;
    },
  };

  if (logo) {
    const png = await document.embedPng(new Uint8Array(logo));
    const width = 82;
    const height = (png.height / png.width) * width;
    flow.page.drawImage(png, { x: MARGIN_X, y: flow.y - height + 12, width, height });
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
  flow.y -= 96;

  flow.page.drawRectangle({
    x: MARGIN_X,
    y: flow.y - 76,
    width: CONTENT_WIDTH,
    height: 84,
    color: PANEL,
    borderColor: LINE,
    borderWidth: 0.7,
  });
  flow.y -= 12;
  drawWrapped(flow, regular, text(model.customerPostalCode), { x: MARGIN_X + 14, width: CONTENT_WIDTH - 28, size: 9.8, color: MUTED, lineHeight: 15, fallback: "〒" });
  drawWrapped(flow, bold, text(model.customerAddress), { x: MARGIN_X + 14, width: CONTENT_WIDTH - 28, size: 11.8, lineHeight: 17, fallback: "得意先住所未入力" });
  drawWrapped(flow, bold, text(model.customerName, "得意先名未入力"), { x: MARGIN_X + 14, width: CONTENT_WIDTH - 28, size: 15.5, lineHeight: 21, fallback: "得意先名未入力" });
  drawWrapped(flow, regular, `${text(model.customerContact) ? `${text(model.customerContact)} 御中` : "御中"}`, { x: MARGIN_X + 14, width: CONTENT_WIDTH - 28, size: 11.4, lineHeight: 17, fallback: "御中" });
  drawWrapped(flow, regular, `顧客コード：${text(model.customerCode, "-")}　メール：${text(model.customerEmail, "-")}`, { x: MARGIN_X + 14, width: CONTENT_WIDTH - 28, size: 9.4, color: MUTED, lineHeight: 14 });
  flow.y -= 84;

  drawWrapped(flow, regular, text(model.greeting), { x: MARGIN_X, width: CONTENT_WIDTH, size: 10.4, lineHeight: 15 });
  drawSectionHeading(flow, bold, "お見積製品仕様");
  drawLabelValueRow(flow, { regular, bold }, "品名", text(model.productName, "-"), 84);
  drawLabelValueRow(flow, { regular, bold }, "パウチ仕様", text(model.sizeSummary, "-"), 84);
  drawLabelValueRow(flow, { regular, bold }, "数量", `${model.quantity} 枚`, 84);
  drawLabelValueRow(flow, { regular, bold }, "充填仕様", text(model.fillingSpec, "-"), 84);
  if (model.bulkUsage) drawLabelValueRow(flow, { regular, bold }, "バルク量", model.bulkUsage, 84);
  drawLabelValueRow(flow, { regular, bold }, "フィルム構成", text(model.filmComposition, "-"), 84);
  if (model.skuSummary) drawLabelValueRow(flow, { regular, bold }, "SKU", model.skuSummary, 84);

  flow.y -= 4;
  flow.page.drawRectangle({ x: MARGIN_X, y: flow.y - 52, width: CONTENT_WIDTH, height: 62, color: PANEL, borderColor: LINE, borderWidth: 0.7 });
  flow.page.drawRectangle({ x: MARGIN_X, y: flow.y - 52, width: 4, height: 62, color: PRIMARY });
  flow.page.drawText("お見積単価（税抜）", { x: MARGIN_X + 14, y: flow.y - 14, size: 10.5, font: regular, color: MUTED });
  flow.page.drawText(model.priceUnit, { x: MARGIN_X + 14, y: flow.y - 42, size: 16, font: bold, color: INK });
  flow.page.drawText("数量", { x: MARGIN_X + 230, y: flow.y - 14, size: 10.5, font: regular, color: MUTED });
  flow.page.drawText(model.quantity, { x: MARGIN_X + 230, y: flow.y - 42, size: 16, font: bold, color: INK });
  flow.page.drawText("税込合計", { x: MARGIN_X + 352, y: flow.y - 14, size: 10.5, font: regular, color: MUTED });
  flow.page.drawText(model.taxIncluded, { x: MARGIN_X + 352, y: flow.y - 42, size: 16, font: bold, color: INK });
  flow.y -= 68;

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
    flow.y -= 30;
  }

  drawSectionHeading(flow, bold, "納期・お支払い条件");
  drawLabelValueRow(flow, { regular, bold }, "納期", text(model.deliveryDate, "-"), 108);
  drawLabelValueRow(flow, { regular, bold }, "お支払い条件", text(model.paymentTerms, "-"), 108);
  drawLabelValueRow(flow, { regular, bold }, "見積有効期限", text(model.validUntil, "-"), 108);
  const noteBottomReserve = 184;
  const noteMaxLines = Math.max(1, Math.floor((flow.y - noteBottomReserve) / 12));
  drawWrapped(flow, regular, text(model.notes), { x: MARGIN_X, width: CONTENT_WIDTH, size: 9.6, color: INK, lineHeight: 12, maxLines: noteMaxLines });

  ensureSpace(flow, 122);
  flow.page.drawRectangle({ x: MARGIN_X, y: 62, width: CONTENT_WIDTH, height: 90, color: PANEL, borderColor: LINE, borderWidth: 0.7 });
  drawWrapped(flow, regular, text(model.footerNote), { x: MARGIN_X + 12, width: 318, size: 9.8, color: INK, lineHeight: 16 });
  flow.page.drawText(text(model.footerCompanyName), { x: A4_WIDTH - MARGIN_X - 12 - bold.widthOfTextAtSize(text(model.footerCompanyName), 10.2), y: 124, size: 10.2, font: bold, color: INK });
  flow.page.drawText(text(model.footerEmail), { x: A4_WIDTH - MARGIN_X - 12 - regular.widthOfTextAtSize(text(model.footerEmail), 9.8), y: 107, size: 9.8, font: regular, color: INK });
  flow.page.drawText(text(model.footerTelephone), { x: A4_WIDTH - MARGIN_X - 12 - regular.widthOfTextAtSize(text(model.footerTelephone), 9.8), y: 91, size: 9.8, font: regular, color: INK });
  if (seal) {
    const sealImage = await document.embedPng(new Uint8Array(seal));
    const width = 56;
    const height = (sealImage.height / sealImage.width) * width;
    flow.page.drawImage(sealImage, { x: A4_WIDTH - MARGIN_X - 74, y: 54, width, height });
  } else {
    flow.page.drawCircle({ x: A4_WIDTH - MARGIN_X - 74, y: 82, size: 28, borderColor: rgb(0.72, 0.11, 0.11), borderWidth: 1.8 });
  }
  flow.page.drawText(text(model.approverName), { x: A4_WIDTH - MARGIN_X - 74 - bold.widthOfTextAtSize(text(model.approverName), 7.2) / 2 + 14, y: 91, size: 7.2, font: bold, color: rgb(0.72, 0.11, 0.11) });
  flow.page.drawText(text(model.sealText), { x: A4_WIDTH - MARGIN_X - 74 - bold.widthOfTextAtSize(text(model.sealText), 7.2) / 2 + 14, y: 78, size: 7.2, font: bold, color: rgb(0.72, 0.11, 0.11) });

  const bytes = await document.save({ ...CANONICAL_QUOTATION_PDF_SAVE_OPTIONS });
  return Buffer.from(bytes);
}

export async function renderCanonicalQuotationPdf(
  model: StandardQuotePdfModel,
  ownerDomain: "kanei" | "seven",
  readFileAsset: AssetReader = async (assetPath) => {
    if (assetPath === PINNED_FONT_FILES.regular.path) {
      return readFile(path.join(process.cwd(), "src", "fonts", "NotoSansJP-Quotation-Regular.ttf"));
    }
    if (assetPath === PINNED_FONT_FILES.bold.path) {
      return readFile(path.join(process.cwd(), "src", "fonts", "NotoSansJP-Quotation-Bold.ttf"));
    }
    if (assetPath === PINNED_BRAND_ASSET_FILES.kanei.logo.path) {
      return readFile(path.join(process.cwd(), "assets", "brand", "kanei-trade-logo.png"));
    }
    if (assetPath === PINNED_BRAND_ASSET_FILES.kanei.seal?.path) {
      return readFile(path.join(process.cwd(), "assets", "brand", "kanei-trade-seal.png"));
    }
    if (assetPath === PINNED_BRAND_ASSET_FILES.seven.logo.path) {
      return readFile(path.join(process.cwd(), "public", "seven-chemical-logo.png"));
    }
    throw new CanonicalQuotationPdfAssetError("unknown", assetPath, "");
  },
): Promise<CanonicalQuotationPdf> {
  const regularBytes = await readPinnedAsset("font:regular", PINNED_FONT_FILES.regular, readFileAsset);
  const boldBytes = await readPinnedAsset("font:bold", PINNED_FONT_FILES.bold, readFileAsset);
  const brandAssets = PINNED_BRAND_ASSET_FILES[ownerDomain];
  const logoBytes = await readPinnedAsset("brand:logo", brandAssets.logo, readFileAsset);
  const sealBytes = brandAssets.seal
    ? await readPinnedAsset("brand:seal", brandAssets.seal, readFileAsset)
    : null;

  const bytes = await generateStandardQuotationPdf(model, regularBytes, boldBytes, logoBytes, sealBytes);
  return {
    bytes,
    provenance: {
      rendererVersion: CANONICAL_QUOTATION_PDF_RENDERER_VERSION,
      saveOptions: CANONICAL_QUOTATION_PDF_SAVE_OPTIONS,
      fonts: {
        regular: { sha256: PINNED_FONT_FILES.regular.sha256 },
        bold: { sha256: PINNED_FONT_FILES.bold.sha256 },
      },
      assets: {
        logo: { sha256: brandAssets.logo.sha256 },
        seal: brandAssets.seal ? { sha256: brandAssets.seal.sha256 } : null,
      },
      outputSha256: sha256Bytes(bytes),
    },
  };
}

function safeText(value: unknown, maxLength: number, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  return normalized.slice(0, maxLength) || fallback;
}

function safeAmount(value: unknown): string {
  const normalized = safeText(value, 40);
  return /^\d+(?:\.\d+)?$/u.test(normalized) && Number(normalized) > 0 ? normalized : "";
}

function money(value: string): string {
  return `¥${value}`;
}

function positiveAmount(value: unknown): boolean {
  return safeAmount(value) !== "";
}

export function buildCanonicalQuotationPdfModel(
  input: QuotationRecordInput,
  quotationNumber: string,
  ownerDomain: "kanei" | "seven" = "kanei",
  profileOverride?: QuoteOwnerProfile,
): StandardQuotePdfModel {
  const profile = profileOverride ?? quotationOwnerProfile(ownerDomain);
  if (!profile) throw new Error("canonical_quotation_owner_profile_missing");
  const payload = input.payload;
  const contact = payload.footerContact as { companyName?: unknown; contactName?: unknown; email?: unknown; telephone?: unknown } | undefined;
  const contactEmail = /^\S+@\S+\.\S+$/u.test(safeText(contact?.email, 200))
    ? safeText(contact?.email, 200)
    : profile.defaultContactEmail;
  const rows: StandardQuotePdfRow[] = [];
  const bulkAmount = safeAmount(payload.bulkAmountDisplay);
  if (bulkAmount) {
    rows.push({
      name: safeText(payload.bulkItemName, 160, "バルク液体"),
      description: safeText(payload.bulkItemDescription, 360, "バルク液体"),
      unit: `${safeText(payload.bulkUnitDisplay, 40)} /g`,
      quantity: `${safeText(payload.calculationChecklistSnapshot && typeof payload.calculationChecklistSnapshot === "object"
        ? (payload.calculationChecklistSnapshot as { bulkUsageMl?: unknown }).bulkUsageMl
        : "", 40, "0")} g`,
      amount: money(bulkAmount),
    });
  }
  const fillingAmount = safeAmount(payload.fillingAmountDisplay);
  if (fillingAmount) {
    rows.push({
      name: safeText(payload.fillingItemName, 160, "充填・加工"),
      description: safeText(payload.fillingItemDescription, 360, "充填および加工"),
      unit: `${safeText(payload.fillingUnitDisplay, 40)} /枚`,
      quantity: `${safeText(input.quantity, 40)} 枚`,
      amount: money(fillingAmount),
    });
  }
  const filmAmount = safeAmount(payload.filmAmountDisplay);
  if (filmAmount) {
    rows.push({
      name: safeText(payload.filmItemName, 160, "フィルム"),
      description: [
        payload.printingMethod === "gravure" ? "グラビア印刷" : "デジタル印刷",
        safeText(payload.filmComposition, 200),
      ].filter(Boolean).join("／"),
      unit: `${safeText(payload.filmUnitDisplay, 40)} /m\n${safeText(payload.filmPouchUnitDisplay, 40)} /枚`,
      quantity: `${safeText(input.filmOrderLengthM, 40)} m`,
      amount: money(filmAmount),
    });
  }
  const copperAmount = safeAmount(payload.copperAmountDisplay);
  if (copperAmount) {
    rows.push({
      name: safeText(payload.copperItemName, 160, "銅版"),
      description: safeText(payload.copperItemDescription, 360, "グラビア印刷用銅版"),
      unit: `${safeText(payload.copperUnitDisplay, 40)} /色`,
      quantity: `${safeText(payload.copperColorCount, 40)} 色`,
      amount: money(copperAmount),
    });
  }
  const setupAmount = safeAmount(payload.setupAmountDisplay);
  if (setupAmount) {
    rows.push({
      name: safeText(payload.setupItemName, 160, "セットアップ"),
      description: safeText(payload.setupItemDescription, 360, "セットアップ制作"),
      unit: `${safeText(payload.setupUnitDisplay, 40)} /個`,
      quantity: `${safeText(payload.setupQuantity, 40, "1")} 個`,
      amount: money(setupAmount),
    });
  }
  const customAmount = safeAmount(payload.customAmountDisplay);
  if (customAmount) {
    rows.push({
      name: safeText(payload.customItemName, 160, "カスタム制作"),
      description: safeText(payload.customItemDescription, 360, "カスタム制作"),
      unit: `${safeText(payload.customUnitDisplay, 40)} /個`,
      quantity: `${safeText(payload.customQuantity, 40, "1")} 個`,
      amount: money(customAmount),
    });
  }
  if (rows.length === 0 && positiveAmount(input.subtotal)) {
    rows.push({
      name: safeText(input.productName, 500, "製品"),
      description: safeText(input.sizeSummary, 300),
      unit: "—",
      quantity: `${safeText(input.quantity, 40)} 枚`,
      amount: money(safeAmount(input.subtotal)),
    });
  }

  return {
    issuerName: profile.legalName,
    issuerEnglishName: profile.englishName,
    issuerPostalCode: profile.postalCode,
    issuerAddress: profile.address,
    issuerTelephone: profile.telephone,
    issuerWebsite: profile.website,
    documentEnglish: profile.documentEnglish,
    documentHeading: profile.documentHeading,
    quotationNumber: safeText(quotationNumber, 60),
    issueDate: safeText(input.issueDate, 10),
    customerPostalCode: safeText(payload.customerPostalCode, 20),
    customerAddress: safeText(payload.customerAddress, 500),
    customerName: safeText(input.customerName, 300),
    customerContact: safeText(input.customerContact, 200),
    customerCode: safeText(payload.customerCode, 80),
    customerEmail: safeText(payload.customerEmail, 200),
    greeting: safeText(payload.greeting, 1000, "下記の通りお見積りを申し上げます。"),
    productName: safeText(input.productName, 500),
    sizeSummary: safeText(input.sizeSummary, 300),
    quantity: `${safeText(input.quantity, 40)} 枚`,
    fillingSpec: safeText(payload.fillingUnitDisplay, 100),
    bulkUsage: positiveAmount(payload.bulkAmountDisplay) ? safeText(payload.bulkItemName, 160, "バルク液体") : null,
    filmComposition: safeText(payload.filmComposition, 300),
    skuSummary: Array.isArray(payload.skuNames)
      ? (payload.skuNames as unknown[]).filter((item): item is string => typeof item === "string" && item.trim() !== "").join(" / ").slice(0, 500)
      : "",
    priceUnitLabel: "単価",
    priceUnit: money(safeText(input.pricePerPiece, 40, "0")),
    taxIncludedLabel: "税込合計",
    taxIncluded: money(safeText(input.grandTotal, 40, "0")),
    rows,
    subtotalLabel: safeText(input.notes, 1) === "" ? "小計" : "小計",
    subtotal: money(safeText(input.subtotal, 40, "0")),
    taxLabel: "消費税",
    tax: money(safeText(input.tax, 40, "0")),
    grandTotalLabel: "合計金額",
    grandTotal: money(safeText(input.grandTotal, 40, "0")),
    deliveryDate: safeText(input.deliveryDate, 200, "-"),
    paymentTerms: safeText(input.paymentTerms, 500, "-"),
    validUntil: safeText(input.validUntil, 10, "-"),
    notes: safeText(input.notes, 2000),
    footerNote: profile.approvalFooterNote,
    footerCompanyName: safeText(contact?.companyName, 200, profile.legalName),
    footerEmail: contactEmail,
    footerTelephone: safeText(contact?.telephone, 100, profile.defaultContactTelephone),
    approverName: safeText(payload.approverName, 100, safeText(contact?.contactName, 100)),
    sealText: safeText(payload.sealText, 20, "検討済"),
  };
}
