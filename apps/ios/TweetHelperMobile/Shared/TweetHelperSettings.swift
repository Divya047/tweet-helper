import Foundation

enum TweetHelperSettings {
    static let appGroupIdentifier = "group.com.djdesai.TweetHelperMobile"
    static let defaultBackendURL = "http://100.64.0.1:4317"

    private static let backendURLKey = "backendURL"
    private static let authTokenKey = "authToken"

    static var defaults: UserDefaults {
        UserDefaults(suiteName: appGroupIdentifier) ?? .standard
    }

    static var backendURL: String {
        get {
            defaults.string(forKey: backendURLKey) ?? defaultBackendURL
        }
        set {
            defaults.set(normalizedBackendURL(newValue), forKey: backendURLKey)
        }
    }

    static var authToken: String {
        get {
            defaults.string(forKey: authTokenKey) ?? ""
        }
        set {
            defaults.set(newValue.trimmingCharacters(in: .whitespacesAndNewlines), forKey: authTokenKey)
        }
    }

    static func normalizedBackendURL(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let url = URL(string: trimmed), let scheme = url.scheme, let host = url.host else {
            return defaultBackendURL
        }
        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        components.port = url.port
        return components.url?.absoluteString ?? defaultBackendURL
    }

    static var diagnostics: String {
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? "?"
        let build = info["CFBundleVersion"] as? String ?? "?"
        let bundleId = Bundle.main.bundleIdentifier ?? "unknown"
        let ats = info["NSAppTransportSecurity"] as? [String: Any] ?? [:]
        let arbitraryLoads = ats["NSAllowsArbitraryLoads"] as? Bool ?? false
        return "Build \(version) (\(build)) | \(bundleId) | ATS arbitrary=\(arbitraryLoads)"
    }
}

struct DraftEnvelope: Decodable {
    let data: DraftResponse
}

struct DraftResponse: Decodable {
    let suggestions: [DraftSuggestion]
}

struct DraftSuggestion: Identifiable, Decodable {
    let id: String
    let text: String
    let rationale: String
    let confidence: Double
}

struct HealthResponse: Decodable {
    let ok: Bool
}

enum TweetHelperAPI {
    static func getHealth() async throws -> Bool {
        let data = try await request(path: "/health", method: "GET", body: nil, includeAuth: false)
        return try JSONDecoder().decode(HealthResponse.self, from: data).ok
    }

    static func generatePost(topic: String, instructions: String) async throws -> [DraftSuggestion] {
        var body: [String: String] = ["topic": topic, "goal": "authentic", "length": "short"]
        if !instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            body["instructions"] = instructions
        }
        return try await generate(path: "/api/generate/post", body: body)
    }

    static func generateReply(context: String, angle: String) async throws -> [DraftSuggestion] {
        var body: [String: Any] = [
            "sourcePost": ["text": context],
            "instructions": "Draft only from the manually supplied context. Do not imply any unseen post was read."
        ]
        if !angle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            body["angle"] = angle
        }
        return try await generate(path: "/api/generate/comment", body: body)
    }

    static func rewrite(text: String, kind: String, instructions: String) async throws -> [DraftSuggestion] {
        var body: [String: String] = ["text": text, "kind": kind]
        if !instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            body["instructions"] = instructions
        }
        return try await generate(path: "/api/generate/rewrite", body: body)
    }

    private static func generate(path: String, body: Any) async throws -> [DraftSuggestion] {
        let data = try await request(path: path, method: "POST", body: body, includeAuth: true)
        return try JSONDecoder().decode(DraftEnvelope.self, from: data).data.suggestions
    }

    private static func request(path: String, method: String, body: Any?, includeAuth: Bool) async throws -> Data {
        guard let baseURL = URL(string: TweetHelperSettings.backendURL),
              let url = URL(string: path, relativeTo: baseURL) else {
            throw APIError.invalidBackendURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 12
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        if includeAuth {
            let token = TweetHelperSettings.authToken
            if !token.isEmpty {
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            }
        }

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            if httpResponse.statusCode == 401 {
                throw APIError.unauthorized
            }
            throw APIError.httpStatus(httpResponse.statusCode)
        }
        return data
    }
}

enum APIError: LocalizedError {
    case invalidBackendURL
    case invalidResponse
    case unauthorized
    case httpStatus(Int)

    var errorDescription: String? {
        switch self {
        case .invalidBackendURL:
            return "Backend URL is invalid."
        case .invalidResponse:
            return "Backend response was invalid."
        case .unauthorized:
            return "Backend rejected the token. Check setup in the Tweet Helper app."
        case .httpStatus(let status):
            return "Backend request failed with HTTP \(status)."
        }
    }
}

func readableNetworkError(_ error: Error) -> String {
    let nsError = error as NSError
    if nsError.domain == NSURLErrorDomain {
        return "\(nsError.localizedDescription) [\(nsError.domain) \(nsError.code)]"
    }
    return error.localizedDescription
}
