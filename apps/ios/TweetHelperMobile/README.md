# Tweet Helper for iPhone

The iOS workspace contains a full-screen SwiftUI composer, a compact Safari Web Extension, a Share Extension, a custom keyboard, and XCTest coverage. Every surface drafts or inserts text only. Nothing submits to X.

## Targets

- `TweetHelperMobile`: enter a brief or reply context with the normal iOS keyboard, generate a native 1+4 Explore set (recommended first, alternatives on demand), edit a working draft, see soft Today counts, review the saved queue, and configure backend + growth defaults in Settings.
- `TweetHelperShare`: share text or a web URL from Chrome, X, or another app; review, edit, or skip drafts, then use `Save & Return to X` to save to the App Group and restore host-app focus. If an app shares no usable content, `Paste Context` reads the clipboard once after a tap. Uses the same growth prefs as the main app.
- `TweetHelperSafari`: browse `x.com` in Safari and use a compact four-tab popup for Today, Queue, Ideas, and Tools. It reuses the Chrome feed collector for configurable high-intent reply and trend scans, inserts into the X web composer, and sends backend calls through a native App Group/Tailscale bridge. Tools includes scan filters and funnel history, writing presets, local profiles, templates, and profile backup.
- `TweetHelperKeyboard`: large `Insert saved draft`, `Rewrite current`, `Undo`, and `Globe` actions. Inserts bump soft goals and record both `used` outcomes and learned-taste feedback. It has no embedded editor and never submits.
- `TweetHelperTests`: share parsing, App Group transfer, 1+4 envelope mapping, used-outcome payload, activity day reset, and rewrite/undo helper coverage.

Feed-native features (high-intent reply scoring and trend scans) work in the Chrome and iPhone Safari extensions because they need live X DOM access. They are intentionally unavailable in the Share Extension and keyboard.

## Signing and App Group setup

1. Open `TweetHelperMobile.xcodeproj` in Xcode and select your development team for the app and its Keyboard, Share, and Safari extension targets.
2. If the bundle IDs change, use unique IDs for the app, `.Keyboard`, `.Share`, `.Safari`, and `.Tests` products.
3. Enable the same App Group on the app, keyboard, share, and Safari targets. The checked-in identifier is `group.com.djdesai.TweetHelperMobile`; update it consistently in all four entitlements files and `Shared/TweetHelperSettings.swift` if needed.
4. Build the containing app on an iPhone. In its Settings sheet, paste the **same** backend URL that opens `/health` in Safari (your Mac’s Tailscale IP, not the placeholder `100.64.0.1`), plus the optional mobile auth token. Those values are shared through the App Group.
5. On first launch, allow **Local Network** when iOS prompts. If Check connection fails with `[-1004]` while Safari works, open iOS Settings → Tweet Helper → Local Network and turn it on, then retry.
6. In iOS Settings → General → Keyboard → Keyboards, add Tweet Helper and enable Full Access. iOS requires Full Access for a custom keyboard to call the local backend.
7. In the system share sheet, choose Tweet Helper. Use "Edit Actions" if it is not initially visible.
8. In iOS Settings → Apps → Safari → Extensions, enable Tweet Helper and allow access to `x.com`. Sign into `x.com` in Safari, open the page menu, and choose Tweet Helper. Keep its compact sheet open during an automatic feed scroll.

## Backend and privacy

For a Mac reachable over a private Tailscale network:

```bash
HOST=0.0.0.0 PORT=4317 MOBILE_AUTH_TOKEN=<long-random-token> npm run backend:dev
```

The app calls health and generation routes with the same growth fields as the Chrome extension (`audience`, `contentPillar`, `desiredOutcome`) and a 90s request timeout. Responses prefer the native `recommendation` + `explore` envelope (falling back to `suggestions`). Saves, edits, skips, and keyboard inserts enqueue `/api/feedback` events for the learned taste model. Keyboard insertion also enqueues `/api/outcomes` with `status=used`, `platform=ios`, optional `contentKind`, the final text/source pair, a stable per-insertion `clientEventId`, and any available `sessionId`/`workId`. Both queues live in the App Group and retry when the app or keyboard opens, so composing and insertion remain available offline.

The Share Extension accepts only plain text and `http`/`https` URLs. It processes at most twelve attachments, does not scrape the source app, and offers clipboard access only through the explicit Paste Context fallback.

The Safari bundle is generated from the shared TypeScript sources. Rebuild it after extension changes with `npm run extension:safari-build` before building the Xcode project.

## Verification

Unsigned device compilation (does not need provisioning):

```bash
xcodebuild -project TweetHelperMobile.xcodeproj \
  -scheme TweetHelperMobile \
  -destination 'generic/platform=iOS' \
  -derivedDataPath /tmp/TweetHelperDerivedData \
  CODE_SIGNING_ALLOWED=NO build-for-testing
```

Run tests on an installed iOS Simulator runtime or a signed device:

```bash
xcodebuild test -project TweetHelperMobile.xcodeproj \
  -scheme TweetHelperMobile \
  -destination 'platform=iOS Simulator,name=iPhone 16'
```
