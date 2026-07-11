#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
沖縄県内の「暴風警報」の状態変化を気象庁の無料JSONから検知して通知する。

検知する4イベント:
  1. 発表された     … 警報JSONの暴風警報(code=05) status が 発表/継続 に立ち上がった
  2. 解除された     … 暴風警報が 解除/なし に落ちた
  3. 発表されそう   … 早期注意情報(警報級の可能性 風)が「高」に上がった（まだ警報は無い）
  4. 解除されそう   … 暴風警報が出ている最中に、可能性が「なし」まで下がった（＝解除の見込み）

依存: Python 標準ライブラリのみ（外部パッケージ不要）。

環境変数:
  WEBHOOK_URL      通知先。未設定なら標準出力にだけ出す（DRY RUN 相当）
  WEBHOOK_TYPE     slack | discord | ntfy | raw   (既定: slack)
  DRY_RUN=1        WEBHOOK_URL があっても送信せず標準出力のみ
  ANNOUNCE_ON_INIT=1  state が無い初回でも現在発表中の警報を通知する（既定は静かにベースライン化）
  STATE_FILE       状態ファイルのパス（既定: state/state.json）
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta

JST = timezone(timedelta(hours=9))

# --- 監視対象（沖縄県内の全気象台エリア） -----------------------------------
# key = 予報区(気象台)コード, value = 表示用の呼称
OFFICES = {
    "471000": "沖縄本島地方",
    "472000": "大東島地方",
    "473000": "宮古島地方",
    "474000": "八重山地方",
}

# 監視する警報コード（気象庁 警報・注意報コード表）
#   05 = 暴風警報
# 必要なら "02"(暴風雪警報) 等を足せば対象を広げられる。
TARGET_CODES = {"05"}
CODE_NAMES = {"05": "暴風警報", "02": "暴風雪警報"}

# 早期注意情報のうち、暴風警報に対応する指標名
PROB_WIND_TYPE = "風（風雪）の警報級の可能性"

WARNING_URL = "https://www.jma.go.jp/bosai/warning/data/warning/{code}.json"
PROB_URL = "https://www.jma.go.jp/bosai/probability/data/probability/{code}.json"
AREA_MASTER_URL = "https://www.jma.go.jp/bosai/common/const/area.json"

STATE_FILE = os.environ.get("STATE_FILE", "state/state.json")

ACTIVE_STATUSES = {"発表", "継続"}          # 警報が出ている状態
PROB_ISSUE = {"高"}                         # 発表されそう、とみなす可能性レベル
PROB_ANY = {"高", "中"}                     # 何らかの可能性ありレベル


# --- HTTP -------------------------------------------------------------------
def fetch_json(url, retries=3):
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "kishou-push-okinawa/1.0"})
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.load(r)
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
            last = e
            time.sleep(2 ** i)
    raise RuntimeError(f"fetch failed: {url} ({last})")


# --- 地域名の解決 -----------------------------------------------------------
_area_names = None


def area_name(code, fallback):
    """細分区域コード -> 地域名。area.json を一度だけ取得してキャッシュ。"""
    global _area_names
    if _area_names is None:
        _area_names = {}
        try:
            master = fetch_json(AREA_MASTER_URL)
            for grp in ("class20s", "class15s", "class10s", "offices"):
                for c, v in master.get(grp, {}).items():
                    _area_names[c] = v.get("name")
        except Exception:
            pass  # 取得失敗時はコードのまま表示
    return _area_names.get(code) or fallback


# --- 気象庁データのパース ---------------------------------------------------
def parse_warning(doc):
    """警報JSON -> {area_code: status}  status は 発表/継続/解除/なし"""
    result = {}
    area_types = doc.get("areaTypes", [])
    if not area_types:
        return result
    # areaTypes[0] は粗い予報細分（本島中南部/北部/久米島 など）。通知に丁度よい粒度。
    for area in area_types[0].get("areas", []):
        code = area.get("code")
        status = "なし"
        for w in area.get("warnings", []):
            if w.get("code") in TARGET_CODES:
                status = w.get("status", "なし")
                break
        result[code] = status
    return result


def parse_probability(doc):
    """早期注意情報JSON -> {area_code: 'high'|'any'|'none'} 近い時間帯での風の可能性の最大"""
    result = {}
    if not isinstance(doc, list):
        return result
    for block in doc:
        for ts in block.get("timeSeries", []):
            for area in ts.get("areas", []):
                code = area.get("code")
                level = result.get(code, "none")
                for prop in area.get("properties", []):
                    if prop.get("type") != PROB_WIND_TYPE:
                        continue
                    for cell in prop.get("timeCells", []):
                        for loc in cell.get("locals", []):
                            v = loc.get("value", "")
                            if v in PROB_ISSUE:
                                level = "high"
                            elif v in PROB_ANY and level != "high":
                                level = "any"
                if code:
                    result[code] = level
    return result


