# Moodmusic V2 — analysis and implementation plan

Revision 4, 2026-09-23. Written from a full read of the V1 code, the live V1
site, the V1 git history, the Spotify developer documentation as of today and
live tests of the ReccoBeats API, then updated with Hadrien's decisions and
the step 0 answers from the Spotify dashboard (§6) and Spotify's own guidance
for API apps (§3.5, appendix K). It is meant to be executed step by step by
another model, one pull request per step, without needing the conversation
that produced it. Copy it to `docs/PLAN.md` of the new repository in step 0
and keep the status table of §7 up to date.

V1 (this repository, `web/`) keeps running untouched until V2 is released.

---

## 0. Decisions (read this first)

| Topic | Decision | Why |
|---|---|---|
| Where V2 lives | A **new public GitHub repository** (suggested name `moodmusic`; `mood-music` stays as V1). V1 is never modified. | The Pi pulls this repo's `master` at every V1 restart, V1 has no lock file, and the repo carries dead Cordova/React Native/iOS folders plus committed database dumps. A clean repo gives a clean Dependabot baseline and zero risk to V1. Public because the Pi service pulls over HTTPS without credentials (it runs as root and has no access to pi's SSH key); the repo will contain no secret. |
| Spotify app | **Reuse the V1 client ID.** The dashboard shows it is in **Development Mode** (checked 2026-09-23): owner has Premium, an allow-list exists with one user, so the **5-user cap and every Development Mode rule of §3.1 are firm constraints** of V2. Add the V2 redirect URIs, remove the stale `http://pi.local:8080/callback`, keep `https://moodmusic.fedutia.fr/callback` until V1 is retired. | A new app would be in Development Mode too, with nothing gained. |
| Client secret | **Rotate it** in the dashboard during step 0 (coordinated with a V1 `.env` update and restart). | The real client ID and secret were committed in early V1 history. Rotation is the only fix; the client ID itself is public by design. |
| Recommendation engine | **ReccoBeats is the default engine** (§4.7, appendix J): the values computed by the core algorithm go to ReccoBeats' recommendation endpoint with the same `valence`/`energy`/`danceability` targets, seeded by one track per chosen artist, and the result becomes a Spotify playlist through `POST /v1/me/playlists` + `POST /v1/playlists/{id}/items`. The **Spotify engine** (`/v1/recommendations`, V1's request to the letter) is kept only as the V1 reference behind the `RECOMMENDER` switch; it cannot work for this app and there is **no runtime probe**. | `/v1/recommendations`, `/v1/audio-features` and `/v1/artists/{id}/top-tracks` are unavailable to Development Mode apps. ReccoBeats is free, accepts Spotify ids, and was tested today (§3.4). |
| Spotify rules | Follow Spotify's own guidance for API apps (§3.5, appendix K): the OpenAPI spec is the source of truth for endpoints and fields, Authorization Code flow with a secure backend, HTTPS or `127.0.0.1` redirect URIs, minimal scopes, tokens stored server-side and refreshed, exponential backoff honouring `Retry-After`, no deprecated endpoints (`/playlists/{id}/items`, not `/tracks`), meaningful error feedback, Developer Terms (no caching beyond immediate use, attribution to Spotify, no machine-learning training). | Required by Spotify; several V1 findings violated them. |
| Auth design | Server-side **Authorization Code flow with `state`**; tokens live only in a server-side session; the browser gets an `httpOnly; Secure; SameSite=Lax` cookie. Nothing token-like ever appears in a URL, a fragment or a page. | Fixes V1's `/#access_token=…` redirect and the open `/refresh_token` endpoint. Spotify's guidance accepts this flow when the app has a secure backend; PKCE is for apps without one. |
| Data store | **Firestore** in a **new Firebase project**, `firebase-admin` modular API, deny-all rules, Firestore emulator in tests. No MongoDB. **No data migrated from V1**: V2 starts empty; each user re-imports their top artists at first login (V1's own first-login flow). | Same stack as frek-backend and secret-santa, no database process on the Pi, free tier is plenty. |
| Core algorithm | Extracted into a pure module (`server/core/`) with golden tests written from the V1 spec (§1.5), with the deliberate deviations of §4.6.1 (serene valence direction fixed, two V1 bugs not reproduced). | This is what must survive. |
| Product defaults | Mood screen starts with **no mood selected** (V1: all eight). New playlists are **private by default** with a switch to make them public (V1: public). | Hadrien's decisions. |
| Stack | Node ≥ 22.12, native ESM JavaScript (no Babel, no TypeScript), Express 5, `express-session` with a small Firestore store, Vite 8 + React 19 SPA, `node --test`. | Identical conventions to the two repos just migrated; the Pi already runs Node 22.23 via nvm. |
| UI | Mobile-first React SPA, French copy kept from V1, emojis + sliders, PWA manifest, Spotify attribution. Dropped: jQuery, Handlebars, Bootstrap 3, Ratchet, bootstrap-slider, Affectiva webcam, Facebook login, Google Analytics, weather, lyrics, e-mailed API codes, Cordova, React Native, iOS. | All dead or unrelated to the core. |
| Deployment | New systemd service `moodmusic-v2` on the Pi (port 8004 unless taken), Apache vhost `moodmusic-v2.fedutia.fr` for the beta (the wildcard certificate covers it), then the vhost for `moodmusic.fedutia.fr` is pointed at V2 and the V1 service is disabled. | Same pattern as frek/secret-santa; V1 and V2 run side by side until cutover. |

---

## 1. V1 as it is

### 1.1 Repository layout

```
mood-music/                      GitHub hadrienbbt/mood-music, default branch master, public
├── .gitignore                   ignores .env, lib/, node_modules, package-lock.json, yarn.lock
├── .idea/                       IDE files (committed)
├── ios/Rhapsody/                empty Swift app (2018), nothing in it
└── web/
    ├── package.json             express ~4.0.0, request ~2.34.0, nodemailer ^3.0.2, mongodb ^3.0.0,
    │                            express-session, cookie-parser 1.3.2, body-parser, lyric-get, dotenv,
    │                            querystring, core-js; build "babel src -d lib"; start "npm run build && node lib/app.js"
    ├── src/app.js               the whole server, 1301 lines, CommonJS, callbacks
    ├── src/js/response.js       monkey-patches http.ServerResponse.prototype.respond
    ├── src/js/tests_Spotify.js  scratch file
    ├── src/public/              the web client: index.html (Handlebars templates inline),
    │   ├── js/index.js          bootstrap: reads access_token from location.hash
    │   ├── js/functionMoodMusic.js  calibration, artists, mood sliders, playlist button
    │   ├── js/functionsSpotify.js   direct browser→Spotify calls with the token from the hash
    │   ├── js/functionsAffectiva.js webcam emotion detection (Affectiva SDK)
    │   ├── js/functionsFacebook.js, init_facebook.js  Facebook login (commented out in HTML)
    │   ├── js/render.js, cookies.js, bootstrap-slider.min.js
    │   ├── js/class/RecommendationRequest.js, IdRequest.js, User.js   used by the server
    │   └── css/, img/           img/ holds the logos and icons to reuse
    ├── moodmusic/               Cordova wrapper with a slightly older copy of public/
    ├── moodmusic_rn/            React Native 0.53 app: login + "get my top artists", nothing more
    ├── PC.html, script_mood.sh  scratch; script_mood.sh = mongo inserts of an early mood table
    ├── backup/                  bson dumps of the 2017 database (user, artist, mood, playlist)
    └── db/                      23 MB of raw WiredTiger MongoDB files (2018), committed
```

There is no README, no test, no CI, no lock file. Every `npm install` on the Pi
resolves dependencies fresh.

### 1.2 Runtime

- Environment: `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI`
  (default `http://localhost:8888/callback`; on the Pi `https://moodmusic.fedutia.fr/callback`),
  `PORT` (8888), `MONGO_URI`, `PUBLIC_DIR`, `NODE_ENV`, `SSL_CERT`, `SSL_KEY`
  (https when `NODE_ENV` is not development). Read from `web/.env` (not in
  the repo; it exists on the Pi).
- Hard-coded: session secret `'ssshhhhh'`, Gmail `'YOUR_EMAIL'/'YOUR_PASSWORD'`
  placeholders for nodemailer, `key_weather = 'YOUR_KEY_WEATHER'`, CORS `*`.
- Live: `https://moodmusic.fedutia.fr/` (Apache 2.4 → Express, HSTS). The
  `/getMoods`, `/api/playlist/count` and `/api/playlist/all` endpoints answer
  without authentication. The live database holds 23 playlists, all created in
  2024 (first 2024-01-30, last 2024-11-22).
- Spotify scopes requested: `user-read-private user-read-email user-top-read
  playlist-modify-public playlist-modify-private`.

### 1.3 Data model (MongoDB, database `moodmusic`)

| Collection | Document |
|---|---|
| `user` | `_id` = Spotify user id, `name`, `email`, `lien_profil`, `refresh_token`, `tabArtistesPref: [{ id, name, images[], mood_related: [state…], valence?, activation?, danceability? }]` |
| `artist` | `_id` = Spotify artist id, `name`, `popularity`, `genres` (global catalogue, only written) |
| `mood` | the 8 moods, see appendix B |
| `playlist` | `_id` = Spotify playlist id, `name`, `id_user`, `time`, `tunetables`, `artists` (names), `mood` (csv of states) |
| `api_connect_tmp` | 4-digit e-mail codes for the React Native app |

### 1.4 User flow

1. `/login` → Spotify authorize (state in a plain cookie) → `/callback`
   exchanges the code with the client secret, stores `access_token` in the
   Express session, upserts the user (with `refresh_token` and `email`), and on
   first login imports `GET /v1/me/top/artists?limit=15` into
   `tabArtistesPref` with empty moods. Then **redirects to
   `/#access_token=…&refresh_token=…&user_exists=…`**.
2. The browser reads the tokens from the hash, calls `GET /v1/me` itself and:
   - first login with imported artists → *calibration*: one screen per artist,
     tap the emojis that describe the artist, "Valider" or "Je n'aime pas cet
     artiste" (removes it);
   - first login without artists → *manual calibration*: type 5 artist names,
     tag each;
   - returning user → *artists screen*.
3. Artists screen ("Artistes favoris"): add by name (Spotify search, first
   result; "L'artiste n'existe pas 🙁" / "L'artiste existe déjà 😁"), remove
   (×), toggle emojis per artist. Every toggle calls `/addMoodToArtist` then
   `/calculerTunetables` (§1.5.2).
4. Mood screen ("Créer une playlist"): "Comment te sens-tu ?", the 8 emojis
   each with a slider (default 0.55). All moods start selected in V1; the
   user taps to deselect. Optional name "Un petit nom ?" (cut to 25
   characters). The button computes the target (§1.5.1 in the browser) and
   calls `/getArtistsFromMood` (§1.5.3) which chains server-side redirects
   `/moodmusic` → `/create_playlist` → `/addTracksToPlaylist` and finally
   returns the playlist object; the browser navigates to
   `external_urls.spotify`.

### 1.5 The core algorithm — the contract for V2

Everything below is V1's exact behaviour. V2 reproduces it except for the
deviations listed in §4.6.1.

#### 1.5.1 Target "tunetables" from the selected moods (V1: `processTunetables`, browser)

Input: the selected moods, each with a slider value `x` (0 to 1; the slider
widget allows up to 1.1 but clamps to 1 on release; a value of exactly 0
deselects the mood). Each mood defines functions of `x`:

| state | emoji | stateFR | ordre | energy(x) | valence(x) | danceability(x) |
|---|---|---|---|---|---|---|
| dance | 💃 | dansant | 1 | – | – | x |
| excited | 😜 | excité | 2 | 0.625 + 0.375x | 0.625 + 0.375x | – |
| happy | 😃 | heureux | 2.5 | 0.375 + 0.25x | 0.5 + 0.5x | – |
| serene | 🙂 | calme | 3 | 0.375 − 0.25x | 0.625 − 0.375x (**V1**; V2 uses 0.625 + 0.375x, see §4.6.1) | – |
| tired | 😴 | fatigué | 4 | 0.375(1 − x) | 0.75 − 0.5x | – |
| nostalgic | 🙄 | nostalgie | 4.5 | 0.375(1 + x) | 0.5 − 0.25x | – |
| sad | 😢 | triste | 5 | 0.25 + 0.5x | 0.25(1 − x) | – |
| upset | 😡 | énervé | 6 | 0.75 + 0.25x | 0.5(1 − x) | – |

Target = per key (`valence`, `energy`, `danceability`), the **arithmetic mean
of the values produced by the selected moods that define that key**, rounded
to 4 decimals; a key with no contributing mood is absent. Example: excited at
0.55 and sad at 0.55 → valence = ((0.625+0.20625) + (0.25·0.45)) / 2 = 0.471875
→ 0.4719; energy = (0.83125 + 0.525) / 2 = 0.6781.

V1 evaluated the formulas with `eval()` on strings stored in MongoDB; V2 uses
plain functions in a shared module. V1 only produced `danceability` correctly
because "dance" is first in display order (an indexing quirk with
`nbSliders`); the definition above is the intended behaviour.

#### 1.5.2 Artist profile from its tagged moods (V1: `/calculerTunetables`, server)

Each mood also has a fixed base point used to profile artists:

| state | valence | activation | danceability |
|---|---|---|---|
| excited | 0.8125 | 0.8125 | |
| happy | 0.75 | 0.5 | |
| serene | 0.8125 | 0.3125 | |
| tired | 0.4375 | 0.3125 | |
| nostalgic | 0.375 | 0.5625 | |
| sad | 0.125 | 0.5 | |
| upset | 0.25 | 0.875 | |
| dance | – | – | 0.5 |

For an artist tagged with a set of moods:
- `valence` = mean of the base valence of its moods **other than dance**;
  `activation` likewise; both absent if there is no non-dance mood.
- `danceability` = 0.5 if "dance" is among the moods, absent otherwise (it is
  stored but never used for matching).
- No mood at all → no profile (the artist is ignored when matching).

#### 1.5.3 Choosing the seed artists (V1: `/getArtistsFromMood`, server)

Input: target `(v, e)` = `(valence, energy)` from §1.5.1, the user's artists in
stored order (manually added artists are inserted at the front, imported top
artists keep Spotify's order), each with an optional profile `(valence,
activation)`.

```
gap(a) = |v − a.valence| + |e − a.activation|          (Manhattan distance)
candidates = artists that have a profile, sorted by gap ascending (stable: ties keep stored order)
if the user has no artists at all → error "Pas d'artiste représentant cette émotion. Ajoutez d'abord des artistes et choisissez des émotions."
if candidates is empty            → error "Pas assez d'émotions sélectionnées. Ajoutez d'abord des émotions aux artistes."
chosen = [candidates[0]]                                (always kept, even if gap > 0.5)
for a in candidates[1..]:
    stop if chosen.length == 5
    stop if gap(last chosen) >= 0.5
    if gap(a) > 0.5: stop                              (V1 pushes it then pops it)
    chosen.push(a)
seeds = chosen ids (1 to 5)
```

V1 implements this as a `do … while (gap < 0.5 && chosen.length < 5)` loop
that re-scans the remaining artists each time; when it runs out of profiled
artists it re-pushes the previous best and then pops it, so the net result is
the list above. V1 also skips artists whose valence is exactly 0 (a JavaScript
truthiness bug); V2 must not. The golden tests in step 2 encode these cases.

#### 1.5.4 Tracks and playlist (V1: `RecommendationRequest`, `/create_playlist`, `/addTracksToPlaylist`)

1. `GET https://api.spotify.com/v1/recommendations?seed_artists=<ids>&limit=30&target_valence=<v>&target_energy=<e>[&target_danceability=<d>]`
   (only the keys present in the target are sent).
2. `POST /v1/users/{userId}/playlists` with `{ "name": "[Moodmusic] <name>" }`
   where `<name>` is the user's text cut to 25 characters, or the
   comma-separated list of selected mood states (table order) when empty.
   Visibility is Spotify's default (public).
3. `POST /v1/users/{userId}/playlists/{playlistId}/tracks` with
   `{ "uris": [track.uri …] }` in the order returned by step 1.
4. Save `{ name, id_user, time, tunetables, artists: [names], mood: "excited,sad" }`.
5. Return the playlist object; the browser opens `external_urls.spotify`.

#### 1.5.5 Onboarding rules worth keeping

- First login imports the user's top 15 artists (`GET /v1/me/top/artists?limit=15`,
  default `time_range=medium_term`) with `name`, `id`, `images`.
