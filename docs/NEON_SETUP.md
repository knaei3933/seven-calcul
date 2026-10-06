# 共有データベース構成（Vercel + Neon PostgreSQL）

これまで本番（Vercel）ではインスタンス毎に消える `/tmp` の SQLite を使っていたため、
閲覧者やタイミングによって見積履歴・顧客マスタが異なる問題がありました。

この構成では `DATABASE_URL` を設定すると、全ユーザー・全インスタンスが同じ
PostgreSQL（Neon Free プランで開始可能）を参照します。未設定の場合は従来どおり
ローカル SQLite（`.data/*.db`）へ保存します。

## セットアップ手順

1. **Neon プロジェクトを作成する**
   - https://neon.com で無料アカウントを作成し、プロジェクト（例: `seven-calcul`）を作成します。
   - リージョンは日本国内（Tokyo / `ap-southeast-1` 近傍）を選ぶと通信遅延が小さくなります。

2. **接続文字列をコピーする**
   - Dashboard の「Connection Details」で **Pooled connection**（ホスト名に `-pooler` が付く方）を選びます。
   - 形式: `postgresql://ユーザー:パスワード@ep-xxxx-pooler-xxxx.aws.neon.tech/neondb?sslmode=require`
   - パスワードは再表示できないため、必ずこの時点で控えます。

3. **Vercel に環境変数を登録する**
   - Vercel プロジェクト → Settings → Environment Variables
   - Key: `DATABASE_URL`
   - Value: 上記の接続文字列
   - Environment: Production / Preview / Development すべてに適用

4. **再デプロイする**
   - 環境変数の反映には再デプロイが必要です。
   - デプロイ後、初回アクセス時に `users / sessions / quotations / quotation_checklists / customers`
     テーブルが自動作成されます。

5. **動作確認**
   - `https://seven-calcul.vercel.app` にログインし、見積を1件保存します。
   - 別のブラウザ（または別端末）で同じURLを開き、履歴に同じ見積が表示されることを確認します。

## 環境変数の切替えで変わる動作

| 環境 | 動作 |
| --- | --- |
| `DATABASE_URL` あり | PostgreSQL（Neon）に共有保存。全ユーザーで同一データ |
| `DATABASE_URL` なし（ローカル） | `.data/quotations.db` / `.data/customers.db` に保存 |
| `DATABASE_URL` なし（Vercel） | `/tmp` の一時SQLiteに保存。**共有されずデプロイで消える**（起動時に警告ログ） |

## 接続の仕様

- `sslmode=require` または非ローカルホストの場合は SSL 接続を使用します。
- 同時接続数を抑えるためプールサイズは `max: 3` に制限しています。Neon 側も
  Pooled connection を使うことで接続数上限を消費しにくくなります。
- `pg`（node-postgres）を使用するため、Neon 以外の PostgreSQL（将来的に自社NAS等）にも
  同じ `DATABASE_URL` の形式で切り替え可能です。

## 既存ローカル履歴の移行

現時点では各PCの `.data/` 内 SQLite は自動移行されません。移行が必要になった場合は
SQLite から PostgreSQL への data 移行スクリプトを別途用意します。

## 開発・テスト

```bash
# 通常のローカル開発（SQLite）
npm run dev

# PostgreSQL を使ったローカル開発
DATABASE_URL="postgresql://..." npm run dev

# PostgreSQL 統合テスト（URLを指定した時だけ実行）
POUCH_TEST_DATABASE_URL="postgresql://..." npm test
```
