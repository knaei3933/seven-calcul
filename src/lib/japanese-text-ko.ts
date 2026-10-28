const DISPLAY_NAME_KO: Record<string, string> = {
  "レディエイドルプリカント": "레디에이돌 프리칸트",
  "株式会社フォーライフ": "주식회사 포라이프",
};

const CORPORATE_PREFIX_KO: Array<[RegExp, string]> = [
  [/株式会社/gu, "주식회사 "],
  [/有限会社/gu, "유한회사 "],
  [/合名会社/gu, "합명회사 "],
  [/合資会社/gu, "합자회사 "],
  [/医療法人/gu, "의료법인 "],
  [/学校法人/gu, "학교법인 "],
  [/一般社団法人/gu, "일반사단법인 "],
  [/一般財団法人/gu, "일반재단법인 "],
];

type KanaUnit =
  | { initial?: string; vowel: string; finalAtEnd?: string }
  | { final: string }
  | { geminate: true };

const KANA_UNITS = new Map<string, KanaUnit>([
  ["ア", { vowel: "a" }], ["イ", { vowel: "i" }], ["ウ", { vowel: "u" }],
  ["エ", { vowel: "e" }], ["オ", { vowel: "o" }],
  ["カ", { initial: "k", vowel: "a" }], ["キ", { initial: "k", vowel: "i" }],
  ["ク", { initial: "k", vowel: "u", finalAtEnd: "k" }],
  ["ケ", { initial: "k", vowel: "e" }], ["コ", { initial: "k", vowel: "o" }],
  ["ガ", { initial: "g", vowel: "a" }], ["ギ", { initial: "g", vowel: "i" }],
  ["グ", { initial: "g", vowel: "u" }], ["ゲ", { initial: "g", vowel: "e" }],
  ["ゴ", { initial: "g", vowel: "o" }],
  ["サ", { initial: "s", vowel: "a" }], ["シ", { initial: "s", vowel: "i" }],
  ["ス", { initial: "s", vowel: "u" }], ["セ", { initial: "s", vowel: "e" }],
  ["ソ", { initial: "s", vowel: "o" }],
  ["ザ", { initial: "j", vowel: "a" }], ["ジ", { initial: "j", vowel: "i" }],
  ["ズ", { initial: "j", vowel: "u" }], ["ゼ", { initial: "j", vowel: "e" }],
  ["ゾ", { initial: "j", vowel: "o" }],
  ["タ", { initial: "t", vowel: "a" }], ["チ", { initial: "ch", vowel: "i" }],
  ["ツ", { initial: "ch", vowel: "u", finalAtEnd: "t" }],
  ["テ", { initial: "t", vowel: "e" }], ["ト", { initial: "t", vowel: "o" }],
  ["ダ", { initial: "d", vowel: "a" }], ["ヂ", { initial: "j", vowel: "i" }],
  ["ヅ", { initial: "j", vowel: "u" }], ["デ", { initial: "d", vowel: "e" }],
  ["ド", { initial: "d", vowel: "o", finalAtEnd: "r" }],
  ["ナ", { initial: "n", vowel: "a" }], ["ニ", { initial: "n", vowel: "i" }],
  ["ヌ", { initial: "n", vowel: "u" }], ["ネ", { initial: "n", vowel: "e" }],
  ["ノ", { initial: "n", vowel: "o" }],
  ["ハ", { initial: "h", vowel: "a" }], ["ヒ", { initial: "h", vowel: "i" }],
  ["フ", { initial: "p", vowel: "u", finalAtEnd: "p" }],
  ["ヘ", { initial: "h", vowel: "e" }], ["ホ", { initial: "h", vowel: "o" }],
  ["バ", { initial: "b", vowel: "a" }], ["ビ", { initial: "b", vowel: "i" }],
  ["ブ", { initial: "b", vowel: "u" }], ["ベ", { initial: "b", vowel: "e" }],
  ["ボ", { initial: "b", vowel: "o" }],
  ["パ", { initial: "p", vowel: "a" }], ["ピ", { initial: "p", vowel: "i" }],
  ["プ", { initial: "p", vowel: "u" }], ["ペ", { initial: "p", vowel: "e" }],
  ["ポ", { initial: "p", vowel: "o" }],
  ["マ", { initial: "m", vowel: "a" }], ["ミ", { initial: "m", vowel: "i" }],
  ["ム", { initial: "m", vowel: "u" }], ["メ", { initial: "m", vowel: "e" }],
  ["モ", { initial: "m", vowel: "o" }],
  ["ヤ", { vowel: "ya" }], ["ユ", { vowel: "yu" }], ["ヨ", { vowel: "yo" }],
  ["ラ", { initial: "r", vowel: "a" }], ["リ", { initial: "r", vowel: "i" }],
  ["ル", { initial: "r", vowel: "u", finalAtEnd: "l" }],
  ["レ", { initial: "r", vowel: "e" }], ["ロ", { initial: "r", vowel: "o" }],
  ["ワ", { vowel: "wa" }], ["ヲ", { vowel: "o" }],
  ["ン", { final: "ng" }],
  ["ヴァ", { initial: "b", vowel: "a" }], ["ヴィ", { initial: "b", vowel: "i" }],
  ["ヴ", { initial: "b", vowel: "u" }], ["ヴェ", { initial: "b", vowel: "e" }],
  ["ヴォ", { initial: "b", vowel: "o" }],
  ["ファ", { initial: "p", vowel: "a" }], ["フィ", { initial: "p", vowel: "i" }],
  ["フェ", { initial: "p", vowel: "e" }], ["フォ", { initial: "p", vowel: "o" }],
  ["フュ", { initial: "p", vowel: "yu" }],
  ["ティ", { initial: "t", vowel: "i" }], ["ディ", { initial: "d", vowel: "i" }],
  ["トゥ", { initial: "t", vowel: "u" }], ["ドゥ", { initial: "d", vowel: "u" }],
  ["シェ", { initial: "s", vowel: "e" }], ["ジェ", { initial: "j", vowel: "e" }],
  ["チェ", { initial: "ch", vowel: "e" }],
  ["キャ", { initial: "k", vowel: "ya" }], ["キュ", { initial: "k", vowel: "yu" }], ["キョ", { initial: "k", vowel: "yo" }],
  ["シャ", { initial: "s", vowel: "ya" }], ["シュ", { initial: "s", vowel: "yu" }], ["ショ", { initial: "s", vowel: "yo" }],
  ["チャ", { initial: "ch", vowel: "ya" }], ["チュ", { initial: "ch", vowel: "yu" }], ["チョ", { initial: "ch", vowel: "yo" }],
  ["ニャ", { initial: "n", vowel: "ya" }], ["ニュ", { initial: "n", vowel: "yu" }], ["ニョ", { initial: "n", vowel: "yo" }],
  ["ヒャ", { initial: "h", vowel: "ya" }], ["ヒュ", { initial: "h", vowel: "yu" }], ["ヒョ", { initial: "h", vowel: "yo" }],
  ["ミャ", { initial: "m", vowel: "ya" }], ["ミュ", { initial: "m", vowel: "yu" }], ["ミョ", { initial: "m", vowel: "yo" }],
  ["リャ", { initial: "r", vowel: "ya" }], ["リュ", { initial: "r", vowel: "yu" }], ["リョ", { initial: "r", vowel: "yo" }],
  ["ギャ", { initial: "g", vowel: "ya" }], ["ギュ", { initial: "g", vowel: "yu" }], ["ギョ", { initial: "g", vowel: "yo" }],
  ["ジャ", { initial: "j", vowel: "ya" }], ["ジュ", { initial: "j", vowel: "yu" }], ["ジョ", { initial: "j", vowel: "yo" }],
  ["ビャ", { initial: "b", vowel: "ya" }], ["ビュ", { initial: "b", vowel: "yu" }], ["ビョ", { initial: "b", vowel: "yo" }],
  ["ピャ", { initial: "p", vowel: "ya" }], ["ピュ", { initial: "p", vowel: "yu" }], ["ピョ", { initial: "p", vowel: "yo" }],
]);