- Manual calibration asks for 5 artists (`minArtistes = 5`).
- Adding an artist by name = `GET /v1/search?q=<name>&type=artist&limit=1`,
  first item; duplicates by id are rejected.

### 1.6 Everything else in V1 and its fate

| Feature | V1 state | V2 |
|---|---|---|
| Affectiva webcam mood detection (`functionsAffectiva.js`, SDK from download.affectiva.com) | Hidden behind a hidden "camera" template; the SDK is discontinued (Affectiva was acquired by Smart Eye) though the CDN file still answers | Dropped. Could return later as an optional feature using MediaPipe face landmarks; out of scope. |
| Facebook login / liked artists | Commented out in `index.html` | Dropped |
| Weather (`/user`, Weather Underground) | API shut down years ago, key placeholder | Dropped |
| Lyrics (`/getLyrics`, `lyric-get` scraping) | Unused by the UI flow | Dropped |
| REST API for the React Native app (`/api/authorization_code`, `/api/authorize`, e-mail codes via Gmail) | Only client was the abandoned RN app | Dropped (removes nodemailer: 14 alerts) |
| Stats endpoints (`/api/playlist/*`, `/api/user/:id/*`, `/api/artist/*`) | Public, no auth, leak user ids | Dropped; a private "my playlists" history replaces `/api/user/:id/info-playlists` |
| Test/dev screens (`rechercheSpotify` template, genre seeds, "Obtain new token") | Rendered but hidden | Dropped |
| Cordova app, React Native app, iOS project | Abandoned (2018) | Not migrated; V2 is a responsive PWA |
| Google Analytics `UA-89932436-1` | Universal Analytics stopped in 2023 | Dropped (no analytics) |

---

## 2. V1 audit — why V2 is a rewrite

Decision (§6): V1 stays exactly as it is until the cutover of step 10. The
findings below therefore stay live until then, which is a reason to keep the
beta short.

### 2.1 Security findings in V1 (as deployed today)

| # | Finding | Where |
|---|---|---|
| S1 | Access and refresh tokens are sent to the browser in the URL fragment (`/#access_token=…`), rendered into the hidden "oauth" template, and used from `location.hash` on every Spotify call. They end up in browser history and in any script on the page. | `app.js` `/callback`, `public/js/index.js`, `functionsSpotify.js` |
| S2 | **No authorization at all**: every endpoint takes the Spotify user id as a query parameter (`?user=<id>`) and trusts it. Anyone can read or modify anyone's artists and moods. | all `app.get` routes |
| S3 | `/getCurrentUserInfos?user=<id>` very likely returns the **whole user document including `refresh_token` and `email`**: it calls `find(query, { _id: 0, tabArtistesPref: 1 })`, but the MongoDB 3.x driver ignores a projection passed as the second argument (it must be `{ projection: … }`). The client only reads `tabArtistesPref`, so nobody noticed. (Can be confirmed with your own user id; not required.) | `app.js:265` |
| S4 | `/refresh_token?refresh_token=<any>` mints an access token for **any** refresh token using the app's secret, without authentication: an open token oracle. Combined with S3 and `/api/playlist/all` (lists user ids), any V1 user who logged in during the last 6 months can be impersonated on Spotify. | `app.js:273` |
| S5 | All state-changing operations are `GET` requests with no CSRF protection, and `Access-Control-Allow-Origin: *`. | middleware |
| S6 | Session secret hard-coded (`'ssshhhhh'`), default in-memory session store. | middleware |
| S7 | The **real Spotify client id and client secret, and a Weather Underground key, were committed** in early V1 history (`app.js`, later replaced by `YOUR_…` placeholders). The client secret must be rotated. | `git log -p -- web/src/app.js` |
| S8 | **Personal data committed**: `web/backup/` (bson, 42 users of 2017: name, e-mail, refresh token, artists) and `web/db/` (23 MB WiredTiger files, 2018). Public since then. | repository |
| S9 | Third-party scripts loaded from CDNs without integrity (Handlebars alpha, Affectiva, jQuery 1.12), inline templates → XSS surface with tokens in page context (S1). | `index.html` |
| S10 | `x-powered-by` exposed; errors `throw` inside callbacks (crashes the process on any database error). | everywhere |

### 2.2 Dependencies

25 open Dependabot alerts: `web/package.json` → nodemailer 14 (1 critical, 3
high; fixed ≥ 9.1.1), express 3 (fixed ≥ 4.5.0 but 4.x is end-of-life for
this code), request 2 (deprecated since 2020, no fix); plus stale alerts for
manifests that no longer exist on `master` (`package.json` with socket.io,
`moodmusic_rn/package.json` with firebase) and `web/moodmusic_rn/package.json`
(firebase, fixed ≥ 10.9.0). `mongodb ^3` and `express-session` old, Babel 6
build. None of it survives in V2; the alerts disappear when the V1 repository
is archived (step 10).

### 2.3 Platform breakage (confirmed by the dashboard on 2026-09-23)

The V1 Spotify app is in Development Mode. Therefore V1 has been unable to
create playlists since 2024-11-27 (`/v1/recommendations` answers 404 for such
apps), lost `/v1/artists/{id}/top-tracks` and the `email` field on
2026-03-09, and only the one allow-listed account can log in. The last
playlist in the live database dates from 2024-11-22, five days before the
first of those changes.

---

## 3. Spotify platform constraints, verified 2026-09-23

Sources: Spotify developer blog posts of 2021-05-27, 2024-11-27, 2025-04-15,
2026-02-06, 2026-06-18; the "February 2026 Web API Dev Mode Changes —
Migration Guide"; the "Quota modes" and "Redirect URI" concept pages; the
app's dashboard page (Hadrien, step 0).

### 3.1 Development Mode: the firm rules V2 is built under

The app is in Development Mode and cannot leave it: since 2025-05-15 Extended
Quota Mode is only granted to registered organisations with ≥ 250 000 monthly
active users. Everything below is therefore a hard constraint, not a
contingency.

| Rule | Consequence for V2 |
|---|---|
| **At most 5 authorised users**, each added by Hadrien to the dashboard allow-list (currently 1). Since the app's list already exists, it is **not** grandfathered to more. | V2 is a personal app for Hadrien and up to four people. A user who is not on the list gets a `403` from the API after login; V2 shows a dedicated page (§4.5). No user-facing sign-up. |
| **The owner must keep Spotify Premium**; if it lapses the app stops working. | Documented in `docs/DEPLOY.md` as an operational dependency. |
| `/v1/recommendations`, `/v1/audio-features`, `/v1/audio-analysis`, `/v1/artists/{id}/related-artists` unavailable since 2024-11-27 | ReccoBeats is the engine (§4.7). |
| Removed on 2026-03-09: `GET /v1/artists/{id}/top-tracks`, batch `GET /v1/artists|tracks|albums`, `GET /v1/users/{id}`, `GET/POST /v1/users/{id}/playlists`, `/v1/browse/*`, `/v1/markets`, entity-specific library endpoints | Not used. Playlists are created with `POST /v1/me/playlists`, items added with `POST /v1/playlists/{id}/items`. |
| `GET /v1/search`: `limit` at most 10 (default 5) | V2 sends `limit=1` for artist search; never more than 10 anywhere. |
| Fields removed: track `popularity`, `available_markets`, `external_ids`, `preview_url` (new apps); artist `followers`, `popularity`; `GET /v1/me` without `email`, `country`, `product`, `followers`, `explicit_content` | V2 reads none of them; `market=from_token` replaces `country`. |
| Shared per-account quota; `429` with `"reason": "QUOTA_EXCEEDED"` and `Retry-After` | Backoff of appendix I; Spotify calls per playlist creation are exactly two (create, add items). |
| Refresh tokens expire **180 days** after the user's authorisation (dashboard shows "180 days"; the 2026-06-18 policy) | `invalid_grant` → session destroyed, user logs in again (§4.3). |
| Redirect URIs: exact match, HTTPS or `http://127.0.0.1:PORT`; `localhost` refused | Registered set in §3.5. The stale `http://pi.local:8080/callback` is removed in step 0. |

### 3.2 Endpoints V2 uses (all available in Development Mode)

| Endpoint | Use | Notes |
|---|---|---|
| `GET /v1/me` | login: id, display name, images | no `email`/`country` |
| `GET /v1/me/top/artists?limit=15` | first-login import, "Réimporter" | scope `user-top-read` |
| `GET /v1/search?q=<name>&type=artist&limit=1` | add an artist by name | `limit` ≤ 10 |
| `GET /v1/artists/{id}` | weekly refresh of name/image (§4.4) | one artist per call |
| `POST /v1/me/playlists` | create the playlist | body `{ name, public }` |
| `POST /v1/playlists/{id}/items` | add tracks | body `{ uris }`, ≤ 100 per call |
| `GET /v1/me/playlists` | probe/smoke only | |

Kept in code but unusable for this app: `GET /v1/recommendations` (the V1
reference engine, §4.7).

### 3.3 Tokens

