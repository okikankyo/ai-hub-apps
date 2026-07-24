# 猫マスコット スプライト動画ガイド

## 概要

このプロジェクトでは、シミュレーター向けの猫マスコットスプライト動画を使用しています。

- **アプリ側**: VideoPlayer で mp4 動画を直接再生（iOS 14+）
- **ウィジェット側**: iOS 17 WidgetKit の制限により、GIF プレビュー + SF Symbol

## ファイル構成

```
cat_mascot_launcher_ios/
├── CatMascotLauncher/
│   └── Resources/Videos/
│       └── app_sprite_video.mp4    (101KB, 540x960px, 7秒, 18fps)
│
├── CatMascotWidget/
│   └── Videos/
│       └── widget_sprite_preview.gif (196KB, 640x640px, 5秒)
│
└── metadata.json
    ├── widget: {size: [640, 640], duration: 5, fps: 18}
    └── app: {size: [540, 960], duration: 7, fps: 18}
```

## アプリ側: VideoPlayer 実装

### CatMascotView.swift

```swift
import AVKit

struct CatMascotView: View {
    @State private var player: AVPlayer?
    
    var body: some View {
        VStack {
            if let player = player {
                VideoPlayer(player: player)
                    .frame(height: 200)
            } else {
                // フォールバック: SF Symbol + 絵文字
                Image(systemName: mood.symbolName)
                // ...
            }
        }
        .onAppear { setupPlayer() }
    }
    
    private func setupPlayer() {
        if let url = Bundle.main.url(forResource: "app_sprite_video", withExtension: "mp4") {
            let player = AVPlayer(url: url)
            player.play()
            // ループ再生設定
            player.actionAtItemEnd = .none
            NotificationCenter.default.addObserver(
                forName: .AVPlayerItemDidPlayToEndTime,
                object: player.currentItem,
                queue: .main
            ) { _ in
                player.seek(to: .zero)
                player.play()
            }
            self.player = player
        }
    }
}
```

**特徴:**
- ✅ iOS 14+ で利用可能
- ✅ ループ再生対応
- ✅ フォールバック: 動画未読み込み時は SF Symbol を表示
- ✅ 自動レイアウト調整（高さ 200pt に制約）

### ビルド時の確認

1. Xcode で `CatMascotLauncher` ターゲットを選択
2. **Build Phases** → **Copy Bundle Resources** を確認
3. `app_sprite_video.mp4` がリストに存在することを確認
4. 存在しない場合：ドラッグドロップして手動追加

## ウィジェット側: GIF プレビュー + SF Symbol

### 実装理由

iOS 17 WidgetKit では以下の制限があります：

| 機能 | 対応 |
|------|------|
| VideoPlayer | ❌ ウィジェットでは未サポート |
| GIF アニメーション | ❌ 自動アニメーション不可（1フレームのみ表示） |
| AVPlayer | ❌ 拡張機能では使用不可 |
| Image + URL | ✅ 静止画のみ |
| Timeline ベース更新 | ✅ 複数エントリで疑似アニメーション（推奨されない） |

### 現在の設計

```swift
struct CatMascotWidgetView: View {
    var body: some View {
        // Small (1x1) ウィジェット
        VStack {
            Image(systemName: entry.mood.symbolName)
                .foregroundStyle(.orange)
            Text(entry.mood.emoji)
            Text("Pet me!")  // CTA
        }
        .widgetURL(URL(string: "catlauncher://open"))
    }
}
```

**理由:**
- SF Symbol で軽量・レスポンシブ
- 絵文字で気分を直感的に表示
- "Pet me!" で、アプリタップを促進（アプリでは動画が見られる）
- WidgetKit の制限内で最善のUX

### GIF 活用方法（参考）

`widget_sprite_preview.gif` はプレビュー用として保持されています。
将来的に異なる方法で使用する場合のリファレンスです：

**Option A: App Clip での使用**
```
- App Clip 内でのプレビュー表示
- 複数のUIコンテキストでのプレビュー
```

**Option B: カスタムWidget（iOS 17+）**
```
- ウィジェットの静止画プレビュー設定
- WidgetPreviewContext でのプレビュー画像
```

## 動作確認チェックリスト

### アプリ側

