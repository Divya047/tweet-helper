# Tweet Helper

Local-first X post, comment, and reaction helper.

The app has two parts:

- A local Fastify backend that stores your writing examples in SQLite and calls Together AI.
- A Chrome Manifest V3 extension that adds drafting and visible-post scoring controls on X.

V1 never clicks Post, Reply, Like, Follow, or Repost. It only generates, ranks, copies, or inserts drafts that you approve manually.

## Setup

```bash
npm install
cp .env.example .env.local
npm run build
npm run backend:dev
```

Set `TOGETHER_API_KEY` in `.env.local`. The default model is `zai-org/GLM-5.2`.

## Chrome Extension

Build the extension:

```bash
npm run extension:build
```

Then load `apps/extension/dist` as an unpacked extension in Chrome.

## API

- `POST /api/import/x-archive`
- `POST /api/generate/post`
- `POST /api/generate/comment`
- `POST /api/score/visible-posts`
- `POST /api/feedback`
- `GET /api/settings`
- `PUT /api/settings`

See [docs/API.md](docs/API.md) for request and response shapes.

## Privacy

Archive zips, parsed examples, SQLite files, logs, `.env*`, and generated style profiles are ignored by git. Keep the GitHub repo private because even prompts and examples can reveal your writing patterns.
