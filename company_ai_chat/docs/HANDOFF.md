# 引き継ぎ書 — 社内AIチャット (company_ai_chat)

最終更新: 2026-07-04

このドキュメントは、開発を別の担当者/AIエージェント(Codex 等)に引き継ぐための
現状まとめです。**README.md は一部が古い**ので、最新の挙動はこちらを正としてください
(後述の「README との差分」を参照)。

---

## 1. これは何か

OpenAI API(ChatGPTのモデル)を使った、観光系企業(okikankyo)向けの社内チャットWebアプリ。
ChatGPT風のUIに、部署ごとの予算管理・利用状況の可視化・Googleログイン承認制などを載せている。

- 本番URL: `https://chat.k-sango.com`
- リポジトリ: `okikankyo/ai-hub-apps`(このアプリはサブディレクトリ `company_ai_chat/`)
- 作業ブランチ: `claude/chatgpt-api-budget-chat-l708m9`

---

## 2. 技術スタック / 設計方針

- **Node.js 22+ / 依存フレームワークなし**。Webサーバーは生の `node:http`(`server.js`)。
- **DBは `node:sqlite`**(Node標準の実験的SQLite。外部ドライバ不要)。データは `DATA_DIR`(既定 `./data`)に `app.db` として保存。
- **フロントは素のVanilla JS SPA**(`public/app.js` 1ファイル)。ビルド工程なし。
- **重要な制約: ネイティブバイナリ依存を避ける。**
  本番は `node:22-alpine`(musl libc)で、かつ社内ネットワークのSSL検査機器によりビルドサーバーからの
  npmレジストリ接続が失敗する。そのため:
  - `node_modules` を**リポジトリにコミットして**いる(Dockerビルド時に `npm install` しない。`Dockerfile` は `COPY node_modules` するだけ)。
  - `.npmrc` に `omit=optional` を設定し、ネイティブバイナリの optional 依存を常に除外する。
  - PDF抽出に `pdf-parse` を使わない(`@napi-rs/canvas` というネイティブ依存を必須で持つため)。代わりに canvas 不要の `unpdf` を使用。
  - **npm パッケージを追加する場合は、ネイティブ `.node` バイナリを引き込まないか必ず確認すること**(`find node_modules -name '*.node'` で0件を確認)。

### 依存パッケージ(`package.json`)
- `nodemailer` — メール通知(Gmail SMTP)
- `unpdf` — PDFテキスト抽出(canvas不要)
- `mammoth` — Word(docx)テキスト抽出
- `xlsx` — Excel抽出(**npm版は脆弱性があるため公式CDNの `https://cdn.sheetjs.com/...` を参照している**。バージョン変更時は同様にCDN版を使うこと)

---

## 3. ローカルでの動かし方

```bash
cd company_ai_chat
node server.js            # http://localhost:8787
```

- `OPENAI_API_KEY` 未設定だと**モックモード**で起動する(AI応答・画像生成はダミー)。
  ロジック(ルーティング・予算・添付処理など)の確認はモックで可能だが、**実際のAI出力・画像生成の品質は本番(実キー)でしか確認できない**。
- ログイン: `admin` / `admin1234`、`demo` / `demo1234`(初回起動時にseedされる。本番では別途Google連携済み)。
- テストは Playwright(`playwright-core`)でUIを実際に操作して確認するのが基本。手元では
  `/opt/pw-browsers/chromium_headless_shell-*/chrome-linux/headless_shell` を `executablePath` に指定して使っていた。

---

## 4. ファイル構成

