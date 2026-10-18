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

## データ保存

- 既定ではローカル SQLite（`.data/`）を使用します。
- 環境変数 `DATABASE_URL`（Neon PostgreSQL など）を設定すると、全環境で共有される
  PostgreSQL に見積履歴・顧客マスタ・チェックリストを保存します。
- 本番（Vercel）での共有DB設定手順は [docs/NEON_SETUP.md](docs/NEON_SETUP.md) を参照してください。

### 見積ドメイン バックアップ

```bash
npm run backup:quotation-domain
```

- 既定ターゲットはローカル SQLite `.data/quotations.db` です。
- `quotations`、`quotation_checklists`、`film_orders`、`film_order_files`、`film_order_events`
  をバイナリ安全な JSONL として検証付きで保存し、`manifest.json` にターゲット証明・行数・
  レコード数・SHA-256 を記録します。
- バックアップは既定で `.omx/backups/` に作成され、Git には含まれません。
- PostgreSQL の本番バックアップは誤接続を防ぐため既定になりません。明示的な
  `--target production` に加えて、正確な `--confirm-host` / `--confirm-database` と
  `--confirm-production-read-only-backup` が必要です。コマンドは読み取り専用トランザクションで実行されます。
- `--target postgres-test` は自動検証専用の内部経路です。`POUCH_TEST_POSTGRESQL_URL`
  が localhost の `*test*` database と isolated schema を指す場合のみ許可し、
  host / database / schema の一致確認が必要です。本番接続には使用しません。
- 本番削除は 2 フェーズ固定です。Phase 1 は読み取り専用接続で対象証明・FK グラフ・行数・
  保持テーブル identity を検証し、バイナリ安全な backup を作成した後、`authorization.json`
  と `authorization.challenge` を作成します。Phase 1 は削除しません。

### 見積ドメイン ローカル削除

```bash
npm run cleanup:quotation-domain:local
```

- ローカル削除は検証済み backup を必要とし、rollback 可能な検証はすべて `COMMIT` 前に
  行います。`COMMIT` 後の検証や外部顧客 DB 比較に失敗した場合は削除が確定済みであることを
  示す `committed_with_post_commit_warning` と exit code 3 を返します。通常失敗は exit code 1 です。
- 削除証明用の一時 SQLite snapshot は owner-only（directory `0700` / file `0600`）の
  一時 directory に作成し、成功・失敗とも処理後に directory ごと削除します。

```bash
npm run cleanup:quotation-domain:production:phase1 -- \
  --target production --confirm-production-read-only-backup \
  --confirm-host <exact-host> --confirm-database <exact-database> \
  --confirm-schema public \
  --confirm-domain-tables film_order_events,film_order_files,film_orders,quotation_checklists,quotations \
  --output-dir <verified-ignored-output-directory>

# operator inspection happens here

npm run cleanup:quotation-domain:production:phase2 -- \
  --target production --confirm-production-deletion \
  --confirm-host <exact-host> --confirm-database <exact-database> \
  --confirm-schema public \
  --confirm-domain-tables film_order_events,film_order_files,film_orders,quotation_checklists,quotations \
  --backup-manifest <phase-1-output>/manifest.json \
  --authorization-file <phase-1-output>/authorization.json \
  --challenge-file <phase-1-output>/authorization.challenge
```

- authorization evidence は target / manifest SHA-256 / table counts / binary totals /
  nonce / 作成・失効時刻 / tool version を記録します。raw challenge は evidence に書かず、
  token SHA-256 と evidence HMAC のみで束縛します。Phase 2 は `--challenge-file` または
  exact token 引数のどちらか一方だけを受け付けます。失効は既定 15 分（30〜3600 秒）です。
- Phase 2 は challenge / evidence / manifest / 現在 target / FK graph / backup 内容 /
  count / binary totals / retained identity を再検証した後、対象 table に
  `ACCESS EXCLUSIVE` lock を取得し、`READ COMMITTED` で post-challenge commit を隠さない
  状態でもう一度現在行を検証してから、1 transaction で FK-safe 順に削除します。
  COMMIT 後の既定処理は fallible な検証を行いません。明示的な post-commit 検証 API が
  失敗した場合は `committed_with_post_commit_warning` と exit code 3 を返します。

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
