import SwiftUI

struct SetupView: View {
    enum ComposerMode: String, CaseIterable, Identifiable {
        case post = "Post", reply = "Reply"
        var id: Self { self }
    }

    @State private var mode: ComposerMode = .post
    @State private var brief = ""
    @State private var source = ""
    @State private var draft = ""
    @State private var suggestions: [DraftSuggestion] = []
    @State private var queue: [SharedDraft] = []
    @State private var isLoading = false
    @State private var message: String?
    @State private var showingSettings = false

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

                        if !suggestions.isEmpty {
                            SectionTitle("Suggestions")
                            ForEach(suggestions) { suggestion in
                                Button {
                                    draft = suggestion.text
                                } label: {
                                    VStack(alignment: .leading, spacing: 6) {
                                        Text(suggestion.text).foregroundStyle(.primary)
                                        Text(suggestion.rationale).font(.caption).foregroundStyle(.secondary)
                                    }.frame(maxWidth: .infinity, alignment: .leading)
                                }.buttonStyle(.bordered)
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
            .task { refreshQueue() }
            .onChange(of: showingSettings) { _, isShowing in if !isShowing { refreshQueue() } }
        }
    }

    private func generate() async {
        let input = (mode == .post ? brief : source).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !input.isEmpty else { message = mode == .post ? "Enter a brief first." : "Paste reply context first."; return }
        isLoading = true; message = nil
        do {
            let result = mode == .post
                ? try await TweetHelperAPI.generatePost(topic: input)
                : try await TweetHelperAPI.generateReply(context: input)
            suggestions = result
            draft = result.first?.text ?? ""
            message = result.isEmpty ? "The backend returned no drafts." : nil
        } catch { message = readableNetworkError(error) }
        isLoading = false
    }

    private func saveDraft() {
        guard let text = draft.nilIfBlank else { return }
        let match = suggestions.first { $0.text == text }
        do {
            try SharedDraftStore.save(SharedDraft(text: text, sourceText: mode == .reply ? source : brief,
                                                  suggestionID: match?.id))
            refreshQueue(); message = "Saved. Switch to the Tweet Helper keyboard to insert it."
        } catch { message = "Could not save the draft: \(error.localizedDescription)" }
    }

    private func remove(_ item: SharedDraft) {
        do { try SharedDraftStore.remove(id: item.id); refreshQueue() }
        catch { message = "Could not remove the draft." }
    }

    private func refreshQueue() { queue = SharedDraftStore.load() }
}

private struct SectionTitle: View {
    let title: String
    init(_ title: String) { self.title = title }
    var body: some View { Text(title).font(.headline) }
}

private struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var backendURL = TweetHelperSettings.backendURL
    @State private var authToken = TweetHelperSettings.authToken
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

    private func save() { TweetHelperSettings.backendURL = backendURL; TweetHelperSettings.authToken = authToken }
    private func check() async {
        save(); checking = true; defer { checking = false }
        do { status = try await TweetHelperAPI.getHealth() ? "Connected." : "Backend did not report healthy." }
        catch { status = readableNetworkError(error) }
    }
}
