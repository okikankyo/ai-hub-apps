import SwiftUI

struct CatMascotView: View {
    let mood: CatMood
    @State private var bounce = false

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: mood.symbolName)
                .resizable()
                .scaledToFit()
                .frame(width: 120, height: 120)
                .foregroundStyle(.orange)
                .scaleEffect(bounce ? 1.08 : 1.0)
                .animation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true), value: bounce)
                .onAppear { bounce = true }

            Text(mood.emoji + " " + mood.message)
                .font(.headline)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
        }
    }
}

#Preview {
    CatMascotView(mood: .happy)
}
