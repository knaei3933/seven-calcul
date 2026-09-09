# パウチ原価計算・見積システム 設計書

## 1. 概要

任意のパウチ製品の原価を自動計算し、見積書を生成するウェブベースのシステム。
現在Excelで手計算しているパウチ原価計算をシステム化し、将来的な公開・配備に対応できる形にする。

本システムの第一義的な利用者は金井貿易株式会社とする。金井貿易株式会社が顧客向け見積を作成・送付し、
顧客承認後に成立した見積額からシステム提供側が20%の成功報酬を受領する。
第一想定の納入先は株式会社セブン化学とし、セブン化学向けの書式・項目・提示条件に合わせた
見積書を出力できることを前提とする。

### 1.1 ビジネスフロー

```
1. 金井貿易株式会社がパウチ仕様・充填条件・数量を入力する
2. システムが原価・推奨販売単価・見積書ドラフトを自動生成する
3. 金井貿易株式会社が条件を確認・調整し、顧客へ見積を送付する
4. 顧客が承認した場合、見積を「承認済み」に変更する
5. システムは承認済み見積額から成功報酬20%を計算し、内部管理情報として記録する
```

成功報酬は顧客向け見積書には表示しない内部計算値とする。`draft`・`sent`・`rejected`・`expired`
の見積は報酬計算の対象とせず、顧客承認によって状態が`approved`に変わった時点でのみ計算・記録する。
報酬の計算基準（税抜見積小計・税込額・受注額のいずれを基準にするか）は管理者画面で設定可能とし、
初期値は税抜見積小計に対する20%とする。税区分・端数処理・Seven化学指定テンプレート値は
最終確認項目および設定入力として管理し、未確認の値を既定値として固定しない。

## 2. システム要件

### 2.1 機能要件

- パウチ仕様（サイズ・デザイン・充填量など）を入力すると原価を自動計算
- デジタルフィルム価格は `/root/pouch_film_price_all_sizes_500mplus.xlsx` のルールを数式化して適用
- 左右幅・長さ・充填量・発注数量・充填方式・連結形式・色数・カスタム区分を入力できる
- 1連／2連／3連／4連パウチの充填量と生産数量を自動換算できる
- ホッパ充填と加圧充填でバルク必要量を切替計算できる
- デジタルフィルムは合計500m以上かつ同一発注グループ内の各SKU300m以上を条件に検証する
- カスタムパウチの場合は1仕様あたり400,000円の固定費用を自動加算する
- 管理者画面で原価パラメータ（人件費・機械チャージ・フィルム価格など）を調整可能
- 利益率を指定して販売単価を算出
- セブン化学向けに整形した見積書をPDF/画面で出力
- 承認済み見積に対して金井貿易株式会社経由の成功報酬20%を内部計算・記録する
- 将来的にグラビア印刷にも対応できる拡張性

### 2.1.1 必須入力項目

| 入力項目 | 型 / 選択肢 | 補足 |
|---|---|---|
| パウチ左右幅 | mm | 標準はサイズマスタ選択。カスタムは自由入力だが、列数・原反幅・価格帯の変換ルールが確定するまで確定見積を禁止 |
| パウチ長さ | mm | フィルムピッチ計算に使用 |
| 充填量 | ml/室 | 連結パウチでは1室あたりの量を入力する |
| 発注数量 | 連結パウチ単位 | 販売・見積の「1枚」は連結されたままのパウチを指す |
| 充填方式 | ホッパ充填 / 加圧充填 | 初期投入量とテスト充填の計算に使用 |
| 連結形式 | 1連 / 2連 / 3連 / 4連 | 室数として扱う |
| カスタム区分 | 標準 / カスタム | カスタム時は400,000円を加算 |
| 印刷色数 | 整数 | デジタル価格テーブル・グラビア版費の判定に使用 |
| SKU別発注m | 数値リスト | 同一デジタル発注グループ内の複数SKU長さ。合計500m以上かつ各SKU300m以上を検証 |
| 充填列数 | 列 | テスト充填量`500回 × 充填列数 × 充填量`専用の入力。初期値4 |

### 2.1.2 用語と単位の統一

- 「枚」は顧客へ販売する連結後パウチ1枚を意味する。
- 「室」は連結パウチ内の独立した充填区画を意味する。
- 「充填量」は特に明記しない限り`ml/室`で入力する。
- 「列数」はフィルム進行方向の生産列数である。「充填列数」はテスト充填量の計算に使う別入力であり、
  連結室数ともフィルム生産列数とも同一視しない。両者が異なる場合はテスト充填量へ充填列数を適用し、
  管理者へ設定差異警告を表示する。
- 「2連／3連／4連」はそれぞれ室数2／3／4として計算する。
- 「連結後パウチ枚数」は数量入力・見積表示・売上計算の基準数量とする。
  充填対象室数、原価按分、発注数量は常にこの基準を先に確認してから計算する。

### 2.2 非機能要件

- ホームページ形式で配備可能（Next.js + Vercel想定）
- 日本語UI
- 通貨はJPY基本
- レスポンシブ対応（PC・タブレット）
- 管理者は原価値を調整可能（認証付き管理画面）

## 3. 原価計算モデル

### 3.1 原価構成要素

```
総原価 = 材料費 + 変動加工費 + 固定費 + カスタム費用

材料費
  ├── フィルム費（デジタル印刷 or グラビア印刷）
  └── バルク費（内容液原価）

変動加工費
  ├── 生産中人件費
  ├── 検品人件費
  └── 機械変動費

固定費（1ロットあたり）
  ├── 段取り人件費
  ├── 清掃人件費
  └── 機械固定費

カスタム費用
  └── カスタムパウチ固定費（カスタム区分時のみ400,000円/仕様）
```

### 3.2 各要素の計算式

#### 3.2.1 材料費

**フィルム費**

```
必要生産数量 = 発注数量 ÷ (1 - ロス率)
必要フィルム長さ(m) = 必要生産数量 ÷ 列数 × ピッチ(mm) ÷ 1000
発注長さ(m) = 必要フィルム長さ(m) を100m単位で切上げ
フィルム代(JPY) = 発注長さ(m) × フィルムm単価(JPY/m)
フィルム費/枚 = フィルム総額(JPY) ÷ 単価計算用数量
```

※ フィルムm単価はデジタル印刷・グラビア印刷それぞれで管理。
※ デジタルフィルム価格は後述4章の数式モデルを使用。

**バルク費**

```
室数 = 連結形式（1連=1、2連=2、3連=3、4連=4）
充填対象室数 = 生産数量(連結後パウチ枚数) × 室数

バルク使用量(ml)
  = 充填対象室数 × 充填量(ml/室) × 1.1
  + 初期投入量(ml)
  + テスト充填量(ml)

テスト充填量(ml) = 500回 × 充填列数 × 充填量(ml/室)

初期投入量(ml)
  = ホッパ充填: 2,000
  = 加圧充填: 8,000

バルク費(JPY) = バルク使用量(ml) × バルク単価(JPY/ml)
バルク費/枚 = バルク費(JPY) ÷ 生産数量
```

充填方式の違いは初期投入量のみに適用する。加圧充填でもホッパ充填と同じく
`500回 × 充填列数 × 充填量`のテスト充填量を含める。

一般形:

```
bulkUsageMl =
  quantityPieces × chambersPerPouch × fillMlPerChamber × 1.1
  + initialChargeMl
  + 500 × fillingLanes × fillMlPerChamber

initialChargeMl:
  hopper   = 2,000
  pressure = 8,000
```

例（ホッパ充填・2連・充填量30ml・発注数量10,000枚・充填列数4・バルク単価0.37円/ml）:

```
充填対象室数 = 10,000 × 2 = 20,000室
テスト充填量 = 500 × 4 × 30 = 60,000ml
バルク使用量 = 20,000 × 30 × 1.1 + 2,000 + 60,000 = 722,000ml
バルク費 = 722,000 × 0.37 = 267,140円
バルク費/枚 = 26.714円
```

同じ条件で加圧充填の場合:

```
テスト充填量 = 500 × 4 × 30 = 60,000ml
バルク使用量 = 20,000 × 30 × 1.1 + 8,000 + 60,000 = 728,000ml
```

充填方式による差分は初期投入量の6,000mlのみであり、テスト充填量は両方式で共通とする。

#### 3.2.2 変動加工費

**生産中人件費**

```
生産時間(h) = 生産数量 ÷ 時間当たり生産数量
生産中人件費(JPY) = 生産時間(h) × 生産中人件費/時間
生産中人件費/枚 = 生産中人件費/時間 ÷ 時間当たり生産数量
```

生産中人件費/時間:
```
人件費/時間 = 2,500円/時間（統一）
※ 技術者・アルバイトの区別なく、保守的に一律2,500円で計算
```

**検品人件費**

```
検品時間(h) = 生産数量 ÷ 検品速度(枚/時間)
検品人件費(JPY) = 検品時間(h) × 検品人件費/時間
検品人件費/枚 = 検品人件費/時間 ÷ 検品速度
```

**機械変動費**

```
機械変動費/枚 = 機械チャージ(JPY/時間) ÷ 時間当たり生産数量
```

**変動加工費合計/枚**

```
変動加工費/枚 = 生産中人件費/枚 + 検品人件費/枚 + 機械変動費/枚
```

#### 3.2.3 固定費

**固定人件費**

```
固定人件費/ロット = (段取り時間 + 清掃時間) × 2,500円
例: (3h + 2h) × 2,500円 = 12,500円
```

**機械固定費**

```
機械固定費/ロット = 機械チャージ × (段取り時間 + 清掃時間)
```

**固定費合計/ロット**

```
固定費/ロット = 固定人件費 + 機械固定費
固定費/枚 = 固定費/ロット ÷ 生産数量

カスタム費用/仕様
  = 標準パウチ: 0
  = カスタムパウチ: 400,000円
```

カスタム費用はロット固定費とは区別した独立項目として計算・表示し、最終原価へ1回だけ合算する。
`fixedLotCost`等の内部集計値に含める場合は二重計上しないよう、費用分類と集計経路を明示する。

#### 3.2.4 最終原価・販売単価

```
最終原価/枚 = 材料費/枚 + 変動加工費/枚 + 固定費/枚
販売単価/枚 = 最終原価/枚 ÷ (1 - 利益率)
売上総額 = 販売単価/枚 × 生産数量
営業利益 = 売上総額 - 総原価
```

## 4. デジタルフィルム価格数式モデル

`/root/pouch_film_price_all_sizes_500mplus.xlsx` から抽出したルール。

### 4.1 基本変数

| インデックス | 名称 | 説明 |
|---|---|---|
| A | 製品長さ(mm) | パウチの長さ方向寸法 |
| B | ピッチ加算(mm) | 通常6mm、ラウンド50×80のみ8mm |
| C | ピッチ(mm) | A + B |
| D | 列数 | サイズ別に確定（1/2/4/8） |
| E | 生産倍率 | 通常1、35mm幅大ロットは2 |
| F | 発注長さ(m) | 実際に注文するフィルム長さ |
| G | 生産換算長さ(m) | F × E |
| J | 原反幅(mm) | サイズ別に確定 |
| K | 価格帯 | 原反幅で判定 |

### 4.2 ピッチ計算

```
ピッチ = 製品長さ + ピッチ加算

ピッチ加算:
  通常: 6mm
  例外: ラウンド50×80のみ 8mm
```

### 4.3 ロス計算

```
ロス(m) = max(80, 発注長さ × 10%)
```

最低80mを保証。総長さの10%が80mを超える場合は10%を採用。

### 4.4 有効長さ・数量計算

```
有効長さ(m) = 発注長さ - ロス
ロス後数量(枚) = floor(有効長さ × 1000 ÷ ピッチ × 列数)
単価計算用数量(枚) = floor(ロス後数量 ÷ 500) × 500
```

### 4.5 価格帯判定とm単価

**価格帯は原反幅で判定:**

| 価格帯 | 原反幅 | 500m単価 | 1000m単価 | 1500m単価 |
|---|---|---|---|---|
| 570mm以下 | 356/368/396/464/476/512mm | 328円/m | 252円/m | 226円/m |
| 571〜740mm | 556/580/620/736mm | 365円/m | 280円/m | 252円/m |

**適用ルール:**

```
発注長さ 500〜999m   → 500m単価
発注長さ 1000〜1499m → 1000m単価
発注長さ 1500m以上    → 1500m単価
```

### 4.6 配送費

**配送単位は原反幅パターン別:**

| 原反幅パターン | 配送単位 |
|---|---|
| 356/396/464/476/512/736mm | 500m/回 |
| 556/580/620mm | 400m/回 |

```
配送回数 = ceil(生産換算長さ ÷ 配送単位)
国内配送費 = 配送回数 × 2,000円
海外配送費 = 配送回数 × 16,000円
```

### 4.7 通関料

```
if フィルム代 > 200,000円:
  通関料 = 6,600円
else:
  通関料 = 配送回数 × 200円
```

### 4.8 フィルム総額・1枚単価

```
フィルム代 = 発注長さ × 適用m単価
フィルム総額 = フィルム代 + 国内配送費 + 海外配送費 + 通関料
フィルム1枚単価 = フィルム総額 ÷ 単価計算用数量
```

### 4.9 35mm幅大ロット特殊ルール

- 35mm幅品とXraラウンドは特殊扱い
- 500〜900m: 1倍生産（356mm幅 / 368mm幅）
- 1000m以上: 736mm幅・2倍生産で計算
- 2倍生産時は実発注長さ500mが最小
- 検討長さは1000mから開始、200m刻み（1000/1200/1400...）で対応

### 4.10 確定済みサイズ別パラメータ

| デザイン | サイズ(mm) | 列数 | 原反幅(mm) | 価格帯 |
|---|---|---|---|---|
| ラウンド | 50×60 | 4 | 476 | 570mm以下 |
| ラウンド | 50×80 | 4 | 476 | 570mm以下 |
| ラウンド | 50×90 | 4 | 476 | 570mm以下 |
| ラウンド | 60×80 | 4 | 556 | 570mm以下 |
| ラウンド | 60×100 | 4 | 580 | 571〜740mm |
| ラウンド | 60×120 | 4 | 556 | 570mm以下 |
| ラウンド | 70×120 | 4 | 620 | 571〜740mm |
| ラウンド | 60×80 (2連) | 2 | 512 | 570mm以下 |
| ラウンド | 70×120 (3連) | 1 | 464 | 570mm以下 |
| 丸形 | 70×70 | 4 | 620 | 571〜740mm |
| チューブ | 35×60 | 4 | 356/736 | 切替 |
| チューブ | 35×80 | 4 | 356/736 | 切替 |
| チューブ | 50×90 | 4 | 476 | 570mm以下 |
| チューブ | 70×120 | 4 | 620 | 571〜740mm |
| ボトル型 | 35×60 | 4 | 356/736 | 切替 |
| ボトル型 | 35×80 | 4 | 356/736 | 切替 |
| ボトル型 | 50×90 | 4 | 476 | 570mm以下 |
| ボトル型 | 70×120 | 4 | 620 | 571〜740mm |
| Xraラウンド | 38.5×90 | 4 | 368/736 | 切替 |
| マウスウォッシュ用 | 45×145 | 4 | 396 | 570mm以下 |