- [ ] Xcode で Cmd+B ビルド成功
- [ ] Cmd+R でシミュレータ実行
- [ ] 猫マスコット表示領域に**アニメーション動画**が再生
  - 540x960px のビデオが 200pt 高さにスケール表示
  - ループ再生で連続アニメーション
- [ ] 猫をタップして気分変更時も動画は継続再生
- [ ] 気分が変わると絵文字とメッセージが更新
- [ ] 動画が読み込めない場合は SF Symbol にフォールバック

### ウィジェット側

- [ ] ホーム画面で Cat Mascot ウィジェット追加可能
- [ ] Small (1×1) 表示
  - [ ] オレンジ色の SF Symbol
  - [ ] 気分絵文字
  - [ ] "Pet me!" テキスト
- [ ] Medium (2×1) 表示
  - [ ] 左側：猫アイコン
  - [ ] 右側：ショートカット3つ
- [ ] ウィジェットタップでアプリ起動
- [ ] アプリで気分変更 → ウィジェットも自動更新（~1分以内）

## トラブルシューティング

### 「動画が再生されない」

**確認:**
1. Xcode の **Build Phases** → **Copy Bundle Resources** に `app_sprite_video.mp4` が存在
2. ファイルサイズ確認: `ls -lh CatMascotLauncher/Resources/Videos/`
3. ビデオコーデック確認: `file app_sprite_video.mp4`

**解決:**
- ファイルが見つからない場合：ZIP から再抽出
- Xcode キャッシュクリア: `Cmd+Shift+K` で Clean Build Folder
- 再ビルド: `Cmd+B`

### 「ウィジェットが表示されない」

**確認:**
1. ホーム画面で長押し → 編集 → "Cat Mascot" 検索
2. **Widget Extension が Build Phases に含まれているか確認**
3. アプリがシミュレータにインストールされているか確認

**解決:**
- ウィジェット拡張を手動追加（Xcode では自動埋め込み）
- シミュレータから app 削除後、再実行

### 「動画がループしない」

**確認:**
- CatMascotView.swift の `setupPlayer()` で以下が設定されているか：
  ```swift
  player.actionAtItemEnd = .none
  NotificationCenter.default.addObserver(...) // ループ設定
  ```

**解決:**
- ビルド設定を確認
- AVPlayer の初期化時に `actionAtItemEnd` が正しく設定されているか確認

## パフォーマンス

### ファイルサイズ

| ファイル | サイズ | 形式 | 用途 |
|---------|--------|------|------|
| app_sprite_video.mp4 | 101KB | H.264 | アプリ VideoPlayer |
| widget_sprite_preview.gif | 196KB | GIF | リファレンス・プレビュー |

**最適化:**
- MP4 は H.264 コーデック使用
- ビットレート最適化で低ファイルサイズ実現
- ウィジェット側は SF Symbol で軽量化

### メモリ使用量

- VideoPlayer: ~ 5-10 MB（再生時）
- フォールバック SF Symbol: < 1 MB

## 将来の拡張

### 1. 動画フォーマット変更
```
現在: MP4 (H.264)
検討: HEVC (.heic)
利点: ファイルサイズ 30% 削減
```

### 2. ウィジェット側アニメーション
```
iOS 17.4+: Timeline ベースでフレーム更新
- Provider で複数エントリ返却
- 0.1 秒間隔でビューステート更新
- 疑似アニメーション効果
デメリット: バッテリー消費増
```

### 3. 複数スプライト対応
```
気分ごとに異なる動画を使用
- idle_sprite.mp4
- happy_sprite.mp4
- sleepy_sprite.mp4
実装: AppRouter で mood に応じた動画 URL を切り替え
```

## 参考リンク

- [AVPlayer - Apple Developer](https://developer.apple.com/documentation/avfoundation/avplayer)
- [VideoPlayer - SwiftUI](https://developer.apple.com/documentation/swiftui/videoplayer)
- [WidgetKit - Best Practices](https://developer.apple.com/widgets/)

---

**最終更新**: 2026-07-24  
**ビデオ仕様**: widget 640×640/5s, app 540×960/7s (18fps)  
**互換性**: iOS 14+ (VideoPlayer), iOS 17+ (WidgetKit)
