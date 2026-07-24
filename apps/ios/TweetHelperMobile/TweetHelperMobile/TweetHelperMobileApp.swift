import Network
import SwiftUI

@main
struct TweetHelperMobileApp: App {
    var body: some Scene {
        WindowGroup {
            SetupView()
                .task { LocalNetworkAccess.requestPermissionIfNeeded() }
        }
    }
}

enum LocalNetworkAccess {
    /// Bonjour browse surfaces the iOS Local Network permission prompt when missing.
    @MainActor
    static func requestPermissionIfNeeded() {
        guard browser == nil else { return }
        let parameters = NWParameters()
        parameters.includePeerToPeer = true
        let next = NWBrowser(for: .bonjour(type: "_http._tcp", domain: "local."), using: parameters)
        next.stateUpdateHandler = { (_: NWBrowser.State) in }
        next.start(queue: .main)
        browser = next
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
            next.cancel()
            if browser === next { browser = nil }
        }
    }

    @MainActor private static var browser: NWBrowser?
}
