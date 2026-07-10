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
        get { defaults.string(forKey: backendURLKey) ?? defaultBackendURL }
        set { defaults.set(normalizedBackendURL(newValue), forKey: backendURLKey) }
    }

    static var authToken: String {
        get { defaults.string(forKey: authTokenKey) ?? "" }
        set { defaults.set(newValue.trimmingCharacters(in: .whitespacesAndNewlines), forKey: authTokenKey) }
    }

    static func normalizedBackendURL(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme),
              let host = url.host else { return defaultBackendURL }
        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        components.port = url.port
        components.path = url.path == "/" ? "" : url.path
        return components.url?.absoluteString ?? defaultBackendURL
    }

    static var diagnostics: String {
        let info = Bundle.main.infoDictionary ?? [:]
        let version = info["CFBundleShortVersionString"] as? String ?? "?"
        let build = info["CFBundleVersion"] as? String ?? "?"
        return "Build \(version) (\(build)) | \(Bundle.main.bundleIdentifier ?? "unknown")"
    }
}

struct SharedDraft: Codable, Equatable, Identifiable {
    let id: UUID
    var text: String
    var sourceText: String?
    var sourceURL: URL?
    var suggestionID: String?
    var sessionID: String?
    var workID: String?
    let savedAt: Date

    init(id: UUID = UUID(), text: String, sourceText: String? = nil, sourceURL: URL? = nil,
         suggestionID: String? = nil, sessionID: String? = nil, workID: String? = nil,
         savedAt: Date = Date()) {
        self.id = id
        self.text = text
        self.sourceText = sourceText?.nilIfBlank
        self.sourceURL = sourceURL
        self.suggestionID = suggestionID?.nilIfBlank
        self.sessionID = sessionID?.nilIfBlank
        self.workID = workID?.nilIfBlank
        self.savedAt = savedAt
    }
}

enum SharedDraftStore {
    private static let key = "savedDrafts.v2"
    static let maximumDrafts = 20

    static func load(defaults: UserDefaults = TweetHelperSettings.defaults) -> [SharedDraft] {
        guard let data = defaults.data(forKey: key),
              let drafts = try? JSONDecoder().decode([SharedDraft].self, from: data) else { return [] }
        return drafts.sorted { $0.savedAt > $1.savedAt }
    }

    static func save(_ draft: SharedDraft, defaults: UserDefaults = TweetHelperSettings.defaults) throws {
        var drafts = load(defaults: defaults).filter { $0.id != draft.id }
        drafts.insert(draft, at: 0)
        try persist(Array(drafts.prefix(maximumDrafts)), defaults: defaults)
    }

    static func remove(id: UUID, defaults: UserDefaults = TweetHelperSettings.defaults) throws {
        try persist(load(defaults: defaults).filter { $0.id != id }, defaults: defaults)
    }

    private static func persist(_ drafts: [SharedDraft], defaults: UserDefaults) throws {
        defaults.set(try JSONEncoder().encode(drafts), forKey: key)
    }
}

struct SharedContent: Equatable {
    var text: String?
    var url: URL?
    var isUsable: Bool { text?.nilIfBlank != nil || url != nil }
}

enum ShareContentParser {
    static func parse(textItems: [String], urlItems: [URL]) -> SharedContent {
        var textParts: [String] = []
        var urls = urlItems.filter(isWebURL)
        for item in textItems {
            let trimmed = item.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            if let url = URL(string: trimmed), isWebURL(url) { urls.append(url) }
            else { textParts.append(trimmed) }
        }
        let uniqueText = Array(NSOrderedSet(array: textParts)) as? [String] ?? textParts
        return SharedContent(text: uniqueText.joined(separator: "\n\n").nilIfBlank, url: urls.first)
    }

    static func isWebURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme) else { return false }
        return url.host?.isEmpty == false
    }
}

struct DraftEnvelope: Decodable { let data: DraftResponse }
struct DraftResponse: Decodable { let suggestions: [DraftSuggestion] }
struct DraftSuggestion: Identifiable, Decodable, Equatable {
    let id: String
    let text: String
    let rationale: String
    let confidence: Double
}
struct HealthResponse: Decodable { let ok: Bool }

struct UsedOutcomePayload: Codable, Equatable {
    let status: String
    let platform: String
    let finalText: String
    let sourceText: String?
    let sourceURL: String?
    let clientEventID: String
    let sessionID: String?
    let workID: String?

    enum CodingKeys: String, CodingKey {
        case status, platform, finalText, sourceText, sourceURL, clientEventID = "clientEventId"
        case sessionID = "sessionId", workID = "workId"
    }

