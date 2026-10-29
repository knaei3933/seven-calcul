import { access, readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import type { MailAttachment } from "./mail-sender";
import type { QuotationRecord } from "./quotation-shared";
import { sizeMaster } from "./constants";
import type { Design } from "./types";

const DESIGN_PREFIXES: Record<Design, string> = {
  round: "RDA",
  circle: "CRA",
  tube: "TUA",
  bottle: "BTA",
  xraRound: "XRA",
  mouthWash: "PBA",
};

const DESIGN_LABELS: Record<Design, string> = {
  round: "ラウンド型",
  circle: "丸型",
  tube: "チューブ型",
  bottle: "ボトル型",
  xraRound: "Xraラウンド型",
  mouthWash: "マウスウォッシュ型",
};

export type CustomerDesignAttachment = MailAttachment & { sourcePath: string; revision: number };

const C_SUFFIX_PATTERN = /^([A-Za-z]{3})[_-]?(\d{3,5})(?:[_-](\d+))?(?:[_-](\d+))?[_-]?C\.(ai|pdf)$/iu;

function rootCandidates(): string[] {
  const configured = process.env.DESIGN_DATA_ROOT?.trim();
  const candidates = [
    configured,
    "/mnt/nas/版下データ",
    "\\\\10.10.10.3\\Epackage-lab\\版下データ",
    "\\\\192.168.11.3\\Epackage-lab\\版下データ",
  ].filter((value): value is string => Boolean(value));
  return [...new Set(candidates)];
}

async function resolveDesignDataRoot(): Promise<string | null> {
  for (const candidate of rootCandidates()) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next platform-specific mount point.
    }
  }
  return null;
}

