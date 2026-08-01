import SwiftUI
import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        let host = UIHostingController(rootView: ShareComposerView(extensionContext: extensionContext))
        addChild(host)
        view.addSubview(host.view)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        host.didMove(toParent: self)
    }
}

@MainActor
private struct ShareComposerView: View {
    let extensionContext: NSExtensionContext?
    @State private var content = SharedContent()
    @State private var cards: [DraftCard] = []
    @State private var selected = 0
    @State private var draft = ""
    @State private var loading = true
    @State private var exploring = false
    @State private var message: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if loading { ProgressView("Reading shared content…") }
                    else if !content.isUsable { emptyState }
                    else {
                        sourceCard
                        if let card = cards[safe: selected] {
                            Text(card.recommended ? "\(card.strategy) · Recommended" : card.strategy).font(.headline)
                            TextEditor(text: $draft)
                                .font(.title3)
                                .frame(minHeight: 130)
                                .padding(8)
                                .background(.quaternary, in: RoundedRectangle(cornerRadius: 16))
                            Button("Save & Return to X") { save(card) }
                                .buttonStyle(.borderedProminent).frame(maxWidth: .infinity)
                            Button("Skip this draft", role: .destructive) { skip(card) }
                                .buttonStyle(.bordered)
                            if cards.count > 1 {
                                Button(exploring ? "Hide alternatives" : "Explore alternatives") { exploring.toggle() }
                                if exploring {
                                    Picker("Draft", selection: $selected) {
                                        ForEach(cards.indices, id: \.self) { index in
                                            Text(cards[index].recommended ? "Recommended" : "Alt \(index)").tag(index)
                                        }
                                    }
                                    .pickerStyle(.segmented)
                                    .onChange(of: selected) { _, index in
                                        draft = cards[safe: index]?.text ?? ""
                                    }
                                }
                            }
                        } else if message == nil { ProgressView("Drafting a reply…") }
                    }
                    if let message { Label(message, systemImage: "info.circle").font(.footnote).foregroundStyle(.secondary) }
                }.padding()
            }
            .navigationTitle("Tweet Helper")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { finish() } }
            }
            .task { await loadAndGenerate() }
        }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("No usable text", systemImage: "doc.text.magnifyingglass")
        } description: {
            Text("This share did not include readable text or a web URL.")
        } actions: {
            Button("Paste Context") {
                content = ShareContentParser.parse(textItems: [UIPasteboard.general.string ?? ""], urlItems: [])
                if content.isUsable { Task { await generate() } }
                else { message = "The clipboard does not contain usable text." }
            }.buttonStyle(.borderedProminent)
        }
    }

    private var sourceCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Source").font(.headline)
            if let text = content.text { Text(text).lineLimit(6) }
            if let url = content.url { Text(url.absoluteString).font(.caption).foregroundStyle(.secondary) }
        }.padding().frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
    }

    private func loadAndGenerate() async {
        content = await ShareAttachmentLoader.load(from: extensionContext?.inputItems ?? [])
        loading = false
        if content.isUsable { await generate() }
    }

    private func generate() async {
        message = nil; cards = []; selected = 0
        let context = content.text ?? content.url?.absoluteString ?? ""
        do {
            let response = try await TweetHelperAPI.generateReply(context: context, sourceURL: content.url)
            cards = DraftExploreMapper.map(response)
            draft = cards.first?.text ?? ""
            if cards.isEmpty {
                message = response.abstained == true
                    ? (response.abstainReason ?? "Nothing here clears your reply taste bar.")
                    : "No drafts were returned. Check the backend and try again."
            }
        } catch { message = readableNetworkError(error) }
    }

    private func save(_ card: DraftCard) {
        do {
            guard let text = draft.nilIfBlank else { return }
            let saved = SharedDraft(
                text: text,
                originalText: card.text,
                sourceText: content.text,
                sourceURL: content.url,
                suggestionID: card.suggestionID,
                contentKind: .reply
            )
            try SharedDraftStore.save(saved)
            if let payload = TasteFeedbackPayload.make(draft: saved, eventKind: .saved) {
                try PendingTelemetryStore.enqueueFeedback(payload)
            }
            // A Share extension cannot write into its host app. Completing the request
            // returns focus to X so the Tweet Helper keyboard can insert the saved text.
            finish()
        } catch { message = "Could not save to the App Group: \(error.localizedDescription)" }
    }

    private func skip(_ card: DraftCard) {
        let skipped = SharedDraft(
            text: card.text,
            originalText: card.text,
            sourceText: content.text,
            sourceURL: content.url,
            suggestionID: card.suggestionID,
            contentKind: .reply
        )
        do {
            if let payload = TasteFeedbackPayload.make(draft: skipped, eventKind: .skipped) {
                try PendingTelemetryStore.enqueueFeedback(payload)
            }
            cards.removeAll { $0.id == card.id }
            selected = min(selected, max(0, cards.count - 1))
            draft = cards[safe: selected]?.text ?? ""
            if cards.isEmpty { finish() }
            else { message = "Skipped. Showing the next draft." }
        } catch { message = "Could not save skip feedback: \(error.localizedDescription)" }
    }

    private func finish() { extensionContext?.completeRequest(returningItems: nil) }
}

enum ShareAttachmentLoader {
    static func load(from items: [Any]) async -> SharedContent {
        let providers = items.compactMap { ($0 as? NSExtensionItem)?.attachments }.flatMap { $0 }
        var texts: [String] = []
        var urls: [URL] = []
        for provider in providers.prefix(12) {
            if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
               let value = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier),
               let url = value as? URL { urls.append(url); continue }
            if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
               let value = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) {
                if let text = value as? String { texts.append(text) }
                else if let data = value as? Data, let text = String(data: data, encoding: .utf8) { texts.append(text) }
            }
        }
        return ShareContentParser.parse(textItems: texts, urlItems: urls)
    }
}

private extension Collection {
    subscript(safe index: Index) -> Element? { indices.contains(index) ? self[index] : nil }
}