※ 「切替」= 500〜900mは狭幅、1000m以上は736mm幅に切替

## 5. 印刷方式の拡張設計

### 5.1 デジタルフィルムのSKU別発注ルール

デジタルフィルムはSKU別に必要長さを100m単位へ切上げた後、同一発注グループ内で
次の条件を満たす必要がある。

```
合計発注長さ = SUM(SKU別発注長さ)
合計発注長さ >= 500m
すべてのSKUについて SKU別発注長さ >= 300m
```

したがって、2SKUで300m＋300mの合計600mのような発注は可能である。
合計が500m未満、または任意のSKUが300m未満の場合は見積計算を確定させず、
検証エンジンは構造化された修正案をユーザーに返す。

1. 不足分を加えて各SKU300m以上・合計500m以上に変更する
2. SKUを統合または再割当てする
3. 発注可能な最小構成の修正案を自動提示する

標準品の発注数量から自動算出したSKU別必要長さが最小発注制約を満たさない場合は、
数量の増加、SKUの統合、最小発注構成による過剰数量の発生可否を候補として比較する。

システムは見積候補として「必要長さそのまま」「各SKU300mに切上げ」「合計500mを充足」の
パターンを比較表示する。近似見積では発注長さを100m単位に切上げ、実際の発注可能数量は
ピッチ・列数・ロスから再計算して提示する。

### 5.2 デジタル印刷の色数管理

- 色数は必須入力とし、デジタル印刷では0色（無地）〜8色程度を想定する。
- 現時点で色数別単価表は未取得である。取得までは該当幅帯・長さ帯の共通単価を使用し、
  印刷色数はフィルム単価へ影響させない。算出結果には「色数別価格 未適用」を必ず表示する。
- 画面および監査メタデータには、実際に適用した価格モード
  （`color_specific` / `common_fallback`）と使用した色数を保存する。
- 管理画面では`widthBand × orderLengthBand × colorCount`の単価テーブルを拡張可能にする。
- 色数別テーブルが登録された場合は同一キーの色別単価を優先する。部分登録の場合は該当キーが
  なければ共通フォールバックを使い、フォールバック事実を見積監査メタデータへ記録する。
- 未確認の色別価格を既定値として発明してはならない。
- グラビア印刷の色数は版代・インク費・価格帯判定に使用する。

### 5.3 現在: デジタル印刷

- フィルム価格は4章の数式モデルで計算
- 管理画面で価格パラメータ（m単価・配送費・通関料）を調整可能

### 5.4 将来: グラビア印刷

グラビア印刷はデジタル印刷と異なるコスト構造を持つ。
システムは印刷方式を切り替え可能にする。

**グラビア固有のコスト要素:**

| 要素 | 説明 | 性質 |
|---|---|---|
| 版代（シリンダー代） | 色数×版単価 | 固定費（ロットごと） |
| 版作成費 | 製版工程の人件費 | 固定費（ロットごと） |
| グラビアフィルム単価 | デジタルとは別の価格テーブル | 変動費（m単価） |
| 最小ロット | グラビアは最小発注ロットが存在 | 制約 |
| 色数 | 版代・製版費に影響 | パラメータ |
| インク代 | 色数・面積による | 変動費 |

**データ構造設計:**

```typescript
type PrintingMethod = 'digital' | 'gravure';

interface PrintingCostConfig {
  method: PrintingMethod;
  
  // 共通
  filmUnitPrices: PriceBand[];     // m単価テーブル
  shippingRules: ShippingRule[];    // 配送費ルール
  customsRules: CustomsRule[];      // 通関料ルール
  lossMinM: number;                 // 最小ロス(m)
  lossRate: number;                 // ロス率(%)
  pitchAdditionMm: number;          // ピッチ加算(mm)

  // グラビア固有
  cylinderCostPerColor?: number;    // 色あたり版代
  plateMakingCost?: number;         // 製版費
  inkCostPerColorPerM?: number;     // 色/mあたりインク代
  minOrderM?: number;               // 最小発注m
  colorCount?: number;              // 色数
}

interface PriceBand {
  widthBand: string;        // "570mm以下" / "571~740mm"
  orderLengthRange: string; // "500-999" / "1000-1499" / "1500+"
  unitPrice: number;        // 円/m
}

interface CostParameters {
  lossRate: number;
  lossMinM: number;
  domesticShippingPerTrip: number;
  overseasShippingPerTrip: number;
  bulkLossRate: number;
  fillTestRuns: number;
  laborPerHour: number;
  machineChargePerHour: number;
  productionSpeed: number;
  inspectionSpeed: number;
  setupTime: number;
  cleanupTime: number;
  customPouchCharge: number;
  hopperInitialChargeMl: number;
  pressureInitialChargeMl: number;
  digitalFilmMinTotalM: number;
  digitalFilmMinSkuM: number;
}

interface FilmCostDetails {
  requiredLengthM: number;
  orderLengthM: number;
  loss: number;
  effectiveLengthM: number;
  actualQty: number;
  pricingQty: number;
  unitPrice: number;
  filmBaseCost: number;
  domesticShipping: number;
  overseasShipping: number;
  customs: number;
  filmTotal: number;
}

class QuotationValidationError extends Error {
  constructor(
    code: string,
    public corrections: ValidationResult['corrections'] = [],
  ) {
    super(code);
  }
}
```

## 6. 管理画面で調整可能なパラメータ

### 6.1 フィルム関連

| パラメータ | 初期値 | 単位 | 説明 |
|---|---|---|---|
| 価格帯別m単価（6パターン） | 328/252/226/365/280/252 | 円/m | 4.5参照 |
| 配送単位（原反幅パターン別） | 500/400 | m/回 | 4.6参照 |
| 国内配送費/回 | 2,000 | 円 | |
| 海外配送費/回 | 16,000 | 円 | |
| 通関料（フィルム代>20万） | 6,600 | 円 | |
| 通関料（フィルム代<=20万）/回 | 200 | 円 | |
| ロス最小長さ | 80 | m | |
| ロス率 | 10 | % | |

### 6.2 人件費関連

| パラメータ | 初期値 | 単位 | 説明 |
|---|---|---|---|
| 人件費/時間（統一） | 2,500 | 円/時間 | 生産・検品・段取り・清掃すべて一律 |
| 段取り時間 | 3 | 時間/回 | |
| 清掃時間 | 2 | 時間/回 | |

### 6.3 機械関連

| パラメータ | 初期値 | 単位 | 説明 |
|---|---|---|---|
| 月額賃借料 | 74,100 | 円/月 | |
| 年間使用電力量 | 10,800 | kWh/年 | |
| 電力単価 | 32 | 円/kWh | 15kWh × 32円で算定 |
| 機械取得価額 | 25,000,000 | 円 | |
| 耐用年数 | 7 | 年 | |
| 年間稼働時間 | 1,800 | 時間/年 | |

### 6.4 生産関連

| パラメータ | 初期値 | 単位 | 説明 |
|---|---|---|---|
| 時間当たり生産数量 | 3,600 | 枚/時間 | |
| 検品速度 | 1,500 | 枚/時間 | |
| バルクロス率 | 10 | % | |

### 6.5 印刷方式切替（グラビア追加時）

| パラメータ | 初期値 | 単位 | 説明 |
|---|---|---|---|
| 版代/色 | - | 円 | グラビア時のみ |
| 製版費 | - | 円 | グラビア時のみ |
| インク代/色/m | - | 円 | グラビア時のみ |
| 最小発注m | - | m | グラビア時のみ |