- Access tokens last 1 hour; refresh with `grant_type=refresh_token` and
  Basic auth `client_id:client_secret`. The response may omit a new refresh
  token; keep the old one when it does.
- Refresh tokens expire 180 days after the original authorisation; the token
  endpoint then answers `400 {"error":"invalid_grant"}`: discard the stored
  token, do not retry, send the user through login again.

### 3.4 ReccoBeats — the default engine (tested 2026-09-23, https://api.reccobeats.com, no key, JSON)

| Call | Verified behaviour |
|---|---|
| `GET /v1/track?ids=<spotify or reccobeats ids, comma-separated>` | 200 `{ content: [ { id (uuid), trackTitle, artists: [{ id, name, href: "https://open.spotify.com/artist/<spotifyId>" }], durationMs, isrc, href: "https://open.spotify.com/track/<spotifyId>", availableCountries: "AR,AU,…", popularity } ] }`; unknown ids simply missing from `content` |
| `GET /v1/audio-features?ids=<spotify ids>` | 200, per track: `acousticness, danceability, energy, instrumentalness, key, liveness, loudness, mode, speechiness, tempo, valence` + `href` with the Spotify id (batch size limit undocumented: send ≤ 40 ids, halve on 400) |
| `GET /v1/track/recommendation?size=1..100&seeds=<1..5 track ids (Spotify or ReccoBeats)>&valence=&energy=&danceability=&…&negativeSeeds=&featureWeight=1..5` | 200, same track objects as above (Spotify id in `href`); 400 `"seeds need at least one track"` when no seed is known. `featureWeight` "scales the influence of audio feature queries" |
| `GET /v1/artist?ids=<spotify artist ids>` | 200 `{ content: [ { id (uuid), name, href } ] }`; unknown ids missing |
| `GET /v1/artist/{reccobeatsArtistId}/track?size=N` | 200 the artist's tracks (a Spotify id here is a 404: resolve it first); maximum `size` to verify in step 0 |
| `GET /v1/track/search?searchText=…&size=N` | 200 |
| Rate limits | undocumented numbers, `429` + `Retry-After`; "cache recommendations" |

Coverage gap observed: 4 of 5 famous tracks tested were known; "Bohemian
Rhapsody" (`7tFiyTwD0nx5a1eklYtX2J`) was not. Treat every answer as possibly
partial. It is a free third-party service with no SLA: an outage makes
playlist creation unavailable until it is back (mapped to a 503 with a clear
message, §4.5); a search-based fallback is listed under "Later iterations"
in §5 if that proves too fragile.

Other options surveyed and not chosen: SoundStat and Musicae (paid, Spotify
id lookups), FreqBlog Music API (free tier, prefers title+artist lookups),
Essentia (self-hosted audio analysis, needs 30-second previews that dev-mode
apps no longer get), AcousticBrainz (frozen since 2022), Apple Music (no
valence/energy).

### 3.5 Spotify's guidance for API apps and how V2 follows it

Spotify publishes a set of rules for applications built on the Web API
(verbatim in appendix K). The table maps each rule to V2.

| Rule | V2 | Where |
|---|---|---|
| Use the OpenAPI spec (`https://developer.spotify.com/reference/web-api/open-api-schema.yaml`) for every path, parameter and response field; never guess | The implementer downloads the spec in step 0 (not committed) and checks every endpoint of §3.2 against it in steps 4 and 6; findings go to `docs/spotify-capabilities.md`. The fake Spotify server's responses copy the spec's field names. | steps 0, 4, 6 |
| Authorization Code with PKCE, or Authorization Code when there is a secure backend; Client Credentials only for public data; never Implicit Grant | Authorization Code flow with `state`, run entirely by the server; the secret never leaves the Pi. No Client Credentials, no Implicit Grant. | §4.3 |
| HTTPS redirect URIs, `http://127.0.0.1` for local development only; no `localhost`, no wildcards | Registered set after step 0: `http://127.0.0.1:5173/auth/callback`, `http://127.0.0.1:8004/auth/callback`, `https://moodmusic-v2.fedutia.fr/auth/callback`, plus V1's `https://moodmusic.fedutia.fr/callback` until V1 is retired and `https://moodmusic.fedutia.fr/auth/callback` from the cutover. `http://pi.local:8080/callback` removed. | step 0 |
| Minimum scopes | `user-top-read playlist-modify-public playlist-modify-private`; V1's `user-read-private` and `user-read-email` dropped. `playlist-modify-public` is needed for the public switch. | §4.3 |
| Store tokens securely, never expose the secret client-side, implement refresh, re-authorise when a refresh token expires | Tokens only in the server-side session store; refresh at `expiresAt − 60 s`; `invalid_grant` → session destroyed, user sent to login. | §4.3, appendix I |
| Exponential backoff and `Retry-After` on 429; no tight retry loops | Up to 3 retries, wait = max(`Retry-After`, 1 s, 2 s, 4 s), never more than 8 s per wait; a `Retry-After` above 8 s ends the request with a "réessaie dans N secondes" message. Same policy for ReccoBeats. | appendix I, appendix J |
| No deprecated endpoints: `/playlists/{id}/items` not `/tracks`; `/me/library` not the type-specific library endpoints | `POST /v1/me/playlists`, `POST /v1/playlists/{id}/items`; no library endpoint used. The probe script flags any endpoint the spec marks deprecated. | §3.2 |
| Handle every documented HTTP error and surface Spotify's message to the user | `SpotifyError` carries `body.error.message`; the API maps statuses to French messages that include Spotify's text where useful (§4.5). | §4.5, appendix I |
| Developer Terms: no caching beyond immediate use, attribute content to Spotify, no machine-learning training on Spotify data | Firestore holds only the ids and names (plus image URL) of the artists the user chose, refreshed from `GET /v1/artists/{id}` (§4.4); track ids from ReccoBeats are turned into a Spotify playlist immediately and never stored; no Spotify response is cached. Every screen showing Spotify data carries the Spotify logo with "Contenu fourni par Spotify" and links back to open.spotify.com. Nothing is trained on anything. | §4.4, §4.8 |

---

## 4. V2 architecture

### 4.1 Repository layout (new repo)

```
moodmusic/
├── package.json            "type": "module", engines node >=22.12, scripts in §4.2
├── package-lock.json       committed
├── .nvmrc                  22
├── .gitignore              node_modules, .env, .keys/, app/dist, coverage, .idea, .DS_Store
├── firebase.json, firestore.rules (deny all), .firebaserc (project alias)
├── docs/PLAN.md            this document; docs/spotify-capabilities.md (step 0 output); docs/DEPLOY.md; docs/QA.md
├── shared/
│   └── moods.js            the mood table of §1.5 as data + functions (no strings, no eval); imported by server and client
├── server/
│   ├── index.js            starts http or https, mounts the app
│   ├── app.js              createApp({ firestore, config }) → express app (dependencies injected for tests)
│   ├── config.js           env parsing with defaults and validation (§4.9)
│   ├── auth/               routes login/callback/logout, requireUser middleware, session setup
│   ├── session-store.js    express-session Store backed by Firestore "sessions" (appendix G)
│   ├── spotify/client.js   fetch-based Spotify Web API client (token refresh, backoff, error mapping; appendix I)
│   ├── reccobeats/client.js fetch-based ReccoBeats client (timeouts, backoff, 24 h in-memory cache)
│   ├── core/               pure functions, no I/O: targets.js, artistProfile.js, pickArtists.js, rankTracks.js, playlistName.js, index.js
│   ├── recommenders/       reccobeats.js (default engine), spotify.js (V1 reference), index.js (selection by RECOMMENDER)
│   ├── repositories/       users.js, playlists.js (Firestore access)
│   └── routes/             api.js (JSON endpoints), static.js (serves app/dist + SPA fallback)
├── app/                    Vite + React client (own package.json and lock)
│   ├── index.html, vite.config.js
│   ├── public/             manifest.webmanifest, icons (from V1 web/src/public/img), Spotify logo, robots.txt
│   └── src/                main.jsx, App.jsx, api.js, pages/, components/, styles/
├── scripts/
│   ├── probe-spotify.mjs   step 0: capability probe with a local loopback login
│   ├── probe-reccobeats.mjs step 0: coverage check of the user's top artists
│   └── deploy/             moodmusic-v2 start script, apache vhost, systemd unit templates
└── test/
    ├── helpers/            fake-spotify.js, fake-reccobeats.js, server.js (boot with emulator + fakes), firestore.js (reset/read), v1-reference.js
    ├── core.test.js        golden tests from §1.5 and §4.6.1 (no network, no emulator)
    ├── session-store.test.js, auth.test.js, spotify-client.test.js, artists.test.js, playlists.test.js, failure.test.js   (emulator + fakes)
    ├── production.test.js  https mode with a self-signed cert, refuses to start without SESSION_SECRET
    └── app-build.test.js   builds the client and checks dist/index.html and the SPA fallback
```

### 4.2 Stack, versions and scripts

Server: `express` 5, `express-session` 1.18+, `firebase-admin` 14 (modular
imports `firebase-admin/app`, `firebase-admin/firestore`), `dotenv`; the
built-in `fetch`. Not used: `request`, `body-parser` (use `express.json()`),
`cookie-parser` (express-session handles its cookie), `querystring`, `core-js`.
Client: `vite` 8, `@vitejs/plugin-react` 6, `react` 19, `react-dom` 19,
`react-router` 7 (import everything from `react-router`; `react-router-dom` is
no longer needed). Dev: `firebase-tools` (Firestore emulator; needs Java,
present on the Mac), optional `eslint` 9 flat config. Tests: `node --test`.

`package.json` scripts:

```json
{
  "start": "node server/index.js",
  "dev": "NODE_ENV=development node --watch server/index.js",
  "build": "cd app && npm run build",
  "test": "node --test --test-concurrency=1 test/*.test.js",
  "test:emulator": "firebase emulators:exec --only firestore --project demo-moodmusic \"npm test\"",
  "probe": "node scripts/probe-spotify.mjs",
  "probe:reccobeats": "node scripts/probe-reccobeats.mjs"
}
```

`app/package.json` scripts: `dev` (`vite`), `build` (`vite build`), `preview`.

### 4.3 Authentication and sessions

```
browser                     server                                   Spotify
  GET /auth/login  ───────►  state = 16 random bytes hex, stored in session, session saved
                             302 https://accounts.spotify.com/authorize?response_type=code&client_id&scope&redirect_uri&state
                                                                        ──► user consents
  GET /auth/callback?code&state ─► state must equal session.oauthState (else 400 page "Connexion impossible, réessaie.")
                             POST accounts.spotify.com/api/token (Basic clientId:secret, grant_type=authorization_code, code, redirect_uri)
                             GET /v1/me   (403 here = account not on the allow-list → page "Compte non autorisé", §4.5)
                             users/{id}: create on first login (then import top artists), else update displayName/image/lastLoginAt
                             session.regenerate(); session.user = { id, displayName, image }; session.tokens = { access, refresh, expiresAt }
                             302 /onboarding (new user) or 302 /
  POST /auth/logout ───────►  session.destroy(), clears cookie, 204
```

This is the Authorization Code flow with a secure backend (§3.5); PKCE is
not needed because the secret stays on the server.

- Scopes: `user-top-read playlist-modify-public playlist-modify-private`
  (`user-read-private` and `user-read-email` are dropped: V2 does not store
  e-mails; `GET /v1/me` works without them for id, display name, images).
- Cookie: name `moodmusic.sid`, `httpOnly`, `secure` in production,
  `sameSite: 'lax'`, `maxAge` 30 days, `rolling: true`; `express-session`
  options `resave: false`, `saveUninitialized: false`, `store` = appendix G.
  `SESSION_SECRET` from the environment; refuse to start in production
  without it (development generates one at boot).
- Tokens never leave the server. The Spotify client refreshes the access
  token when `expiresAt − 60 s` has passed, writes the new tokens back into
  the session, and on `invalid_grant` (or a 401 from the API) destroys the
  session so the API answers `401 { "error": "reauth" }` and the SPA goes to
  `/login`.
- CSRF: the cookie is `SameSite=Lax`, all mutating routes are `POST`/`PUT`/
  `DELETE` with JSON bodies, and the server rejects mutating requests whose
  `Origin` header (when present) differs from `APP_ORIGIN` (403). No CORS
  headers at all (same origin).
- Security headers on every response: `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`,
  `Content-Security-Policy: default-src 'self'; img-src 'self' https://i.scdn.co https://*.scdn.co data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src https://open.spotify.com; base-uri 'none'; form-action 'self'`,
  `app.disable('x-powered-by')`. HSTS stays on Apache.
