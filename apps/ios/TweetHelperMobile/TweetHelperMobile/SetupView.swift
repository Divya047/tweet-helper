import SwiftUI

struct SetupView: View {
    @State private var backendURL = TweetHelperSettings.backendURL
    @State private var authToken = TweetHelperSettings.authToken
    @State private var isChecking = false
    @State private var status = "Enter your Mac Tailscale backend URL and optional mobile token."

    var body: some View {
        NavigationStack {
            Form {
                Section("Backend") {
                    TextField("http://100.x.y.z:4317", text: $backendURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                    SecureField("MOBILE_AUTH_TOKEN", text: $authToken)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    Button("Save") {
                        save()
                    }
                }

                Section("Health Check") {
                    Button(isChecking ? "Checking..." : "Check Backend") {
                        Task {
                            await checkBackend()
                        }
                    }
                    .disabled(isChecking)
                    Text(status)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("Diagnostics") {
                    Text(TweetHelperSettings.diagnostics)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    Text("Saved URL: \(TweetHelperSettings.backendURL)")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Section("Keyboard Setup") {
                    Text("Enable Settings -> General -> Keyboard -> Keyboards -> Add New Keyboard -> Tweet Helper.")
                    Text("Open the Tweet Helper keyboard details and turn on Allow Full Access so it can call your local backend.")
                    Text("In X, switch to Tweet Helper with the globe key. The keyboard inserts drafts only after you tap a suggestion.")
                }
            }
            .navigationTitle("Tweet Helper")
        }
    }

    private func save() {
        TweetHelperSettings.backendURL = backendURL
        TweetHelperSettings.authToken = authToken
        backendURL = TweetHelperSettings.backendURL
        status = "Saved."
    }

    private func checkBackend() async {
        save()
        isChecking = true
        defer { isChecking = false }

        do {
            status = try await TweetHelperAPI.getHealth() ? "Connected." : "Backend did not report healthy."
        } catch {
            status = "URL: \(TweetHelperSettings.backendURL)\n\(readableNetworkError(error))"
        }
    }
}
