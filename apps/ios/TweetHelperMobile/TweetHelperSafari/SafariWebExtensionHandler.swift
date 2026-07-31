import Foundation
import SafariServices

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        guard
            let item = context.inputItems.first as? NSExtensionItem,
            let message = item.userInfo?[SFExtensionMessageKey] as? [String: Any],
            let type = message["type"] as? String
        else {
            complete(context, payload: ["ok": false, "error": "Invalid request from the Safari extension."])
            return
        }

        if type == "NATIVE_CONFIG_REQUEST" {
            do {
                let settings = try sharedSettings()
                complete(context, payload: [
                    "ok": true,
                    "backendUrl": settings.backendURL,
                    "authToken": settings.authToken
                ])
            } catch {
                complete(context, payload: ["ok": false, "error": error.localizedDescription])
            }
            return
        }

        guard
            type == "NATIVE_API_REQUEST",
            let path = message["path"] as? String,
            let method = message["method"] as? String,
            ["GET", "POST"].contains(method)
        else {
            complete(context, payload: ["ok": false, "error": "Invalid request from the Safari extension."])
            return
        }

        Task {
            do {
                let payload = try await perform(path: path, method: method, body: message["body"])
                complete(context, payload: payload)
            } catch {
                complete(context, payload: ["ok": false, "error": readableNetworkError(error)])
            }
        }
    }

    private func perform(path: String, method: String, body: Any?) async throws -> [String: Any] {
        let settings = try sharedSettings()
        guard
            let base = URL(string: settings.backendURL),
            let endpoint = URL(string: path, relativeTo: base)?.absoluteURL
        else {
            throw SafariBridgeError.backendNotShared
        }

        var request = URLRequest(url: endpoint)
        request.httpMethod = method
        request.timeoutInterval = 180
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        var requestBody = body
        if path == "/api/outcomes", var outcome = body as? [String: Any] {
            outcome["platform"] = "ios"
            requestBody = outcome
        }
        if let requestBody {
            guard JSONSerialization.isValidJSONObject(requestBody) else {
                throw APIError.invalidResponse
            }
            request.httpBody = try JSONSerialization.data(withJSONObject: requestBody)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if !settings.authToken.isEmpty {
            request.setValue("Bearer \(settings.authToken)", forHTTPHeaderField: "Authorization")
        }

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        let json = data.isEmpty ? NSNull() : try JSONSerialization.jsonObject(with: data)
        guard (200..<300).contains(http.statusCode) else {
            let backendMessage = ((json as? [String: Any])?["error"] as? [String: Any])?["message"] as? String
            return [
                "ok": false,
                "status": http.statusCode,
                "error": backendMessage ?? "Backend request failed with HTTP \(http.statusCode)."
            ]
        }
        return ["ok": true, "status": http.statusCode, "data": json]
    }

    private func sharedSettings() throws -> (backendURL: String, authToken: String) {
        guard TweetHelperSettings.sharedContainerAvailable else {
            throw SafariBridgeError.appGroupUnavailable
        }
        guard let backendURL = TweetHelperSettings.sharedBackendURL else {
            throw SafariBridgeError.backendNotShared
        }
        return (backendURL, TweetHelperSettings.authToken)
    }

    private func complete(_ context: NSExtensionContext, payload: [String: Any]) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: payload]
        context.completeRequest(returningItems: [response])
    }
}

private enum SafariBridgeError: LocalizedError {
    case appGroupUnavailable
    case backendNotShared

    var errorDescription: String? {
        switch self {
        case .appGroupUnavailable:
            "Safari cannot open the Tweet Helper App Group. Enable App Groups for both TweetHelperMobile and TweetHelperSafari in Xcode, reinstall the app, then save Settings again."
        case .backendNotShared:
            "Safari found the App Group, but no backend URL was saved there. Open Tweet Helper, save Settings again, then reopen Safari."
        }
    }
}
