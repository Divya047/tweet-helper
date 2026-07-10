# Tweet Helper

Local-first X post, comment, and reaction helper.

The app has two parts:

- A local Fastify backend that stores your writing examples in SQLite and calls Together AI.
- A Chrome Manifest V3 extension that adds drafting and visible-post scoring controls on X.
- An iPhone SwiftUI containing app and custom keyboard scaffold under `apps/ios/TweetHelperMobile`.

V1 never clicks Post, Reply, Like, Follow, or Repost. It only generates, ranks, copies, or inserts drafts that you approve manually.

## Setup

```bash
npm install
cp .env.example .env.local
npm run build
npm run backend:dev
```

Set `TOGETHER_API_KEY` in `.env.local`. The default model is `MiniMaxAI/MiniMax-M3` (toggle **Advanced** in the panel to use `zai-org/GLM-5.2` per request).

Optional `.env.local` values:

```bash
PORT=4317
HOST=127.0.0.1
DB_PATH=./data/tweet-helper.sqlite
DAILY_BUDGET_USD=2
MONTHLY_BUDGET_USD=20
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

## iPhone Keyboard

The iOS scaffold lives in `apps/ios/TweetHelperMobile`. It includes a setup app and a `Tweet Helper` custom keyboard extension.

Recommended personal setup is Tailscale-only:

```bash
HOST=0.0.0.0 PORT=4317 MOBILE_AUTH_TOKEN=<long-random-token> npm run backend:dev
```

On the phone, use `http://<mac-tailscale-ip>:4317` as the backend URL and enter the same token. Open the Xcode project, replace the placeholder bundle IDs/App Group with your Apple developer values, enable the App Group on both targets, run the containing app on the phone, then enable the keyboard in iOS Settings with Allow Full Access.

The keyboard supports `Post`, `Reply`, and `Rewrite`. It inserts text only after you tap a suggestion, uses `documentContextBeforeInput` only for rewrite, and never posts, replies, likes, reposts, scrapes the screen, or calls the X API.

## API

- `POST /api/import/x-archive`
- `POST /api/generate/post`
- `POST /api/generate/comment`
- `POST /api/generate/rewrite`
- `POST /api/score/visible-posts`
- `POST /api/feedback`
- `GET /api/settings`
- `PUT /api/settings`

See [docs/API.md](docs/API.md) for request and response shapes.

## Privacy

Archive zips, parsed examples, SQLite files, logs, `.env*`, and generated style profiles are ignored by git. Keep the GitHub repo private because even prompts and examples can reveal your writing patterns. Do not expose the backend on the public internet; use localhost for Chrome and a private network such as Tailscale for iPhone access.