- Development runs through the Vite dev server: browser at
  `http://127.0.0.1:5173`, `vite.config.js` proxies `/api` and `/auth` to
  `http://127.0.0.1:8004`, so everything is same-origin and the redirect URI
  registered for development is `http://127.0.0.1:5173/auth/callback`. A
  production-like local run (built client served by the server) uses
  `http://127.0.0.1:8004/auth/callback`; register both.

### 4.4 Firestore data model

```
users/{spotifyUserId}
  displayName: string, image: string|null, createdAt, lastLoginAt: Timestamp
  artists: [ { id, name, image: string|null, moods: ["excited", …], addedAt: ISO string, refreshedAt: ISO string } ]
            (ordered; manual additions unshifted like V1)
users/{spotifyUserId}/playlists/{spotifyPlaylistId}
  name, createdAt: Timestamp, moods: { excited: 0.55, … } (selected moods with slider values),
  target: { valence, energy, danceability? }, artists: [ { id, name, gap } ], trackCount, public: boolean,
  engine: "reccobeats" | "spotify", url
sessions/{sid}
  data: string (JSON), expiresAt: Timestamp
```

- Artist profiles (§1.5.2) are computed on read by `core/artistProfile.js`,
  never stored, so a change in the mood table cannot leave stale numbers.
- Spotify metadata kept per artist is the minimum the feature needs: the id
  (the calibration is about that artist), the name and one image URL (both
  needed to show the calibration). `mergeTopArtists` updates name/image of
  artists it sees again; after each login the server refreshes, in the
  background, the artists whose `refreshedAt` is older than 7 days with
  `GET /v1/artists/{id}` (at most 30 per login, errors logged and ignored;
  a 404 removes the image only). No track, no recommendation result and no
  Spotify response is stored or cached anywhere else.
- No global `artist` collection, no e-mails, no refresh tokens outside
  `sessions`. Arrays are updated read-modify-write inside
  `firestore.runTransaction`. `firestore.rules` denies all client access
  (only the admin SDK reads/writes).

### 4.5 HTTP API (JSON, all under `/api`; `requireUser` on everything except `/api/session`, `/api/moods`, `/api/health`)

| Method & path | Body → Response | Notes |
|---|---|---|
| `GET /api/session` | → `{ user: { id, displayName, image, isNew } }` or `401 { error: "unauthenticated" }` | `isNew` = no artist has a mood yet |
| `GET /api/moods` | → `[ { state, emoji, label, order } ]` | from `shared/moods.js`; functions are code, not data |
| `GET /api/me/artists` | → `{ artists: [ { id, name, image, moods, profile: { valence, activation, danceability? }|null } ] }` | |
| `POST /api/me/artists` | `{ query }` → `201 { artist }` / `404 { error: "L'artiste n'existe pas 🙁" }` / `409 { error: "L'artiste existe déjà 😁" }` | Spotify search `type=artist&limit=1`; new artist unshifted |
| `POST /api/me/artists/import-top` | → `{ added: n }` | `GET /v1/me/top/artists?limit=15`, merge by id (existing kept and refreshed, new appended in Spotify order); called by the auth callback for new users and by a "Réimporter mes top artistes" button |
| `PUT /api/me/artists/{id}/moods` | `{ moods: [state…] }` → `{ artist }` | replaces the set (V1 toggled one at a time); unknown state → 400; unknown artist → 404 |
| `DELETE /api/me/artists/{id}` | → `204` | |
| `POST /api/playlists` | `{ moods: { state: x, … }, name?, public? }` → `201 { playlist: { id, name, url, trackCount, engine, public }, artists: [ { id, name, gap } ], target }` or `422 { error }` (the V1 messages of §1.5.3, or the ReccoBeats "no seed" message below), or `400` for an empty selection ("Sélectionne au moins une émotion") | `public` defaults to `false`; the whole §1.5 pipeline with the configured engine |
| `GET /api/me/playlists` | → `{ playlists: [ … ] }` newest first, max 50 | history |
| `GET /api/health` | → `{ ok: true, engine: "reccobeats" }` | for the Pi and smoke tests |

Error shape everywhere: `{ error: "<message shown to the user>" }`. Firestore
failures → `503 { error: "Service indisponible, réessaie plus tard" }`.
Spotify and ReccoBeats failures are mapped as below (Spotify's own
`error.message` is appended where marked, as plain text); never a hanging
request (15 s timeout on Spotify calls, 10 s on ReccoBeats calls via
`AbortSignal.timeout`), never a crash (Express 5 forwards rejected promises
from async handlers to the error middleware; add `process.on('unhandledRejection', log)`).

| Upstream answer | API answer | Notes |
|---|---|---|
| Spotify 401 (or `invalid_grant` on refresh) | `401 { error: "reauth" }`, session destroyed | SPA redirects to `/login` |
| Spotify 403 on `GET /v1/me` during login | html page "Compte non autorisé : Moodmusic est une application Spotify en mode développement limitée à 5 utilisateurs. Demande à Hadrien d'ajouter ton compte, puis reconnecte-toi." with a "Réessayer" link | the allow-list rule of §3.1; no session is created |
| Spotify 403 elsewhere | `403 { error: "Spotify a refusé la demande : <message>" }` | missing scope, playlist not owned |
| Spotify 404 on `/v1/recommendations` | `503 { error: "Le moteur Spotify n'est pas disponible pour cette application (mode développement)." }` | only reachable with `RECOMMENDER=spotify` |
| Spotify 404 elsewhere | `404 { error: "Introuvable sur Spotify : <message>" }` | |
| Spotify 429 after the backoff of appendix I | `429 { error: "Spotify limite les requêtes, réessaie dans <n> secondes." }` with `Retry-After` forwarded | |
| Spotify 400 / other 4xx | `502 { error: "Réponse inattendue de Spotify : <message>" }` + log with the request path | a bug on our side or a spec change |
| Spotify 5xx, timeout or network error | `503 { error: "Spotify est indisponible, réessaie plus tard." }` | |
| ReccoBeats knows none of the chosen artists / no seed track | `422 { error: "Aucun des artistes choisis n'est connu du moteur de recommandation. Ajoute d'autres artistes favoris ou change d'émotion." }` | |
| ReccoBeats 429 after backoff | `429 { error: "Le moteur de recommandation limite les requêtes, réessaie dans <n> secondes." }` | |
| ReccoBeats 5xx, timeout or network error | `503 { error: "Le moteur de recommandation est indisponible, réessaie plus tard." }` | |

### 4.6 Core module (pure, tested first)

```js
// shared/moods.js — one entry per mood, table order
export const MOODS = [
  { state: 'dance',     emoji: '💃', label: 'dansant',   order: 1,   base: { danceability: 0.5 },              fn: { danceability: x => x } },
  { state: 'excited',   emoji: '😜', label: 'excité',    order: 2,   base: { valence: 0.8125, activation: 0.8125 }, fn: { energy: x => 0.625 + 0.375 * x, valence: x => 0.625 + 0.375 * x } },
  { state: 'happy',     emoji: '😃', label: 'heureux',   order: 2.5, base: { valence: 0.75,   activation: 0.5 },    fn: { energy: x => 0.375 + 0.25 * x,  valence: x => 0.5 + 0.5 * x } },
  { state: 'serene',    emoji: '🙂', label: 'calme',     order: 3,   base: { valence: 0.8125, activation: 0.3125 }, fn: { energy: x => 0.375 - 0.25 * x,  valence: x => 0.625 + 0.375 * x } },   // valence sign fixed, §4.6.1
  { state: 'tired',     emoji: '😴', label: 'fatigué',   order: 4,   base: { valence: 0.4375, activation: 0.3125 }, fn: { energy: x => 0.375 * (1 - x),   valence: x => 0.75 - 0.5 * x } },
  { state: 'nostalgic', emoji: '🙄', label: 'nostalgie', order: 4.5, base: { valence: 0.375,  activation: 0.5625 }, fn: { energy: x => 0.375 * (1 + x),   valence: x => 0.5 - 0.25 * x } },
  { state: 'sad',       emoji: '😢', label: 'triste',    order: 5,   base: { valence: 0.125,  activation: 0.5 },    fn: { energy: x => 0.25 + 0.5 * x,    valence: x => 0.25 * (1 - x) } },
  { state: 'upset',     emoji: '😡', label: 'énervé',    order: 6,   base: { valence: 0.25,   activation: 0.875 },  fn: { energy: x => 0.75 + 0.25 * x,   valence: x => 0.5 * (1 - x) } },
]
// server/core/targets.js
export function targetFromSelection(selection /* { state: x } */) → { valence?, energy?, danceability? }   // §1.5.1, values rounded to 4 decimals
// server/core/artistProfile.js
export function profileFromMoods(moods /* [state] */) → { valence, activation, danceability? } | null      // §1.5.2
// server/core/pickArtists.js
export function pickArtists(artists /* [{ id, name, moods }] */, target) → { artists: [{ id, name, gap }] } | { error }   // §1.5.3
// server/core/rankTracks.js   (used by the ReccoBeats engine)
export function rankTracks(candidates /* [{ id, artistId, features: { valence, energy, danceability } }] */, target, { limit, exclude = new Set() }) → [id]
//   distance = Σ over keys present in target of |features[key] − target[key]|; sort ascending (stable); round-robin across artistId so no artist exceeds ceil(limit / nbArtists) + 1 tracks
// server/core/playlistName.js
export function playlistName(name, selection) → '[Moodmusic] ' + (name?.trim().slice(0, 25) || selected states in table order joined by ',')   // §1.5.4
```

#### 4.6.1 Deliberate deviations from V1 (encoded in the golden tests)

1. **Serene valence increases with the slider**: `0.625 + 0.375x` instead of
   V1's `0.625 − 0.375x`. Rationale: "less serene" must lower the valence, and
   with the `+` sign the function at x = 0.5 equals the base valence 0.8125
   used for artist profiles, like the other moods.
2. Artists whose profile valence is exactly 0 are matched (V1 skipped them).
3. `danceability` is averaged over all selected moods that define it,
   whatever their position (V1 depended on "dance" being first).
4. Playlists are private unless the user switches "Playlist publique" on.
5. The mood screen starts with nothing selected and requires at least one mood.

### 4.7 Recommendation engines (the "values → tracks" step)

Contract, identical for both engines:

```js
// server/recommenders/<name>.js
export async function recommend({ seedArtists /* [{ id, name }] in gap order */, target /* { valence?, energy?, danceability? } */, limit /* 30 */, spotify /* per-user client */, reccobeats /* client */ }) → { trackUris: ['spotify:track:…'], engine }
```

- **`reccobeats`** (default; appendix J): for each seed artist, resolve the
  ReccoBeats artist id, fetch its tracks and their audio features, and keep
  the track closest to the target as that artist's seed track (one per
  artist, up to 5). Then one `GET /v1/track/recommendation` with the same
  `valence`/`energy`/`danceability` targets, `featureWeight=2` and
  `size=limit`; Spotify ids come from each result's `href`; tracks whose
  `availableCountries` excludes `MARKET` are dropped; if fewer than `limit`
  remain, the artists' own tracks ranked by `rankTracks` top the list up.
  Artists unknown to ReccoBeats contribute nothing; no seed at all →
  `NoSeedsError` (422 in §4.5). The ReccoBeats client caches
  artist → tracks → features in memory for 24 h and applies the backoff of
  appendix I.
- **`spotify`** (V1 reference, not usable by this app): V1's request to the
  letter plus `market=from_token`:
  `GET /v1/recommendations?seed_artists=<ids csv>&limit=<limit>&market=from_token&target_valence=…&target_energy=…[&target_danceability=…]`
  (only the keys present in the target), `tracks[].uri` in Spotify's order.
  Kept so the V1 behaviour stays executable against the fake server and
  documented in code; selecting it in production yields the 503 of §4.5.
- **Selection** (`recommenders/index.js`): `RECOMMENDER` env, default
  `reccobeats`, accepted `reccobeats|spotify`; anything else refuses to
  start. No runtime probe. The playlist route calls
  `recommenders[config.recommender].recommend(...)` and records the engine
  in the playlist document.

Both engines end the same way: `playlistName` → `POST /v1/me/playlists` →
`POST /v1/playlists/{id}/items` in chunks of 100 → playlist document → response.
Each `POST /api/playlists` logs one line:
`playlist user=<id> engine=<e> seeds=<n>/<artists> tracks=<n> ms=<n>`.

### 4.8 Client application

Routes (react-router 7 `BrowserRouter`, French copy from V1 where it exists):