function numberOr<T>(value: unknown, fallback: T): number | T {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function specificationOf(record: QuotationRecord): {
  design: Design;
  widthMm: number;
  lengthMm: number;
} | null {
  const request = record.payload.calculationRequest as {
    spec?: { sizeKey?: unknown; customWidthMm?: unknown; customLengthMm?: unknown };
  } | null | undefined;
  const key = typeof request?.spec?.sizeKey === "string" ? request.spec.sizeKey : "";
  const master = (sizeMaster as Record<string, { design: Design; widthMm: unknown; lengthMm: unknown } | undefined>)[key];
  const width = numberOr(request?.spec?.customWidthMm, numberOr(master?.widthMm, Number.NaN));
  const length = numberOr(request?.spec?.customLengthMm, numberOr(master?.lengthMm, Number.NaN));
  if (master && Number.isFinite(width) && Number.isFinite(length)) {
    return { design: master.design, widthMm: width, lengthMm: length };
  }
  const dimensions = /(\d+(?:\.\d+)?)\s*[×x]\s*(\d+(?:\.\d+)?)/iu.exec(record.sizeSummary ?? "");
  const parsedWidth = Number(dimensions?.[1]);
  const parsedLength = Number(dimensions?.[2]);
  if (!Number.isFinite(parsedWidth) || !Number.isFinite(parsedLength)) return null;
  // Legacy records without calculationRequest use the common round-family prefix.
  return { design: "round", widthMm: parsedWidth, lengthMm: parsedLength };
}

export function customerDesignLabel(record: QuotationRecord): string | null {
  const spec = specificationOf(record);
  if (!spec) return null;
  return `${DESIGN_LABELS[spec.design]}／${spec.widthMm}×${spec.lengthMm}mm`;
}

function sizeCodes(widthMm: number, lengthMm: number): Set<string> {
  const codes = new Set<string>();
  const lengthCode = Math.round(lengthMm);
  for (const width of [Math.round(widthMm), Math.floor(widthMm), Math.ceil(widthMm), widthMm]) {
    if (!Number.isFinite(width) || width <= 0 || lengthCode <= 0) continue;
    codes.add(`${String(Math.round(width)).padStart(2, "0")}${String(lengthCode).padStart(2, "0")}`);
    const compact = width.toString().replace(".", "");
    if (/^\d{2,4}$/u.test(compact)) codes.add(`${compact}${String(lengthCode).padStart(2, "0")}`);
  }
  return new Set([...codes].filter((code) => /^\d{3,5}$/u.test(code)));
}

async function walk(root: string, current = root, depth = 0): Promise<string[]> {
  if (depth > 2) return [];
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await walk(root, path, depth + 1));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export interface CustomerDesignAttachmentInfo {
  fileName: string;
  sizeBytes: number;
  contentType: string;
  sourcePath: string;
  revision: number;
  stem: string;
  designLabel: string;
  designRoot: string;
}

export async function findCustomerDesignAttachments(record: QuotationRecord): Promise<CustomerDesignAttachmentInfo[]> {
  const root = await resolveDesignDataRoot();
  const spec = specificationOf(record);
  if (!root || !spec) return [];
  const prefix = DESIGN_PREFIXES[spec.design];
  const sizes = sizeCodes(spec.widthMm, spec.lengthMm);
  const designLabel = customerDesignLabel(record) ?? "";
  const stems = new Map<string, { ai?: CustomerDesignAttachmentInfo; pdf?: CustomerDesignAttachmentInfo }>();
  for (const path of await walk(root)) {
    const directory = relative(root, dirname(path)).split(/[\\/]/)[0] ?? "";
    // other / 未作成 は現行候補ではなく保管・未完成データ扱いとする。
    if (directory === "other" || directory === "未作成") continue;
    const match = C_SUFFIX_PATTERN.exec(path.split(/[\\/]/).pop() ?? "");
    if (!match) continue;
    const [, filePrefix, sizeCode, variant, revision] = match;
    const extension = match[5].toLowerCase() as "ai" | "pdf";
    if (filePrefix.toUpperCase() !== prefix || !sizes.has(sizeCode)) continue;
    const candidate: CustomerDesignAttachmentInfo = {
      fileName: path.split(/[\\/]/).pop() ?? path,
      sizeBytes: 0,
      contentType: extension === "pdf" ? "application/pdf" : "application/postscript",
      sourcePath: path,
      // C直前の番号を revision として扱う: _1_3_C -> 3, _1_C -> 1。
      revision: Number(revision ?? variant ?? 0),
      stem: basename(path, `.${extension}`),
      designLabel,
      designRoot: root,
    };
    const grouped = stems.get(candidate.stem) ?? {};
    grouped[extension] = candidate;
    stems.set(candidate.stem, grouped);
  }
  // AI/PDFが同一ファイル stem で揃う候補のみ送付する。片方だけの旧データを混在させない。
  const paired = [...stems.entries()]
    .filter(([, files]) => Boolean(files.ai && files.pdf))
    .map(([stem, files]) => ({ stem, ai: files.ai!, pdf: files.pdf! }));
  if (!paired.length) return [];
  paired.sort((left, right) =>
    right.ai.revision - left.ai.revision
    || right.pdf.revision - left.pdf.revision
    || left.stem.localeCompare(right.stem, "ja"));
  const selected = paired[0];
  for (const file of [selected.ai, selected.pdf]) {
    file.sizeBytes = (await stat(file.sourcePath)).size;
  }
  return [selected.ai, selected.pdf];
}

export async function readCustomerDesignAttachments(
  record: QuotationRecord,
): Promise<CustomerDesignAttachment[]> {
  const files = await findCustomerDesignAttachments(record);
  const maxBytes = Number(process.env.DESIGN_DATA_MAX_FILE_MB ?? 25) * 1024 * 1024;
  const attachments: CustomerDesignAttachment[] = [];
  for (const file of files) {
    const content = await readFile(file.sourcePath);
    if (content.byteLength === 0) throw new Error("empty_design_file");
    if (content.byteLength > maxBytes) throw new Error("design_file_too_large");
    attachments.push({
      filename: file.fileName,
      content,
      contentType: file.contentType,
      sourcePath: file.sourcePath,
      revision: file.revision,
    });
  }
  return attachments;
}