| ファイル | 役割 |
|---|---|
| `server.js` | HTTPサーバー本体・静的配信(`Cache-Control: no-cache`)・エラーハンドリング |
| `lib/db.js` | SQLiteスキーマ定義・マイグレーション(`ALTER TABLE`を冪等に実行)・seed・`DEFAULT_TEMPLATES` |
| `lib/routes.js` | 全APIハンドラ(最大のファイル)。予算計算・チャットSSE・添付・POP・管理API |
| `lib/openai.js` | OpenAI呼び出し(チャットstream・画像生成/編集・分類)+コスト計算。モック実装も同居 |
| `lib/auth.js` | セッションCookie・ログイン |
| `lib/google_auth.js` | Google OAuth(fetchのみ、ライブラリ不使用) |
| `lib/mailer.js` | Gmail SMTP通知(nodemailer) |
| `lib/pop.js` | POP画像のSVG合成(**AI不使用の決定的処理**) |
| `lib/docs.js` | PDF/Word/Excelのテキスト抽出 |
| `public/app.js` | フロントSPA全部 |
| `public/style.css` | スタイル全部 |
| `public/index.html` | シェル |

---

## 5. DBスキーマ(主要テーブル)

- `departments` — 部署。`monthly_budget_jpy`(月予算)、`unlock_month`(管理者解除した月)、`advance_used`/`advance_month`(前倒し利用回数と対象月)
- `users` — `role`(user/admin)、`department_id`、`status`(active/pending)、`google_sub`/`email`、`requested_name`/`requested_department`(申請フォーム)
- `sessions` — セッショントークン
- `projects` — チャットをまとめるフォルダ(ユーザーごと)
- `conversations` — `pinned`/`archived`/`project_id` を持つ
- `messages` — `role`(user/assistant)、`content`、`model`
- `usage_log` — コスト計上(`kind`: chat/classify、`cost_jpy`)
- `classifications` — **業務/私的のラベルのみ保存(本文は保持しない = プライバシー配慮)**
- `warnings` — 私的利用率の自動警告
- `prompt_templates` — チャット開始テンプレート(**ユーザーごと**、`user_id`を持つ)

マイグレーションは `lib/db.js` の起動時ブロックで `PRAGMA table_info` を見て `ALTER TABLE ADD COLUMN` を冪等に実行している。**既存の本番DBを壊さないよう、スキーマ変更は必ずこの方式で追加すること。**

---

## 6. APIエンドポイント一覧

認証必須(ログインユーザー):
- `GET/POST /api/templates`, `PATCH/DELETE /api/templates/:id`, `POST /api/templates/:id/duplicate` — 個人テンプレートCRUD(1〜5個)
- `GET /api/me` — 自分の情報・部署予算状況・警告など
- `POST /api/apply` — 承認申請(氏名・希望部署)。管理者に通知メール
- `POST /api/budget/advance` — 「前倒しで使う」(次の期間枠を先取り、月3回まで)
- `GET/POST /api/projects`, `PATCH/DELETE /api/projects/:id` — プロジェクト
- `GET/POST /api/conversations`, `GET .../messages`, `PATCH/DELETE /api/conversations/:id` — 会話(PATCHで title/pinned/archived/project_id)
- `POST /api/chat` — チャット送信(SSEストリーミング)。body: `{conversation_id, message, model_pref}`
- `POST /api/upload` — 画像アップロード(base64、8MBまで)
- `POST /api/extract-text` — PDF/Word/Excelのテキスト抽出
- `POST /api/pop` — POP作成(後述)
- `GET /api/files/:name` — 生成/添付ファイル配信(ファイル名はランダムhexのみ許可)

管理者のみ(`/api/admin/*`):
- `GET /api/admin/overview` — ダッシュボード集計
- `POST /api/admin/departments`, `PATCH/DELETE /api/admin/departments/:id` — 部署(rename・予算・ロック解除)
- `POST /api/admin/users`, `PATCH /api/admin/users/:id` — ユーザー管理・承認

公開:
- `GET /api/config`(google_enabled等)、`POST /api/login`、`POST /api/logout`、`GET /auth/google`、`GET /auth/google/callback`

---

## 7. 主要機能の現在の挙動(重要)

