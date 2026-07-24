import SwiftUI
import AVKit

struct CatMascotView: View {
    let mood: CatMood
    @State private var player: AVPlayer?
    @State private var bounce = false

    var body: some View {
        VStack(spacing: 16) {
            ZStack {
                RoundedRectangle(cornerRadius: 12)
                    .fill(Color.black.opacity(0.1))

                if let player = player {
                    VideoPlayer(player: player)
                        .frame(height: 200)
                        .roundedRectangle(cornerRadius: 12)
                } else {
                    VStack(spacing: 8) {
                        Image(systemName: mood.symbolName)
                            .resizable()
                            .scaledToFit()
                            .frame(width: 100, height: 100)
                            .foregroundStyle(.orange)
                            .scaleEffect(bounce ? 1.08 : 1.0)
                            .animation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true), value: bounce)
                        Text(mood.emoji)
                            .font(.title)
                    }
                    .frame(height: 200)
                    .onAppear { bounce = true }
                }
            }

            Text(mood.message)
                .font(.headline)
                .multilineTextAlignment(.center)
                .padding(.horizontal)
        }
        .frame(maxWidth: .infinity)
        .padding(20)
        .background(
            RoundedRectangle(cornerRadius: 16)
                .fill(Color(UIColor.secondarySystemBackground))
        )
        .padding()
        .onAppear {
            setupPlayer()
        }
    }

    private func setupPlayer() {
        if let url = Bundle.main.url(forResource: "app_sprite_video", withExtension: "mp4") {
            let player = AVPlayer(url: url)
            player.play()
            player.actionAtItemEnd = .none
            NotificationCenter.default.addObserver(
                forName: .AVPlayerItemDidPlayToEndTime,
                object: player.currentItem,
                queue: .main
            ) { _ in
                player.seek(to: .zero)
                player.play()
            }
            self.player = player
        }
    }
}

extension View {
    func roundedRectangle(cornerRadius: CGFloat) -> some View {
        self.clipShape(RoundedRectangle(cornerRadius: cornerRadius))
    }
}

#Preview {
    CatMascotView(mood: .happy)
}
