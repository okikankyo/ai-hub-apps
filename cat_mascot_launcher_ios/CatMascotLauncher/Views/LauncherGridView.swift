import SwiftUI

struct LauncherGridView: View {
    let shortcuts: [LaunchShortcut]
    let onSelect: (LaunchShortcut) -> Void

    private let columns = [GridItem(.adaptive(minimum: 84), spacing: 16)]

    var body: some View {
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
                        Text(shortcut.title)
                            .font(.caption)
                            .lineLimit(1)
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .padding()
    }
}

#Preview {
    LauncherGridView(shortcuts: LaunchShortcut.defaults) { _ in }
}
