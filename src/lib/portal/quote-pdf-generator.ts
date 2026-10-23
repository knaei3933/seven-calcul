import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { PortalQuoteProjection } from "@/lib/portal/quote-projection";

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MARGIN_X = 52;
const MARGIN_Y = 56;
const CONTENT_WIDTH = A4_WIDTH - MARGIN_X * 2;
const BODY_SIZE = 10.5;
const LINE_HEIGHT = 17;
const MAX_TEXT_CODE_POINTS = 2_000;

type FontLayoutGlyph = { id: number; codePoints: readonly number[] };
type PdfLibCustomFontInternals = {
  embedder?: {
    font: { layout(text: string): { glyphs: FontLayoutGlyph[] } };
    glyphCache: { access: () => FontLayoutGlyph[] };
  };
};

export class PortalQuotePdfGenerationError extends Error {
  constructor() {
    super("portal_quote_pdf_generation_failed");
    this.name = "PortalQuotePdfGenerationError";
  }
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function normalizePdfText(value: string): string {
  const normalized = value.replace(/\r\n?/g, "\n").replace(/\s+$/g, "");
  if (codePointLength(normalized) > MAX_TEXT_CODE_POINTS) {
    const truncated = Array.from(normalized).slice(0, MAX_TEXT_CODE_POINTS).join("");
    return `${truncated}…`;
  }
  return normalized;
}

function drawPageFrame(page: PDFPage, font: PDFFont): void {
  page.drawRectangle({
    x: 32,
    y: 32,
    width: A4_WIDTH - 64,
    height: A4_HEIGHT - 64,
    borderColor: rgb(0.82, 0.85, 0.88),
    borderWidth: 0.8,
  });
  page.drawText("カネイトレード", {
    x: MARGIN_X,
    y: A4_HEIGHT - MARGIN_Y,
    size: 20,
    font,
    color: rgb(0.08, 0.18, 0.28),
  });
  page.drawText("お見積書", {
    x: MARGIN_X,
    y: A4_HEIGHT - MARGIN_Y - 32,
    size: 16,
    font,
    color: rgb(0.12, 0.16, 0.22),
  });
}

function drawParagraph(
  context: { page: PDFPage; cursor: number; newPage: () => void },
  font: PDFFont,
  input: { text: string; x: number; y: number; maxWidth: number; size?: number; color?: ReturnType<typeof rgb> },
): number {
  let y = input.y;
  const activePage = (): PDFPage => context.page;
  const ensureLineSpace = (): void => {
    if (y - LINE_HEIGHT < MARGIN_Y + 32) {
      context.newPage();
      y = context.cursor;
    }
  };
  for (const originalLine of input.text.split("\n")) {
    let currentLine = "";
    for (const character of Array.from(originalLine)) {
      const candidate = currentLine + character;
      if (currentLine && font.widthOfTextAtSize(candidate, input.size ?? BODY_SIZE) > input.maxWidth) {
        ensureLineSpace();
        activePage().drawText(currentLine, {
          x: input.x,
          y,
          size: input.size ?? BODY_SIZE,
          font,
          color: input.color ?? rgb(0.15, 0.18, 0.22),
        });
        currentLine = character;
        y -= LINE_HEIGHT;
      } else {
        currentLine = candidate;
      }
    }
    if (currentLine) {
      ensureLineSpace();
      activePage().drawText(currentLine, {
        x: input.x,
        y,
        size: input.size ?? BODY_SIZE,
        font,
        color: input.color ?? rgb(0.15, 0.18, 0.22),
      });
      y -= LINE_HEIGHT;
    }
  }
  return y;
}

function drawField(
  page: PDFPage,
  font: PDFFont,
  label: string,
  value: string,
  y: number,
  maxWidth = CONTENT_WIDTH,
): number {
  const text = normalizePdfText(value);
  page.drawText(label, {
    x: MARGIN_X,
    y,
    size: BODY_SIZE,
    font,
    color: rgb(0.35, 0.4, 0.46),
  });
  if (!text) return y - LINE_HEIGHT;
  return drawParagraph({ page, cursor: y, newPage: () => undefined }, font, {
    text,
    x: MARGIN_X + 105,
    y,
    maxWidth: Math.max(maxWidth - 105, 120),
  }) - 5;
}

function drawSummaryRow(
  page: PDFPage,
  font: PDFFont,
  label: string,
  value: string,
  y: number,
  emphasized = false,
): number {
  page.drawRectangle({
    x: MARGIN_X,
    y: y - 6,
    width: CONTENT_WIDTH,
    height: 26,
    color: emphasized ? rgb(0.9, 0.94, 0.97) : rgb(0.97, 0.98, 0.98),
  });
  page.drawText(label, {
    x: MARGIN_X + 12,
    y,
    size: BODY_SIZE,
    font,
    color: rgb(0.22, 0.28, 0.35),
  });
  const renderedValue = normalizePdfText(value) || "—";
  const width = font.widthOfTextAtSize(renderedValue, BODY_SIZE);
  page.drawText(renderedValue, {
    x: MARGIN_X + CONTENT_WIDTH - 14 - width,
    y,
    size: BODY_SIZE,
    font,
    color: rgb(0.08, 0.12, 0.18),
  });
  return y - 33;
}

export async function generatePortalQuotePdf(
  quote: PortalQuoteProjection,
  fontBytes: Uint8Array | ArrayBuffer,
): Promise<Buffer> {
  try {
    const document = await PDFDocument.create();
    document.registerFontkit(fontkit);
    document.setTitle(`お見積書 ${quote.quotationNumber}`, { showInWindowTitleBar: true });
    document.setAuthor("カネイトレード");
    document.setSubject("お見積書");
    document.setProducer("Kanei Trade Customer Portal");
    document.setCreationDate(new Date(quote.createdAt));
    const fontData = new Uint8Array(fontBytes as ArrayBuffer);
    // Full-font embedding is required: pdf-lib/fontkit's variable CFF/TTF
    // subset is visually incomplete. The ToUnicode map is repaired below for
    // reliable text extraction.
    const font = await document.embedFont(fontData, { subset: false });
    let page = document.addPage([A4_WIDTH, A4_HEIGHT]);
    const renderContext = {
      page,
      cursor: A4_HEIGHT - MARGIN_Y - 74,
      newPage: () => {
        newPage();
      },
    };
    let cursor = renderContext.cursor;

    const newPage = (): void => {
      page = document.addPage([A4_WIDTH, A4_HEIGHT]);
      renderContext.page = page;
      renderContext.cursor = A4_HEIGHT - MARGIN_Y - 8;
      cursor = A4_HEIGHT - MARGIN_Y - 8;
    };
    const ensureSpace = (required: number): void => {
      if (cursor - required < MARGIN_Y + 32) newPage();
    };

    drawPageFrame(page, font);
    page.drawText(quote.availability === "expired" ? "有効期限切れ" : "有効", {
      x: A4_WIDTH - MARGIN_X - 96,
      y: A4_HEIGHT - MARGIN_Y,
      size: 14,
      font,
      color: quote.availability === "expired" ? rgb(0.72, 0.16, 0.16) : rgb(0.09, 0.45, 0.29),
    });
    cursor = A4_HEIGHT - MARGIN_Y - 74;

    ensureSpace(LINE_HEIGHT * 3);
    cursor = drawField(page, font, "お見積番号", quote.quotationNumber, cursor);
    cursor = drawField(page, font, "発行日", quote.issueDate, cursor);
    cursor = drawField(page, font, "有効期限", quote.validUntil, cursor);

    ensureSpace(LINE_HEIGHT * 3);
    page.drawText("お客様情報", {
      x: MARGIN_X,
      y: cursor,
      size: 12,
      font,
      color: rgb(0.12, 0.2, 0.28),
    });
    cursor -= 25;
    cursor = drawField(page, font, "お客様名", quote.customerName, cursor);
    cursor = drawField(page, font, "ご担当者様", quote.customerContact, cursor);

    ensureSpace(LINE_HEIGHT * 6);
    page.drawText("お見積内容", {
      x: MARGIN_X,
      y: cursor,
      size: 12,
      font,
      color: rgb(0.12, 0.2, 0.28),
    });
    cursor -= 25;
    cursor = drawField(page, font, "製品名", quote.productName, cursor);
    cursor = drawField(page, font, "サイズ", quote.sizeSummary, cursor);
    cursor = drawField(page, font, "数量", quote.quantity, cursor);

    ensureSpace(LINE_HEIGHT * 5);
    cursor = drawSummaryRow(page, font, "単価", quote.displayedUnitPrice, cursor);
    cursor = drawSummaryRow(page, font, "小計", quote.displayedSubtotal, cursor);
    cursor = drawSummaryRow(page, font, "消費税", quote.displayedTax, cursor);
    cursor = drawSummaryRow(page, font, "合計金額", quote.displayedGrandTotal, cursor, true);

    ensureSpace(LINE_HEIGHT * 7);
    page.drawText("配送・お支払い", {
      x: MARGIN_X,
      y: cursor,
      size: 12,
      font,
      color: rgb(0.12, 0.2, 0.28),
    });
    cursor -= 25;
    cursor = drawField(page, font, "納期", quote.deliveryDate, cursor);
    cursor = drawField(page, font, "お支払い条件", quote.paymentTerms, cursor);
    cursor = drawField(page, font, "備考", quote.notes, cursor);

    ensureSpace(LINE_HEIGHT * 3);
    const expiredWording = quote.availability === "expired"
      ? "有効期限切れ：このお見積りは現在無効です。最新のお見積りをご確認ください。"
      : "このお見積りは有効期限以内です。";
    drawParagraph(renderContext, font, {
      text: expiredWording,
      x: MARGIN_X,
      y: cursor,
      maxWidth: CONTENT_WIDTH,
      color: quote.availability === "expired" ? rgb(0.72, 0.16, 0.16) : rgb(0.24, 0.38, 0.28),
    });

    const lastPage = document.getPages().at(-1)!;
    const customerSafeTexts = [
      "カネイトレード",
      "お見積書",
      quote.availability === "expired" ? "有効期限切れ" : "有効",
      "お見積番号", quote.quotationNumber,
      "発行日", quote.issueDate,
      "有効期限", quote.validUntil,
      "お客様情報", "お客様名", quote.customerName,
      "ご担当者様", quote.customerContact,
      "お見積内容", "製品名", quote.productName,
      "サイズ", quote.sizeSummary, "数量", quote.quantity,
      "単価", quote.displayedUnitPrice,
      "小計", quote.displayedSubtotal,
      "消費税", quote.displayedTax,
      "合計金額", quote.displayedGrandTotal,
      "配送・お支払い", "納期", quote.deliveryDate,
      "お支払い条件", quote.paymentTerms,
      "備考", quote.notes,
      expiredWording,
      "カネイトレード お客様ポータル｜このお見積書はポータルから安全に発行されました。",
    ];
    const usedGlyphs = new Map<number, FontLayoutGlyph>();
    const embeddedFontInternals = font as unknown as PdfLibCustomFontInternals;
    if (!embeddedFontInternals.embedder) throw new PortalQuotePdfGenerationError();
    for (const text of customerSafeTexts) {
      for (const glyph of embeddedFontInternals.embedder.font.layout(text).glyphs) {
        usedGlyphs.set(glyph.id, glyph);
      }
    }
    const sortedUsedGlyphs = [...usedGlyphs.values()].sort((left, right) => left.id - right.id);
    embeddedFontInternals.embedder.glyphCache = { access: () => sortedUsedGlyphs };

    drawParagraph({ page: lastPage, cursor: MARGIN_Y + 2, newPage: () => undefined }, font, {
      text: "カネイトレード お客様ポータル｜このお見積書はポータルから安全に発行されました。",
      x: MARGIN_X,
      y: MARGIN_Y + 2,
      maxWidth: CONTENT_WIDTH,
      size: 8.5,
      color: rgb(0.45, 0.5, 0.55),
    });

    const bytes = await document.save({ useObjectStreams: false });
    return Buffer.from(bytes);
  } catch (error) {
    throw new PortalQuotePdfGenerationError();
  }
}
