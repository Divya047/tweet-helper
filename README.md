# Tweet Helper

Local-first X post, comment, and reaction helper.

The app has two parts:

- A local Fastify backend that stores your writing examples in SQLite and invokes the Codex CLI.
- A Chrome Manifest V3 extension that adds drafting and visible-post scoring controls on X.
- An iPhone SwiftUI app with a compact Safari feed scanner, Share Extension, and custom keyboard under `apps/ios/TweetHelperMobile`.

V1 never clicks Post, Reply, Like, Follow, or Repost. It only generates, ranks, copies, or inserts drafts that you approve manually.

## Setup

```bash
npm install
codex login
cp .env.example .env.local
npm run build
npm run backend:dev
```

`codex login` must report **Logged in using ChatGPT**. Every AI-backed flow runs an isolated, read-only, ephemeral Codex CLI task with `gpt-5.6-luna`, so no API key is required. Check the active authentication method with `codex login status`.

Optional `.env.local` values:

```bash
PORT=4317
HOST=127.0.0.1
DB_PATH=./data/tweet-helper.sqlite
CODEX_CLI_PATH=codex
MOBILE_AUTH_TOKEN=
```

Set `MOBILE_AUTH_TOKEN` to a long random value when exposing the backend to your phone over a private network. When set, generation, feedback, and settings endpoints require `Authorization: Bearer <token>`.

The backend creates the SQLite database automatically at `DB_PATH` on first start.

## First Run

1. Start the backend and leave it running:

   ```bash
   npm run backend:dev
   ```

   The API should be available at `http://127.0.0.1:4317`.

2. Import your X archive so the app can build a local writing profile:

   ```bash
   curl -X POST http://127.0.0.1:4317/api/import/x-archive \
     -H "Content-Type: application/json" \
     -d '{"archivePath":"/absolute/path/to/twitter-archive.zip"}'
   ```

   You can also pass the text from an archive `tweets.js` file:

   ```bash
   curl -X POST http://127.0.0.1:4317/api/import/x-archive \
     -H "Content-Type: application/json" \
     -d '{"tweetsJsText":"window.YTD.tweets.part0 = [...]"}'
   ```

3. Build the extension:

   ```bash
   npm run extension:build
   ```

4. Load the extension in Chrome:

   - Open `chrome://extensions`
   - Enable **Developer mode**
   - Click **Load unpacked**
   - Select `apps/extension/dist`

5. Open `https://x.com` or `https://twitter.com`. A **Tweet Helper** panel appears in the bottom-right corner.

   - Use **Draft post** with a topic or rough draft.
   - Use **Draft reply** while focused in a reply composer, or paste the source post/angle into the helper panel.
   - Use **Scan visible posts** to score posts currently visible in the viewport.
   - Use **Select**, then **Insert selected** or **Copy selected**.
   - Use **Good** or **Skip** to save feedback for future personalization.

If you rebuild the extension, go back to `chrome://extensions` and click reload on Tweet Helper before using the updated code.

## Chrome Extension

Build the extension:

```bash
npm run extension:build
```

Then load `apps/extension/dist` as an unpacked extension in Chrome.

The shared Chrome and Safari panel now includes:

- Configurable reply scans with depth, overlap, render timing, author exclusions, blocked terms, and optional engagement-bait inclusion.
- A saved scan funnel showing collected, filtered, scored, eligible, abstained, and queued counts.
- Queue search, post/reply filters, favorites, tags, planned dates, duplicate warnings, sorting, copy, bulk removal, and local templates.
- One-click reply adaptation for the currently open reply composer, plus concise, technical, pushback, question, warm, and learned-taste rewrite presets.
- Local draft checks for length, generic praise, engagement-only questions, absolute or numeric claims, excess hashtags, and duplicate copy.
- Numbered thread splitting for posts over 280 characters.
- Up to twelve local profiles. Each profile keeps separate queues, activity, growth preferences, scan controls, templates, and scan history.
- JSON backup and restore for the current profile. Tweet Helper still never submits to X.

## iPhone Safari Scanner and Keyboard

The iOS project lives in `apps/ios/TweetHelperMobile`. It includes a setup app, compact Safari Web Extension, Share Extension, and custom keyboard.

Recommended personal setup is Tailscale-only:

```bash
HOST=0.0.0.0 PORT=4317 MOBILE_AUTH_TOKEN=<long-random-token> npm run backend:dev
```

On the phone, use `http://<mac-tailscale-ip>:4317` as the backend URL and enter the same token. Run `npm run extension:safari-build`, open the Xcode project, confirm signing and the shared App Group on every target, and run the containing app on the phone. Enable Tweet Helper under iOS Settings → Apps → Safari → Extensions with access to `x.com`; enable the keyboard separately with Allow Full Access.

In Safari on `x.com`, the compact popup exposes Today, Queue, Find 8 high-intent replies, and feed-trend ideas while the shared content script handles composer detection and insertion. A queued reply can be inserted into any open reply composer. Backend requests travel through the native extension handler to the App Group’s Tailscale URL. The keyboard remains available for inserting or rewriting text in the native X app. Nothing submits automatically or calls the X API.

## API

- `POST /api/import/x-archive`
- `POST /api/generate/post`
- `POST /api/generate/comment`
- `POST /api/generate/rewrite`
- `POST /api/score/visible-posts`
- `POST /api/feedback`
- `GET /api/taste-profile`
- `GET /api/settings`
- `PUT /api/settings`

See [docs/API.md](docs/API.md) for request and response shapes.

## Privacy

Archive zips, parsed examples, SQLite files, logs, `.env*`, and generated style profiles are ignored by git. Keep the GitHub repo private because even prompts and examples can reveal your writing patterns. Do not expose the backend on the public internet; use localhost for Chrome and a private network such as Tailscale for iPhone access.