### 6.6 充填・連結・カスタム関連

| パラメータ | 初期値 | 単位 | 説明 |
|---|---|---|---|
| ホッパ充填 初期投入量 | 2,000 | ml | 充填方式がホッパの場合 |
| 加圧充填 初期投入量 | 8,000 | ml | 充填方式が加圧の場合 |
| テスト充填回数 | 500 | 回 | 充填方式によらず共通 |
| テスト充填列数 | 4 | 列 | 初期値。サイズ仕様で上書き可能 |
| カスタムパウチ費用 | 400,000 | 円/仕様 | カスタム区分の場合に加算 |
| 成功報酬率 | 20 | % | 承認済み見積に対する内部計算用 |

### 6.7 デジタルフィルム最小発注関連

| パラメータ | 初期値 | 単位 | 説明 |
|---|---|---|---|
| 発注グループ合計最小長さ | 500 | m | デジタル発注グループ合計に対する制約 |
| SKU別最小長さ | 300 | m | 合計長さに関係なく全SKUへ適用する制約 |
| 近似発注切上げ単位 | 100 | m | 見積用の発注長さ丸め |

## 7. システム構成

### 7.1 技術スタック（想定）

```
フロントエンド: Next.js (App Router)
スタイリング: Tailwind CSS
UIコンポーネント: shadcn/ui
バックエンドAPI: Next.js API Routes
データベース: Prisma + PostgreSQL (or Supabase)
認証: NextAuth.js
ホスティング: Vercel
```

### 7.2 画面構成

```
/
├── /                    # ランディングページ
├── /estimate             # 見積計算画面（メイン）
│   ├── パウチ仕様入力（接続フォーム＋単位別ヘルプ＋エラー要約）
│   ├── リアルタイム検証パネル（未入力・単位・計算可能性）
│   ├── 原価計算結果表示（内部者のみ）
│   ├── 見積書プレビュー（顧客出力フィールドのみ）
│   └── 入力/結果差分・監査メタデータ表示
├── /estimate/result      # 見積結果詳細
├── /estimate/compare     # 改訂・候補発注の比較
├── /admin                # 管理画面（認証必要）
│   ├── /cost-params      # 原価パラメータ管理
│   ├── /film-prices      # フィルム価格テーブル管理
│   ├── /size-master      # サイズマスタ管理
│   ├── /printing-methods  # 印刷方式管理
│   ├── /quotation-templates # Seven化学向け書式・顧客出力欄管理
│   └── /audit-logs       # 承認・改訂・内部値参照ログ
└── /history              # 過去の見積履歴
```

### 7.2.1 計算画面UI設計

#### レイアウトと状態

デスクトップでは左30%に入力、中央40%に結果、右30%に検証・出力プレビューを配置する。
モバイルでは「入力 → 検証 → 結果 → 見積プレビュー」の順に縦積みし、主要CTAを下部固定する。
フォームは4状態（`idle`、`validating`、`calculatable`、`blocked`）を持ち、
確定見積に必要な条件が満たされるまで主要送信ボタンを無効化する。

#### 入力UX

- 幅・長さ・充填量・数量・SKU長さは単位を入力欄の接尾辞として常時表示する。
- 連結形式は1連〜4連をカード型ラジオで選択し、選択直後に「1枚あたり総充填量＝室数×ml/室」を表示する。
- 充填方式の選択では、テスト充填量は両方式共通、初期投入量だけが2,000ml/8,000mlで変わることを即時表示する。
- SKU長さは行追加で複数SKUを入力し、各行に300m未満エラー、下部に合計500m判定を表示する。
- カスタム寸法を選択した場合は「列数・原反幅・価格帯の変換ルール未設定」を警告し、確定見積を禁止する。
- 未確認色数別価格が使われる場合は「色数別価格 未適用」バッジを常時表示する。

#### バリデーションと計算可否

| レベル | 条件 | UI挙動 |
|---|---|---|
| field error | 必須未入力、0以下、数値以外 | 該当欄下に日本語メッセージを表示し、他欄の入力は妨げない |
| cross-field error | 充填列数と生産列数の不一致 | 結果は暫定計算のみ。管理者警告と差異値を表示 |
| business blocker | SKU合計<500mまたはSKU<300m | 計算を実行せず、修正案を構造化表示して確定ボタンを無効化 |
| business blocker | カスタム寸法変換ルール未設定 | 暫定比較を禁止し、設定依頼アクションを表示 |
| warning | 色別単価・Seven書式・税丸め未確認 | 設定既定値で暫定計算し、監査メタデータに未確認フラグを保存 |

#### 結果・出力

内部者向け結果は「フィルム／バルク／変動加工／固定／カスタム」の独立カードと合計検算行を表示し、
構成要素合計が最終原価と一致しない場合は計算結果を破棄する。金額は小数誤差を避けるため内部計算を
`Decimal`で行い、表示時のみ丸める。入力変更・パラメータ変更・計算バージョンが異なる結果は
見積プレビューへ反映しない。

顧客向けプレビューはSeven化学出力欄のみを表示し、原価・仕入・利益率・成功報酬・内部メタデータの
欄自体をDOMに生成しない。アクセシビリティは全入力にlabel、単位、エラーの`aria-describedby`接続を必須とし、
コントラスト比4.5:1以上、キーボード操作可能な入力・修正・出力フローを検証項目とする。

### 7.3 見積計算フロー

```
1. ユーザーがパウチ仕様を入力
   ├── デザイン選択（ラウンド/丸形/チューブ等）
   ├── サイズ選択（幅×長さ）
   ├── 印刷方式選択（デジタル / グラビア）
   ├── 印刷色数入力
   ├── 生産数量入力
   ├── 連結形式選択（1連/2連/3連/4連）
   ├── 充填方式選択（ホッパ/加圧）
   ├── 充填量入力（ml/室）
   ├── カスタム区分選択
   ├── 充填列数入力（列）
   ├── SKU別発注m入力（デジタル時）
   └── バルク単価入力（円/ml）

2. システムが自動計算
   ├── 必須入力・単位・カスタム寸法変換ルールを検証
   ├── サイズマスタから列数・原反幅・価格帯を取得
   ├── フィルム価格数式モデルでフィルム費を算出
   ├── バルク費を算出
   ├── 変動加工費（人件費+機械）を算出
   ├── 固定費を算出
   ├── カスタム費用を算出
   ├── デジタルフィルムのSKU別最小発注条件を検証
   └── 最終原価・販売単価を算出

3. 結果表示
   ├── 検証結果・修正案・未確認設定バッジ
   ├── 原価内訳テーブル
   ├── 利益率別販売単価
   ├── シナリオ比較（数量別）
   ├── 発注可能な近似数量・実際の発注m
   ├── 入力/結果監査メタデータ
   └── セブン化学向け見積書PDF出力
```

### 7.4 データベース設計（概要）

