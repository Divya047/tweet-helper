import UIKit

final class KeyboardViewController: UIInputViewController {
    private let stack = UIStackView()
    private let insertButton = UIButton(type: .system)
    private let rewriteButton = UIButton(type: .system)
    private let undoButton = UIButton(type: .system)
    private let globeButton = UIButton(type: .system)
    private let statusLabel = UILabel()
    private var undoSnapshot: RewriteSnapshot?
    private var busy = false { didSet { updateButtons() } }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        stack.axis = .vertical; stack.spacing = 10; stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 10),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -10),
            stack.topAnchor.constraint(equalTo: view.topAnchor, constant: 10),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: view.bottomAnchor, constant: -10)
        ])
        configure(insertButton, title: "Insert saved draft", symbol: "tray.and.arrow.up.fill", action: #selector(insertSaved))
        configure(rewriteButton, title: "Rewrite current", symbol: "sparkles", action: #selector(rewriteCurrent))
        let row = UIStackView(arrangedSubviews: [undoButton, globeButton]); row.axis = .horizontal; row.spacing = 10; row.distribution = .fillEqually
        configure(undoButton, title: "Undo", symbol: "arrow.uturn.backward", action: #selector(undoRewrite))
        configure(globeButton, title: "Globe", symbol: "globe", action: #selector(nextKeyboard))
        stack.addArrangedSubview(insertButton); stack.addArrangedSubview(rewriteButton); stack.addArrangedSubview(row)
        statusLabel.font = .preferredFont(forTextStyle: .caption1); statusLabel.textColor = .secondaryLabel
        statusLabel.numberOfLines = 2; statusLabel.text = "Save drafts in the app or Share Extension. Tweet Helper never submits."
        stack.addArrangedSubview(statusLabel)
        updateButtons()
    }

    private func configure(_ button: UIButton, title: String, symbol: String, action: Selector) {
        var config = UIButton.Configuration.filled(); config.title = title; config.image = UIImage(systemName: symbol)
        config.imagePadding = 8; config.cornerStyle = .large; config.baseBackgroundColor = .secondarySystemBackground
        config.baseForegroundColor = .label; button.configuration = config
        button.heightAnchor.constraint(greaterThanOrEqualToConstant: 52).isActive = true
        button.addTarget(self, action: action, for: .touchUpInside)
    }

    private func updateButtons() {
        insertButton.isEnabled = !busy
        rewriteButton.isEnabled = !busy
        undoButton.isEnabled = !busy && undoSnapshot != nil
    }

    @objc private func insertSaved() {
        guard let draft = SharedDraftStore.load().first else {
            statusLabel.text = "No saved draft. Create one in the Tweet Helper app or Share Extension."
            return
        }
        textDocumentProxy.insertText(draft.text)
        if let kind = draft.contentKind {
            TweetHelperSettings.recordActivity(kind: kind)
        } else if draft.sourceURL != nil || draft.sourceText?.nilIfBlank != nil {
            TweetHelperSettings.recordActivity(kind: .reply)
        } else {
            TweetHelperSettings.recordActivity(kind: .post)
        }
        statusLabel.text = "Inserted. Recording usage…"
        let eventID = UUID()
        Task {
            do { try await TweetHelperAPI.recordUsed(draft, clientEventID: eventID); setStatus("Inserted and recorded as used.") }
            catch { setStatus("Inserted. Usage could not sync; \(readableNetworkError(error))") }
        }
    }

    @objc private func rewriteCurrent() {
        let before = textDocumentProxy.documentContextBeforeInput ?? ""
        guard let input = before.nilIfBlank else { statusLabel.text = "Type a draft in X first."; return }
        busy = true; statusLabel.text = "Rewriting…"
        Task {
            do {
                let response = try await TweetHelperAPI.rewrite(text: input, kind: "comment")
                guard let suggestion = DraftExploreMapper.map(response).first
                        ?? response.suggestions.first.map({
                            DraftCard(from: $0, strategy: $0.strategy ?? "Rewrite", recommended: true)
                        }) else {
                    finishBusy("No rewrite was returned."); return
                }
                await MainActor.run {
                    let snapshot = RewriteSnapshot(before: before, after: suggestion.text)
                    RewriteUndoHelper.replace(before: before, with: suggestion.text,
                                              deleteBackward: { self.textDocumentProxy.deleteBackward() },
                                              insert: { self.textDocumentProxy.insertText($0) })
                    self.undoSnapshot = snapshot; self.busy = false; self.statusLabel.text = "Rewritten. Tap Undo to restore the previous text."
                }
            } catch { finishBusy(readableNetworkError(error)) }
        }
    }

    @objc private func undoRewrite() {
        guard let snapshot = undoSnapshot else { return }
        let current = textDocumentProxy.documentContextBeforeInput ?? ""
        if RewriteUndoHelper.undo(snapshot, currentBeforeCursor: current,
                                  deleteBackward: { textDocumentProxy.deleteBackward() },
                                  insert: { textDocumentProxy.insertText($0) }) {
            undoSnapshot = nil; statusLabel.text = "Rewrite undone."
        } else { statusLabel.text = "Undo is unavailable because the composer changed." }
        updateButtons()
    }

    @objc private func nextKeyboard() { advanceToNextInputMode() }
    @MainActor private func setStatus(_ text: String) { statusLabel.text = text }
    @MainActor private func finishBusy(_ text: String) { statusLabel.text = text; busy = false }
}