### モデル選択(★READMEと違う)
以前は「内容から自動でlight/heavy/image/sensitiveを振り分けるルーター」があったが、
**誤判定が多く実用に耐えないため廃止した。** 現在はユーザーが手動で選ぶ:
- `⚡軽量`(既定、`LIGHT_MODEL`=既定 gpt-5-mini)
- `🧠高性能`(`HEAVY_MODEL`=既定 gpt-5)
- `🎨画像生成`(`IMAGE_MODEL`=既定 gpt-image-1)

`model_pref` で `light`/`heavy`/`image` を送る。**sensitiveの実行前確認ダイアログも廃止済み**
(チャット開始画面に「自動確認は行われない」旨の注意書きを表示)。
※業務/私的の分類(`CLASSIFIER_MODEL`)は応答とは別に非同期で今も動いている(ラベルのみ保存)。

### 予算(★READMEと違う。3日ごとのペース配分方式)
月予算を「1ヶ月30日 ÷ 3日ごと = 10期間」に分割し、経過に応じて少しずつ解放する。
**利用者には総額(円)を見せず、期間の進み具合と利用ペースのリングだけ表示する**(心理的な使いやすさのため)。
- 期間の枠を使い切ると送信がロックされる。
- ロック時、利用者自身が「前倒しで使う」で次の期間枠を先取りできる(**月3回まで**)。3回使い切ったら次の期間まで待つ。
- 管理者は管理画面から「ロック解除」で今月分を無条件解除できる。
- ロジックは `lib/routes.js` の `periodInfo()` / `deptStatus()` / `/api/budget/advance`。

### 添付ファイル(📎ボタン)
- 画像 → アップロードし、通常チャットでは Vision(画像を読む)、画像生成モードでは `images/edits`(写真を実際に加工)。
- テキスト系(txt/md/csv/json等) → 本文に取り込み。
- **PDF/Word/Excel → `/api/extract-text` で中身をテキスト抽出して本文に取り込み**(集計・グラフ化はしない。要約・質問応答向け)。

### POP作成ツール(🏷️ボタン、`/api/pop`)
AI画像生成は「正確な価格・文字」が苦手なので、**役割分担**する専用ツール:
- **見出し・価格は必ず `lib/pop.js` の `buildPopSvg()` でSVG合成する(AIに文字を作らせない → 崩れない)。**
- 元になる商品画像は2モード:
  - `photo`(写真から): 添付写真をAI(`images/edits`)で切り抜き・明るさ補正。商品自体は変えない。
  - `generate`(新規作成): 説明文からAI(`images/generations`)で生成。
- AI利用のためコストが発生し、予算ロックを尊重して `usage_log` に計上する。

### その他
- チャットのピン留め/名前変更(インライン)/アーカイブ/削除・プロジェクト移動(右クリック or 「…」メニュー)。
- テンプレートはユーザーごとに個人管理(1〜5個、保存/リセット/複製/削除)。
- 送信は **Shift+Enter**(IME確定Enterでの誤送信を避けるため)。Enterのみは改行。
- Googleログイン承認制 + 申請フォーム + 承認通知メール。承認待ち画面は10秒ポーリングで自動復帰。

---

## 8. デプロイ(Coolify + Cloudflare)

- **Coolify**(self-hosted PaaS、`https://coolify.k-sango.com`)でこのアプリ(`company-ai-chat`, uuid `y3qty69e57qvuec50vureocf`)をビルド・稼働。
  - デプロイ実行はCoolify管理画面 → 該当アプリ → Actions → **Redeploy**、または API `GET /api/v1/deploy?uuid=<uuid>`(★メソッドは **GET**。POSTだと401になる罠あり)。
  - 永続ボリュームを `/app/data` にマウントすること(しないと再デプロイでDB・画像が消える)。