```
table SizeMaster {
  id          Int      @id
  design      String   // デザイン名
  widthMm     Int      // 製品幅
  lengthMm    Int      // 製品長さ
  lanes       Int      // 列数
  webWidthMm  Int      // 原反幅
  priceBand   String   // 価格帯
  pitchAddMm  Int      // ピッチ加算
  prodMultiplier Int   // 生産倍率
  chambers       Int    // 1連=1、2連=2、3連=3、4連=4
  fillingLanes   Int    // 充填テスト列数（初期値4）
  isCustom       Boolean // カスタム仕様か
  customCharge   Decimal? // 個別カスタム費用。未設定時は既定400,000円
  createdAt   DateTime
  updatedAt   DateTime
}

table DigitalFilmSku {
  id               Int      @id
  estimateGroupId  String   // 同一デジタル発注グループを識別
  skuCode          String
  requiredLengthM  Decimal  // 必要長さ(m)
  orderLengthM     Decimal  // 100m単位切上げ後の発注長さ(m)
  createdAt        DateTime
}

table CostParameter {
  id          Int      @id
  category    String   // film/labor/machine/production
  key         String   // パラメータキー
  value       Float    // 値
  unit        String   // 単位
  description String   // 説明
  updatedAt   DateTime
}

table FilmPriceTable {
  id              Int      @id
  widthBand       String   // 価格帯
  orderLengthMin  Int      // 発注長さ最小(m)
  orderLengthMax  Int      // 発注長さ最大(m) null=上限なし
  colorCount      Int?     // null=色数共通。色数別価格拡張用
  unitPrice       Float    // 円/m
  updatedAt       DateTime
}

table EstimateRecord {
  id            Int      @id
  inputJson     Json     // 入力パラメータ
  resultJson    Json     // 計算結果
  createdAt     DateTime
}

table QuotationRecord {
  id                Int      @id
  estimateId        Int
  quotationNumber   String   // 例: SQ-YYYYMMDD-00001
  issuerName        String   // 金井貿易株式会社
  customerName      String   // 株式会社セブン化学 等
  status            String   // draft/sent/approved/rejected/expired
  revision          Int      // 1開始。変更時は同一見積番号で新バージョンを作成
  previousRevisionId Int?    // 改訂前バージョン。監査・差分・再計算に使用
  commissionBasis   String   // tax_exclusive_subtotal / tax_inclusive_total / order_amount
  subtotal          Decimal  // 税抜小計
  taxRate           Decimal
  tax               Decimal
  total             Decimal
  commissionRate    Decimal  // 初期値0.20
  commissionAmount  Decimal? // approved時のみ計算する内部管理値。非承認状態では未計算
  validUntil        DateTime?
  approvedAt        DateTime?
  createdAt         DateTime
  updatedAt         DateTime
}

table QuotationLine {
  id            Int      @id
  quotationId   Int
  lineNumber    Int
  description   String   // 品名・仕様
  quantity      Int
  unit          String   // 枚、式、ロット等
  unitPrice     Decimal
  amount        Decimal
  sortOrder     Int
}

table QuotationTemplate {
  id             Int      @id
  customerName   String   // 標準テンプレートはnull、セブン化学向けを登録
  issuerBlock    Json
  headerNotes    Json
  footerNotes    Json
  taxRule       Json
  isActive       Boolean
  createdAt      DateTime
  updatedAt      DateTime
}
```

## 8. 計算エンジン設計

### 8.1 コア計算関数（TypeScript疑似コード）

```typescript
interface PouchSpec {
  design: string;
  widthMm: number;
  lengthMm: number;
  fillMlPerChamber: number;      // ml/室
  connectedChambers: 1 | 2 | 3 | 4; // 1連/2連/3連/4連
  fillingMethod: 'hopper' | 'pressure';
  fillingLanes: number;          // 初期値4。テスト充填量計算に使用
  isCustom: boolean;
  colorCount: number;
  bulkUnitPrice: number;  // JPY/ml
}

interface CostResult {
  quantity: number;
  connectedChambers: number;
  chamberCount: number;
  fillMlPerChamber: number;
  fillingMethod: 'hopper' | 'pressure';
  fillingLanes: number;
  bulkLossRate: number;
  initialChargeMl: number;
  testFillMl: number;
  bulkUsageMl: number;
  filmCostPerPiece: number;
  bulkCostPerPiece: number;
  bulkInitialAndTestCost: number;
  materialCostPerPiece: number;
  variableLaborPerPiece: number;
  machineVariablePerPiece: number;
  variableProcessingPerPiece: number;
  fixedCostPerPiece: number;
  customCharge: number;
  fixedLotCost: number;
  totalCostPerPiece: number;
  costComponents: {
    film: number;
    bulk: number;
    variableProcessing: number;
    fixedLot: number;
    custom: number;
  };
  costPerPieceComponents: {
    film: number;
    bulk: number;
    variableProcessing: number;
    fixedLot: number;
    custom: number;
  };
  sellingPrices: { margin: number; pricePerPiece: number; totalSales: number; profit: number }[];
  audit: {
    inputJsonSha256: string;
    resultJsonSha256: string;
    calculationVersion: string;
    digitalFilmPriceMode: 'color_specific' | 'common_fallback';
    unresolvedInputFlags: string[];
  };
}

function calculatePouchCost(
  spec: PouchSpec,
  quantity: number,
  printingMethod: 'digital' | 'gravure',
  params: CostParameters,
): CostResult {
  // 1. サイズマスタからパラメータ取得
  const sizeInfo = getSizeMaster(spec.design, spec.widthMm, spec.lengthMm);

  // 1-a. 連結パウチの室数を反映
  // 発注数量は連結後パウチ1枚を基準とし、充填・検品・生産の生産対象数は室数倍する
  const chamberCount = quantity * spec.connectedChambers;
  if (quantity <= 0 || spec.fillMlPerChamber <= 0 || spec.fillingLanes <= 0) {
    throw new QuotationValidationError('invalid_positive_input');
  }
  
  // 2. フィルム費計算
  const filmResult = calculateFilmCost(sizeInfo, spec, quantity, printingMethod, params);
  
  // 3. バルク費計算（初期投入 + テスト充填を含む）
  const initialChargeMl = spec.fillingMethod === 'pressure'
    ? params.pressureInitialChargeMl
    : params.hopperInitialChargeMl;
  const testFillMl = params.fillTestRuns * spec.fillingLanes * spec.fillMlPerChamber;
  const bulkUsageMl =
    chamberCount * spec.fillMlPerChamber * (1 + params.bulkLossRate)
    + initialChargeMl
    + testFillMl;
  const bulkCost = bulkUsageMl * spec.bulkUnitPrice;
  const bulkCostPerPiece = bulkCost / quantity;
  const bulkInitialAndTestCost = (initialChargeMl + testFillMl) * spec.bulkUnitPrice;
  
  // 4. 変動加工費計算
  const prodLaborPerPiece = params.laborPerHour / params.productionSpeed;
  const inspectLaborPerPiece = params.laborPerHour / params.inspectionSpeed;
  const machineVarPerPiece = params.machineChargePerHour / params.productionSpeed;
  const variableProcessingPerPiece = prodLaborPerPiece + inspectLaborPerPiece + machineVarPerPiece;
  
  // 5. 固定費計算
  const fixedLabor = (params.setupTime + params.cleanupTime) * params.laborPerHour;
  const fixedMachine = params.machineChargePerHour * (params.setupTime + params.cleanupTime);
  const fixedTotal = fixedLabor + fixedMachine;
  const customCharge = spec.isCustom ? params.customPouchCharge : 0;
  const fixedPerPiece = fixedTotal / quantity;
  
  // 6. 集計
  const materialCostPerPiece = filmResult.filmCostPerPiece + bulkCostPerPiece;
  const totalCostPerPiece =
    materialCostPerPiece + variableProcessingPerPiece + fixedPerPiece
    + customCharge / quantity;
  const costTotal = filmResult.filmTotal + bulkCost + fixedTotal + customCharge;
  const reconciledCostPerPiece =
    filmResult.filmCostPerPiece + bulkCostPerPiece + variableProcessingPerPiece
    + fixedPerPiece + customCharge / quantity;
  if (costTotal !== reconciledCostPerPiece * quantity) {
    throw new QuotationValidationError('cost_reconciliation_failed');
  }
  const inputForAudit = JSON.stringify({ spec, quantity, printingMethod, params });
  const costComponents = {
    film: filmResult.filmTotal,
    bulk: bulkCost,
    variableProcessing: variableProcessingPerPiece * quantity,
    fixedLot: fixedTotal,
    custom: customCharge,
  };
  const unresolvedInputFlags = [
    ...(!hasVerifiedSevenTemplate() ? ['seven_template_unconfirmed'] : []),
    ...(!hasVerifiedTaxRounding() ? ['tax_rounding_unconfirmed'] : []),
    ...(filmResult.digitalFilmPriceMode === 'common_fallback' ? ['digital_color_price_not_applied'] : []),
    ...(isCustomSizeMappingUnconfirmed(spec) ? ['custom_size_mapping_unconfirmed'] : []),
  ];
  
  // 7. 利益率別販売単価
  const margins = [0.15, 0.20, 0.30];
  const sellingPrices = margins.map(m => ({
    margin: m,
    pricePerPiece: totalCostPerPiece / (1 - m),
    totalSales: (totalCostPerPiece / (1 - m)) * quantity,
    profit: (totalCostPerPiece / (1 - m) - totalCostPerPiece) * quantity,
  }));
  
  return {
    quantity,
    connectedChambers: spec.connectedChambers,
    chamberCount,
    filmCostPerPiece: filmResult.filmCostPerPiece,
    bulkCostPerPiece, materialCostPerPiece,
    variableLaborPerPiece: prodLaborPerPiece + inspectLaborPerPiece,
    machineVariablePerPiece: machineVarPerPiece,
    variableProcessingPerPiece, fixedCostPerPiece: fixedPerPiece,
    totalCostPerPiece, sellingPrices,
    fillMlPerChamber: spec.fillMlPerChamber,
    fillingMethod: spec.fillingMethod,
    fillingLanes: spec.fillingLanes,
    bulkLossRate: params.bulkLossRate,
    initialChargeMl,
    testFillMl,
    bulkUsageMl,
    bulkInitialAndTestCost,
    fixedLotCost: fixedTotal,
    customCharge,
    costComponents,
    costPerPieceComponents: {
      film: filmResult.filmCostPerPiece,
      bulk: bulkCostPerPiece,
      variableProcessing: variableProcessingPerPiece,
      fixedLot: fixedPerPiece,
      custom: customCharge / quantity,
    },
    audit: {
      inputJsonSha256: sha256(inputForAudit),
      resultJsonSha256: sha256(JSON.stringify({
        quantity,
        chamberCount,
        filmResult,
        bulkUsageMl,
        costComponents,
        totalCostPerPiece,
        sellingPrices,
      })),
      calculationVersion: '2026-09.1',
      digitalFilmPriceMode,
      unresolvedInputFlags,
    },
  };
}
```

