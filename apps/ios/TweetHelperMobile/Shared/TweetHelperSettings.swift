import Foundation

enum TweetHelperSettings {
    static let appGroupIdentifier = "group.com.djdesai.TweetHelperMobile"
    static let defaultBackendURL = "http://100.64.0.1:4317"

    private static let backendURLKey = "backendURL"
    private static let authTokenKey = "authToken"
    private static let growthPreferencesKey = "growthPreferences.v1"
    private static let activityKey = "activity.v1"

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

    static var growthPreferences: GrowthPreferences {
        get {
            guard let data = defaults.data(forKey: growthPreferencesKey),
                  let value = try? JSONDecoder().decode(GrowthPreferences.self, from: data) else {
                return .defaults
            }
            return value.normalized
        }
        set {
            defaults.set(try? JSONEncoder().encode(newValue.normalized), forKey: growthPreferencesKey)
        }
    }

    static var activity: ActivityState {
        get {
            guard let data = defaults.data(forKey: activityKey),
                  let value = try? JSONDecoder().decode(ActivityState.self, from: data) else {
                return ActivityState.today()
            }
            return value.normalized()
        }
        set {
            defaults.set(try? JSONEncoder().encode(newValue.normalized()), forKey: activityKey)
        }
    }

    static func recordActivity(kind: ContentKind) {
        var current = activity
        switch kind {
        case .post: current.posts += 1
        case .reply: current.replies += 1
        }
        activity = current
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

enum ContentKind: String, Codable {
    case post, reply
}

struct GrowthPreferences: Codable, Equatable {
    var audience: String
    var pillar: String
    var outcome: String

    static let defaults = GrowthPreferences(
        audience: "Tech founders, indie hackers, and builders shipping products",
        pillar: "building",
        outcome: "earn relevant follows"
    )

    static let pillarOptions: [(id: String, label: String)] = [
        ("building", "Build in public"),
        ("teaching", "Teach something useful"),
        ("point-of-view", "Share a point of view")
    ]

    static let outcomeOptions: [(id: String, label: String)] = [
        ("earn relevant follows", "Earn relevant follows"),
        ("start a useful conversation", "Start a useful conversation"),
        ("create something worth saving", "Create something worth saving")
    ]

    var normalized: GrowthPreferences {
        GrowthPreferences(
            audience: audience.nilIfBlank ?? Self.defaults.audience,
            pillar: pillar.nilIfBlank ?? Self.defaults.pillar,
            outcome: outcome.nilIfBlank ?? Self.defaults.outcome
        )
    }
}

struct ActivityState: Codable, Equatable {
    static let softGoals = (posts: 8, replies: 24)

    var dayKey: String
    var posts: Int
    var replies: Int

    static func today(date: Date = Date()) -> ActivityState {
        ActivityState(dayKey: Self.dayKey(for: date), posts: 0, replies: 0)
    }

    static func dayKey(for date: Date) -> String {
        let calendar = Calendar.current
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    func normalized(now: Date = Date()) -> ActivityState {
        let today = Self.dayKey(for: now)
        guard dayKey == today else { return ActivityState(dayKey: today, posts: 0, replies: 0) }
        return ActivityState(dayKey: today, posts: max(0, posts), replies: max(0, replies))
    }

    var postProgress: Double { min(1, Double(posts) / Double(Self.softGoals.posts)) }
    var replyProgress: Double { min(1, Double(replies) / Double(Self.softGoals.replies)) }
}

struct SharedDraft: Codable, Equatable, Identifiable {
    let id: UUID
    var text: String
    var sourceText: String?
    var sourceURL: URL?
    var suggestionID: String?
    var sessionID: String?
    var workID: String?
    var contentKind: ContentKind?
    let savedAt: Date

    init(id: UUID = UUID(), text: String, sourceText: String? = nil, sourceURL: URL? = nil,
         suggestionID: String? = nil, sessionID: String? = nil, workID: String? = nil,
         contentKind: ContentKind? = nil, savedAt: Date = Date()) {
        self.id = id
        self.text = text
        self.sourceText = sourceText?.nilIfBlank
        self.sourceURL = sourceURL
        self.suggestionID = suggestionID?.nilIfBlank
        self.sessionID = sessionID?.nilIfBlank
        self.workID = workID?.nilIfBlank
        self.contentKind = contentKind
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

struct DraftResponse: Decodable {
    let suggestions: [DraftSuggestion]
    let recommendedId: String?
    let recommendation: DraftSuggestion?
    let explore: [DraftSuggestion]?
}

struct DraftSuggestion: Identifiable, Decodable, Equatable {
    let id: String
    let text: String
    let rationale: String
    let confidence: Double
    let strategy: String?
    let isQuestion: Bool?

    init(id: String, text: String, rationale: String = "", confidence: Double = 0,
         strategy: String? = nil, isQuestion: Bool? = nil) {
        self.id = id
        self.text = text
        self.rationale = rationale
        self.confidence = confidence
        self.strategy = strategy
        self.isQuestion = isQuestion
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        text = try container.decode(String.self, forKey: .text)
        rationale = try container.decodeIfPresent(String.self, forKey: .rationale) ?? ""
        confidence = try container.decodeIfPresent(Double.self, forKey: .confidence) ?? 0
        strategy = try container.decodeIfPresent(String.self, forKey: .strategy)
        isQuestion = try container.decodeIfPresent(Bool.self, forKey: .isQuestion)
    }

    private enum CodingKeys: String, CodingKey {
        case id, text, rationale, confidence, strategy, isQuestion
    }
}

/// Explore card mapped from a native 1+4 generate response (recommended first).
struct DraftCard: Identifiable, Equatable {
    let id: String
    let text: String
    let rationale: String
    let strategy: String
    let recommended: Bool
    let suggestionID: String

    init(from suggestion: DraftSuggestion, strategy: String, recommended: Bool) {
        id = suggestion.id
        text = suggestion.text
        rationale = suggestion.rationale
        self.strategy = strategy
        self.recommended = recommended
        suggestionID = suggestion.id
    }
}

enum DraftExploreMapper {
    private static let fallbackLabels = [
        "Recommended", "Specific", "Constructive tension", "Experience question", "Concise practical"
    ]

    /// Map a standard generate response into Explore cards (recommended first), matching the extension.
    static func map(_ response: DraftResponse) -> [DraftCard] {
        let recommended = response.recommendation ?? response.suggestions.first
        let exploreItems = Array((response.explore?.isEmpty == false
            ? response.explore!
            : Array(response.suggestions.dropFirst().prefix(4))).prefix(4))

        var cards: [DraftCard] = []
        if let recommended {
            cards.append(DraftCard(
                from: recommended,
                strategy: recommended.strategy ?? fallbackLabels[0],
                recommended: true
            ))
        }
        for (index, item) in exploreItems.enumerated() {
            if let recommended, item.id == recommended.id { continue }
            let label = item.strategy
                ?? fallbackLabels[safe: index + 1]
                ?? "Explore \(index + 1)"
            cards.append(DraftCard(from: item, strategy: label, recommended: false))
        }
        return Array(cards.prefix(5))
    }
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
    let contentKind: String?

    enum CodingKeys: String, CodingKey {
        case status, platform, finalText, sourceText, sourceURL, clientEventID = "clientEventId"
        case sessionID = "sessionId", workID = "workId", contentKind
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
        contentKind = draft.contentKind?.rawValue
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(status, forKey: .status)
        try container.encode(platform, forKey: .platform)
        try container.encode(finalText, forKey: .finalText)
        try container.encodeIfPresent(sourceText, forKey: .sourceText)
        try container.encodeIfPresent(sourceURL, forKey: .sourceURL)
        try container.encode(clientEventID, forKey: .clientEventID)
        try container.encodeIfPresent(sessionID, forKey: .sessionID)
        try container.encodeIfPresent(workID, forKey: .workID)
        try container.encodeIfPresent(contentKind, forKey: .contentKind)
    }
}

enum TweetHelperAPI {
    static var session: URLSession = .shared
    /// Matches the extension's default wait for Together-backed generation.
    static let requestTimeout: TimeInterval = 90

    static func getHealth() async throws -> Bool {
        let data = try await request(path: "/health", method: "GET", body: nil, includeAuth: false)
        return try JSONDecoder().decode(HealthResponse.self, from: data).ok
    }

    static func generatePost(
        topic: String,
        growth: GrowthPreferences = TweetHelperSettings.growthPreferences,
        instructions: String = ""
    ) async throws -> DraftResponse {
        var body: [String: String] = [
            "topic": topic,
            "goal": "engagement",
            "length": "short",
            "audience": growth.audience,
            "contentPillar": growth.pillar,
            "desiredOutcome": growth.outcome
        ]
        let base = instructions.nilIfBlank
            ?? "Return one strongest recommendation and four distinct Explore strategies."
        body["instructions"] = "\(base)\nDesired response: \(growth.outcome)."
        return try await generate(path: "/api/generate/post", body: body)
    }

    static func generateReply(
        context: String,
        sourceURL: URL? = nil,
        angle: String = "",
        growth: GrowthPreferences = TweetHelperSettings.growthPreferences,
        instructions: String = ""
    ) async throws -> DraftResponse {
        var source: [String: String] = ["text": context]
        if let sourceURL { source["url"] = sourceURL.absoluteString }
        let growthInstructions = instructions.nilIfBlank ?? defaultReplyInstructions(growth: growth)
        var body: [String: Any] = [
            "sourcePost": source,
            "audience": growth.audience,
            "contentPillar": growth.pillar,
            "desiredOutcome": growth.outcome,
            "instructions": growthInstructions
        ]
        if let angle = angle.nilIfBlank { body["angle"] = angle }
        return try await generate(path: "/api/generate/comment", body: body)
    }

    static func rewrite(
        text: String,
        kind: String = "post",
        growth: GrowthPreferences = TweetHelperSettings.growthPreferences,
        instructions: String = ""
    ) async throws -> DraftResponse {
        var body: [String: String] = ["text": text, "kind": kind]
        let base = instructions.nilIfBlank
            ?? "Tighten the draft for \(growth.audience). Keep the author's intent. Desired response: \(growth.outcome)."
        body["instructions"] = base
        return try await generate(path: "/api/generate/rewrite", body: body)
    }

    static func recordUsed(_ draft: SharedDraft, clientEventID: UUID) async throws {
        _ = try await request(path: "/api/outcomes", method: "POST",
                              body: UsedOutcomePayload(draft: draft, clientEventID: clientEventID), includeAuth: true)
    }

    private static func defaultReplyInstructions(growth: GrowthPreferences) -> String {
        [
            "Use only the supplied context. Do not imply any unseen post was read.",
            "Signal peer expertise with a complete thought that stands alone.",
            "Never invent facts, metrics, credentials, or personal experiences.",
            "Do not use generic AI openers; sound like a real peer typing on X.",
            "Desired response: \(growth.outcome)."
        ].joined(separator: "\n")
    }

    private static func generate(path: String, body: Any) async throws -> DraftResponse {
        let data = try await request(path: path, method: "POST", body: body, includeAuth: true)
        return try JSONDecoder().decode(DraftEnvelope.self, from: data).data
    }

    private static func request(path: String, method: String, body: Any?, includeAuth: Bool) async throws -> Data {
        guard let base = URL(string: TweetHelperSettings.backendURL),
              let resolved = URL(string: path, relativeTo: base)?.absoluteURL else {
            throw APIError.invalidBackendURL
        }
        var request = URLRequest(url: resolved)
        request.httpMethod = method
        request.timeoutInterval = requestTimeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(AnyEncodable(body))
        }
        if includeAuth, !TweetHelperSettings.authToken.isEmpty {
            request.setValue("Bearer \(TweetHelperSettings.authToken)", forHTTPHeaderField: "Authorization")
        }
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
            guard (200..<300).contains(http.statusCode) else {
                if http.statusCode == 401 { throw APIError.unauthorized }
                throw APIError.httpStatus(http.statusCode)
            }
            return data
        } catch let error as APIError {
            throw error
        } catch {
            throw APIError.transport(error, endpoint: resolved.absoluteString)
        }
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
    case transport(Error, endpoint: String)

    var errorDescription: String? {
        switch self {
        case .invalidBackendURL: "Backend URL is invalid."
        case .invalidResponse: "Backend returned an invalid response."
        case .unauthorized: "Backend rejected the token. Check Settings in the app."
        case .httpStatus(let status): "Backend request failed with HTTP \(status)."
        case .transport(let error, let endpoint):
            readableTransportError(error, endpoint: endpoint)
        }
    }
}

extension String {
    var nilIfBlank: String? {
        let value = trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }
}

private extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}

func readableNetworkError(_ error: Error) -> String {
    if let api = error as? APIError, let description = api.errorDescription {
        return description
    }
    return readableTransportError(error, endpoint: TweetHelperSettings.backendURL)
}

private func readableTransportError(_ error: Error, endpoint: String) -> String {
    let value = error as NSError
    guard value.domain == NSURLErrorDomain else { return error.localizedDescription }
    let host = URL(string: endpoint)?.host ?? endpoint
    switch value.code {
    case NSURLErrorCannotConnectToHost, NSURLErrorCannotFindHost, NSURLErrorNetworkConnectionLost:
        return "Could not reach \(host) [\(value.code)]. Use the same URL that works in Safari, allow Local Network for Tweet Helper in iOS Settings, and keep Tailscale connected."
    case NSURLErrorTimedOut:
        return "Timed out reaching \(host). Check that the backend is listening on 0.0.0.0:\(URL(string: endpoint)?.port ?? 4317)."
    case NSURLErrorNotConnectedToInternet:
        return "No network route to \(host). Connect Tailscale or Wi‑Fi and try again."
    default:
        return "\(value.localizedDescription) [\(value.code)] → \(endpoint)"
    }
}
