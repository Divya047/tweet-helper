import SwiftUI

struct SetupView: View {
    enum ComposerMode: String, CaseIterable, Identifiable {
        case post = "Post", reply = "Reply"
        var id: Self { self }
        var contentKind: ContentKind { self == .post ? .post : .reply }
    }

    @State private var mode: ComposerMode = .post
    @State private var brief = ""
    @State private var source = ""
    @State private var draft = ""
    @State private var cards: [DraftCard] = []
    @State private var selectedCard = 0
    @State private var showingAlternatives = false
    @State private var activity = TweetHelperSettings.activity
    @State private var queue: [SharedDraft] = []
    @State private var isLoading = false
    @State private var message: String?
    @State private var showingSettings = false

    private var selected: DraftCard? { cards[safe: selectedCard] }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("Session type", selection: $mode) {
                    ForEach(ComposerMode.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                .padding()

                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        softGoalsStrip

                        GroupBox(mode == .post ? "Brief" : "Reply context") {
                            TextEditor(text: mode == .post ? $brief : $source)
                                .frame(minHeight: 100)
                                .overlay(alignment: .topLeading) {
                                    if (mode == .post ? brief : source).isEmpty {
                                        Text(mode == .post ? "What do you want to say?" : "Paste the source post and add your angle")
                                            .foregroundStyle(.tertiary).padding(.top, 8).padding(.leading, 5)
                                            .allowsHitTesting(false)
                                    }
                                }
                        }

                        Button {
                            Task { await generate() }
                        } label: {
                            Label(isLoading ? "Drafting…" : "Generate drafts", systemImage: "sparkles")
                                .frame(maxWidth: .infinity).padding(.vertical, 6)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(isLoading)

                        if let message {
                            Label(message, systemImage: "info.circle")
                                .font(.footnote).foregroundStyle(.secondary)
                        }

                        if let card = selected {
                            SectionTitle(card.recommended ? "\(card.strategy) · Recommended" : card.strategy)
                            Text(card.text)
                                .padding()
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(.quaternary, in: RoundedRectangle(cornerRadius: 14))
                            Button("Use this draft") { draft = card.text }
                                .buttonStyle(.bordered)
                            if cards.count > 1 {
                                Button(showingAlternatives ? "Hide alternatives" : "Explore alternatives") {
                                    showingAlternatives.toggle()
                                }
                                if showingAlternatives {
                                    Picker("Draft", selection: $selectedCard) {
                                        ForEach(cards.indices, id: \.self) { index in
                                            Text(cards[index].recommended ? "Recommended" : "Alt \(index)").tag(index)
                                        }
                                    }
                                    .pickerStyle(.segmented)
                                    .onChange(of: selectedCard) { _, _ in
                                        if let card = selected { draft = card.text }
                                    }
                                }
                            }
                        }

                        GroupBox("Working draft") {
                            TextEditor(text: $draft).frame(minHeight: 140)
                        }

                        Button {
                            saveDraft()
                        } label: {
                            Label("Save to keyboard queue", systemImage: "tray.and.arrow.down")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(draft.nilIfBlank == nil)

                        SectionTitle("Saved queue")
                        if queue.isEmpty {
                            ContentUnavailableView("No saved drafts", systemImage: "tray", description: Text("Generate or write a draft, then save it for the keyboard."))
                        } else {
                            ForEach(queue) { item in
                                VStack(alignment: .leading, spacing: 8) {
                                    Text(item.text).lineLimit(4)
                                    HStack {
                                        Button("Edit") { draft = item.text }
                                        Spacer()
                                        Button("Delete", role: .destructive) { remove(item) }
                                    }.font(.subheadline)
                                }.padding().background(.quaternary, in: RoundedRectangle(cornerRadius: 14))
                            }
                        }
                    }.padding([.horizontal, .bottom])
                }
            }
            .navigationTitle("Tweet Helper")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Settings", systemImage: "gear") { showingSettings = true }
                }
            }
            .sheet(isPresented: $showingSettings) { SettingsView() }
            .task { refresh() }
            .onChange(of: showingSettings) { _, isShowing in if !isShowing { refresh() } }
        }
    }

    private var softGoalsStrip: some View {
        HStack(spacing: 16) {
            Label("\(activity.posts)/\(ActivityState.softGoals.posts) posts", systemImage: "square.and.pencil")
            Label("\(activity.replies)/\(ActivityState.softGoals.replies) replies", systemImage: "bubble.left")
            Spacer(minLength: 0)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Today: \(activity.posts) of \(ActivityState.softGoals.posts) posts, \(activity.replies) of \(ActivityState.softGoals.replies) replies")
    }

    private func generate() async {
        let input = (mode == .post ? brief : source).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !input.isEmpty else { message = mode == .post ? "Enter a brief first." : "Paste reply context first."; return }
        isLoading = true; message = nil
        selectedCard = 0
        showingAlternatives = false
        do {
            let growth = TweetHelperSettings.growthPreferences
            let response = mode == .post
                ? try await TweetHelperAPI.generatePost(topic: input, growth: growth)
                : try await TweetHelperAPI.generateReply(context: input, growth: growth)
            cards = DraftExploreMapper.map(response)
            draft = cards.first?.text ?? ""
            message = cards.isEmpty ? "The backend returned no drafts." : nil
        } catch { message = readableNetworkError(error) }
        isLoading = false
    }

    private func saveDraft() {
        guard let text = draft.nilIfBlank else { return }
        let match = cards.first { $0.text == text }
        do {
            try SharedDraftStore.save(SharedDraft(
                text: text,
                sourceText: mode == .reply ? source : brief,
                suggestionID: match?.suggestionID,
                contentKind: mode.contentKind
            ))
            refresh(); message = "Saved. Switch to the Tweet Helper keyboard to insert it."
        } catch { message = "Could not save the draft: \(error.localizedDescription)" }
    }

    private func remove(_ item: SharedDraft) {
        do { try SharedDraftStore.remove(id: item.id); refresh() }
        catch { message = "Could not remove the draft." }
    }

    private func refresh() {
        activity = TweetHelperSettings.activity
        queue = SharedDraftStore.load()
    }
}