| Route | Screen |
|---|---|
| `/login` | logo + "Connexion avec Spotify" (`<a href="/auth/login">`, a full navigation, not fetch), shown whenever `GET /api/session` is 401; a line "Application privée : l'accès est réservé aux comptes autorisés." |
| `/onboarding` | "Bienvenue {prénom} !" ("prénom" = first word of the display name) then the calibration wizard: one card per artist (image, name, emoji row with labels, "Valider", "Je n'aime pas cet artiste" which deletes it), progress "n/N"; when the user has no artists: "Nous allons calibrer Moodmusic sur tes goûts musicaux, écris quelques uns de tes artistes préférés et touche les emojis pour nous dire dans quels états ils te mettent." with an input + "+" until 5 artists are tagged; final "Le calibrage est terminé, tu peux désormais créer une playlist ou ajouter d'autres artistes pour encore plus de précision !" → `/` |
| `/` | "Comment te sens-tu ?" — the 8 emojis (table order) as toggle buttons with their label; a range slider (`<input type="range" min="0" max="1" step="0.01">`, default 0.55) appears under each selected one; "Un petit nom ?" input (`maxlength="25"`); "Playlist publique" switch, off by default; "Créer la playlist" button (disabled until one mood is selected; V1's three-dot animation while waiting); errors from the API shown inline |
| `/playlist/:id` | result: name, chosen artists with their gap, "Ouvrir dans Spotify" link (`https://open.spotify.com/playlist/{id}`), and `<iframe src="https://open.spotify.com/embed/playlist/{id}" loading="lazy">` |
| `/artists` | "Artistes favoris": "Tu peux ajouter tes artistes préférés" input + "+", "Touche les emojis pour nous dire dans quels états te mettent ces artistes", one card per artist with emoji toggles (saved on change with `PUT …/moods`), "×" to remove, "Réimporter mes top artistes" |
| `/playlists` | "Mes playlists": history from `GET /api/me/playlists` with date, moods, artists, link |

Header with the V1 wordmark (`img/moodmusic_written.png`), tabs "Créer une
playlist" / "Artistes favoris" / "Mes playlists", "Déconnexion" (POST then
navigate to `/login`). Footer on every signed-in screen: the official
Spotify logo (downloaded unmodified from Spotify's design resources at
https://developer.spotify.com/documentation/design) with "Contenu fourni par
Spotify", and every artist or playlist shown links to its
`open.spotify.com` page. `app/src/api.js` is a thin `fetch` wrapper
(`credentials: 'same-origin'`, JSON, throws with the server's `error`
message, redirects to `/login` on 401). Layout mobile-first, plain CSS with
V1's palette, no CSS framework. `manifest.webmanifest` + icons so the app can
be installed; no service worker. `shared/moods.js` is imported by the client
through a Vite alias `@shared` (`resolve.alias` + `server.fs.allow` including
the repo root, see step 1).

### 4.9 Configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `NODE_ENV` | | development | `production` enables https, secure cookie, strict checks |
| `PORT` | | 8004 | |
| `APP_ORIGIN` | prod | `http://127.0.0.1:5173` in dev | the site's origin: `Origin` check, default redirect URI |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` | ✔ | | |
| `SPOTIFY_REDIRECT_URI` | | `${APP_ORIGIN}/auth/callback` | must be registered in the dashboard exactly |
| `SESSION_SECRET` | prod | random in dev | |
| `FIREBASE_KEY_PATH` | prod | | service-account JSON (in `.keys/`, mode 600). Tests and dev use the emulator: `FIRESTORE_EMULATOR_HOST=127.0.0.1:8183`, `initializeApp({ projectId: 'demo-moodmusic' })`, no key |
| `RECOMMENDER` | | reccobeats | `reccobeats` or `spotify` (§4.7) |
| `RECCOBEATS_URL` | | https://api.reccobeats.com | overridden by tests |
| `MARKET` | | FR | ReccoBeats `availableCountries` filter |
| `SPOTIFY_ACCOUNTS_URL`, `SPOTIFY_API_URL` | | https://accounts.spotify.com, https://api.spotify.com | overridden by tests with the fake server |
| `PUBLIC_DIR` | | app/dist | built client |
| `SSL_CERT`, `SSL_KEY` | prod | | Node's own https listener behind Apache, as for frek/secret-santa |

Secrets live in `/home/pi/webserver/moodmusic/.env` (root-owned, mode 600),
loaded by `dotenv` (which never overrides variables already set by the start
script); the start script contains no secret.

### 4.10 Testing strategy

- `core.test.js`: golden tests for §1.5 and §4.6.1 with the values of
  appendix C (targets for single and combined moods, dance handling, profile
  means, artist selection edge cases: no artists, no profiled artist, one
  artist with a gap > 0.5, exactly 5, gap ties keep stored order, valence 0,
  the 0.5 boundary; `rankTracks` distance order and per-artist cap), plus a
  property test against a port of the V1 code (`test/helpers/v1-reference.js`:
  `processTunetables` without jQuery with the string formulas evaluated by
  `new Function`, the `/calculerTunetables` arithmetic, the
  `/getArtistsFromMood` do-while loop) on 500 random selections/artist sets,
  excluding the deviations of §4.6.1 (skip "serene" and valence-0 artists in
  the comparison, and put "dance" first).
- `test/helpers/fake-spotify.js`: one http server on port 0 playing both
  `accounts.spotify.com` (`/authorize` redirects to the given `redirect_uri`
  with `code` and `state`; `/api/token` handles `authorization_code` and
  `refresh_token` grants, checks the Basic header, can be told to answer
  `invalid_grant`) and `api.spotify.com` **in Development Mode shape**:
  `/v1/me` without `email`/`country`, `/v1/me/top/artists`, `/v1/search`
  (400 when `limit` > 10), `/v1/artists/{id}`, `/v1/recommendations`
  answering 404 unless told otherwise, `/v1/me/playlists`,
  `/v1/playlists/{id}/items`; response bodies shaped like the OpenAPI spec;
  401 on a missing or expired bearer; a per-user "not allow-listed" mode
  answering 403 `{ error: { status: 403, message: "User not registered in the Developer Dashboard" } }`;
  scriptable `429 Retry-After` sequences; a request log for assertions.
- `test/helpers/fake-reccobeats.js`: `/v1/artist`, `/v1/artist/{id}/track`,
  `/v1/audio-features`, `/v1/track/recommendation` from fixtures (three
  artists known, one unknown; features chosen so the expected seed track and
  ranking are unambiguous); scriptable 400 on large `ids` batches, 429, 500,
  and a "hang" mode for the timeout test; a request log.
- `test/helpers/server.js`: boots the real server on port 0 with
  `FIRESTORE_EMULATOR_HOST`, the fakes' URLs and `NODE_ENV=test`; returns the
  base URL, a `fetch` with a cookie jar, and `close()`. Files reset the
  emulator between tests (`DELETE http://127.0.0.1:8183/emulator/v1/projects/demo-moodmusic/databases/(default)/documents`)
  and read documents through the REST API with `Authorization: Bearer owner`.
- `failure.test.js`: Firestore unreachable → 503 (point `FIRESTORE_EMULATOR_HOST`
  at a closed port); login of a non-allow-listed user → the "Compte non
  autorisé" page and no session; Spotify 403 → the Spotify message surfaced;
  Spotify 429 twice then 200 → success after two waits, 429 four times → 429
  to the client, `Retry-After: 30` → immediate 429 with "30 secondes"; Spotify
  500 → 503; `invalid_grant` → session cleared and `401 reauth`; ReccoBeats
  unknown artists only → 422; ReccoBeats 429 → backoff then 429; ReccoBeats
  500 / hang → 503 within the timeout; `RECOMMENDER=spotify` with the fake's
  404 → the "mode développement" 503.
- `production.test.js`: `NODE_ENV=production` with a throwaway self-signed
  cert → https answers, cookie has `Secure`, server refuses to start without
  `SESSION_SECRET`.
- `app-build.test.js`: `vite build` produces `dist/index.html` referencing
  hashed assets; the server serves it for `/artists` (SPA fallback) and
  answers JSON 404 for unknown `/api/*`.

### 4.11 Deployment on the Raspberry Pi

Same pattern as secret-santa's start script (nvm block, Node ≥ 22.12 guard,
`runuser -u pi -- git … pull --ff-only` over HTTPS with the `insteadOf` trick,
`npm ci` gated on the lock-file hash for `.` and `app`, `vite build`, then
`exec node server/index.js`). Template in appendix D. Apache terminates TLS
on 443 (HSTS) and proxies to Node's https listener on 8004 (appendix E). The
Let's Encrypt wildcard `*.fedutia.fr` covers `moodmusic-v2.fedutia.fr`
(one label) but not `beta.moodmusic.fedutia.fr` (two labels).

### 4.12 Reference code to copy from (same author, same conventions)

| Need | Copy from |
|---|---|
| https/http switch, security headers, modular firebase-admin init | `/Users/equilab/Projects/secret-santa/server/index.js`, `/Users/equilab/Projects/frek-backend/src/index.js` |
| Boot the server in tests, emulator reset, REST reads with `Bearer owner` | `/Users/equilab/Projects/secret-santa/test/helpers/server.js`, `test/server.test.js` |
| A fake network service in tests (pattern) | `/Users/equilab/Projects/secret-santa/test/helpers/fake-smtp.js` |
| Firestore failure test | `/Users/equilab/Projects/secret-santa/test/helpers/failing-firestore.js`, `/Users/equilab/Projects/frek-backend/test/server.test.js` |
| Production https test, client build test | `/Users/equilab/Projects/secret-santa/test/production.test.js`, `test/app-build.test.js` |
| Vite config, package scripts, firebase.json, firestore.rules | `/Users/equilab/Projects/secret-santa/app/vite.config.js`, `package.json`, `firebase.json`, `firestore.rules` |
| Pi start script | appendix D (derived from the secret-santa script) |

---

## 5. Step-by-step plan

### Conventions for the implementing sessions

- One pull request per step into `main` of the new repository, branch
  `step-N-<slug>`; `npm test` and `npm run test:emulator` green before opening
  it; PR description lists what was verified manually.
- Never modify the V1 repository (`mood-music`). Never commit `.env`, `.keys/`,
  tokens or the client secret; never print tokens in logs or test output.
- **Development Mode rules are firm** (§3.1): at most 5 allow-listed users,
  owner Premium, none of the removed endpoints, `limit` ≤ 10 on search,
  quota-aware backoff. Do not design anything that assumes more users or
  the recommendations/audio-features endpoints.
- **Spotify's rules** (§3.5, appendix K): the OpenAPI schema at
  `https://developer.spotify.com/reference/web-api/open-api-schema.yaml`
  decides paths, parameters and field names — look them up, do not guess;
  Authorization Code flow with the secret on the server only; HTTPS or
  `127.0.0.1` redirect URIs; minimum scopes; exponential backoff honouring
  `Retry-After` on 429, never tight retries; no deprecated endpoint
  (`/playlists/{id}/items`, not `/tracks`; no type-specific library
  endpoints); handle every documented error code and surface Spotify's
  message; Developer Terms: no caching of Spotify data beyond §4.4,
  attribution on every screen with Spotify data, no machine-learning use.
- French for user-facing strings, English for code, comments, commits and docs.
- No new dependency without a one-line reason in the PR. No TypeScript, no
  Babel, no CSS framework, no state-management library.
- After each step, update the status table (§7) in `docs/PLAN.md` and record
  facts learned in `docs/` (capabilities, deploy notes).
- Ask Hadrien only for the items marked **You**; everything else has a
  default in this document.

Steps 2 and 3 are independent and can be done in parallel; everything else
is in order.

### Step 0 — Discovery and gates (no V2 code yet)

Already answered on 2026-09-23 (dashboard): App status = **Development
mode**; owner has Premium; allow-list exists with one user (Hadrien), so the
5-user cap applies; client id matches the V1 app; refresh token lifetime
shown as 180 days; registered redirect URIs `http://pi.local:8080/callback`
(stale) and `https://moodmusic.fedutia.fr/callback` (V1 production).

**You (remaining):**
1. Redirect URIs: add `http://127.0.0.1:5173/auth/callback`,
   `http://127.0.0.1:8004/auth/callback`, `https://moodmusic-v2.fedutia.fr/auth/callback`;
   remove `http://pi.local:8080/callback`; keep `https://moodmusic.fedutia.fr/callback`
   until V1 is retired (step 10).
2. **Rotate the client secret**, put the new value in the Pi's `web/.env`
   (`SPOTIFY_CLIENT_SECRET=…`), restart the V1 service, check that V1 login
   still works. Give the implementer the client id and the new secret for a
   local `.env` (never in chat logs that get committed).
3. Allow-list: add the beta testers' Spotify accounts (5 in total including yours).
4. From the Pi, send: the V1 start script (path under `/home/pi/.bin/`,
   content with secrets removed), `systemctl cat <v1 service>`, the Apache
   vhost for `moodmusic.fedutia.fr`, the V1 port, and `ss -ltnp | grep node`
   (8002 secret-santa, 8003 frek are taken).
