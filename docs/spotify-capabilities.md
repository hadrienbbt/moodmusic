# Spotify and ReccoBeats capabilities

What the Spotify Web API and ReccoBeats offer this app, checked in step 0 of
[PLAN.md](PLAN.md). The Spotify OpenAPI spec decides paths, parameters and
field names (§3.5). Where it disagrees with the plan, the spec wins and the
difference is listed below. `npm run probe` and `npm run probe:reccobeats`
append their live results at the end.

## Endpoints checked against the OpenAPI spec

Spec: https://developer.spotify.com/reference/web-api/open-api-schema.yaml
(OpenAPI 3.0.3, `info.version` 1.0.0, downloaded 2026-09-23, not committed).
Paths are relative to its server, `https://api.spotify.com/v1`.

| V2 use | Operation (operationId) | V2 sends | V2 reads | Spec scopes | Deprecated in the spec |
|---|---|---|---|---|---|
| Login | `GET /me` (`get-current-users-profile`) | nothing | `id`, `display_name` (`null` when not set), `images[].url` | `user-read-private`, `user-read-email` | Operation: no. Fields: `country`, `email`, `explicit_content`, `followers`, `product` |
| Import top artists | `GET /me/top/{type}` (`get-users-top-artists-and-tracks`) | `type=artists`, `limit=15` (0–50, default 20); `time_range` left at its default, `medium_term` | `items[]` (ArtistObject): `id`, `name`, `images[]` (widest first) | `user-top-read` | no |
| Add an artist by name | `GET /search` (`search`) | `q`, `type=artist`, `limit=1` (0–10, default 5) | `artists.items[0]`: `id`, `name`, `images[]` | none | no (carries the MachineLearning policy) |
| Refresh an artist | `GET /artists/{id}` (`get-an-artist`) | path `id` | `id`, `name`, `images[]` | none | Operation: no. Fields: `followers`, `genres`, `popularity` |
| Create the playlist | `POST /me/playlists` (`create-playlist`) | body `{ name, public }`; `name` is required and `public` defaults to `true`, so V2 always sends it | 201 PlaylistObject: `id`, `public`; the playlist URL is `https://open.spotify.com/playlist/{id}` | `playlist-modify-public`, `playlist-modify-private` | Operation: no. Field: `tracks` (use `items`) |
| Add the tracks | `POST /playlists/{playlist_id}/items` (`add-items-to-playlist`) | body `{ uris }`, at most 100 per request | 201 `snapshot_id` | `playlist-modify-public`, `playlist-modify-private` | no |
| Smoke check | `GET /me/playlists` (`get-a-list-of-current-users-playlists`) | `limit` (0–50, default 20) | `items[]`, `total` | `playlist-read-private` | no |
| V1 reference engine only | `GET /recommendations` (`get-recommendations`) | `seed_artists`, `limit` (1–100), `market=from_token`, `target_valence`, `target_energy`, `target_danceability` (each 0–1) | `tracks[].uri` | none | **yes** (also carries the MachineLearning policy) |

The step 0 probe also removes its test playlist. `DELETE /playlists/{playlist_id}/followers`
(`unfollow-playlist`) is deprecated; the spec points to
`DELETE /me/library?uris=spotify:playlist:{id}` (`remove-library-items`, at
most 40 URIs, scopes `user-library-modify`, `user-follow-modify`,
`playlist-modify-public`).

## Where the spec differs from the plan

1. `GET /recommendations` is deprecated in the spec. The plan keeps it only
   for the V1 reference engine behind `RECOMMENDER=spotify` (§4.7), which
   production never selects. It must stay out of every default path.
2. `DELETE /playlists/{id}/followers`, which the plan's probe uses to remove
   its test playlist, is deprecated in favour of
   `DELETE /me/library?uris=spotify:playlist:{id}`. The probe uses the library
   endpoint and falls back to the old one only if Spotify refuses it; the
   probe results show which one worked.
3. The spec lists `user-read-private` and `user-read-email` as the scopes of
   `GET /me`, and `playlist-read-private` for `GET /me/playlists`. V2 requests
   none of them (§4.3). The probe checks that `GET /me` still returns `id`,
   `display_name` and `images`. Without `playlist-read-private`,
   `GET /me/playlists` should list public playlists only, which is enough:
   V2's history comes from Firestore.
4. Deprecated fields that §3.1 does not list: ArtistObject `genres` and
   TrackObject `linked_from`. Conversely, TrackObject `external_ids` is not
   marked deprecated, although §3.1 lists it as removed for new apps. V2
   reads none of these.
5. `POST /users/{user_id}/playlists` and `POST /playlists/{id}/tracks` are
   still in the spec, marked deprecated, where §3.1 says they were removed on
   2026-03-09. V2 uses neither.

