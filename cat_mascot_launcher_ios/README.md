# Cat Mascot Launcher for iOS

A playful app launcher featuring a cat mascot that reacts to your interactions. Customize quick-launch shortcuts and add the widget to your home screen or lock screen for instant access.

## Features

- **Pet Your Mascot**: Tap the cat to change its mood (happy, sleepy, playful, hungry, idle)
- **Quick Launcher Grid**: Customize up to dozens of shortcuts to apps, websites, or Apple Maps
- **Home Screen Widget**: Display the cat and top shortcuts on your home screen (small & medium sizes)
- **Lock Screen Support**: Add the widget to your lock screen for quick access
- **App Groups**: Main app and widget extension share state via secure `UserDefaults` app group (`group.com.example.catmascotlauncher`)
- **Deep Links**: Support for `catlauncher://` URL scheme to trigger moods and shortcuts from Shortcuts app or Safari

## Supported Versions

- **iOS**: 17.0+
- **iPad**: 17.0+

## Project Structure

```
CatMascotLauncher/
├── CatMascotLauncher/              # Main app target
│   ├── CatMascotLauncherApp.swift  # Entry point (@main)
│   ├── ContentView.swift           # Root UI
│   ├── Models/
│   │   ├── CatMood.swift           # Mascot mood enum & expressions
│   │   └── LaunchShortcut.swift    # Shortcut data model
│   ├── Shared/
│   │   ├── SharedStore.swift       # App group UserDefaults wrapper
│   │   └── AppRouter.swift         # URL scheme handler & state sync
│   ├── Views/
│   │   ├── CatMascotView.swift     # Animated mascot display
│   │   ├── LauncherGridView.swift  # Grid of shortcuts
│   │   └── EditShortcutsView.swift # Edit/add shortcuts form
│   ├── Resources/
│   │   ├── Info.plist              # App metadata & URL schemes
│   │   └── Assets.xcassets/        # Catalog (app icon, colors)
│   └── CatMascotLauncher.entitlements  # App Groups capability
├── CatMascotWidget/                # Widget extension target
│   ├── CatMascotWidgetBundle.swift # @main widget bundle
│   ├── CatMascotWidget.swift       # Widget configuration
│   ├── CatMascotWidgetView.swift   # Widget UI (small & medium)
│   ├── Provider.swift              # Timeline provider
│   ├── Assets.xcassets/
│   ├── Info.plist
│   └── CatMascotWidget.entitlements    # App Groups capability
└── CatMascotLauncher.xcodeproj/    # Xcode project
    ├── project.pbxproj            # Build configuration
    ├── project.xcworkspace/
    │   └── contents.xcworkspacedata
    └── xcshareddata/xcschemes/
        └── CatMascotLauncher.xcscheme
```

## Build & Run

### Prerequisites

- **macOS** 13.0+ with Xcode 15.2+
- **Swift** 5.9+

### Steps

1. **Clone or download** this project:
   ```bash
   cd cat_mascot_launcher_ios
   ```

2. **Open in Xcode**:
   ```bash
   open CatMascotLauncher.xcodeproj
   ```

3. **Select build target**:
   - Scheme: `CatMascotLauncher`
   - Destination: `Any iOS Device (arm64)` or `iPhone Simulator (16" Pro / 15.7)`

4. **Build & Run**:
   - **Cmd+B**: Build
   - **Cmd+R**: Run on simulator or device
   - Xcode automatically embeds the widget extension in the main app

### Running on a Physical Device

Requires a valid Apple Development Team signing identity:

1. In Xcode: **Signing & Capabilities** → Select your Team
2. Update **Bundle Identifier** from `com.example.catmascotlauncher` to your own (e.g., `com.yourname.catmascotlauncher`)
3. Update the entitlements and widget Info.plist App Groups ID to match your bundle ID:
   - App: `group.<your-bundle-id>`
   - Widget: same group ID

## URL Scheme Support

The app responds to `catlauncher://` deep links:

- **`catlauncher://open`** → Set mood to .happy
- **`catlauncher://mood?type=<mood>`** → Set mood (idle, happy, sleepy, hungry, playful)
- **`catlauncher://launch?id=<uuid>`** → Open shortcut by UUID and set mood to .playful

### Examples

Use these in Shortcuts app, Safari, or Siri Suggestions:

```
catlauncher://mood?type=playful
catlauncher://mood?type=sleepy
catlauncher://launch?id=550e8400-e29b-41d4-a716-446655440000
```

## Widget Configuration

Both app targets share the **App Group** capability to sync state:

```xml
<key>com.apple.security.application-groups</key>
<array>
    <string>group.com.example.catmascotlauncher</string>
</array>
```

When the main app updates shortcuts or mood via `SharedStore`, the widget timeline is automatically reloaded via `WidgetCenter.shared.reloadAllTimelines()`.

### Widget Sizes

- **Small (1×1)**: Displays mascot emoji & symbol, tap to set mood to .happy
- **Medium (2×1)**: Mascot on left + 3 most-recently-used shortcuts on right

## Development Tips

### Adding a New Shortcut

In `EditShortcutsView`, users can:
1. Enter title (e.g., "Maps")
2. Enter SF Symbol name (e.g., "map.fill")
3. Enter URL (e.g., `maps://`, `https://example.com`, `mailto:`)
4. Tap Add

Shortcuts are persisted in app group UserDefaults and synced to the widget.

### Customizing the Mascot

Edit `CatMood.swift`:
- Change emoji and message per mood
- Adjust SF Symbol name for visual variant
- Modify mood transition logic in `AppRouter.setMood(_:)`

### Adding New Moods

1. Add case to `CatMood` enum
2. Provide emoji, message, and symbol name
3. Update mood button or gesture in `ContentView`

## Testing

### On Simulator

- Tap the cat mascot to cycle through moods
- Use Edit button to add/remove shortcuts
- Add widget to home screen: long-press home → Edit → search "Cat Mascot"
- Test deep links by pasting in Safari address bar or using Shortcuts app

### On Device

- Same as simulator; requires signing and provisioning profiles

## Bundle Identifiers & Entitlements

**Main App:**
- Bundle ID: `com.example.catmascotlauncher`
- Product Name: `CatMascotLauncher`
- App Group: `group.com.example.catmascotlauncher`

**Widget Extension:**
- Bundle ID: `com.example.catmascotlauncher.widget`
- Product Name: `CatMascotWidgetExtension`
- App Group: `group.com.example.catmascotlauncher` (same as main app)

Both targets have identical app group IDs so they can read/write the same `UserDefaults` container.

## Deployment

### TestFlight / App Store

1. Update build number in Xcode (or build settings)
2. Build for Generic iOS Device
3. In Xcode: **Product → Archive**
4. In Organizer: **Distribute App**
5. Choose **App Store Connect** & validate

### Debugging Build Errors

- **Entitlements mismatch**: Ensure both targets have the same app group ID
- **Widget not launching**: Check that Info.plist has `NSExtension` with correct `com.apple.widgetkit-extension` identifier
- **SharedStore missing**: Verify `CatMood.swift` and `LaunchShortcut.swift` are included in both app and widget target membership

## File Encoding & Line Endings

All Swift source files use:
- Encoding: UTF-8
- Line endings: LF (Unix)

## License

This project is part of the Qualcomm® AI Hub Apps collection.  
Licensed under BSD-3-Clause. See [LICENSE](../LICENSE).

## References

- [SwiftUI Documentation](https://developer.apple.com/documentation/swiftui/)
- [WidgetKit Documentation](https://developer.apple.com/documentation/widgetkit)
- [App Groups](https://developer.apple.com/documentation/foundation/userdefaults/1409427-init)
- [URL Schemes](https://developer.apple.com/documentation/uikit/uiapplication/1622952-open)
- [SF Symbols](https://developer.apple.com/sf-symbols/)

---

**Created:** 2026-07-24  
**Swift Version:** 5.9+  
**Minimum iOS:** 17.0
