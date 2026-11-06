import { readFile } from "node:fs/promises";
import path from "node:path";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import type { DeliveryNoteDraft } from "./film-order-shared";

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MARGIN = 48;
const INK = rgb(0.12, 0.16, 0.22);
const MUTED = rgb(0.36, 0.41, 0.47);
const PRIMARY = rgb(0.09, 0.28, 0.48);
const LINE = rgb(0.81, 0.85, 0.89);

type Fonts = { regular: PDFFont; bold: PDFFont };

function clean(value: string | undefined | null, fallback = ""): string {
  return value?.trim() || fallback;
}

function drawWrapped(page: PDFPage, font: PDFFont, value: string, x: number, y: number, width: number, size = 10): number {
  let currentY = y;
  for (const sourceLine of clean(value).split("\n")) {
    let current = "";
    for (const character of Array.from(sourceLine)) {
      const candidate = current + character;
      if (current && font.widthOfTextAtSize(candidate, size) > width) {
        page.drawText(current, { x, y: currentY, size, font, color: INK });
        currentY -= size * 1.7;
        current = character;
      } else {
        current = candidate;
      }
    }
    if (current) {
      page.drawText(current, { x, y: currentY, size, font, color: INK });
      currentY -= size * 1.7;
    }
  }
  return currentY;
}

export async function generateFilmDeliveryNotePdf(draft: DeliveryNoteDraft, orderNumber: string): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  document.registerFontkit(fontkit);
  document.setTitle(`納品書 ${orderNumber}`);
  document.setAuthor("金井貿易株式会社");
  document.setProducer("Seven Chemical Quotation Suite");
  const fontDir = path.join(process.cwd(), "src", "fonts");
  const [regularBytes, boldBytes] = await Promise.all([
    readFile(path.join(fontDir, "NotoSansJP-Quotation-Regular.ttf")),
    readFile(path.join(fontDir, "NotoSansJP-Quotation-Bold.ttf")),
  ]);
  const fonts: Fonts = {
    regular: await document.embedFont(new Uint8Array(regularBytes), { subset: false }),
    bold: await document.embedFont(new Uint8Array(boldBytes), { subset: false }),
  };
  const page: PDFPage = document.addPage([A4_WIDTH, A4_HEIGHT]);
  page.drawText("納品書", { x: MARGIN, y: A4_HEIGHT - 62, size: 25, font: fonts.bold, color: PRIMARY });
  page.drawText("DELIVERY NOTE", { x: A4_WIDTH - MARGIN - fonts.regular.widthOfTextAtSize("DELIVERY NOTE", 10), y: A4_HEIGHT - 58, size: 10, font: fonts.regular, color: MUTED });
  page.drawText(clean(draft.issueDate, new Date().toISOString().slice(0, 10)), { x: A4_WIDTH - MARGIN - 100, y: A4_HEIGHT - 82, size: 11, font: fonts.regular, color: INK });
  page.drawText("発行日", { x: A4_WIDTH - MARGIN - 140, y: A4_HEIGHT - 82, size: 10, font: fonts.regular, color: MUTED });

  page.drawText(clean(draft.recipientName), { x: MARGIN, y: A4_HEIGHT - 126, size: 16, font: fonts.bold, color: INK });
  page.drawText(clean(draft.senderName), { x: MARGIN, y: A4_HEIGHT - 156, size: 12, font: fonts.bold, color: INK });
  page.drawText(`発注番号 ${clean(orderNumber)}`, { x: A4_WIDTH - MARGIN - 190, y: A4_HEIGHT - 126, size: 11, font: fonts.regular, color: INK });
  page.drawText(`到着見込 ${clean(draft.arrivalEstimateDate, "-")}`, { x: A4_WIDTH - MARGIN - 190, y: A4_HEIGHT - 144, size: 11, font: fonts.regular, color: INK });

  const rows = [
    ["品名", clean(draft.productName)],
    ["仕様", clean(draft.specification)],
    ["数量", clean(draft.quantity)],
    ["フィルム長", clean(draft.filmLength)],
    ["到着見込", clean(draft.arrivalEstimateDate)],
  ];
  let y = A4_HEIGHT - 220;
  const labelWidth = 110;
  const valueWidth = A4_WIDTH - MARGIN * 2 - labelWidth - 16;
  for (const [label, value] of rows) {
    page.drawRectangle({ x: MARGIN, y: y - 7, width: labelWidth, height: 28, color: rgb(0.97, 0.98, 0.99), borderColor: LINE, borderWidth: 0.8 });
    page.drawRectangle({ x: MARGIN + labelWidth, y: y - 7, width: valueWidth, height: 28, borderColor: LINE, borderWidth: 0.8 });
    page.drawText(label, { x: MARGIN + 10, y: y + 2, size: 11, font: fonts.bold, color: MUTED });
    drawWrapped(page, fonts.regular, value, MARGIN + labelWidth + 10, y + 2, valueWidth - 14, 11);
    y -= 36;
  }

  page.drawText("備考", { x: MARGIN, y: y - 4, size: 12, font: fonts.bold, color: PRIMARY });
  const remarksY = drawWrapped(page, fonts.regular, draft.remarks || "上記内容にて納品いたします。", MARGIN, y - 26, A4_WIDTH - MARGIN * 2, 11);
  page.drawText("上記フィルムを納品いたします。受領後はパウチ充填工程へお願いいたします。", {
    x: MARGIN, y: remarksY - 18, size: 10.5, font: fonts.regular, color: INK,
  });
  page.drawText(clean(draft.senderName), { x: A4_WIDTH - MARGIN - fonts.bold.widthOfTextAtSize(clean(draft.senderName), 12), y: 92, size: 12, font: fonts.bold, color: INK });
  page.drawLine({ start: { x: A4_WIDTH - MARGIN - 150, y: 76 }, end: { x: A4_WIDTH - MARGIN, y: 76 }, thickness: 0.8, color: LINE });

  return await document.save();
}
