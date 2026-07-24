import SwiftUI
import WidgetKit

struct CatMascotWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: CatMascotEntry

    var body: some View {
        switch family {
        case .systemMedium:
            mediumView
        default:
            smallView
        }
    }

    private var smallView: some View {
        VStack(spacing: 8) {
            Image(systemName: entry.mood.symbolName)
                .font(.system(size: 40))
                .foregroundStyle(.orange)
            Text(entry.mood.emoji)
                .font(.title2)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .widgetURL(URL(string: "catlauncher://open"))
        .containerBackground(.fill.tertiary, for: .widget)
    }

    private var mediumView: some View {
        HStack(spacing: 16) {
            Link(destination: URL(string: "catlauncher://open")!) {
                VStack(spacing: 6) {
                    Image(systemName: entry.mood.symbolName)
                        .font(.system(size: 32))
                        .foregroundStyle(.orange)
                    Text(entry.mood.emoji)
                }
                .frame(width: 64)
            }

            VStack(alignment: .leading, spacing: 10) {
                ForEach(entry.shortcuts.prefix(3)) { shortcut in
                    Link(destination: URL(string: "catlauncher://launch?id=\(shortcut.id.uuidString)")!) {
                        Label(shortcut.title, systemImage: shortcut.symbolName)
                            .font(.caption)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .containerBackground(.fill.tertiary, for: .widget)
    }
}

#Preview(as: .systemSmall) {
    CatMascotWidget()
} timeline: {
    CatMascotEntry(date: .now, mood: .happy, shortcuts: LaunchShortcut.defaults)
}
