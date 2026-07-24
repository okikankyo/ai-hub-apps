import Foundation

/// A single quick-launch shortcut shown in the launcher grid and in the widget.
struct LaunchShortcut: Identifiable, Codable, Equatable {
    let id: UUID
    var title: String
    var symbolName: String
    var urlString: String

    init(id: UUID = UUID(), title: String, symbolName: String, urlString: String) {
        self.id = id
        self.title = title
        self.symbolName = symbolName
        self.urlString = urlString
    }

    var url: URL? { URL(string: urlString) }

    static let defaults: [LaunchShortcut] = [
        LaunchShortcut(title: "Safari", symbolName: "safari.fill", urlString: "https://www.apple.com"),
        LaunchShortcut(title: "Maps", symbolName: "map.fill", urlString: "maps://"),
        LaunchShortcut(title: "Music", symbolName: "music.note", urlString: "music://"),
        LaunchShortcut(title: "Mail", symbolName: "envelope.fill", urlString: "mailto:"),
    ]
}