Confirmed as the plan says: `GET /search` caps `limit` at 10 (default 5),
`POST /playlists/{id}/items` takes at most 100 URIs, and every endpoint
documents 401, 403 and 429 answers (§4.5 maps them).

## ReccoBeats checks (2026-09-23, before the probe)

Plain requests, no key:
- `GET /v1/artist/{id}/track` refuses a `size` above 50 (400, "must be less
  than or equal to 50"). Its answer is paged (`page`, `size`,
  `totalElements`, `totalPages`), so appendix J's `size=50` gets the first 50
  tracks only.
- `GET /v1/audio-features` refuses more than 40 `ids` (400, "size must be
  between 1 and 40"). Results come in any order, so they must be matched by
  `href`.
- `availableCountries` can be an empty string. Appendix J's market filter
  must treat it as unknown, like a missing value.

## Spotify probe (2026-09-23 20:06 UTC)

Scopes granted: `playlist-modify-private playlist-modify-public user-top-read`. Unexpected results are in capitals. No personal data is recorded.

| Endpoint | Status | Notable fields present/missing | Spec |
|---|---|---|---|
| `GET /v1/me` | 200 | id ✓, display_name ✓, images ✓, email absent, country absent, product absent, followers PRESENT, explicit_content absent | – |
| `GET /v1/me/top/artists?limit=15` | 200 | 15 artists; first: id ✓, name ✓, images ✓, popularity PRESENT, followers PRESENT, genres present | – |
| `GET /v1/search?q=daft%20punk&type=artist&limit=1` | 200 | 1 artist; id ✓, name ✓, images ✓, popularity PRESENT, followers PRESENT, genres present | – |
| `GET /v1/search?q=daft%20punk&type=artist&limit=11` | 200, EXPECTED 400 |  | – |
| `GET /v1/artists/{id}` | 200 | id ✓, name ✓, images ✓, popularity PRESENT, followers PRESENT, genres present | – |
| `GET /v1/recommendations?seed_artists={id}&limit=1&market=from_token&target_valence=0.5` | 404 |  | DEPRECATED |
| `POST /v1/me/playlists { name, public: false }` | 201 | id ✓, public ✓, external_urls ✓, items present, tracks present; public = false | – |
| `POST /v1/playlists/{id}/items { uris: [1 track] }` | 201 | snapshot_id ✓ | – |
| `DELETE /v1/me/library?uris=spotify:playlist:{id}` | 200 | test playlist removed | – |
| `GET /v1/me/playlists?limit=1` | 200 | items ✓, total ✓ | – |

## ReccoBeats coverage (2026-09-23 20:07 UTC)

Input: 15 Spotify artists. Artist names are not recorded here.

- Artists known to ReccoBeats: 14 of 15.
- Tracks per known artist, first page of `size=50`: min 47, median 50, max 50. All of the artist's tracks on ReccoBeats: min 47, median 276, max 3557.
- Tracks with audio features: 697 of 697 (100 %).
- `availableCountries` of those tracks: empty for 72, includes FR for 577, excludes FR for 48.
- Largest accepted `size` for `/v1/artist/{id}/track`: 50 (51 refused: "must be less than or equal to 50").
- Largest accepted `ids` batch for `/v1/audio-features`: 40 (41 refused: "size must be between 1 and 40").
- Response times in ms, median / max: artist lookup 1214 / 1214, artist tracks 451 / 1222, audio features 240 / 483, limit checks 228 / 781.

## What the live runs add (2026-09-23)

- Every endpoint V2 uses answered as the spec describes, with V2's three
  scopes. That includes `GET /me` (`id`, `display_name` and `images` without
  `user-read-private` or `user-read-email`) and `GET /me/playlists` without
  `playlist-read-private`.
- `GET /recommendations` answers 404: the app has the Development Mode shape
  the plan expects.
- `DELETE /me/library?uris=spotify:playlist:{id}` removes a playlist with
  `playlist-modify-public`, so the deprecated unfollow endpoint is not needed.
- This app still receives fields that the plan (§3.1) or the spec treat as
  removed or deprecated: the user's `followers`, the artist's `popularity`,
  `followers` and `genres`, and the playlist's `tracks`. V2 must not read
  them anyway, since the spec deprecates them.
- `GET /search` accepts `limit` up to 50 for this app: 11, 20 and 50 return
  that many artists, and 51 is refused (400, "Invalid limit"). The cap of 10
  in the spec and §3.1 is not enforced today. V2 sends `limit=1`, and the fake
  Spotify server keeps the documented cap.
- ReccoBeats knows 14 of Hadrien's 15 top artists and has audio features for
  every one of their first 50 tracks, so the engine of §4.7 has seeds for
  almost everyone. About one track in ten has an empty `availableCountries`,
  which appendix J's market filter must treat as unknown.
