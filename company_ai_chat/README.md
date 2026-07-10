# 社内AIチャット (company_ai_chat)

OpenAI API(ChatGPT のモデル)を使った自社向けチャット Web アプリです。
**Node.js 22 以上で動作**し、依存パッケージはメール送信用の `nodemailer` のみです(`npm install` が必要)。

## 主な機能

| 機能 | 説明 |
|---|---|
| ChatGPT 風チャット UI | 会話履歴サイドバー、ストリーミング応答、Markdown/コードブロック表示 |
| 部署ごとの予算管理 | 部署に月次予算(円)を割り当て。トークン使用量から自動でコスト換算・集計 |
| 自動ロック | 予算超過した部署はチャット送信が自動でロック |
| 管理者によるロック解除 | 管理画面から「今月のみ解除」または予算引き上げが可能 |
| 業務/私的利用の自動判定 | 各メッセージを AI(既定: gpt-4o-mini)が work / private に分類。**保存されるのはラベルのみで、本文は分析用に保持しません** |
| グラフ化 | 管理ダッシュボードに部署別予算消化・ユーザー別業務/私的比率・日別コストを表示 |
| ユーザーごとの警告 | 私的利用率が閾値(既定 30%)を超えると自動警告。管理者からの手動警告も可能 |
| ユーザー管理 | 追加・部署変更・停止/再開・権限(一般/管理者) |
| Google ログイン + 承認制 | 個人の Google アカウントでログイン可能。初回ログイン時は**承認待ち**となり、管理者が部署を割り当てて承認するまでチャットは使えない |
| テキスト相談 | GPT-5.6 Lunaを固定して回答。使用モデルは各応答の下に表示 |
| 画像生成 | 画像生成の依頼を検知すると画像モデルで生成し、チャット内に表示 |
| 実行前の人間確認 | 送信・削除・金額・個人情報が絡む依頼は、確認ダイアログで本人が承認してから高性能モデルで処理 |
| 個人の業務/プライベート比率 | サイドバーに本人の比率をミニ円グラフで表示(管理ダッシュボードには全社版も表示) |
| チャット開始テンプレート | 管理画面で1〜5個の定型文(ラベル+内容)を管理でき、ユーザーはワンクリックで送信・チャット開始できる |
| 承認申請フォーム + メール通知 | Google初回ログイン時に氏名・希望部署を入力して申請。管理者に通知メールが届き、承認すると申請者にも通知メールが届く。承認待ち画面は自動更新され、承認後すぐに利用画面に切り替わる |

## 使用モデル

| 内容 | 振り分け先 | 環境変数(既定値) |
|---|---|---|
| テキスト相談 | GPT-5.6 Luna | `LUNA_MODEL`(`gpt-5.6-luna`) |
| 実際の画像生成 | 画像モデル | `IMAGE_MODEL`(`gpt-image-1`) |

GPT-5.6 Lunaは限定プレビューです。OpenAI側で利用許可された組織のAPIキーが必要です。
分類処理だけは別途 `CLASSIFIER_MODEL` を使います。

## 起動方法

```bash
cd company_ai_chat
npm install
OPENAI_API_KEY=sk-xxxx node server.js
# → http://localhost:8787
```

`OPENAI_API_KEY` を設定しない場合は**モックモード**で起動します
(ダミー応答を返すので、API キーなしで UI・予算・ロック・警告の動作確認ができます)。

### 初期アカウント

| ユーザー名 | パスワード | 権限 |
|---|---|---|
| `admin` | `admin1234` | 管理者 |
| `demo` | `demo1234` | 一般(営業部) |

**本番運用前に必ずパスワードを変更してください**(管理画面のユーザータブ、または admin API から変更可能)。

## Google ログインの設定(任意)

