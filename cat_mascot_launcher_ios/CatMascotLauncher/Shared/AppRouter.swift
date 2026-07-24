import Foundation
import SwiftUI

/// Handles `catlauncher://` deep links (from the widget, Shortcuts, or Safari)
/// and drives the mascot's mood shown on screen.
@MainActor
final class AppRouter: ObservableObject {
    @Published var mood: CatMood = SharedStore.mood
    @Published var lastLaunchedShortcut: LaunchShortcut?

    func refreshMood() {
        mood = SharedStore.mood
    }

    /// Entry point wired to `.onOpenURL` in `CatMascotLauncherApp`.
    /// Supported hosts: `open`, `mood?type=<CatMood>`, `launch?id=<shortcut UUID>`.
    func handle(url: URL) {
        guard url.scheme?.lowercased() == "catlauncher" else { return }

        switch url.host?.lowercased() {
        case "open":
            setMood(.happy)
        case "mood":
            if let value = queryValue(in: url, name: "type"), let newMood = CatMood(rawValue: value) {
                setMood(newMood)
            }
        case "launch":
            if let value = queryValue(in: url, name: "id"),
               let id = UUID(uuidString: value),
               let shortcut = SharedStore.shortcuts.first(where: { $0.id == id }) {
                launch(shortcut)
            }
        default:
            break
        }
    }

    func launch(_ shortcut: LaunchShortcut) {
        lastLaunchedShortcut = shortcut
        setMood(.playful)
        if let target = shortcut.url {
            UIApplication.shared.open(target)
        }
    }

    func setMood(_ newMood: CatMood) {
        mood = newMood
        SharedStore.mood = newMood
    }

    private func queryValue(in url: URL, name: String) -> String? {
        URLComponents(url: url, resolvingAgainstBaseURL: false)?
            .queryItems?
            .first(where: { $0.name == name })?
            .value
    }
}