### 8.1.1 SKU別最小発注検証（TypeScript疑似コード）

```typescript
interface FilmSkuOrder {
  skuCode: string;
  requiredLengthM: number;
}

interface FilmSkuOrderWithOrderLength extends FilmSkuOrder {
  orderLengthM: number;
}

interface ValidationResult {
  valid: boolean;
  reason?: 'total_min' | 'sku_min';
  totalM: number;
  orderLengths: FilmSkuOrderWithOrderLength[];
  shortSkus?: FilmSkuOrderWithOrderLength[];
  corrections: {
    kind: 'raise_each_sku_to_minimum' | 'consolidate_skus' | 'minimum_viable_allocation';
    suggestedLengthsM: number[];
    message: string;
  }[];
}

function validateDigitalFilmOrder(
  skus: FilmSkuOrder[],
  params: CostParameters,
): ValidationResult {
  if (skus.length === 0) {
    throw new QuotationValidationError('digital_film_skus_required');
  }

  const orderLengths = skus.map(sku => ({
    ...sku,
    orderLengthM: Math.ceil(sku.requiredLengthM / 100) * 100,
  }));
  const totalM = orderLengths.reduce((sum, sku) => sum + sku.orderLengthM, 0);

  if (totalM < params.digitalFilmMinTotalM) {
    return {
      valid: false,
      reason: 'total_min',
      totalM,
      orderLengths,
      corrections: buildDigitalFilmCorrections(orderLengths, params, 'total_min'),
    };
  }

  const shortSkus = orderLengths.filter(
    sku => sku.orderLengthM < params.digitalFilmMinSkuM
  );
  if (shortSkus.length > 0) {
    return {
      valid: false,
      reason: 'sku_min',
      totalM,
      orderLengths,
      shortSkus,
      corrections: buildDigitalFilmCorrections(orderLengths, params, 'sku_min'),
    };
  }

  return { valid: true, totalM, orderLengths, corrections: [] };
}

function allocateMinimumViableLengths(
  skus: FilmSkuOrderWithOrderLength[],
  minTotalM: number,
  minSkuM: number,
): number[] {
  const raised = skus.map(sku => Math.max(sku.orderLengthM, minSkuM));
  const total = raised.reduce((sum, lengthM) => sum + lengthM, 0);
  if (total >= minTotalM) return raised;

  const largestIndex = raised.reduce(
    (maxIndex, lengthM, index, values) => (lengthM > values[maxIndex] ? index : maxIndex),
    0,
  );
  raised[largestIndex] += minTotalM - total;
  return raised;
}

function buildDigitalFilmCorrections(
  orderLengths: FilmSkuOrderWithOrderLength[],
  params: CostParameters,
  reason: 'total_min' | 'sku_min',
): ValidationResult['corrections'] {
  const raised = orderLengths.map(({ skuCode, orderLengthM }) => ({
    skuCode,
    orderLengthM: Math.max(orderLengthM, params.digitalFilmMinSkuM),
  }));
  const raisedTotal = raised.reduce((sum, sku) => sum + sku.orderLengthM, 0);
  if (raisedTotal >= params.digitalFilmMinTotalM) {
    return [{
      kind: 'raise_each_sku_to_minimum',
      suggestedLengthsM: raised.map(sku => sku.orderLengthM),
      message: '各SKUを300m以上に切り上げます。',
    }];
  }

  return [
    {
      kind: 'minimum_viable_allocation',
      suggestedLengthsM: allocateMinimumViableLengths(
        raised,
        params.digitalFilmMinTotalM,
        params.digitalFilmMinSkuM,
      ),
      message: '合計500mを満たす最小発注配分案です。',
    },
    {
      kind: 'consolidate_skus',
      suggestedLengthsM: [Math.max(params.digitalFilmMinTotalM, raisedTotal)],
      message: 'SKU統合または再割当てを検討してください。',
    },
  ];
}
```

検証が失敗した場合は例外で終了せず、修正可能なUIメッセージと修正案を返す。
修正案は各SKUを300m以上に切り上げた上で、合計500m未満なら不足分を最大SKUまたは
ユーザー指定SKUに追加する。
不足理由に応じて`raise_each_sku_to_minimum`、`consolidate_skus`、
`minimum_viable_allocation`を構造化して返し、デジタル発注検証が通るまで見積確定を禁止する。

### 8.2 フィルム費計算関数

