import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var router: AppRouter
    @State private var shortcuts: [LaunchShortcut] = SharedStore.shortcuts
    @State private var showingEditor = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    CatMascotView(mood: router.mood)
                        .padding(.top, 24)

                    LauncherGridView(shortcuts: shortcuts) { shortcut in
                        router.launch(shortcut)
                    }
                }
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
        .onAppear {
            router.refreshMood()
        }
    }
}

#Preview {
    ContentView()
        .environmentObject(AppRouter())
}
