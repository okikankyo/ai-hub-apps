import SwiftUI

struct EditShortcutsView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var shortcuts: [LaunchShortcut]
    @State private var newTitle = ""
    @State private var newSymbol = "star.fill"
    @State private var newURLString = ""

    let onSave: ([LaunchShortcut]) -> Void

    init(shortcuts: [LaunchShortcut], onSave: @escaping ([LaunchShortcut]) -> Void) {
        _shortcuts = State(initialValue: shortcuts)
        self.onSave = onSave
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Shortcuts") {
                    ForEach(shortcuts) { shortcut in
                        Label(shortcut.title, systemImage: shortcut.symbolName)
                    }
                    .onDelete { indexSet in
                        shortcuts.remove(atOffsets: indexSet)
                    }
                }

                Section("Add Shortcut") {
                    TextField("Title", text: $newTitle)
                    TextField("SF Symbol name", text: $newSymbol)
                    TextField("URL (e.g. https://... or maps://)", text: $newURLString)
                        .autocapitalization(.none)
                        .disableAutocorrection(true)
                    Button("Add") {
                        addShortcut()
                    }
                    .disabled(newTitle.isEmpty || newURLString.isEmpty)
                }
            }
            .navigationTitle("Edit Shortcuts")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        onSave(shortcuts)
                        dismiss()
                    }
                }
            }
        }
    }

    private func addShortcut() {
        let shortcut = LaunchShortcut(
            title: newTitle,
            symbolName: newSymbol.isEmpty ? "star.fill" : newSymbol,
            urlString: newURLString
        )
        shortcuts.append(shortcut)
        newTitle = ""
        newSymbol = "star.fill"
        newURLString = ""
    }
}

#Preview {
    EditShortcutsView(shortcuts: LaunchShortcut.defaults) { _ in }
}