```typescript
function calculateFilmCost(
  sizeInfo: SizeMaster,
  spec: PouchSpec,
  quantity: number,
  printingMethod: 'digital' | 'gravure',
  params: CostParameters,
): {
  filmCostPerPiece: number;
  filmTotal: number;
  actualQty: number;
  pricingQty: number;
  orderLengthM: number;
  digitalFilmPriceMode: 'color_specific' | 'common_fallback';
  details: FilmCostDetails;
} {
  if (quantity <= 0) {
    throw new QuotationValidationError('invalid_positive_input');
  }

  if (printingMethod === 'digital') {
    const digitalValidation = validateDigitalFilmOrder(sizeInfo.skus, params);
    if (!digitalValidation.valid) {
      throw new QuotationValidationError('digital_film_order_invalid', digitalValidation.corrections);
    }
  }
  
  const pitch = sizeInfo.lengthMm + sizeInfo.pitchAddMm;
  const lanes = sizeInfo.lanes;
  const effectiveMultiplier = sizeInfo.prodMultiplier;
  
  // 必要生産数量（ロス考慮）
  const requiredQty = quantity / (1 - params.lossRate);
  
  // 必要フィルム長さ
  const requiredLengthM = (requiredQty / lanes) * pitch / 1000;
  
  // 実発注長さ（最小ロット単位に切り上げ）
  const orderLengthM = Math.ceil(requiredLengthM / 100) * 100;
  
  // ロス
  const loss = Math.max(params.lossMinM, orderLengthM * params.lossRate);
  const effectiveLengthM = orderLengthM - loss;
  
  // 確認数量
  const actualQty = Math.floor((effectiveLengthM * 1000 / pitch) * lanes);
  const pricingQty = Math.floor(actualQty / 500) * 500;
  if (pricingQty <= 0) {
    throw new QuotationValidationError('no_priceable_quantity');
  }
  
  // m単価取得
  const unitPrice = getFilmUnitPrice(sizeInfo.priceBand, orderLengthM, printingMethod, params);
  
  // 配送費
  const shippingUnitM = getShippingUnit(sizeInfo.webWidthMm, params);
  const productionLengthM = orderLengthM * effectiveMultiplier;
  const shippingTrips = Math.ceil(productionLengthM / shippingUnitM);
  const domesticShipping = shippingTrips * params.domesticShippingPerTrip;
  const overseasShipping = shippingTrips * params.overseasShippingPerTrip;
  
  // 通関料
  const filmBaseCost = orderLengthM * unitPrice;
  const customs = filmBaseCost > 200000 ? 6600 : shippingTrips * 200;
  
  // フィルム総額
  const filmTotal = filmBaseCost + domesticShipping + overseasShipping + customs;
  const filmCostPerPiece = filmTotal / pricingQty;
  
  const digitalFilmPriceMode = printingMethod === 'digital'
    ? getDigitalFilmPriceMode(sizeInfo.priceBand, orderLengthM, spec.colorCount, params)
    : 'common_fallback';

  return {
    filmCostPerPiece,
    orderLengthM,
    filmTotal,
    actualQty,
    pricingQty,
    details: {
      requiredLengthM,
      orderLengthM,
      loss,
      effectiveLengthM,
      actualQty,
      pricingQty,
      unitPrice,
      filmBaseCost,
      domesticShipping,
      overseasShipping,
      customs,
      filmTotal,
    },
    digitalFilmPriceMode,
  };
}
```

### 8.3 充填量・連結形式の取り扱い

```
入力発注数量 = 連結後パウチ枚数
室数 = 入力発注数量 × 連結室数
充填量 = ml/室
```

UIでは「充填量（ml/室）」として入力させ、入力後に「1枚あたり総充填量」を参考表示する。
例として3連・30ml/室の場合、1枚あたり総充填量は90mlとなる。
テスト充填量は充填列数で計算するため、フィルム生産列数と必ず一致しているかを起動時・
保存時に検証し、不一致がある場合は管理者に警告する。

## 9. 今回のマウスウォッシュ計算との対応

現在のマウスウォッシュ計算（70円/m固定）は、本システムでは以下のように対応:

| 項目 | 今回の計算 | システム化後 |
|---|---|---|
| フィルム単価 | 70円/m 固定入力 | フィルム価格テーブルから自動取得（45×145 / 396mm / 570mm以下） |
| バルク単価 | 0.37円/ml 入力 | ユーザー入力 |
| 生産速度 | 3,600枚/時間 | 管理画面で調整可能 |
| 人件費 | 一律2,500円/時間 | 管理画面で調整可能 |
| 機械チャージ | 約2,670円/時間 | 管理画面パラメータから自動計算 |
| 固定費 | 25,850.63円/回 | 段取り・清掃時間×人件費 + 機械チャージ×時間 |

## 10. セブン化学向け見積書要件

### 10.1 見積書の基本方針

- 発行者は金井貿易株式会社、第一想定の宛先は株式会社セブン化学とする。
- 原価内訳・成功報酬・仕入値は顧客向け見積書に出力しない。
- 品名、仕様、数量、単位、単価、金額、納期、支払条件、有効期限、備考、発行者・宛先情報、
  見積番号・改訂番号、発行日、税抜小計、消費税、税込合計を出力する。
  承認管理・参照番号などSeven化学指定欄はテンプレート設定値から追加する。
- 見積番号はSKUや仕様ではなく見積単位で採番し、変更時は同一番号で改訂番号を増やす。
  改訂前バージョンは削除・上書きせず、前改訂IDでリンクして監査可能に保つ。
- PDFはA4縦・日本語フォント埋め込みを基本とし、セブン化学指定書式がある場合はそれを優先する。
- 金額は税抜小計・消費税・税込合計を区分表示する。行端数処理・税端数処理・適用税率は
  検証済みテンプレート設定が確定するまで暫定値として扱い、監査メタデータに未確認フラグを記録する。
  設定確定後は行ごとの最終丸めを行い、合計は行金額合計・税額合計から再計算する。
- 原価・仕入価格・利益率・成功報酬・フィルム明細・バルク明細は内部画面と監査記録に限定し、
  標準のSeven化学向け出力テンプレートから除外する。

### 10.2 標準明細構成

```
1. パウチ本体（仕様・サイズ・連結形式・色数・数量・単価）
2. 充填作業（充填方式・充填量・数量）
3. カスタム仕様費用（カスタムの場合のみ、400,000円/仕様）
4. 送料・通関料など諸費用（原価に含めない場合は別明細）
5. セブン化学指定項目（テンプレートで追加）
```

システムは原価計算結果をそのまま見積行に変換せず、管理者が設定した利益率・丸め単位・
販売単価ポリシーを適用した後に見積ドラフトを生成する。金額計算は`Decimal`で行い、表示・
PDF出力時だけ最終丸めを適用する。見積書には近似数量・充填量・連結形式など計算根拠を
内部メタデータとして保存し、監査・再計算に利用する。ただし顧客向け出力DOMには原価・報酬・
仕入値の欄を生成せず、PDF生成前にも表示禁止フィルタを実行する。

### 10.3 金井貿易株式会社の成功報酬

```
成功報酬額 = 報酬計算基準額 × 20%
```

- 初期の報酬計算基準額は税抜見積小計とする。
- 顧客承認済み（approved）の見積のみ報酬対象として扱う。
- 報酬額・報酬率は金井貿易株式会社およびシステム管理者のみ閲覧できる内部情報とする。
- 値引きがあった場合は改訂見積を作成し、承認済みの最新版に基づいて再計算する。
- 初期計算式は`成功報酬額 = 税抜見積小計 × 20%`とする。税込基準・受注額基準へ変更できる場合も、
  基準は見積レコードに`commissionBasis`として保存する。
- approvedへの状態遷移トランザクション内でのみ`commissionAmount`を計算・保存する。
  改訂版は前改訂の承認状態を引き継がず、その改訂自体がapprovedになった時点で再計算する。

### 10.4 承認フロー

```
draft（ドラフト）
  -> sent（送付済）
  -> approved（顧客承認）または rejected（見送り）
  -> expired（有効期限切れ）
```