private struct SectionTitle: View {
    let title: String
    init(_ title: String) { self.title = title }
    var body: some View { Text(title).font(.headline) }
}

private extension Collection {
    subscript(safe index: Index) -> Element? { indices.contains(index) ? self[index] : nil }
}

private struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var backendURL = TweetHelperSettings.backendURL
    @State private var authToken = TweetHelperSettings.authToken
    @State private var growth = TweetHelperSettings.growthPreferences
    @State private var status = "Settings are shared with the keyboard and Share Extension."
    @State private var checking = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Backend") {
                    TextField("http://100.x.y.z:4317", text: $backendURL).keyboardType(.URL)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("Mobile auth token", text: $authToken).textInputAutocapitalization(.never)
                    Button("Save") { save(); status = "Saved to the App Group." }
                    Button(checking ? "Checking…" : "Check connection") { Task { await check() } }.disabled(checking)
                    Text(status).font(.footnote).foregroundStyle(.secondary)
                    Text("Paste the exact URL that loads /health in Safari. If Check connection fails with [-1004], allow Local Network for Tweet Helper in iOS Settings → Tweet Helper.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("Growth defaults") {
                    TextField("Target audience", text: $growth.audience, axis: .vertical)
                        .lineLimit(2...4)
                    Picker("Content pillar", selection: $growth.pillar) {
                        ForEach(GrowthPreferences.pillarOptions, id: \.id) { Text($0.label).tag($0.id) }
                    }
                    Picker("Desired response", selection: $growth.outcome) {
                        ForEach(GrowthPreferences.outcomeOptions, id: \.id) { Text($0.label).tag($0.id) }
                    }
                    Text("Used for Generate and Share. Change here when you want a different default.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("Extensions") {
                    Text("Share text or a URL from Chrome or X to Tweet Helper. Enable the Tweet Helper keyboard in Settings → General → Keyboard → Keyboards and allow Full Access for backend calls.")
                    Text("Tweet Helper only prepares and inserts text. It never submits to X.")
                }
                Section("Diagnostics") { Text(TweetHelperSettings.diagnostics).font(.footnote) }
            }
            .navigationTitle("Settings")
            .toolbar { Button("Done") { save(); dismiss() } }
        }
    }

    private func save() {
        TweetHelperSettings.backendURL = backendURL
        TweetHelperSettings.authToken = authToken
        TweetHelperSettings.growthPreferences = growth
    }

    private func check() async {
        save()
        LocalNetworkAccess.requestPermissionIfNeeded()
        checking = true; defer { checking = false }
        do { status = try await TweetHelperAPI.getHealth() ? "Connected to \(TweetHelperSettings.backendURL)." : "Backend did not report healthy." }
        catch { status = readableNetworkError(error) }
    }
}
