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
        let draft = SharedDraft(text: "Saved reply", sourceText: "Source", sourceURL: URL(string: "https://x.com/a/status/2"),
                                contentKind: .reply)
        try SharedDraftStore.save(draft, defaults: defaults)
        XCTAssertEqual(SharedDraftStore.load(defaults: defaults), [draft])
    }

    func testAPIDraftEnvelopeDecoding() throws {
        let data = #"{"data":{"suggestions":[{"id":"s1","text":"Hello","rationale":"Direct","confidence":0.91}]}}"#.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(DraftEnvelope.self, from: data)
        XCTAssertEqual(decoded.data.suggestions.first, DraftSuggestion(id: "s1", text: "Hello", rationale: "Direct", confidence: 0.91))
    }

    func testNativeExploreEnvelopeMapsRecommendedFirst() throws {
        let json = """
        {"data":{"suggestions":[
          {"id":"r1","text":"Strongest take.","rationale":"Clear","confidence":0.9,"strategy":"Recommended"},
          {"id":"a1","text":"Alt one.","rationale":"Specific","confidence":0.8,"strategy":"Specific"},
          {"id":"a2","text":"Alt two.","rationale":"Tension","confidence":0.7}
        ],"recommendation":{"id":"r1","text":"Strongest take.","rationale":"Clear","confidence":0.9,"strategy":"Recommended"},
        "explore":[
          {"id":"a1","text":"Alt one.","rationale":"Specific","confidence":0.8,"strategy":"Specific"},
          {"id":"a2","text":"Alt two.","rationale":"Tension","confidence":0.7}
        ]}}
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(DraftEnvelope.self, from: json)
        let cards = DraftExploreMapper.map(decoded.data)
        XCTAssertEqual(cards.count, 3)
        XCTAssertTrue(cards[0].recommended)
        XCTAssertEqual(cards[0].text, "Strongest take.")
        XCTAssertEqual(cards[0].strategy, "Recommended")
        XCTAssertEqual(cards[1].strategy, "Specific")
        XCTAssertFalse(cards[1].recommended)
        XCTAssertEqual(cards[2].strategy, "Constructive tension")
    }

    func testUsedOutcomePayloadContract() throws {
        let draft = SharedDraft(text: "Final", sourceText: "Original", sourceURL: URL(string: "https://x.com/p"),
                                sessionID: "session-1", workID: "work-1", contentKind: .reply)
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
        XCTAssertEqual(object["contentKind"] as? String, "reply")
    }

    func testTasteFeedbackMapsSavedEditedSkippedAndInsertedDrafts() throws {
        let base = SharedDraft(
            text: "Generated reply",
            originalText: "Generated reply",
            sourceText: "Source claim",
            sourceURL: URL(string: "https://x.com/a/status/1"),
            suggestionID: "suggestion-1",
            contentKind: .reply
        )
        let saved = try XCTUnwrap(TasteFeedbackPayload.make(draft: base, eventKind: .saved))
        XCTAssertEqual(saved.decision, .accepted)
        XCTAssertEqual(saved.kind, "comment")
        XCTAssertEqual(saved.context.eventKind, .saved)
        XCTAssertEqual(saved.context.sourcePost?.text, "Source claim")
        XCTAssertEqual(saved.context.sourcePost?.url, "https://x.com/a/status/1")

        var editedDraft = base
        editedDraft.text = "Sharper final reply"
        let edited = try XCTUnwrap(TasteFeedbackPayload.make(draft: editedDraft, eventKind: .saved))
        XCTAssertEqual(edited.decision, .edited)
        XCTAssertEqual(edited.originalText, "Generated reply")
        XCTAssertEqual(edited.finalText, "Sharper final reply")

        let skipped = try XCTUnwrap(TasteFeedbackPayload.make(draft: base, eventKind: .skipped))
        XCTAssertEqual(skipped.decision, .skipped)
        XCTAssertNil(skipped.finalText)

        let inserted = try XCTUnwrap(TasteFeedbackPayload.make(draft: editedDraft, eventKind: .inserted))
        XCTAssertEqual(inserted.decision, .edited)
        XCTAssertEqual(inserted.context.eventKind, .inserted)
    }

    func testHandwrittenDraftDoesNotCreateModelFeedback() {
        let draft = SharedDraft(text: "My own reply", contentKind: .reply)
        XCTAssertNil(TasteFeedbackPayload.make(draft: draft, eventKind: .saved))
    }

    func testPendingTelemetrySurvivesOfflineUntilExplicitRemoval() throws {
        let suite = "TweetHelperTelemetryTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let draft = SharedDraft(text: "Reply", originalText: "Reply", sourceText: "Source",
                                suggestionID: "s1", contentKind: .reply)
        let feedback = try XCTUnwrap(TasteFeedbackPayload.make(draft: draft, eventKind: .saved))
        let feedbackID = try PendingTelemetryStore.enqueueFeedback(feedback, defaults: defaults)
        let outcomeID = try PendingTelemetryStore.enqueueOutcome(
            UsedOutcomePayload(draft: draft, clientEventID: UUID()), defaults: defaults
        )

        XCTAssertEqual(PendingTelemetryStore.feedback(defaults: defaults).first?.payload, feedback)
        XCTAssertEqual(PendingTelemetryStore.outcomes(defaults: defaults).first?.payload.finalText, "Reply")

        try PendingTelemetryStore.removeFeedback(id: feedbackID, defaults: defaults)
        try PendingTelemetryStore.removeOutcome(id: outcomeID, defaults: defaults)
        XCTAssertTrue(PendingTelemetryStore.feedback(defaults: defaults).isEmpty)
        XCTAssertTrue(PendingTelemetryStore.outcomes(defaults: defaults).isEmpty)
    }

    func testActivityResetsAcrossDays() {
        let stale = ActivityState(dayKey: "2000-01-01", posts: 3, replies: 5).normalized()
        XCTAssertEqual(stale.posts, 0)
        XCTAssertEqual(stale.replies, 0)
        XCTAssertEqual(stale.dayKey, ActivityState.dayKey(for: Date()))
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