    init(draft: SharedDraft, clientEventID: UUID) {
        status = "used"
        platform = "ios"
        finalText = draft.text
        sourceText = draft.sourceText
        sourceURL = draft.sourceURL?.absoluteString
        self.clientEventID = clientEventID.uuidString.lowercased()
        sessionID = draft.sessionID
        workID = draft.workID
    }
}

enum TweetHelperAPI {
    static var session: URLSession = .shared

    static func getHealth() async throws -> Bool {
        let data = try await request(path: "/health", method: "GET", body: nil, includeAuth: false)
        return try JSONDecoder().decode(HealthResponse.self, from: data).ok
    }

    static func generatePost(topic: String, instructions: String = "") async throws -> [DraftSuggestion] {
        var body: [String: String] = ["topic": topic, "goal": "authentic", "length": "short"]
        if let instructions = instructions.nilIfBlank { body["instructions"] = instructions }
        return try await generate(path: "/api/generate/post", body: body)
    }

    static func generateReply(context: String, sourceURL: URL? = nil, angle: String = "") async throws -> [DraftSuggestion] {
        var source: [String: String] = ["text": context]
        if let sourceURL { source["url"] = sourceURL.absoluteString }
        var body: [String: Any] = [
            "sourcePost": source,
            "instructions": "Use only the supplied context. Do not imply any unseen post was read."
        ]
        if let angle = angle.nilIfBlank { body["angle"] = angle }
        return try await generate(path: "/api/generate/comment", body: body)
    }

    static func rewrite(text: String, kind: String = "post", instructions: String = "") async throws -> [DraftSuggestion] {
        var body = ["text": text, "kind": kind]
        if let instructions = instructions.nilIfBlank { body["instructions"] = instructions }
        return try await generate(path: "/api/generate/rewrite", body: body)
    }

    static func recordUsed(_ draft: SharedDraft, clientEventID: UUID) async throws {
        _ = try await request(path: "/api/outcomes", method: "POST",
                              body: UsedOutcomePayload(draft: draft, clientEventID: clientEventID), includeAuth: true)
    }

    private static func generate(path: String, body: Any) async throws -> [DraftSuggestion] {
        let data = try await request(path: path, method: "POST", body: body, includeAuth: true)
        return try JSONDecoder().decode(DraftEnvelope.self, from: data).data.suggestions
    }

    private static func request(path: String, method: String, body: Any?, includeAuth: Bool) async throws -> Data {
        guard let base = URL(string: TweetHelperSettings.backendURL),
              let url = URL(string: path, relativeTo: base) else { throw APIError.invalidBackendURL }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 15
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(AnyEncodable(body))
        }
        if includeAuth, !TweetHelperSettings.authToken.isEmpty {
            request.setValue("Bearer \(TweetHelperSettings.authToken)", forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 { throw APIError.unauthorized }
            throw APIError.httpStatus(http.statusCode)
        }
        return data
    }
}

private struct AnyEncodable: Encodable {
    private let encodeBlock: (Encoder) throws -> Void
    init(_ value: Any) throws {
        if let value = value as? any Encodable { encodeBlock = value.encode }
        else if JSONSerialization.isValidJSONObject(value) {
            let data = try JSONSerialization.data(withJSONObject: value)
            encodeBlock = { encoder in try JSONDecoder().decode(JSONValue.self, from: data).encode(to: encoder) }
        } else { throw EncodingError.invalidValue(value, .init(codingPath: [], debugDescription: "Not encodable")) }
    }
    func encode(to encoder: Encoder) throws { try encodeBlock(encoder) }
}

private enum JSONValue: Codable {
    case object([String: JSONValue]), array([JSONValue]), string(String), number(Double), bool(Bool), null
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode([String: JSONValue].self) { self = .object(value) }
        else if let value = try? container.decode([JSONValue].self) { self = .array(value) }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else { self = .string(try container.decode(String.self)) }
    }
    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}

enum APIError: LocalizedError {
    case invalidBackendURL, invalidResponse, unauthorized, httpStatus(Int)
    var errorDescription: String? {
        switch self {
        case .invalidBackendURL: "Backend URL is invalid."
        case .invalidResponse: "Backend returned an invalid response."
        case .unauthorized: "Backend rejected the token. Check Settings in the app."
        case .httpStatus(let status): "Backend request failed with HTTP \(status)."
        }
    }
}

extension String {
    var nilIfBlank: String? {
        let value = trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }
}

func readableNetworkError(_ error: Error) -> String {
    let value = error as NSError
    if value.domain == NSURLErrorDomain { return "\(value.localizedDescription) [\(value.code)]" }
    return error.localizedDescription
}
