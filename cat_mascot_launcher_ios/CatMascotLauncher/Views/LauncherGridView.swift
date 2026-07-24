import SwiftUI

struct LauncherGridView: View {
    let shortcuts: [LaunchShortcut]
    let onSelect: (LaunchShortcut) -> Void

    private let columns = [GridItem(.adaptive(minimum: 84), spacing: 16)]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Shortcuts")
                .font(.headline)
                .padding(.horizontal)

            LazyVGrid(columns: columns, spacing: 20) {
                ForEach(shortcuts) { shortcut in
                    Button {
                        onSelect(shortcut)
                    } label: {
                        VStack(spacing: 8) {
                            Image(systemName: shortcut.symbolName)
                                .font(.system(size: 28))
                                .frame(width: 56, height: 56)
                                .background(.orange.opacity(0.15), in: RoundedRectangle(cornerRadius: 16))
                                .foregroundStyle(.orange)
                            Text(shortcut.title)
                                .font(.caption)
                                .lineLimit(1)
                                .foregroundStyle(.primary)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding()
        }
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: 16)
                .fill(Color(UIColor.secondarySystemBackground))
        )
        .padding()
    }
}

#Preview {
    LauncherGridView(shortcuts: LaunchShortcut.defaults) { _ in }
}