5. Create the **new Firebase project** (free Spark plan), enable Firestore
   (region `europe-west`), download a service-account key for later.
6. Create the new GitHub repository (public), enable Dependabot alerts +
   security updates and secret scanning + push protection (Settings → Code
   security).

**Implementer:**
1. Put this document at `docs/PLAN.md` in the new repository.
2. Download the OpenAPI spec (`https://developer.spotify.com/reference/web-api/open-api-schema.yaml`)
   to a scratch location (do not commit it) and, for every endpoint of §3.2,
   note in `docs/spotify-capabilities.md` the exact path, the parameters V2
   sends, the response fields V2 reads, and whether the spec marks anything
   deprecated. If the spec disagrees with this document, the spec wins;
   record the difference.
3. Write `scripts/probe-spotify.mjs`: starts an http server on
   `127.0.0.1:8004`, prints the authorize URL (scopes of §4.3, redirect URI
   `http://127.0.0.1:8004/auth/callback`), handles the callback, exchanges
   the code with the client id/secret from `.env`, then calls with the token:
   `GET /v1/me`, `GET /v1/me/top/artists?limit=15`, `GET /v1/search?q=daft%20punk&type=artist&limit=1`,
   `GET /v1/search?q=daft%20punk&type=artist&limit=11` (expected 400),
   `GET /v1/artists/{id}`, `GET /v1/recommendations?seed_artists={id}&limit=1&market=from_token&target_valence=0.5`
   (expected 404), `POST /v1/me/playlists` (`{ name: "[Moodmusic test] probe", public: false }`),
   `POST /v1/playlists/{id}/items` with one uri, `DELETE /v1/playlists/{id}/followers`
   (unfollows the test playlist), `GET /v1/me/playlists?limit=1`. It prints
   a table `endpoint | status | notable fields present/missing` and appends
   it to `docs/spotify-capabilities.md`. Never print tokens.
4. Write `scripts/probe-reccobeats.mjs`: reads the 15 top-artist ids printed
   by the Spotify probe (or a list given on the command line), calls
   `GET /v1/artist?ids=…`, then for each known artist
   `GET /v1/artist/{rbId}/track?size=50` and `GET /v1/audio-features` for
   those tracks, and prints: artists known/unknown, tracks per artist, the
   largest accepted `size` and `ids` batch, and the response time. Result
   into `docs/spotify-capabilities.md` under "ReccoBeats coverage".
5. Run both probes with Hadrien's account.

Done when: `docs/spotify-capabilities.md` exists with the Spotify statuses
(404 on `/v1/recommendations` confirms the Development Mode shape) and the
ReccoBeats coverage of Hadrien's top artists, the secret is rotated, V1
still works, the repository and Firebase project exist.

### Step 1 — Repository bootstrap

- Root `package.json` (§4.2), `.nvmrc`, `.gitignore`, `firebase.json`
  (emulator port 8183, UI disabled), `firestore.rules` deny-all (appendix F),
  `.firebaserc` with alias `default` = the new project id.
- `app/` from `npm create vite@latest app -- --template react` (JavaScript),
  demo removed; `vite.config.js`:
  `build.outDir: 'dist'`, `server.proxy: { '/api': 'http://127.0.0.1:8004', '/auth': 'http://127.0.0.1:8004' }`,
  `resolve.alias: { '@shared': fileURLToPath(new URL('../shared', import.meta.url)) }`,
  `server.fs.allow: [fileURLToPath(new URL('..', import.meta.url))]`.
- `server/index.js` + `server/app.js` + `server/config.js` + `server/routes/static.js`
  serving `app/dist` with an SPA fallback written as a final middleware
  (`if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/auth')) res.sendFile(indexHtml)`;
  Express 5 uses path-to-regexp 8, so avoid `'*'` routes), `GET /api/health`,
  JSON 404 for unknown `/api/*`, security headers, http/https switch.
- Tests: `app-build.test.js`, `production.test.js`.
- Deploy the rules once: `firebase deploy --only firestore:rules` (You, or
  the implementer if logged in with `firebase login`).
- Optional CI workflow: `actions/setup-node@v4` (22), `actions/setup-java@v4`
  (21), `npm ci` in `.` and `app`, `npx firebase-tools emulators:exec --only firestore --project demo-moodmusic "npm test"`.

Done when: `npm test`, `npm run test:emulator` and `npm run build` pass and
the empty app is served at `http://127.0.0.1:8004`.

### Step 2 — Core algorithm module with golden tests

- `shared/moods.js` exactly as in §4.6, `server/core/*.js` including
  `rankTracks.js`, `server/core/index.js`.
- `test/core.test.js` (§4.10) with the values of appendix C and the V1
  reference property test.

Done when: all core tests pass without network or emulator.

### Step 3 — Sessions and authentication

- `server/session-store.js` (appendix G) + `session-store.test.js` against
  the emulator (set/get/touch/destroy/expiry/unknown sid).
- `server/auth/*` implementing §4.3 and appendix H, including the "Compte
  non autorisé" page for a 403 on `GET /v1/me`; `server/app.js` takes the
  Firestore instance and the base URLs from `config` so tests can inject
  the fakes.
- `test/helpers/fake-spotify.js` (accounts + `/v1/me` + top artists +
  allow-list mode for now), `test/helpers/server.js`, `test/helpers/firestore.js`.
