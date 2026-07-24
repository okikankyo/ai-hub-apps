import Foundation
import WidgetKit

/// Reads and writes state shared between the main app and the widget extension
/// through an App Group container so both processes see the same data.
enum SharedStore {
    static let appGroupID = "group.com.example.catmascotlauncher"

    private static let shortcutsKey = "shortcuts.v1"
    private static let moodKey = "mood.v1"
    private static let lastInteractionKey = "lastInteraction.v1"

    private static var defaults: UserDefaults {
        UserDefaults(suiteName: appGroupID) ?? .standard
    }

    static var shortcuts: [LaunchShortcut] {
        get {
            guard let data = defaults.data(forKey: shortcutsKey),
                  let decoded = try? JSONDecoder().decode([LaunchShortcut].self, from: data) else {
                return LaunchShortcut.defaults
            }
            return decoded
        }
        set {
            guard let data = try? JSONEncoder().encode(newValue) else { return }
            defaults.set(data, forKey: shortcutsKey)
            WidgetCenter.shared.reloadAllTimelines()
        }
    }

    static var mood: CatMood {
        get {
            guard let raw = defaults.string(forKey: moodKey), let mood = CatMood(rawValue: raw) else {
                return .idle
            }
            return mood
        }
        set {
            defaults.set(newValue.rawValue, forKey: moodKey)
            defaults.set(Date(), forKey: lastInteractionKey)
            WidgetCenter.shared.reloadAllTimelines()
        }
    }

    static var lastInteraction: Date {
        defaults.object(forKey: lastInteractionKey) as? Date ?? .distantPast
    }
}
