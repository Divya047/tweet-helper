import XCTest
@testable import TweetHelperMobile

final class TweetHelperTests: XCTestCase {
    func testShareParserKeepsTextAndFirstSafeWebURL() {
        let parsed = ShareContentParser.parse(
            textItems: ["  Useful context  ", "javascript:alert(1)", "https://x.com/user/status/1"],
            urlItems: [URL(string: "file:///private/item")!, URL(string: "https://example.com/post")!]
        )
        XCTAssertEqual(parsed.text, "Useful context\n\njavascript:alert(1)")
        XCTAssertEqual(parsed.url?.absoluteString, "https://example.com/post")
    }

    func testAppGroupTransferRoundTrip() throws {
        let suite = "TweetHelperTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let draft = SharedDraft(text: "Saved reply", sourceText: "Source", sourceURL: URL(string: "https://x.com/a/status/2"))
        try SharedDraftStore.save(draft, defaults: defaults)
        XCTAssertEqual(SharedDraftStore.load(defaults: defaults), [draft])
    }

    func testAPIDraftEnvelopeDecoding() throws {
        let data = #"{"data":{"suggestions":[{"id":"s1","text":"Hello","rationale":"Direct","confidence":0.91}]}}"#.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(DraftEnvelope.self, from: data)
        XCTAssertEqual(decoded.data.suggestions.first, DraftSuggestion(id: "s1", text: "Hello", rationale: "Direct", confidence: 0.91))
    }

    func testUsedOutcomePayloadContract() throws {
        let draft = SharedDraft(text: "Final", sourceText: "Original", sourceURL: URL(string: "https://x.com/p"),
                                sessionID: "session-1", workID: "work-1")
        let eventID = UUID(uuidString: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")!
        let payload = UsedOutcomePayload(draft: draft, clientEventID: eventID)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(payload)) as? [String: Any])
        XCTAssertEqual(object["status"] as? String, "used")
        XCTAssertEqual(object["platform"] as? String, "ios")
        XCTAssertEqual(object["finalText"] as? String, "Final")
        XCTAssertEqual(object["sourceText"] as? String, "Original")
        XCTAssertEqual(object["sourceURL"] as? String, "https://x.com/p")
        XCTAssertEqual(object["clientEventId"] as? String, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
        XCTAssertEqual(object["sessionId"] as? String, "session-1")
        XCTAssertEqual(object["workId"] as? String, "work-1")
    }

    func testRewriteAndUndoHelpersGuardChangedComposer() {
        var value = "Old"
        RewriteUndoHelper.replace(before: value, with: "New", deleteBackward: { value.removeLast() }, insert: { value += $0 })
        XCTAssertEqual(value, "New")
        let snapshot = RewriteSnapshot(before: "Old", after: "New")
        XCTAssertTrue(RewriteUndoHelper.undo(snapshot, currentBeforeCursor: value,
                                             deleteBackward: { value.removeLast() }, insert: { value += $0 }))
        XCTAssertEqual(value, "Old")
        XCTAssertFalse(RewriteUndoHelper.undo(snapshot, currentBeforeCursor: "Changed", deleteBackward: {}, insert: { _ in }))
    }
}