const CHO: Record<string, number> = { g: 0, gg: 1, n: 2, d: 3, dd: 4, r: 5, m: 6, b: 7, bb: 8, s: 9, ss: 10, "": 11, j: 12, jj: 13, ch: 14, k: 15, t: 16, p: 17, h: 18 };
const JUNG: Record<string, number> = { a: 0, ae: 1, ya: 2, yae: 3, eo: 4, e: 5, yeo: 6, ye: 7, o: 8, wa: 9, wae: 10, oe: 11, yo: 12, u: 13, wo: 14, we: 15, wi: 16, yu: 17, eu: 18, yi: 19, i: 20 };
const JONG: Record<string, number> = { "": 0, k: 1, kk: 2, "k-s": 3, n: 4, "n-j": 5, "n-h": 6, t: 7, l: 8, "l-k": 9, "l-m": 10, "l-b": 11, "l-s": 12, "l-t": 13, "l-p": 14, "l-h": 15, m: 16, p: 17, "p-s": 18, ng: 19 };

function hangul(initial: string | undefined, vowel: string, final = ""): string {
  if (!(vowel in JUNG)) return initial ?? "";
  const code = 0xac00 + ((initial ? CHO[initial] ?? 11 : 11) * 21 + JUNG[vowel]!) * 28 + (JONG[final] ?? 0);
  return String.fromCodePoint(code);
}

