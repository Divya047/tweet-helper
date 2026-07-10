# Tweet Helper Mobile

iPhone-first Tweet Helper containing app plus custom keyboard extension.

## Local Setup

1. Open `TweetHelperMobile.xcodeproj` in Xcode.
2. Change both bundle identifiers from `com.example.TweetHelperMobile*` to identifiers under your Apple developer team.
3. Change the App Group in:
   - `Shared/TweetHelperSettings.swift`
   - `TweetHelperMobile/TweetHelperMobile.entitlements`
   - `TweetHelperKeyboard/TweetHelperKeyboard.entitlements`
4. Enable the same App Group for both targets in Xcode Signing & Capabilities.
5. Run the containing app on your iPhone.
6. Enter your backend URL, usually `http://<mac-tailscale-ip>:4317`, plus `MOBILE_AUTH_TOKEN` if configured.
7. In iOS Settings, add the `Tweet Helper` keyboard and enable Allow Full Access.

## Backend

For iPhone access over Tailscale, run the backend with:

```bash
HOST=0.0.0.0 PORT=4317 MOBILE_AUTH_TOKEN=<long-random-token> npm run backend:dev
```

Keep the backend on your private Tailscale network. Do not expose it directly to the public internet.

## Keyboard Behavior

- `Post` drafts from text typed into the keyboard.
- `Reply` drafts only from source/context manually entered in the keyboard.
- `Rewrite` reads `textDocumentProxy.documentContextBeforeInput`, asks for rewrite options, then requires a tap on `Replace Draft` or `Insert After`.
- The keyboard never posts, replies, likes, reposts, follows, scrapes the screen, or calls the X API.

The keyboard requires Full Access because iOS blocks network calls from custom keyboards unless `RequestsOpenAccess` is enabled and the user allows full access.
