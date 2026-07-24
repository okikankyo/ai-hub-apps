import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var router: AppRouter
    @State private var shortcuts: [LaunchShortcut] = SharedStore.shortcuts
    @State private var showingEditor = false

    var body: some View {
        ZStack {
            Color(UIColor.systemBackground)
                .ignoresSafeArea()

            NavigationStack {
                ScrollView {
                    VStack(spacing: 24) {
                        CatMascotView(mood: router.mood)
                            .padding(.top, 24)

                        if !shortcuts.isEmpty {
                            LauncherGridView(shortcuts: shortcuts) { shortcut in
                                router.launch(shortcut)
                            }
                        } else {
                            Text("No shortcuts yet. Tap edit to add some.")
                                .foregroundStyle(.secondary)
                                .padding()
                        }
                    }
                    .frame(maxWidth: .infinity)
                }
                .navigationTitle("Cat Mascot Launcher")
                .toolbar {
                    ToolbarItem(placement: .primaryAction) {
                        Button {
                            showingEditor = true
                        } label: {
                            Image(systemName: "square.and.pencil")
                        }
                    }
                }
                .sheet(isPresented: $showingEditor) {
                    EditShortcutsView(shortcuts: shortcuts) { updated in
                        shortcuts = updated
                        SharedStore.shortcuts = updated
                    }
                }
            }
        }
        .onAppear {
            router.refreshMood()
            shortcuts = SharedStore.shortcuts
        }
        .onChange(of: router.mood) { _ in
            shortcuts = SharedStore.shortcuts
        }
    }
}

#Preview {
    ContentView()
        .environmentObject(AppRouter())
}