function replaceFinal(syllable: string, final: string): string {
  if (!/[가-힣]/u.test(syllable)) return syllable + final;
  const code = syllable.codePointAt(0)! - 0xac00;
  const initial = Math.floor(code / 588);
  const vowel = Math.floor((code % 588) / 28);
  return hangul(Object.entries(CHO).find(([, value]) => value === initial)?.[0], Object.entries(JUNG).find(([, value]) => value === vowel)?.[0] ?? "a", final);
}

function applyFinal(parts: string[], final: string): void {
  if (parts.length === 0) {
    parts.push(final === "ng" ? "응" : final);
    return;
  }
  const last = parts.at(-1)!;
  const consonant = final === "ng" ? "ng" : final;
  parts[parts.length - 1] = replaceFinal(last, consonant);
}

function finalizeWord(parts: string[], pendingFinal?: string): void {
  if (pendingFinal) applyFinal(parts, pendingFinal);
}

function transliterateKatakanaToKorean(value: string): string {
  let index = 0;
  let geminate = false;
  let pendingFinal: string | undefined;
  const parts: string[] = [];
  while (index < value.length) {
    const three = value.slice(index, index + 3);
    const two = value.slice(index, index + 2);
    const one = value[index]!;
    if (three && KANA_UNITS.has(three)) {
      const unit = KANA_UNITS.get(three)!;
      if ("final" in unit || "geminate" in unit) throw new Error("unsupported_kana_unit");
      finalizeWord(parts, pendingFinal);
      pendingFinal = undefined;
      parts.push(hangul(geminate ? `${unit.initial}${unit.initial}` : unit.initial, unit.vowel));
      geminate = false;
      index += 3;
      continue;
    }
    if (two && KANA_UNITS.has(two)) {
      const unit = KANA_UNITS.get(two)!;
      if ("final" in unit || "geminate" in unit) throw new Error("unsupported_kana_unit");
      finalizeWord(parts, pendingFinal);
      pendingFinal = undefined;
      parts.push(hangul(geminate ? `${unit.initial}${unit.initial}` : unit.initial, unit.vowel));
      geminate = false;
      index += 2;
      continue;
    }
    if (one && KANA_UNITS.has(one)) {
      const unit = KANA_UNITS.get(one)!;
      if ("geminate" in unit) {
        geminate = true;
        index += 1;
        continue;
      }
      if ("final" in unit) {
        applyFinal(parts, unit.final);
        index += 1;
        continue;
      }
      finalizeWord(parts, pendingFinal);
      pendingFinal = undefined;
      parts.push(hangul(geminate ? `${unit.initial}${unit.initial}` : unit.initial, unit.vowel));
      geminate = false;
      index += 1;
      continue;
    }
    if (one === "ー") {
      index += 1;
      continue;
    }
    if (one === "・" || one === " " || one === "　") {
      finalizeWord(parts, pendingFinal);
      pendingFinal = undefined;
      geminate = false;
      parts.push(one === "　" ? " " : one);
      index += 1;
      continue;
    }
    finalizeWord(parts, pendingFinal);
    pendingFinal = undefined;
    geminate = false;
    parts.push(one);
    index += 1;
  }
  finalizeWord(parts, pendingFinal);
  return parts.join("").replace(/\s+/gu, " ").trim();
}

export function japaneseDisplayNameKo(value: string | null | undefined): string {
  const source = value?.trim() ?? "";
  if (!source) return "-";
  if (DISPLAY_NAME_KO[source]) return DISPLAY_NAME_KO[source];
  let translated = source;
  for (const [pattern, replacement] of CORPORATE_PREFIX_KO) {
    translated = translated.replace(pattern, replacement);
  }
  translated = transliterateKatakanaToKorean(translated);
  return translated || source;
}

export function registeredJapaneseDisplayNameKo(value: string | null | undefined): string {
  const source = value?.trim() ?? "";
  return source ? DISPLAY_NAME_KO[source] ?? source : "-";
}

export function japaneseDisplayNameKoWithSource(value: string | null | undefined): string {
  const source = value?.trim() ?? "";
  if (!source) return "-";
  const korean = japaneseDisplayNameKo(source);
  if (korean === source || /[가-힯]/u.test(source)) return source;
  return `${korean}（원문: ${source}）`;
}
