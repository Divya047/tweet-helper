# Tweet Helper for iPhone

The iOS workspace contains a full-screen SwiftUI composer, a Share Extension, a custom keyboard, and XCTest coverage. Every surface drafts or inserts text only. Nothing submits to X.

## Targets

- `TweetHelperMobile`: enter a brief or reply context with the normal iOS keyboard, generate and edit drafts, review the saved queue, and configure the backend.
- `TweetHelperShare`: share text or a web URL from Chrome, X, or another app; review the recommended reply, explore alternatives, and save one to the App Group. If an app shares no usable content, `Paste Context` reads the clipboard once after a tap.
- `TweetHelperKeyboard`: large `Insert saved draft`, `Rewrite current`, `Undo`, and `Globe` actions. It has no embedded editor and never submits.
- `TweetHelperTests`: share parsing, App Group transfer, API decoding, used-outcome payload, and rewrite/undo helper coverage.

## Signing and App Group setup

1. Open `TweetHelperMobile.xcodeproj` in Xcode and select your development team for all four targets.
2. If the bundle IDs change, use unique IDs for the app, `.Keyboard`, `.Share`, and `.Tests` products.
3. Enable the same App Group on the app, keyboard, and share targets. The checked-in identifier is `group.com.djdesai.TweetHelperMobile`; update it consistently in all three entitlements files and `Shared/TweetHelperSettings.swift` if needed.
4. Build the containing app on an iPhone. In its Settings sheet, save the backend URL and optional mobile auth token. Those values are shared through the App Group.
5. In iOS Settings → General → Keyboard → Keyboards, add Tweet Helper and enable Full Access. iOS requires Full Access for a custom keyboard to call the local backend.
6. In the system share sheet, choose Tweet Helper. Use “Edit Actions” if it is not initially visible.

## Backend and privacy

For a Mac reachable over a private Tailscale network:

```bash
HOST=0.0.0.0 PORT=4317 MOBILE_AUTH_TOKEN=<long-random-token> npm run backend:dev
```

The app calls health and generation routes. When the keyboard inserts a saved draft it also posts to `/api/outcomes` with `status=used`, `platform=ios`, the final text/source pair, a stable per-insertion `clientEventId`, and any available `sessionId`/`workId`. Insertion succeeds even if that telemetry call is offline, with a visible sync error.

The Share Extension accepts only plain text and `http`/`https` URLs. It processes at most twelve attachments, does not scrape the source app, and offers clipboard access only through the explicit Paste Context fallback.

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
