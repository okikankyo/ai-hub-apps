# Cloud Run + Neon + Google Cloud Storage

この構成では、Cloud Runをアプリ実行、Neonをチャット・利用ログ、GCSを生成画像と添付画像の保存に使う。Cloud Runのコンテナは入れ替わる前提なので、`DATABASE_URL`と`GCS_BUCKET`を必ず設定する。

## 初回設定

1. NeonでPostgreSQLデータベースを作成し、接続文字列を取得する。Cloud Runではpooler接続文字列を使う。
2. Google Cloud Storageでバケットを作成する。
3. Cloud Runの実行サービスアカウントに、そのバケットのオブジェクト読み書き・削除権限を付与する(例: Storage Object Admin)。
4. Cloud Runに次の環境変数を設定する。

```text
OPENAI_API_KEY=...
DATABASE_URL=postgresql://...
DATABASE_SSL=true
DATABASE_POOL_MAX=5
GCS_BUCKET=ai-hub-chat-images
BASE_URL=https://<公開ドメイン>
```

Googleログインを使う場合は、Google Cloud Consoleの承認済みリダイレクトURIに次を追加する。

```text
https://<公開ドメイン>/auth/google/callback
```

Cloud Runのコンテナポートは`8787`にする。Dockerfileがヘルスチェックとして`/api/config`を使う。

## 既存SQLiteログの移行

Cloud Runへ切り替える前に、元の`data/app.db`をバックアップしてから、Neonの空データベースへ一度だけ移行する。

```bash
cd company_ai_chat
SKIP_DB_SEED=1 \
DATABASE_URL='postgresql://...' \
SOURCE_DB='./data/app.db' \
node scripts/migrate-sqlite-to-postgres.js
```

移行後はCloud Runの`DATABASE_URL`を同じNeon接続文字列にする。移行スクリプトはユーザー、部署、会話、メッセージ、利用ログ、分類、警告、テンプレートを対象にする。セッションは期限切れのものを削除するため、切り替え後に再ログインが必要になる。

## デプロイ例

```bash
gcloud run deploy ai-hub-chat \
  --source . \
  --region asia-northeast1 \
  --port 8787 \
  --set-env-vars "DATABASE_URL=...,DATABASE_SSL=true,DATABASE_POOL_MAX=5,GCS_BUCKET=...,BASE_URL=https://..."
```

OpenAI APIキーやNeon接続文字列は、実運用ではSecret ManagerからCloud Runへ渡す。コマンド履歴やGitには保存しない。