- `auth.test.js`: full login round trip creates `users/{id}` (with the 15
  imported artists) and a session; wrong `state` → 400 and no session;
  non-allow-listed user → the dedicated page and no session;
  `GET /api/session` before/after; logout destroys the session and the
  document; cookie flags; **no token string appears in any response body or
  `Location` header** (assert with the fake's issued token values); the sid
  changes after login (regenerate); `Origin` check on a POST.

Done when: tests pass and a manual login works in development against real
Spotify through `http://127.0.0.1:5173`.

### Step 4 — Spotify and ReccoBeats clients

- `server/spotify/client.js` (appendix I) with helpers `me()`,
  `topArtists(limit)`, `searchArtist(name)`, `artist(id)`,
  `recommendations(params)`, `createPlaylist({ name, public })`,
  `addItems(playlistId, uris)` (chunks of 100), `myPlaylists()`. Check each
  path, parameter and read field against the OpenAPI spec and cite the spec
  operation id in a comment.
- `server/reccobeats/client.js`: `artistIds(spotifyIds)`, `artistTracks(rbId, size)`,
  `audioFeatures(spotifyIds)` (batches of ≤ 40, halving on 400),
  `recommendation({ seeds, size, targets, featureWeight })`; 10 s timeout per
  call, the same backoff policy as appendix I, an in-memory cache (24 h) for
  `artistIds`/`artistTracks`/`audioFeatures`, and `spotifyId(href)` parsing.
- Extend the Spotify fake with refresh, 429 and the remaining endpoints;
  write the ReccoBeats fake. `spotify-client.test.js` covers refresh timing
  (`expiresAt − 60 s`), a refresh response without `refresh_token`,
  `invalid_grant` → `ReauthError`, 401 → `ReauthError`, the backoff sequence
  (1 s, 2 s, 4 s, `Retry-After` honoured, > 8 s → immediate `RateLimitError`),
  `market=from_token` sent, 403/404/400/5xx → `SpotifyError` with Spotify's
  message, timeout → error. `reccobeats-client.test.js` covers batching,
  cache hits (second call makes no request), 429 backoff, timeout, `href` parsing.
- Refactor `scripts/probe-*.mjs` onto the clients.

### Step 5 — Artists and moods API

- `server/repositories/users.js` (`get`, `createFromProfile`, `touchLogin`,
  `addArtist`, `removeArtist`, `setArtistMoods`, `mergeTopArtists`,
  `refreshStaleArtists`, all array changes inside `runTransaction`),
  `server/routes/api.js` for the artist endpoints of §4.5; the auth callback
  calls `mergeTopArtists` for new users and `refreshStaleArtists` in the
  background for everyone (errors logged, login still succeeds).
- `artists.test.js`: import on first login (15 artists, order preserved,
  `image` = the middle-size image like V1's `images[1]`, else the first, else
  null), add by name (found / not found / duplicate → the V1 messages and
  status codes), moods validation (unknown state → 400), `profile` computed
  in responses, remove, `isNew` semantics, stale-artist refresh (name/image
  updated, `refreshedAt` bumped, a 404 keeps the artist), and authorization
  (a second session cannot read or change the first user's artists).

### Step 6 — Recommendation engines and playlist creation

- `server/recommenders/{reccobeats,spotify,index}.js` (§4.7, appendix J),
  `server/repositories/playlists.js`, `POST /api/playlists` and
  `GET /api/me/playlists`, the error mapping of §4.5.
- `playlists.test.js` with `RECOMMENDER=reccobeats` (default): the seed
  track chosen per artist is the closest to the target; the recommendation
  request carries `size=30`, the five seeds, `featureWeight=2` and only the
  present targets; `availableCountries` filtering with `MARKET`; top-up
  from the artists' tracks when the fake returns fewer than 30; an unknown
  artist contributes nothing; all unknown → 422; playlist name rule (§1.5.4
  incl. the 25-character cut and the mood csv default); `public` default
  false and true when asked; items added in order and chunked by 100;
  playlist document saved with `engine: "reccobeats"`; the §1.5.3 errors as
  422; empty selection → 400. With `RECOMMENDER=spotify`: the request to the
  fake is exactly V1's plus `market=from_token` when the fake is told to
  answer 200, and the "mode développement" 503 when it answers 404.

Done when: a real playlist is created end to end in development with
Hadrien's account through ReccoBeats (manual check: note seeds found and
tracks returned in the PR), and the tests pass.

### Step 7 — Client application

- Screens of §4.8, `app/src/api.js`, state in React (`useState`/`useEffect`,
  a small `SessionContext`), `@shared/moods.js` for emojis/labels/order,
  Spotify attribution footer and links.
- Accessibility basics: real `<button>`s, `<input type="range">` with
  `<label>`, emoji buttons with `aria-label` = label, `aria-pressed` for toggles.
- Copy V1's images (`logo_cercle.png`, `moodmusic_written.png`, icons) into
  `app/public/img/`; add the official Spotify logo unmodified.
- Extend `app-build.test.js` (SPA fallback, JSON 404).
- `docs/QA.md` manual checklist: first login with and without top artists,
  non-allow-listed account, calibration, add/remove/tag artists, create
  playlist for 1 mood / several moods / dance only / no tagged artists /
  artists unknown to ReccoBeats, public switch, open in Spotify, history,
  logout, expired session (`401 reauth` path), error messages shown, phone
  width, install as PWA.

### Step 8 — Beta deployment on the Pi (`moodmusic-v2.fedutia.fr`)

**You:**
1. `git clone https://github.com/hadrienbbt/<repo> /home/pi/webserver/moodmusic` as `pi`.
2. Copy the service-account key to `/home/pi/webserver/moodmusic/.keys/` (root, mode 600).
3. `/home/pi/webserver/moodmusic/.env` (root, mode 600):
   `APP_ORIGIN=https://moodmusic-v2.fedutia.fr`, `SPOTIFY_CLIENT_ID`,
   `SPOTIFY_CLIENT_SECRET`, `SESSION_SECRET` (`openssl rand -hex 32`),
   `FIREBASE_KEY_PATH=/home/pi/webserver/moodmusic/.keys/<file>.json`, `MARKET=FR`.
4. Install `/home/pi/.bin/moodmusic-v2` (appendix D) and a systemd unit
   `moodmusic-v2.service` copied from the V1 unit with the new `ExecStart`.
5. DNS record for `moodmusic-v2.fedutia.fr` (if the zone has no wildcard),
   Apache vhost of appendix E, `a2ensite`, `apachectl configtest`, reload.
6. `systemctl enable --now moodmusic-v2`, then `journalctl -u moodmusic-v2 -f`.

**Implementer:** `docs/DEPLOY.md` with the above, the operational
dependencies (owner Premium, allow-list, ReccoBeats availability), the
templates in `scripts/deploy/`, and a simulated run of the start script in a
throwaway environment before handing it over (as done for secret-santa:
`env -i`, a fake Node 20 first on PATH, an nvm stand-in providing Node 22, a
`runuser` stand-in, the emulator instead of Firestore). After deployment,
external smoke checks: `curl -sI https://moodmusic-v2.fedutia.fr/` (200,
`nosniff`, no `x-powered-by`), `/api/health`, `/api/session` → 401 JSON,
then a real login and playlist creation by Hadrien.

### Step 9 — Beta

Hadrien and up to four allow-listed friends use the beta for a couple of
weeks (no data is migrated from V1: everyone re-imports their top artists at
first login). Fix what comes up; watch the per-playlist log lines (seeds
found per artist, tracks returned, top-ups) and any upstream error mapped
in §4.5.

### Step 10 — Cutover and V1 retirement

1. Add `https://moodmusic.fedutia.fr/auth/callback` to the Spotify app.
2. Set `APP_ORIGIN=https://moodmusic.fedutia.fr` in the V2 `.env`, point the
   `moodmusic.fedutia.fr` vhost at port 8004 (keep `moodmusic-v2` as an alias
   or remove it), restart `moodmusic-v2`, verify login and playlist creation.
3. `systemctl disable --now <v1 service>`; keep the V1 folder for a month,
   then remove it, the V1 database and the V1 redirect URI
   `https://moodmusic.fedutia.fr/callback` from the Spotify app.
4. V1 repository: add a README pointing to V2, remove `web/backup/` and
   `web/db/` from the tree, then **archive** it (Dependabot alerts stop).
   Purging the files from history (`git filter-repo` + force push) is
   optional and only safe once nothing pulls the repo anymore; making the
   archived repo private is the simpler way to stop exposing the 2017/2018 data.
5. Rename the V2 repository if you want the short name; update `docs/DEPLOY.md`.

### Later iterations (ideas, not planned)

- A search-based fallback engine (`GET /v1/search?q=artist:"<name>"&type=track&limit=10&market=from_token`,
  interleaved across the chosen artists, no audio analysis) if ReccoBeats
  outages become a problem.
- A per-request engine choice in the UI if a second usable engine ever
  appears (the `engine` field of the playlist document is already there).
- Webcam mood detection with MediaPipe face landmarks, the successor of V1's
  Affectiva feature.

---

## 6. Decisions taken and step 0 answers

Decided by Hadrien on 2026-09-23:

1. The core "my computed values → a Spotify playlist" must keep working
   (§0, §4.7).
2. Serene: less serene must lower the valence → formula fixed to `0.625 + 0.375x` (§4.6.1).
3. Mood screen starts with nothing selected.
4. Playlists private by default, with a public/private switch.
5. New repository, new Firebase project.
6. No V1 hotfix: V1 stays untouched until retirement.
7. No user data migrated from V1.
8. Spotify's guidance for API apps is part of the plan (§3.5, appendix K).
9. **ReccoBeats is the default engine**; the Spotify engine stays only as the
   V1 reference behind `RECOMMENDER`; no runtime probe; the Development Mode
   rules are firm (§3.1).

Step 0 answers from the dashboard (2026-09-23): App status **Development
mode**; owner has Premium; allow-list with 1 user (Hadrien), 5-user cap
applies; client id = the V1 app; refresh token lifetime 180 days; redirect
URIs `http://pi.local:8080/callback` (stale, to remove) and
`https://moodmusic.fedutia.fr/callback` (V1 production). Still to do in step
0: secret rotation, redirect URIs, allow-list, Pi facts, Firebase project,
repository.

---

## 7. Step status (kept up to date by the implementing sessions)

| Step | Status | PR | Notes |
|---|---|---|---|
| 0 Discovery | in progress | #3 | app status known (Development mode, confirmed by the 404 of `/v1/recommendations`); repository hadrienbbt/moodmusic created 2026-09-23 with this plan, Dependabot alerts and security updates, secret scanning and push protection on; Firebase project `moodmusic-e84ad` (hbarbat@ensc.fr) with its Firestore database in eur3 (europe-west) and a service-account key; client secret rotated, V2 redirect URIs registered and `pi.local` removed, allow-list = Hadrien only for now, Pi facts in docs/DEPLOY.md; OpenAPI check and both probes done on 2026-09-23 (docs/spotify-capabilities.md): every V2 endpoint works with its three scopes, ReccoBeats knows 14 of the 15 top artists; pending: check that V1 still logs in with the rotated secret |
| 1 Bootstrap | done | #1 | Express 5 server (config checks, security headers, health, SPA fallback, http/https), Vite 8 + React 19 app, CI on GitHub Actions; deny-all rules deployed to `moodmusic-e84ad` on 2026-09-23; `probe` scripts join package.json with step 0's probes; the `Secure` cookie check of production.test.js comes with sessions (step 3) |
| 2 Core | todo | | |
| 3 Auth | todo | | |
| 4 Spotify + ReccoBeats clients | todo | | |
| 5 Artists API | todo | | |
| 6 Engines + playlists | todo | | |
| 7 Client | todo | | |
| 8 Beta deploy | todo | | |
| 9 Beta | todo | | |
| 10 Cutover | todo | | |

---

## Appendix A — V1 route inventory (`web/src/app.js`)

| Route | Line | Purpose | V2 |
|---|---|---|---|
| `GET /login` | 117 | Spotify authorize with state cookie | `/auth/login` |
| `GET /callback` | 133 | token exchange, user upsert, top-artists import, redirect with tokens in hash | `/auth/callback` (no tokens in URL) |
| `GET /getCurrentUserInfos` | 265 | user doc by id (leaks token/e-mail, S3) | `GET /api/me/artists` |
| `GET /refresh_token` | 273 | token oracle (S4) | removed |
| `GET /IdArtist` | 298 | demo: ids of hard-coded artists | removed |
| `GET /moodmusicRecommendation` | 321 | demo recommendations | removed |
| `GET /getMoods` | 348 | mood table | `GET /api/moods` |
| `GET /addMoodToArtist` | 356 | push/pull one mood then redirect to calculerTunetables | `PUT /api/me/artists/{id}/moods` |
| `GET /calculerTunetables` | 386 | artist profile (§1.5.2) stored in the user doc | computed on read |
| `GET /getArtistsFromMood` | 476 | §1.5.3, then redirect chain | inside `POST /api/playlists` |
| `GET /moodmusic` | 575 | recommendations into the session | engine |
| `GET /create_playlist` | 592 | create playlist + save doc | inside `POST /api/playlists` |
| `GET /addTracksToPlaylist` | 623 | add uris, return playlist | inside `POST /api/playlists` |
| `GET /addArtistPref` | 646 | search by name, unshift | `POST /api/me/artists` |
| `GET /removeArtistPref` | 713 | pull artist | `DELETE /api/me/artists/{id}` |
| `GET /getLyrics` | 735 | lyric-get | removed |
| `GET /user` | 750 | weather by lat/long | removed |
| `POST /api/authorization_code`, `POST /api/authorize` | 779, 853 | e-mail codes for the RN app | removed |
| `GET /api/playlist/all`, `/api/playlist/count` | 904, 933 | public stats | removed (private history instead) |
| `GET /api/user/:id/top-artists`, `/api/user/:id_user/artist/:id_artist/mood`, `/api/user/:id_user/artist/mood`, `/api/user/:id/info-playlists` | 956–1000 | per-user data without auth | removed / `GET /api/me/*` |
| `GET /api/artist/mood`, `/api/artist/:id/mood` | 1121, 1163 | mood tendency of an artist across users | removed |

## Appendix B — V1 mood table as JSON (from the live `/getMoods`, minus `_id`)

V1's table, kept for the reference test. V2 changes only the serene valence formula (§4.6.1).

```json
[
 {"state":"dance","emoji":"💃","stateFR":"dansant","ordre":1,"danceability":0.5,"functions":{"danceability":"x"}},
 {"state":"excited","emoji":"😜","stateFR":"excité","ordre":2,"valence":0.8125,"activation":0.8125,"functions":{"energy":"0.625 + x * 0.375","valence":"0.625 + x * 0.375"}},
 {"state":"happy","emoji":"😃","stateFR":"heureux","ordre":2.5,"valence":0.75,"activation":0.5,"functions":{"energy":"0.375 + x * 0.25","valence":"0.5 + x * 0.5"}},
 {"state":"serene","emoji":"🙂","stateFR":"calme","ordre":3,"valence":0.8125,"activation":0.3125,"functions":{"energy":"0.375 - x * 0.25","valence":"0.625 - x * 0.375"}},
 {"state":"tired","emoji":"😴","stateFR":"fatigué","ordre":4,"valence":0.4375,"activation":0.3125,"functions":{"energy":"0.375 * (1-x)","valence":"0.75 - x * 0.5"}},
 {"state":"nostalgic","emoji":"🙄","stateFR":"nostalgie","ordre":4.5,"valence":0.375,"activation":0.5625,"functions":{"energy":"0.375 * (1+x)","valence":"0.5 - x * 0.25"}},
 {"state":"sad","emoji":"😢","stateFR":"triste","ordre":5,"valence":0.125,"activation":0.5,"functions":{"energy":"0.25 + x * 0.5","valence":"0.25 * (1-x)"}},
 {"state":"upset","emoji":"😡","stateFR":"énervé","ordre":6,"valence":0.25,"activation":0.875,"functions":{"energy":"0.75 + x * 0.25","valence":"0.5 * (1-x)"}}
]
```

## Appendix C — Golden values for the core tests (V2 semantics)

Compare numbers with a tolerance of 1e-4; V1 rounded with `toFixed(4)`.

- Target, single mood at x = 0.55: excited → valence 0.8313, energy 0.8313;
  happy → 0.775 / 0.5125; serene → 0.8313 / 0.2375 (V1 gave 0.4187 for the
  valence); tired → 0.475 / 0.1687; nostalgic → 0.3625 / 0.5813;
  sad → 0.1125 / 0.525; upset → 0.225 / 0.8875; dance → danceability 0.55 only.
- Target, excited 1.0 + sad 0.0: valence (1.0 + 0.25)/2 = 0.625, energy (1.0 + 0.25)/2 = 0.625.
- Target, happy 0.5 + dance 0.8 (any order): valence 0.75, energy 0.5, danceability 0.8.
- Target, excited 0.55 + sad 0.55: valence 0.4719, energy 0.6781.
- Profile: ["excited","sad"] → valence 0.46875, activation 0.65625;
  ["dance"] → { danceability: 0.5 } and no valence; ["dance","tired"] →
  valence 0.4375, activation 0.3125, danceability 0.5; [] → null.
- Selection with target (0.8125, 0.8125) (exact in binary, so gaps are exact)
  and artists A["excited"] (gap 0), B["happy"] (0.375), C["serene"] (exactly
  0.5), D["sad"] (1.0), E[] (no profile) → chosen [A, B, C]: C is kept because
  only a last artist whose gap is strictly greater than 0.5 is dropped, and
  the loop stops after it because 0.5 is not strictly less than 0.5; D is
  never considered; E is ignored.
- Selection with only D → [D] (kept although its gap is 1.0).
- Selection with only E → error "Pas assez d'émotions sélectionnées…"; with no
  artist at all → error "Pas d'artiste représentant cette émotion…".
- Selection with 7 profiled artists all within 0.1 → exactly 5, in gap order,
  ties keeping stored order.
- Playlist name: ("Soirée", …) → "[Moodmusic] Soirée"; ("", { excited, sad }) →
  "[Moodmusic] excited,sad"; a 30-character name is cut to 25.
- `rankTracks` with target { valence: 0.8, energy: 0.8 }, limit 4, and tracks
  a1 (0.8, 0.8), a2 (0.7, 0.8), a3 (0.6, 0.8) of artist A and b1 (0.75, 0.8)
  of artist B → [a1, b1, a2, a3]; with limit 3 → [a1, b1, a2] (cap per artist
  = ceil(3/2) + 1 = 3, distance order kept).

## Appendix D — Pi start script template (`/home/pi/.bin/moodmusic-v2`)

```zsh
#!/bin/zsh
# Starts moodmusic V2: update the code, reinstall dependencies when a lock file
# changed, build the web app, then run the server (native ESM, no build step).
cd /home/pi/webserver/moodmusic || exit 1

export NVM_DIR=/home/pi/.nvm
source "$NVM_DIR/nvm.sh" --no-use || { echo "Cannot load nvm from $NVM_DIR"; exit 1 }
nvm use --silent default || { echo "nvm has no usable default version"; exit 1 }

node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)' \
  || { echo "Node $(node -v) at $(command -v node) is too old: 22.12 or newer is required"; exit 1 }

runuser -u pi -- git -c url."https://github.com/".insteadOf="git@github.com:" pull --ff-only \
  || echo "git pull failed; starting the current version"

install_if_changed() {
  local lock_hash=$(sha256sum "$1/package-lock.json" | cut -d ' ' -f 1)
  if [[ "$(cat "$1/node_modules/.lock-hash" 2>/dev/null)" != "$lock_hash" ]]; then
    (cd "$1" && npm ci --include=dev) || return 1
    echo "$lock_hash" > "$1/node_modules/.lock-hash"
  fi
}
install_if_changed . || exit 1
install_if_changed app || exit 1

(cd app && NODE_ENV=production npm run build) || exit 1

# Secrets, APP_ORIGIN, MARKET and the key path come from /home/pi/webserver/moodmusic/.env (root, mode 600).
NODE_ENV=production \
PORT=8004 \
SSL_CERT=/etc/letsencrypt/live/fedutia.fr/fullchain.pem \
SSL_KEY=/etc/letsencrypt/live/fedutia.fr/privkey.pem \
exec node server/index.js
```

## Appendix E — Apache vhost (beta)

```apache
<VirtualHost *:443>
    ServerName moodmusic-v2.fedutia.fr
    SSLEngine on
    SSLCertificateFile /etc/letsencrypt/live/fedutia.fr/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/fedutia.fr/privkey.pem
    Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
    SSLProxyEngine on
    ProxyPreserveHost On
    ProxyPass / https://127.0.0.1:8004/
    ProxyPassReverse / https://127.0.0.1:8004/
</VirtualHost>
<VirtualHost *:80>
    ServerName moodmusic-v2.fedutia.fr
    Redirect permanent / https://moodmusic-v2.fedutia.fr/
</VirtualHost>
```
Copy the `SSLProxy*` directives (`SSLProxyVerify`, `SSLProxyCheckPeerName`)
from the existing frek or secret-santa vhost so Node's certificate is handled
the same way.

## Appendix F — `firestore.rules` and `firebase.json`

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if false; }
  }
}
```
```json
{ "firestore": { "rules": "firestore.rules" }, "emulators": { "firestore": { "port": 8183 }, "ui": { "enabled": false } } }
```

## Appendix G — Firestore session store (`server/session-store.js`)

```js
import session from 'express-session'