承認操作は金井貿易株式会社または管理者が行う。承認後に仕様変更が必要になった場合は、
同一見積番号で改訂版を作成し、改訂前バージョンを履歴として保持する。

状態遷移ルール:

| 現在状態 | 操作 | 次状態 | 内部報酬 |
|---|---|---|---|
| draft | Seven化学へ送付 | sent | 計算しない |
| sent | 顧客承認 | approved | トランザクション内で税抜小計×20%を計算・保存 |
| sent | 見送り | rejected | 計算しない |
| sent | 有効期限切れ | expired | 計算しない |
| approved / rejected / expired | 条件変更 | 新しいrevisionを作成 | 前revの値を保持し、新revでは再計算 |

新しいrevisionは必ず`draft`から開始し、承認時にのみ新しい報酬額を確定させる。

改訂・再計算の検証:

| 検証 | 期待結果 |
|---|---|
| 旧改訂のapproved値 | 変更しない。監査履歴から再表示できる |
| 新改訂draft/sent | 前改訂の報酬額を継承しない。commissionAmountは未計算 |
| 新改訂approved | その時点の税抜小計に対して20%を再計算 |
| 同一操作での二重承認 | 二回目は`approved`遷移が成立せず報酬を再加算しない |

UI検証項目:

1. フォームエラー・検証ブロック・未確認バッジが正しい状態で表示される。
2. 充填方式切替時にテスト充填量が変化せず、初期投入量のみ6,000ml差として表示される。
3. 連結形式変更時に1枚総充填量と合計バルク量が即時更新される。
4. SKU行追加・削除後も合計・SKU最小値判定が維持される。
5. 顧客向けプレビューとPDFに内部金額・原価・報酬が含まれない。
6. キーボードだけで入力→検証修正→確定→出力プレビューまで完結できる。
7. 改訂比較画面で旧値・新値・変更理由・承認状態が区別される。

## 11. 検証シナリオとUI検証

### 11.1 検証シナリオ

| 分類 | シナリオ | 期待結果 |
|---|---|---|
| デジタル最小発注 | SKU1=300m、SKU2=300m | 合計600mのため発注可能 |
| デジタル最小発注 | SKU1=250m、SKU2=300m | SKU1が300m未満のため不可。修正案提示 |
| デジタル最小発注 | SKU1=450m、SKU2=50m | SKU2が300m未満のため不可。修正案提示 |
| デジタル最小発注 | SKU1=500m | 合計500m以上のため発注可能 |
| デジタル近似 | SKU必要長さ137m、切上げ単位100m | SKU発注長さ200mへ切上げ後、ピッチ・列数・ロスで可能数量再計算 |
| ホッパ充填 | 10,000枚・2連・30ml/室・4列 | 充填対象20,000室、テスト60,000ml、初期2,000mlを加算 |
| 加圧充填 | 10,000枚・2連・30ml/室・4列 | テスト60,000mlを含み、初期投入は8,000ml |
| 連結換算 | 3連・1,000枚・30ml/室 | 充填対象室数は3,000室 |
| 連結充填量 | 3連・30ml/室 | 1枚あたり総充填量は90ml |
| カスタム | カスタム区分=標準 | カスタム費用0円 |
| カスタム | カスタム区分=カスタム | 仕様あたり400,000円を独立内訳として1回加算 |
| 報酬 | 税抜小計1,000,000円の見積を承認 | 内部成功報酬200,000円 |
| 報酬 | draft / sent / rejected / expired | commissionAmountは未計算とし、active/eligibleとして有効化しない |
| 改訂 | approved見積を条件変更 | 新revisionはdraft、旧revは保持、新rev承認時に報酬再計算 |
| 近似数量 | 必要長さから100m単位切上げ | ロス・ピッチ・列数から実際可能数量を再計算 |
| 入力完全性 | 標準以外のパウチ寸法 | 変換ルール未設定なら確定見積禁止と設定依頼表示 |
| UI検証 | フォーム・検証・結果・出力 | 7.2.1の7項目すべて合格 |
| 数値整合 | 費用構成要素合計と最終原価 | Decimal集計で差額0円 |
| 出力分離 | 顧客向けDOMとPDF | 原価・仕入・利益率・報酬欄が存在しない |

### 11.2 受け入れ条件トレース

| 受け入れ条件 | 対象章 | 検証 |
|---|---|---|
| 商業フローとapproved後報酬 | 1.1 / 10.3 / 10.4 | 報酬状態遷移表と非承認状態シナリオ |
| 必須入力と単位 | 2.1.1 / 2.1.2 | 入力・用語マトリクス |
| ホッパ/加圧式 | 3.2.1 | 722,000mlと728,000mlの計算例 |
| 連結意味論 | 2.1.2 / 8.3 | 3連×30ml=90mlと3,000室シナリオ |
| デジタル最小発注 | 5.1 / 6.7 / 8.1.1 | 300+300許可、合計不足拒否、SKU不足拒否 |
| デジタル色数拡張 | 5.2 / 7.4 | color_specific / common_fallbackと未適用表示を検証 |
| 充填列数 | 2.1.1 / 2.1.2 / 3.2.1 / 7.2.1 | 500×充填列数×充填量へ専用入力を使用 |
| カスタム費用 | 3.2.3 / 6.6 | 400,000円の独立1回加算 |
| Seven出力と内部区分 | 10.1 / 10.3 | 顧客出力欄から原価・報酬除外 |
| DB/擬似コード整合 | 7.4 / 8.1 / 8.1.1 / 8.2 | 同一ルール・同一単語・同一単位の横断確認 |
| 検証網羅 | 11 / 11.1 / 11.2 | 受け入れ条件と検証シナリオの対応 |
| アーキテクチャ維持 | 7.1 / 12 | Next.js/Vercel構成と段階開発の継続 |
| 未確認項目 | 13 | 書式・税丸め・色別価格・カスタム寸法を確認/設定扱い |

## 12. 開発フェーズ

### Phase 1: 計算エンジン
- 原価計算コアロジック（TypeScript）
- デジタルフィルム価格数式モデル実装
- SKU別最小発注・連結室数・充填方式・カスタム費用の実装
- 単体テスト（既存Excel値との照合）

### Phase 2: UI・管理画面
- 見積計算画面
- 原価パラメータ管理画面
- サイズマスタ管理画面
- セブン化学向け見積テンプレート管理
- 見積結果表示・PDF出力

### Phase 3: グラビア対応
- 印刷方式切替UI
- グラビア固有コスト計算
- 版代・インク代のパラメータ管理

### Phase 4: 公開・配備
- 認証・アクセス制御
- 本番環境デプロイ
- ドメイン設定

## 13. 確認事項

設計を確定する前に以下を確認:

1. **セブン化学書式**: 指定見積テンプレート・必須記載項目・宛先部品の確定
2. **管理者認証**: 管理画面の認証方法（Googleログイン / ID+パスワード / IP制限）
3. **データベース**: Supabase等のBaaSで十分か、独自DBが必要か
4. **消費税・丸め**: 見積行・税額・合計の端数処理と適用税率の最終確認
5. **言語**: 本設計は日本語のみ。韓国語/英語対応が必要になった場合は要件確認を行い、既存文書を複製しない
6. **グラビア価格**: グラビア印刷のフィルム単価テーブルは別途提供か
7. **カスタムサイズ**: サイズマスタにない寸法の列数・原反幅・価格帯算定ルール。確定までは確定見積禁止
8. **デジタル色数価格**: 未取得。色別テーブル登録までは共通単価を使用し、「色数別価格 未適用」を表示
9. **報酬計算基準**: 初期は税抜小計20%。税込・受注額基準へ変更する場合は最終合意を設定へ反映
