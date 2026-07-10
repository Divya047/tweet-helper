import UIKit

final class KeyboardViewController: UIInputViewController {
    private enum Mode: String, CaseIterable {
        case post = "Post"
        case reply = "Reply"
        case rewrite = "Rewrite"
    }

    private let rootStack = UIStackView()
    private let modeControl = UISegmentedControl(items: Mode.allCases.map(\.rawValue))
    private let inputTextView = UITextView()
    private let secondaryTextView = UITextView()
    private let actionButton = UIButton(type: .system)
    private let nextKeyboardButton = UIButton(type: .system)
    private let statusLabel = UILabel()
    private let suggestionsStack = UIStackView()
    private let confirmStack = UIStackView()

    private var mode: Mode = .post {
        didSet {
            configureForMode()
        }
    }
    private var suggestions: [DraftSuggestion] = [] {
        didSet {
            renderSuggestions()
        }
    }
    private var pendingRewrite: DraftSuggestion? {
        didSet {
            renderConfirmation()
        }
    }
    private var isLoading = false {
        didSet {
            actionButton.isEnabled = !isLoading
            actionButton.setTitle(isLoading ? "Working..." : actionTitle(), for: .normal)
        }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        setupView()
        configureForMode()
    }

    private func setupView() {
        view.backgroundColor = .systemBackground

        rootStack.axis = .vertical
        rootStack.spacing = 8
        rootStack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(rootStack)
        NSLayoutConstraint.activate([
            rootStack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 8),
            rootStack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -8),
            rootStack.topAnchor.constraint(equalTo: view.topAnchor, constant: 8),
            rootStack.bottomAnchor.constraint(lessThanOrEqualTo: view.bottomAnchor, constant: -8)
        ])

        modeControl.selectedSegmentIndex = 0
        modeControl.addTarget(self, action: #selector(modeChanged), for: .valueChanged)
        rootStack.addArrangedSubview(modeControl)

        inputTextView.font = .preferredFont(forTextStyle: .body)
        inputTextView.layer.borderWidth = 1
        inputTextView.layer.borderColor = UIColor.separator.cgColor
        inputTextView.layer.cornerRadius = 8
        inputTextView.heightAnchor.constraint(equalToConstant: 58).isActive = true
        rootStack.addArrangedSubview(inputTextView)

        secondaryTextView.font = .preferredFont(forTextStyle: .footnote)
        secondaryTextView.layer.borderWidth = 1
        secondaryTextView.layer.borderColor = UIColor.separator.cgColor
        secondaryTextView.layer.cornerRadius = 8
        secondaryTextView.heightAnchor.constraint(equalToConstant: 42).isActive = true
        rootStack.addArrangedSubview(secondaryTextView)

        let controls = UIStackView()
        controls.axis = .horizontal
        controls.spacing = 8
        controls.distribution = .fillEqually

        nextKeyboardButton.setTitle("Globe", for: .normal)
        nextKeyboardButton.addTarget(self, action: #selector(nextKeyboardTapped), for: .touchUpInside)
        nextKeyboardButton.backgroundColor = .secondarySystemBackground
        nextKeyboardButton.layer.cornerRadius = 8
        controls.addArrangedSubview(nextKeyboardButton)

        actionButton.addTarget(self, action: #selector(generateTapped), for: .touchUpInside)
        actionButton.backgroundColor = .systemBlue
        actionButton.tintColor = .white
        actionButton.layer.cornerRadius = 8
        controls.addArrangedSubview(actionButton)
        rootStack.addArrangedSubview(controls)

        statusLabel.font = .preferredFont(forTextStyle: .caption1)
        statusLabel.textColor = .secondaryLabel
        statusLabel.numberOfLines = 2
        rootStack.addArrangedSubview(statusLabel)

        confirmStack.axis = .horizontal
        confirmStack.spacing = 8
        confirmStack.distribution = .fillEqually
        rootStack.addArrangedSubview(confirmStack)

        suggestionsStack.axis = .vertical
        suggestionsStack.spacing = 6
        rootStack.addArrangedSubview(suggestionsStack)
    }

    private func configureForMode() {
        pendingRewrite = nil
        suggestions = []
        inputTextView.text = ""
        secondaryTextView.text = ""
        secondaryTextView.isHidden = mode == .rewrite
        switch mode {
        case .post:
            inputTextView.accessibilityLabel = "Post topic or instructions"
            secondaryTextView.accessibilityLabel = "Optional post instructions"
            statusLabel.text = "Describe the post you want. Tap a suggestion to insert it."
        case .reply:
            inputTextView.accessibilityLabel = "Manually supplied source context"
            secondaryTextView.accessibilityLabel = "Reply angle"
            statusLabel.text = "Paste or type source context. Tweet Helper cannot read the X post for you."
        case .rewrite:
            inputTextView.accessibilityLabel = "Rewrite instructions"
            statusLabel.text = "Uses only text available before the cursor in the active composer."
        }
        actionButton.setTitle(actionTitle(), for: .normal)
    }

    private func actionTitle() -> String {
        switch mode {
        case .post:
            return "Draft Post"
        case .reply:
            return "Draft Reply"
        case .rewrite:
            return "Rewrite"
        }
    }

    @objc private func modeChanged() {
        let index = modeControl.selectedSegmentIndex
        mode = Mode.allCases[max(0, index)]
    }

    @objc private func nextKeyboardTapped() {
        advanceToNextInputMode()
    }

    @objc private func generateTapped() {
        pendingRewrite = nil
        suggestions = []
        statusLabel.text = "Loading..."
        isLoading = true

        Task {
            do {
                let results: [DraftSuggestion]
                switch mode {
                case .post:
                    let topic = inputTextView.text.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !topic.isEmpty else {
                        throw KeyboardError.emptyInput("Enter a topic or rough draft.")
                    }
                    results = try await TweetHelperAPI.generatePost(topic: topic, instructions: secondaryTextView.text)
                case .reply:
                    let context = inputTextView.text.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !context.isEmpty else {
                        throw KeyboardError.emptyInput("Enter source context manually.")
                    }
                    results = try await TweetHelperAPI.generateReply(context: context, angle: secondaryTextView.text)
                case .rewrite:
                    let draft = textDocumentProxy.documentContextBeforeInput?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    guard !draft.isEmpty else {
                        throw KeyboardError.emptyInput("Type a draft in the composer first.")
                    }
                    results = try await TweetHelperAPI.rewrite(text: draft, kind: "post", instructions: inputTextView.text)
                }

                await MainActor.run {
                    suggestions = results
                    statusLabel.text = results.isEmpty ? "No suggestions returned." : "Tap a suggestion to insert."
                    isLoading = false
                }
            } catch {
                await MainActor.run {
                    statusLabel.text = error.localizedDescription
                    isLoading = false
                }
            }
        }
    }

    private func renderSuggestions() {
        suggestionsStack.arrangedSubviews.forEach { view in
            suggestionsStack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }

        for suggestion in suggestions {
            var configuration = UIButton.Configuration.filled()
            configuration.baseBackgroundColor = .secondarySystemBackground
            configuration.baseForegroundColor = .label
            configuration.cornerStyle = .medium
            configuration.title = suggestion.text
            configuration.subtitle = suggestion.rationale
            configuration.titleAlignment = .leading
            configuration.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 10, bottom: 8, trailing: 10)

            let button = UIButton(configuration: configuration)
            button.contentHorizontalAlignment = .leading
            button.addAction(
                UIAction { [weak self] _ in
                    self?.handleSuggestion(suggestion)
                },
                for: .touchUpInside
            )
            suggestionsStack.addArrangedSubview(button)
        }
    }

    private func handleSuggestion(_ suggestion: DraftSuggestion) {
        if mode == .rewrite {
            pendingRewrite = suggestion
            statusLabel.text = "Choose whether to replace the available composer draft or insert after it."
            return
        }
        textDocumentProxy.insertText(suggestion.text)
        statusLabel.text = "Inserted."
    }

    private func renderConfirmation() {
        confirmStack.arrangedSubviews.forEach { view in
            confirmStack.removeArrangedSubview(view)
            view.removeFromSuperview()
        }
        guard let suggestion = pendingRewrite else {
            confirmStack.isHidden = true
            return
        }

        confirmStack.isHidden = false
        let replace = UIButton(type: .system)
        replace.setTitle("Replace Draft", for: .normal)
        replace.backgroundColor = .systemRed
        replace.tintColor = .white
        replace.layer.cornerRadius = 8
        replace.addAction(UIAction { [weak self] _ in
            self?.replaceAvailableDraft(with: suggestion.text)
        }, for: .touchUpInside)

        let insert = UIButton(type: .system)
        insert.setTitle("Insert After", for: .normal)
        insert.backgroundColor = .secondarySystemBackground
        insert.layer.cornerRadius = 8
        insert.addAction(UIAction { [weak self] _ in
            self?.textDocumentProxy.insertText(suggestion.text)
            self?.pendingRewrite = nil
            self?.statusLabel.text = "Inserted."
        }, for: .touchUpInside)

        confirmStack.addArrangedSubview(replace)
        confirmStack.addArrangedSubview(insert)
    }

    private func replaceAvailableDraft(with text: String) {
        let current = textDocumentProxy.documentContextBeforeInput ?? ""
        for _ in current {
            textDocumentProxy.deleteBackward()
        }
        textDocumentProxy.insertText(text)
        pendingRewrite = nil
        statusLabel.text = "Replaced available draft."
    }
}

private enum KeyboardError: LocalizedError {
    case emptyInput(String)

    var errorDescription: String? {
        switch self {
        case .emptyInput(let message):
            return message
        }
    }
}