// Sessions live in the "sessions" collection: { data: JSON string, expiresAt: Timestamp }.
// Expiry follows the cookie (rolling 30 days); expired documents are ignored and deleted on read.
export class FirestoreStore extends session.Store {
  constructor(firestore, { collection = 'sessions', ttlMs = 30 * 24 * 60 * 60 * 1000 } = {}) {
    super()
    this.col = firestore.collection(collection)
    this.ttlMs = ttlMs
  }
  expiry(sess) {
    const expires = sess?.cookie?.expires
    return expires ? new Date(expires) : new Date(Date.now() + this.ttlMs)
  }
  get(sid, cb) {
    this.col.doc(sid).get().then(doc => {
      if (!doc.exists) return cb(null, null)
      const { data, expiresAt } = doc.data()
      if (expiresAt.toMillis() <= Date.now()) return this.destroy(sid, () => cb(null, null))
      cb(null, JSON.parse(data))
    }).catch(cb)
  }
  set(sid, sess, cb) {
    this.col.doc(sid).set({ data: JSON.stringify(sess), expiresAt: this.expiry(sess) }).then(() => cb(null)).catch(cb)
  }
  touch(sid, sess, cb) {
    this.col.doc(sid).update({ expiresAt: this.expiry(sess) }).then(() => cb(null))
      .catch(error => cb(error.code === 5 ? null : error))   // NOT_FOUND: the session was destroyed meanwhile
  }
  destroy(sid, cb) {
    this.col.doc(sid).delete().then(() => cb(null)).catch(cb)
  }
}
```

## Appendix H — Auth handlers (pseudo-code, `server/auth/routes.js`)

```js
const SCOPES = 'user-top-read playlist-modify-public playlist-modify-private'

router.get('/auth/login', (req, res, next) => {
  const state = crypto.randomBytes(16).toString('hex')
  req.session.oauthState = state
  req.session.save(error => {
    if (error) return next(error)
    const params = new URLSearchParams({ response_type: 'code', client_id, scope: SCOPES, redirect_uri, state })
    res.redirect(`${config.spotifyAccountsUrl}/authorize?${params}`)
  })
})

router.get('/auth/callback', async (req, res) => {
  const { code, state, error } = req.query
  const expected = req.session.oauthState
  delete req.session.oauthState
  if (error || typeof code !== 'string' || !state || state !== expected) return res.status(400).type('html').send(page('Connexion impossible, réessaie.'))
  const tokens = await accounts.exchangeCode(code)                 // POST /api/token, Basic auth, grant_type=authorization_code, code, redirect_uri
  let me
  try { me = await spotifyApi.me(tokens.access_token) }            // { id, display_name, images }
  catch (e) {
    if (e instanceof SpotifyError && e.status === 403) return res.status(403).type('html').send(page(NOT_ALLOWLISTED_MESSAGE))   // §4.5
    throw e
  }
  const { created } = await users.upsertOnLogin(me)
  await regenerate(req)                                            // new sid: no session fixation
  req.session.user = { id: me.id, displayName: me.display_name ?? me.id, image: me.images?.[0]?.url ?? null }
  req.session.tokens = { access: tokens.access_token, refresh: tokens.refresh_token, expiresAt: Date.now() + tokens.expires_in * 1000 }
  await save(req)
  if (created) { try { await mergeTopArtists(req) } catch (e) { log(e) } }   // login succeeds even if the import fails
  else refreshStaleArtists(req).catch(log)                                    // background, §4.4
  res.redirect(created ? '/onboarding' : '/')
})

router.post('/auth/logout', (req, res) => req.session.destroy(() => { res.clearCookie('moodmusic.sid'); res.status(204).end() }))

export const requireUser = (req, res, next) => req.session?.user ? next() : res.status(401).json({ error: 'unauthenticated' })
```

## Appendix I — Spotify client (pseudo-code, `server/spotify/client.js`)

```js
export class ReauthError extends Error {}                                  // → API answers 401 { error: 'reauth' } and destroys the session
export class RateLimitError extends Error { constructor(retryAfter) { super('rate limited'); this.retryAfter = retryAfter } }
export class SpotifyError extends Error {                                  // carries Spotify's own message for the user (§4.5)
  constructor(status, body, path) { super(body?.error?.message ?? (typeof body === 'string' ? body : `Spotify ${status}`)); this.status = status; this.path = path }
}

export function createSpotifyClient({ req, config }) {
  const basic = 'Basic ' + Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')

  async function accessToken() {
    const t = req.session.tokens
    if (t.expiresAt - 60_000 > Date.now()) return t.access
    const res = await fetch(`${config.spotifyAccountsUrl}/api/token`, {
      method: 'POST',
      headers: { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh }),
      signal: AbortSignal.timeout(15_000),
    })
    const body = await res.json().catch(() => ({}))
    if (res.status === 400 && body.error === 'invalid_grant') throw new ReauthError()   // 180-day expiry or revoked: never retry
    if (!res.ok) throw new SpotifyError(res.status, body, '/api/token')
    req.session.tokens = { access: body.access_token, refresh: body.refresh_token ?? t.refresh, expiresAt: Date.now() + body.expires_in * 1000 }
    await save(req)
    return body.access_token
  }

  // Exponential backoff on 429: waits 1 s, 2 s, 4 s (or Retry-After when larger, never more than 8 s),
  // at most 3 retries; a Retry-After above 8 s ends the request at once with the delay for the user.
  async function request(method, path, { query, body } = {}, attempt = 0) {
    const url = new URL(path, config.spotifyApiUrl)
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v)
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${await accessToken()}`, ...(body && { 'Content-Type': 'application/json' }) },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    if (res.status === 401) throw new ReauthError()
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after')) || 0
      if (retryAfter > 8) throw new RateLimitError(retryAfter)
      if (attempt >= 3) throw new RateLimitError(retryAfter || 5)
      await sleep(Math.max(retryAfter, 2 ** attempt) * 1000)
      return request(method, path, { query, body }, attempt + 1)
    }
    if (!res.ok) throw new SpotifyError(res.status, await res.json().catch(() => res.statusText), path)
    return res.status === 204 ? null : res.json()
  }

  return {
    me: () => request('GET', '/v1/me'),
    topArtists: (limit = 15) => request('GET', '/v1/me/top/artists', { query: { limit } }),
    searchArtist: name => request('GET', '/v1/search', { query: { q: name, type: 'artist', limit: 1 } }),
    artist: id => request('GET', `/v1/artists/${id}`),
    recommendations: params => request('GET', '/v1/recommendations', { query: { market: 'from_token', ...params } }),   // V1 reference engine only
    createPlaylist: ({ name, public: isPublic }) => request('POST', '/v1/me/playlists', { body: { name, public: isPublic } }),
    addItems: async (playlistId, uris) => { for (let i = 0; i < uris.length; i += 100) await request('POST', `/v1/playlists/${playlistId}/items`, { body: { uris: uris.slice(i, i + 100) } }) },
    myPlaylists: (limit = 50) => request('GET', '/v1/me/playlists', { query: { limit } }),
  }
}
```

## Appendix J — ReccoBeats engine (`server/recommenders/reccobeats.js`)

```
spotifyId(href) = href.match(/open\.spotify\.com\/track\/([A-Za-z0-9]+)/)?.[1]
distance(features, target) = Σ over keys of target (valence, energy, danceability) of |features[key] − target[key]|

recommend({ seedArtists, target, limit, reccobeats, config }):
  seeds = []; candidates = []
  for artist of seedArtists (≤ 5, gap order):
    rb = reccobeats.artistIds([artist.id])[0]                                        (GET /v1/artist?ids=…; cached 24 h; skip artist when unknown)
    tracks = reccobeats.artistTracks(rb, 50)                                         (GET /v1/artist/{rb}/track?size=50; cached; skip when empty)
    ids = tracks.map(t => spotifyId(t.href)).filter(Boolean)
    features = reccobeats.audioFeatures(ids)                                         (GET /v1/audio-features?ids=… in batches ≤ 40, halving on 400; cached)
    withFeatures = tracks that have features, as { id, artistId: artist.id, features, availableCountries }
    if withFeatures is empty: continue
    candidates.push(...withFeatures)
    seeds.push(argmin over withFeatures of distance(features, target))               (ties: first in list)
  if seeds is empty: throw NoSeedsError                                             (→ 422 of §4.5)
  rec = reccobeats.recommendation({ seeds, size: limit, targets: target, featureWeight: 2 })
        (GET /v1/track/recommendation?size=<limit>&seeds=<csv>&featureWeight=2&valence=…&energy=…[&danceability=…]; never cached)
  chosen = unique spotifyId(rec.content[].href), keeping tracks whose availableCountries is absent or contains config.market
  if chosen.length < limit: chosen += rankTracks(candidates, target, { limit: limit − chosen.length, exclude: new Set(chosen) })
  return { trackUris: chosen.map(id => `spotify:track:${id}`), engine: 'reccobeats' }
```
Every ReccoBeats call has a 10 s timeout and the backoff policy of appendix
I; a network error, timeout or 5xx anywhere above → the 503 of §4.5, a 429
after backoff → the 429 of §4.5. Nothing from ReccoBeats is persisted; the
in-memory cache (24 h, artist → tracks → features) holds ReccoBeats data
only and is bounded (at most 500 artists, oldest evicted). Per playlist
this costs at most 5 artist lookups, 5 track lists, ~10 feature batches and
1 recommendation on ReccoBeats, and 2 calls on Spotify.

## Appendix K — Spotify's guidance for applications using the Web API (verbatim)

> You are helping me build an application using the Spotify Web API. Follow these rules:
>
> - OpenAPI spec: Refer to the Spotify OpenAPI specification at https://developer.spotify.com/reference/web-api/open-api-schema.yaml for all endpoint paths, parameters, and response schemas. Do not guess endpoints or field names.
> - Authorization: Use the Authorization Code with PKCE flow (https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow) for any user-specific data. If the app has a secure backend, the Authorization Code flow (https://developer.spotify.com/documentation/web-api/tutorials/code-flow) is also acceptable. Only use Client Credentials for public, non-user data. Never use the Implicit Grant flow (it is deprecated).
> - Redirect URIs: Always use HTTPS redirect URIs (except http://127.0.0.1 for local development). Never use http://localhost or wildcard URIs. See https://developer.spotify.com/documentation/web-api/concepts/redirect_uri for requirements.
> - Scopes: Request only the minimum scopes (https://developer.spotify.com/documentation/web-api/concepts/scopes) needed for the features being built. Do not request broad scopes preemptively.
> - Token management: Store tokens securely. Never expose the Client Secret in client-side code. Implement token refresh (https://developer.spotify.com/documentation/web-api/tutorials/refreshing-tokens) logic and send the user through authorization again when a refresh token expires.
> - Rate limits: Implement exponential backoff and respect the Retry-After header when receiving HTTP 429 responses. Do not retry immediately or in tight loops.
> - Deprecated endpoints: Do not use deprecated endpoints. Prefer /playlists/{id}/items over /playlists/{id}/tracks, and use /me/library over the type-specific library endpoints.
> - Error handling: Handle all HTTP error codes documented in the OpenAPI schema. Read the returned error message and use it to provide meaningful feedback to the user.
> - Developer Terms of Service: Comply with the Spotify Developer Terms (https://developer.spotify.com/terms). In particular: do not cache Spotify content beyond what is needed for immediate use, always attribute content to Spotify, and do not use the API to train machine learning models on Spotify data.