1. [Google Cloud Console](https://console.cloud.google.com/apis/credentials) で「OAuth クライアント ID」(種類: ウェブアプリケーション)を作成
2. 「承認済みのリダイレクト URI」に `{BASE_URL}/auth/google/callback` を追加
   (例: `http://localhost:8787/auth/google/callback`、本番は `https://chat.example.com/auth/google/callback`)
3. 環境変数を設定して起動:

```bash
GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com \
GOOGLE_CLIENT_SECRET=GOCSPX-xxxx \
BASE_URL=http://localhost:8787 \
OPENAI_API_KEY=sk-xxxx node server.js
```

### 承認フロー

1. ユーザーがログイン画面の「Google でログイン」からログイン(個人アカウント可)
2. 初回は**承認待ち**アカウントとして作成され、本人には「承認待ちです」画面が表示される(チャットは利用不可)
3. 管理者が管理画面 → ユーザータブの「承認待ちのユーザー」で**部署を割り当てて承認**(または拒否)
4. 承認後、ユーザーは割り当てられた部署の予算内でチャットを利用できる

既存ユーザーと同じメールアドレスの Google アカウントでログインした場合は、そのアカウントに自動的に紐付きます(再承認は不要)。

## Coolify へのデプロイ

このリポジトリには `Dockerfile` が含まれているので、Coolify では「Dockerfile」タイプのリソースとしてデプロイできます。

1. Coolify で **新規リソース → Dockerfile** を選び、このリポジトリ(またはこのブランチ)と `company_ai_chat` をベースディレクトリに指定
2. **ポート**: `8787` を公開ポートとして設定(Dockerfile 内で `EXPOSE 8787` 済み)。Coolify 側で自動的に Traefik 経由の HTTPS が割り当てられる
3. **永続ボリューム**: コンテナ内の `/app/data` に永続ボリュームをマウントする(必須)。
   ここに SQLite データベースと生成画像が保存されるため、マウントしないと**再デプロイのたびに全データが消えます**
4. **環境変数**を Coolify の「Environment Variables」画面で設定(`.env.example` を参照):
   - `OPENAI_API_KEY`(必須。未設定だとモックモードのまま公開されてしまうので注意)
   - `BASE_URL` に Coolify が割り当てた公開ドメイン(例: `https://chat.example.com`)を設定
     - `https://` で始めておくと、セッション Cookie に自動で `Secure` 属性が付く
     - Google ログインを使う場合、このドメイン+`/auth/google/callback` を Google Cloud Console の承認済みリダイレクト URI に登録すること
   - `LUNA_MODEL` は通常変更不要です。GPT-5.6 Lunaの利用許可があるAPIキーを設定してください
   - 部署予算・Google OAuth 関連の変数は必要に応じて設定
5. デプロイ後、初回は `admin` / `admin1234` でログインし、**必ずパスワードを変更**してください

ヘルスチェックは認証不要の `/api/config` を利用しています(Dockerfile の `HEALTHCHECK` に設定済み)。

## 環境変数

`.env.example` を参照してください。主なもの:

| 変数 | 既定値 | 説明 |
|---|---|---|
| `OPENAI_API_KEY` | (なし=モック) | OpenAI API キー |
| `LUNA_MODEL` | `gpt-5.6-luna` | テキスト相談に固定して使うモデル |
| `CLASSIFIER_MODEL` | `gpt-4o-mini` | 業務/私的判定・モデルルーティング判定に使うモデル |
| `USD_JPY` | `150` | コスト換算レート(円/ドル) |
| `PRIVATE_RATIO_WARN` | `0.3` | 自動警告を出す私的利用率の閾値 |
| `PRIVATE_MIN_COUNT` | `5` | 自動警告に必要な月間の最低判定件数 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | (なし=無効) | Google ログイン用 OAuth クライアント |
| `BASE_URL` | `http://localhost:8787` | リダイレクト URI・通知メール内リンクの生成に使う公開 URL |
| `SMTP_USER` / `SMTP_PASS` | (なし=無効) | 通知メール送信用の Gmail アドレスと[アプリパスワード](https://myaccount.google.com/apppasswords) |
| `PORT` | `8787` | 待ち受けポート |
| `DATA_DIR` | `./data` | SQLite データベースの保存先 |
| `SYSTEM_PROMPT` | (社内アシスタント既定文) | チャットのシステムプロンプト |

## 仕組み

- **コスト計算**: OpenAI のレスポンスに含まれるトークン数 × モデル単価(`lib/openai.js` の `PRICING`)を円換算して `usage_log` に記録します。分類 API のコストも含まれます。
- **ロック判定**: 「当月の部署合計コスト ≥ 予算」でロック。管理者の解除は当月限りで、翌月は自動的に通常判定に戻ります。
- **プライバシー**: 分類結果テーブル(`classifications`)にはラベルと日時のみ保存し、メッセージ本文・会話への参照を持ちません。会話本文は本人のチャット履歴表示のためだけに保存され、管理画面からは参照できません。
- **認証**: scrypt によるパスワードハッシュ + HttpOnly Cookie セッション。`BASE_URL` が `https://` の場合、セッション/OAuth Cookie に自動で `Secure` が付与されます(`lib/auth.js`)。

## ディレクトリ構成

```
company_ai_chat/
├── server.js          # エントリポイント(HTTP サーバー + 静的配信)
├── Dockerfile          # Coolify 等へのデプロイ用
├── package.json        # メタデータ・依存パッケージ(nodemailer)
├── lib/
│   ├── db.js          # SQLite (node:sqlite) スキーマ・シード
│   ├── auth.js        # セッション認証
│   ├── google_auth.js # Google OAuth (OIDC) ログイン
│   ├── openai.js      # OpenAI API 呼び出し・コスト計算・モック
│   └── routes.js      # API ルート(チャット SSE / 予算 / 管理)
├── public/            # フロントエンド(vanilla JS SPA)
└── data/              # SQLite DB・生成画像(自動生成、Git 管理外。本番は永続ボリューム推奨)
```
