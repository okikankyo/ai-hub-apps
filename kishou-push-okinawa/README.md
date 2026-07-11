# kishou-push-okinawa

気象庁（JMA）の無料JSONを使って、**沖縄県内の「暴風警報」**の状態変化を検知し通知するツール。

検知するのは次の4つ:

| 種別 | トリガー | 精度 |
|---|---|---|
| 🌀 発表された | 暴風警報(code 05)の status が `発表`/`継続` に立ち上がった | **確実**（公式の警報データ） |
| ✅ 解除された | 暴風警報が `解除`/なし に落ちた | **確実**（公式の警報データ） |
| ⚠️ 発表されそう | 早期注意情報（警報級の可能性・風）が **高** に上がった | 目安（気象庁の可能性情報ベース） |
| 🔽 解除されそう | 警報発表中に、風の可能性が **なし** まで下がった | 目安（近似ロジック） |

> **設計方針**: 「された／された（発表・解除）」は気象庁の警報データそのものなので**確実**に取れます。「されそう」は気象庁が公式に出している[早期注意情報（警報級の可能性）](https://www.jma.go.jp/bosai/probability/)を使った**目安**です。予告の性質上100%ではありません。

## なぜこの構成なのか（安くて保守しやすい）

- **サーバー費用ゼロ**: GitHub Actions の cron で定期実行するだけ。常時稼働のサーバー/VM/DB は不要。
- **依存ゼロ**: `check.py` は Python 標準ライブラリのみ。`pip install` 不要で壊れにくい。
- **DB不要**: 前回の状態は `state/state.json` に保存し、ワークフローが自動コミット。外部ストレージ不要。
- **公式データ**: 気象庁 `bosai` JSON（認証不要・無料）。仕様が安定しており保守が楽。

## 監視対象エリア（沖縄県内・全域）

4つの気象台エリアの警報JSONを監視します。

| 予報区コード | エリア |
|---|---|
| 471000 | 沖縄本島地方（本島中南部・本島北部・久米島） |
| 472000 | 大東島地方 |
| 473000 | 宮古島地方 |
| 474000 | 八重山地方（石垣島地方・与那国島地方） |

## 使うデータ（気象庁 bosai JSON・無料/認証不要）

- 警報・注意報: `https://www.jma.go.jp/bosai/warning/data/warning/{予報区}.json`
  （`areaTypes[0].areas[].warnings[]` の `code=05`＝暴風警報 の `status`）
- 早期注意情報: `https://www.jma.go.jp/bosai/probability/data/probability/{予報区}.json`
  （`風（風雪）の警報級の可能性` の値 `高`/`中`）
- 地域名マスタ: `https://www.jma.go.jp/bosai/common/const/area.json`

## セットアップ

### 1. 通知先を用意する（どれか1つ）

- **Slack**: Incoming Webhook URL（`https://hooks.slack.com/...`）
- **Discord**: チャンネルの Webhook URL
- **ntfy**（スマホPush、無料・簡単）: `https://ntfy.sh/あなたのトピック名` を購読

### 2. リポジトリに登録

- **Settings → Secrets and variables → Actions → Secrets** に
  `WEBHOOK_URL` = 上のURL
- **Variables** に `WEBHOOK_TYPE` = `slack` / `discord` / `ntfy` / `raw`（未設定なら `slack`）

### 3. 有効化

`.github/workflows/check.yml` が15分ごとに走ります。まず **Actions タブ → 手動実行(workflow_dispatch)** で1回動かすと、初回は現在状態をベースライン化（通知なし）。以降、変化があった時だけ通知します。

## ローカルでの試し方

```bash
cp config.example.env .env && set -a && . ./.env && set +a
DRY_RUN=1 python3 check.py      # 送信せず標準出力に表示
```

## コスト / 実行頻度の目安

- **Public リポジトリ**: GitHub Actions は無料・無制限。`*/5`〜`*/10` でもOK。
- **Private リポジトリ**: 無料枠2,000分/月。1回あたり約30秒なので、**15分間隔（既定）で月約1,440分**と枠内。台風シーズンだけ間隔を短くする運用も可。
- GitHub の cron は数分の遅延が起こり得ます。分刻みの即時性が要る用途には不向きです。

## カスタマイズ

- 対象警報を増やす: `check.py` の `TARGET_CODES`（例 `"02"`＝暴風雪警報を追加）。
- 実行間隔: `check.yml` の `cron`。
- 「されそう」の閾値: `PROB_ISSUE`（既定は `高` のみ。`中` も拾うなら追加）。

## 制約・注意

- 「発表されそう／解除されそう」は早期注意情報からの**推定**であり、外れることがあります。確実なのは「発表された／解除された」です。
- 気象庁の bosai JSON は公開・無料ですが公式APIとして保証されたものではありません。仕様変更の可能性はあります（その際は `parse_*` を直すだけ）。
- 出典表示: 気象庁 https://www.jma.go.jp/bosai/
