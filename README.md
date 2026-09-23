# Moodmusic

Spotify playlists from your mood and your favorite artists. This is V2, a
rewrite of [mood-music](https://github.com/hadrienbbt/mood-music). The plan
and its progress are in [docs/PLAN.md](docs/PLAN.md).

## Development

Requirements: Node 22.12 or newer; for the Firestore emulator, the Firebase
CLI (`npm install -g firebase-tools`) and Java 21 or newer.

```sh
npm ci && (cd app && npm ci)
npm test                 # all tests; those needing Firestore are skipped
npm run test:emulator    # the same inside the Firestore emulator
npm run build            # builds the web app into app/dist
```

To run it locally, put `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` in
`.env`, start the emulator with
`firebase emulators:start --only firestore --project demo-moodmusic`, then run
`npm run dev` (server on http://127.0.0.1:8004) and `npm run dev` in `app/`
(web app on http://127.0.0.1:5173, which proxies `/api` and `/auth` to the
server). The configuration variables are listed in §4.9 of the plan.
