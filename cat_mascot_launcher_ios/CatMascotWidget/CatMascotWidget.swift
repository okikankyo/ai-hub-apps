import SwiftUI
import WidgetKit

struct CatMascotWidget: Widget {
    let kind: String = "CatMascotWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: CatMascotProvider()) { entry in
            CatMascotWidgetView(entry: entry)
        }
        .configurationDisplayName("Cat Mascot Launcher")
        .description("Pet your cat mascot and jump straight to your favorite shortcuts.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