- **Traefikラベルの罠**: CoolifyはHTTPS強制リダイレクト+Let's Encryptを自動生成するが、Cloudflare TunnelはオリジンにHTTPしか渡さないため**無限リダイレクトになる**。`custom_labels`(base64)を手動で上書きし、httpsルーター/redirect-to-httpsミドルウェアを消して、httpエントリポイント+gzip+`loadbalancer.server.port=8787` だけにしてある。
- **Cloudflare**: Tunnelで `chat.k-sango.com` を配信。ゾーンの既定キャッシュがオリジンの `no-cache` を上書きしてしまうため、`chat.k-sango.com` 全体をキャッシュ無効にする Cache Rule を入れてある。
  - Cloudflareの**bot対策でヘッドレスブラウザが弾かれる**(`ERR_CONNECTION_RESET`)。本番の画面確認は `curl` かユーザーの実機で行う。
- **CI/自動テストは無い。** 変更したら手元で `node --check` とローカルPlaywright/curlで確認 → コミット → push → Coolifyで手動(またはAPI)デプロイ、という流れ。

### デプロイ用トークンについて(未解決の申し送り)
- Coolifyデプロイには read+deploy 権限のAPIトークンが要る。
- 現状 `COOLIFY_API_URL` / `COOLIFY_API_TOKEN` / `COOLIFY_APP_UUID` を実行環境の環境変数に入れる想定だが、
  **`COOLIFY_API_TOKEN` の値が壊れている(トークン形式 `N|hex...` の `|` が欠落し401になる)**。
  引き継ぎ後、Coolifyでトークンを再発行し、`N|` プレフィックス込みの全体を環境変数に入れ直すこと。
- **トークン・APIキー等の秘密情報はこのドキュメントやリポジトリに書かないこと。**

---

## 9. 環境変数(名前のみ。値は各自設定。`.env.example` 参照)

`OPENAI_API_KEY` / `LIGHT_MODEL`(または `ROUTER_LIGHT_MODEL`)/ `HEAVY_MODEL`(または `ROUTER_HEAVY_MODEL`)/ `IMAGE_MODEL` / `IMAGE_COST_JPY` / `CLASSIFIER_MODEL` / `USD_JPY` / `PRIVATE_RATIO_WARN` / `PRIVATE_MIN_COUNT` / `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `BASE_URL`(**リダイレクトURI生成とCookieのSecure判定に使う。httpsで公開するなら必ずhttpsで設定**)/ `SMTP_USER` / `SMTP_PASS`(Gmailアプリパスワード)/ `PORT` / `DATA_DIR` / `SYSTEM_PROMPT`

---

## 10. 既知の課題 / TODO

- **README.md と .env.example が古い**(廃止した自動ルーター・sensitive確認・「画像生成の自動検知」の記述が残る)。手が空いたら本ドキュメントに合わせて更新するとよい。
- **本番デプロイトークンが壊れている**(§8)。要再発行・再設定。
- **AI画像生成の品質**: 生APIを直接叩いているため、ChatGPTアプリのような"気を利かせた"補正はしない。POPツールで「役割分担」して破綻を抑えているが、生成そのものの質は素のモデル性能どまり。ここは実キーでの目視評価が必要。
- **SMTP実送信の本番確認が未完了**: Gmail SMTPが社内ファイアウォール下のCoolifyホストから実際に届くかは未検証(コードは実装済み)。
- **Code Interpreter相当(Excel実データ集計・グラフ化)/ Web検索**: 未実装。前者はChat Completionsとは別のAPI土台が必要で規模が大きい。後者は外部検索APIの契約・コストが発生する。いずれも要設計。
- **同時実行の軽微なTOCTOU**: テンプレート作成などで、件数チェックと `await readBody` の間に理論上の競合があるが、単一ユーザーの連打では現実的に問題にならない範囲。

---

## 11. 引き継ぎ相手へのお願い

- スキーマ変更は必ず冪等マイグレーション方式で(§5)。既存本番DBを壊さないこと。
- npm追加時はネイティブバイナリ(`*.node`)を持ち込まないこと(§2)。持ち込むと本番Alpineで動かない。
- 変更後は必ずローカル(モック)で動作確認 → コミット → push。デプロイは§8の手順で。
- 秘密情報(トークン・APIキー・パスワード)をコミットしないこと。
