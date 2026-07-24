import WidgetKit

struct CatMascotEntry: TimelineEntry {
    let date: Date
    let mood: CatMood
    let shortcuts: [LaunchShortcut]
}

struct CatMascotProvider: TimelineProvider {
    func placeholder(in context: Context) -> CatMascotEntry {
        CatMascotEntry(date: Date(), mood: .idle, shortcuts: LaunchShortcut.defaults)
    }

    func getSnapshot(in context: Context, completion: @escaping (CatMascotEntry) -> Void) {
        completion(currentEntry())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<CatMascotEntry>) -> Void) {
        let entry = currentEntry()
        let nextRefresh = Calendar.current.date(byAdding: .hour, value: 1, to: entry.date)
            ?? entry.date.addingTimeInterval(3600)
        completion(Timeline(entries: [entry], policy: .after(nextRefresh)))
    }

    private func currentEntry() -> CatMascotEntry {
        CatMascotEntry(date: Date(), mood: SharedStore.mood, shortcuts: SharedStore.shortcuts)
    }
}
