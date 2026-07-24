import Foundation

/// The mascot's current mood, shared between the app and the widget via `SharedStore`.
enum CatMood: String, CaseIterable, Codable {
    case idle
    case happy
    case sleepy
    case hungry
    case playful

    var emoji: String {
        switch self {
        case .idle: return "😺"
        case .happy: return "😻"
        case .sleepy: return "😴"
        case .hungry: return "🐟"
        case .playful: return "🧶"
        }
    }

    var message: String {
        switch self {
        case .idle: return "What should we launch today?"
        case .happy: return "Yay! Thanks for the pet!"
        case .sleepy: return "Zzz... let me nap a bit."
        case .hungry: return "Meow~ feed me a shortcut!"
        case .playful: return "Let's go somewhere fun!"
        }
    }

    var symbolName: String {
        switch self {
        case .sleepy: return "moon.zzz.fill"
        default: return "cat.fill"
        }
    }
}
