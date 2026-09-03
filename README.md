# パウチ見積システム

承認済み設計（`pouch-quotation-system-design.md`）に基づく Next.js アプリケーションです。日本語UI、Decimal原価計算コア、暫定計算／サーバー確定計算、および顧客向け出力の内部情報分離を提供します。

## 現在の実装範囲

- `src/lib/calculation.ts`
  - 発注数量は販売できる連結後パウチ「枚」、充填区画は「室」として区別して計算します。
  - バルク使用量: `quantity * chambers * fill * 1.1 + methodInitial + 500 * fillingLanes * fill`
  - ホッパ初期投入 2,000ml、加圧初期投入 8,000ml。
  - デジタルフィルム必要長さを100m単位へ切上げ、サイズマスタ別のロス・単価・配送・通関を計算します。
  - カスタム費用 400,000円/仕様をロット固定費とは独立した構成要素として1回だけ加算します。
  - 20%の成功報酬は承認済み（approved）見積のみを対象とし、結果内部にのみ保持します。
  - 全金額計算を Decimal.js で行い、構成要素合計と総原価の差分を監査項目として出力します。
- `src/lib/digital-film.ts`
  - SKU別発注長さの100m切上げ、合計500m以上、各SKU300m以上を検証します。
  - 不合格時は例外で終了せず、構造化された修正案を返します。
- `src/app/page.tsx`
  - 日本語の入力UI、暫定計算、検証・ブロック表示、原価結果カード、顧客向け見積プレビューを提供します。
  - 顧客プレビューには原価・仕入・利益率・成功報酬・内部メタデータを出力しません。
  - Seven書式・税丸め・色数別単価は未確認のため警告表示とし、値を捏造しません。
- `src/app/api/calculate/route.ts`
  - 同一計算コアをサーバーAPIでも実行します。

## 制約と未確認事項

- デジタル印刷のみ実装済みです。グラビア固有費用はパラメータが確定していないため計算しません。
- 標準外寸法の列数・原反幅・価格帯変換は確定していないため、カスタム寸法は確定見積をブロックします。
- Sevenテンプレート、消費税の端数処理、色数別デジタル単価、PDF本実装はこの increment には含みません。
- データベース・認証・永続化は含まれません。計算はリクエストごとに完結します。

## 実行方法

```bash
npm install
npm run dev
```

`http://localhost:3000` を開いてください。

## 検証

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run e2e
```

各コマンドのスコープ:

| コマンド | 検証内容 |
|---|---|
| `npm run lint` | ESLint / Next.js rules |
| `npm run typecheck` | TypeScript strict type check |
| `npm test` | バルク公式・デジタル最小発注・カスタム費用・承認報酬・API |
| `npm run build` | Next.js production build |
| `npm run e2e` | Chromium による入力・計算・出力分離のブラウザ検証 |

## 原価パラメータ

`src/lib/constants.ts` の `defaultParameters` に設計書で確定済みの値を集約しています。サイズ別列数・原反幅・ピッチ・価格帯も同ファイルの `sizeMaster` で管理します。将来の管理画面はこの構造を境界にして拡張してください。