# --- 状態ファイル -----------------------------------------------------------
def load_state():
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def save_state(state):
    os.makedirs(os.path.dirname(STATE_FILE) or ".", exist_ok=True)
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write("\n")


# --- 差分 → イベント --------------------------------------------------------
def diff_events(prev, cur):
    """prev, cur = {area_code: {"warn": status, "prob": level}} -> [ (emoji, kind, area, detail) ]"""
    events = []
    for code, c in cur.items():
        p = (prev or {}).get(code, {})
        pw, cw = p.get("warn", "なし"), c["warn"]
        pp, cp = p.get("prob", "none"), c["prob"]
        name = c["name"]
        was_active = pw in ACTIVE_STATUSES
        is_active = cw in ACTIVE_STATUSES

        if not was_active and is_active:
            events.append(("🌀", "発表", name, "暴風警報が発表されました"))
        elif was_active and not is_active:
            events.append(("✅", "解除", name, "暴風警報が解除されました"))
        elif not is_active and cp == "high" and pp != "high":
            events.append(("⚠️", "発表の見込み", name, "暴風警報級の可能性【高】。発表される見込みです"))
        elif is_active and cp == "none" and pp in ("high", "any"):
            events.append(("🔽", "解除の見込み", name, "暴風警報級の可能性が下がりました。まもなく解除される見込みです"))
    return events


# --- 通知 -------------------------------------------------------------------
def format_message(events, now):
    lines = [f"【沖縄・暴風警報】{now.strftime('%m/%d %H:%M')} 更新", ""]
    order = {"発表": 0, "解除の見込み": 1, "解除": 2, "発表の見込み": 3}
    for emoji, kind, area, detail in sorted(events, key=lambda e: order.get(e[1], 9)):
        lines.append(f"{emoji} [{kind}] {area}｜{detail}")
    lines.append("")
    lines.append("出典: 気象庁 (https://www.jma.go.jp/bosai/)")
    return "\n".join(lines)


def notify(message):
    url = os.environ.get("WEBHOOK_URL", "").strip()
    wtype = os.environ.get("WEBHOOK_TYPE", "slack").strip().lower()
    dry = os.environ.get("DRY_RUN") == "1"

    print("---- notification ----")
    print(message)
    print("----------------------")

    if not url or dry:
        if not url:
            print("(WEBHOOK_URL 未設定のため送信スキップ)")
        return

    if wtype == "ntfy":
        data = message.encode("utf-8")
        headers = {"Title": "沖縄 暴風警報", "Priority": "high", "Tags": "cyclone"}
    else:
        key = {"slack": "text", "discord": "content", "raw": "text"}.get(wtype, "text")
        data = json.dumps({key: message}).encode("utf-8")
        headers = {"Content-Type": "application/json"}

    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    for i in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                r.read()
            print(f"通知送信OK ({wtype})")
            return
        except urllib.error.URLError as e:
            print(f"通知送信リトライ {i+1}: {e}")
            time.sleep(2 ** i)
    print("通知送信に失敗しました", file=sys.stderr)


# --- メイン -----------------------------------------------------------------
def build_current():
    cur = {}
    for office_code, office_name in OFFICES.items():
        warn = parse_warning(fetch_json(WARNING_URL.format(code=office_code)))
        try:
            prob = parse_probability(fetch_json(PROB_URL.format(code=office_code)))
        except Exception as e:
            print(f"警告: 早期注意情報の取得に失敗 {office_code}: {e}", file=sys.stderr)
            prob = {}
        for code, status in warn.items():
            cur[code] = {
                "warn": status,
                "prob": prob.get(code, "none"),
                "name": f"{office_name}／{area_name(code, code)}",
            }
    return cur


def main():
    now = datetime.now(JST)
    cur = build_current()
    if not cur:
        print("データを取得できませんでした。状態は更新しません。", file=sys.stderr)
        return 1

    prev_state = load_state()
    prev = (prev_state or {}).get("areas")

    if prev is None and os.environ.get("ANNOUNCE_ON_INIT") != "1":
        # 初回はベースライン化のみ（過去の状態を通知しない）
        save_state({"areas": cur, "updated": now.isoformat()})
        active = [v["name"] for v in cur.values() if v["warn"] in ACTIVE_STATUSES]
        print(f"初回ベースラインを保存しました。現在発表中: {active or 'なし'}")
        return 0

    events = diff_events(prev, cur)
    if events:
        notify(format_message(events, now))
    else:
        print(f"{now.strftime('%H:%M')} 変化なし")

    save_state({"areas": cur, "updated": now.isoformat()})
    return 0


if __name__ == "__main__":
    sys.exit(main())
