// Step 0 of docs/PLAN.md: checks what the Spotify Web API gives this app, with
// a real login. It serves the loopback redirect URI on 127.0.0.1:8004, prints
// the authorize URL (the scopes of plan §4.3), exchanges the code with the
// client id and secret from .env, then calls each endpoint V2 relies on
// through the server's Spotify client. The table it prints (endpoint, status,
// notable fields, whether the OpenAPI spec deprecates the operation) is
// appended to docs/spotify-capabilities.md, without personal data. It
// creates a private "[Moodmusic test] probe" playlist and removes it again.
// Tokens are never printed.
//
// Usage: npm run probe
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import dotenv from 'dotenv'

import { ConfigError, loadConfig } from '../server/config.js'
import { exchangeCode } from '../server/spotify/accounts.js'
import { RateLimitError, ReauthError, SpotifyError, createSpotifyClient } from '../server/spotify/client.js'
import { SCOPES } from '../server/auth/routes.js'

dotenv.config({ quiet: true })

const PORT = 8004
const REDIRECT_URI = `http://127.0.0.1:${PORT}/auth/callback`
const SPEC_URL = 'https://developer.spotify.com/reference/web-api/open-api-schema.yaml'
const DOC = path.join(import.meta.dirname, '..', 'docs', 'spotify-capabilities.md')
const TEST_TRACK = 'spotify:track:7tFiyTwD0nx5a1eklYtX2J' // Bohemian Rhapsody, the track of plan §3.4
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000

let config
try {
  // The probe's own redirect URI, registered for it and the local server.
  config = { ...loadConfig({ ...process.env, NODE_ENV: 'development' }), redirectUri: REDIRECT_URI }
} catch (error) {
  if (!(error instanceof ConfigError)) throw error
  console.error(error.message)
  process.exit(1)
}

// Serves the redirect URI until Spotify sends the user back with a code.
const waitForCode = state => new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, REDIRECT_URI)
    if (url.pathname !== '/auth/callback') return res.writeHead(404).end()
    const code = url.searchParams.get('state') === state ? url.searchParams.get('code') : null
    const problem = url.searchParams.get('error') ?? 'state mismatch'
    res.writeHead(code ? 200 : 400, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(code ? 'Moodmusic probe: login received, you can close this tab.' : `Moodmusic probe: login failed (${problem}).`)
    finish(code ? null : new Error(`Login failed: ${problem}`), code)
  })
  const timer = setTimeout(() => finish(new Error('No login within 15 minutes')), LOGIN_TIMEOUT_MS)
  const finish = (error, code) => {
    clearTimeout(timer)
    server.close()
    if (error) reject(error)
    else resolve(code)
  }
  server.on('error', error => finish(error.code === 'EADDRINUSE' ? new Error(`Port ${PORT} is in use: stop the dev server first`) : error))
  server.listen(PORT, '127.0.0.1', () => {
    const query = new URLSearchParams({ response_type: 'code', client_id: config.clientId, scope: SCOPES, redirect_uri: REDIRECT_URI, state })
    console.log(`Open this URL and log in with the Spotify account to probe:\n\n${config.spotifyAccountsUrl}/authorize?${query}\n`)
  })
})

// "id ✓, email absent": what an answer contains. A field V2 reads that is
// missing, or a field the plan says is gone that is still sent, is written in
// capitals. `info` fields (deprecated in the spec, unused by V2) are only
// reported.
const fieldsOf = (object, { present = [], absent = [], info = [] }) => {
  const has = key => object != null && object[key] !== undefined
  return [
    ...present.map(key => (has(key) ? `${key} ✓` : `${key} MISSING`)),
    ...absent.map(key => (has(key) ? `${key} PRESENT` : `${key} absent`)),
    ...info.map(key => `${key} ${has(key) ? 'present' : 'absent'}`),
  ].join(', ')
}

// Whether the spec deprecates an operation, read from its YAML layout: paths
// are indented by 2 spaces, methods by 4 and operation fields by 6.
const deprecation = (specText, method, specPath) => {
  if (!specText) return 'spec unavailable'
  const lines = specText.split('\n')
  const start = lines.indexOf(`  ${specPath}:`)
  if (start === -1) return 'not in spec'
  for (let i = start + 1; i < lines.length && !/^ {0,2}\S/.test(lines[i]); i++) {
    if (lines[i] !== `    ${method}:`) continue
    for (let j = i + 1; j < lines.length && !/^ {0,4}\S/.test(lines[j]); j++) {
      if (/^ {6}deprecated: true\s*$/.test(lines[j])) return 'DEPRECATED'
    }
    return '–'
  }
  return 'not in spec'
}

let tokens
try {
  tokens = await exchangeCode(config, await waitForCode(crypto.randomBytes(16).toString('hex')))
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
console.log('Logged in. Probing…\n')

// One call through the client: { status, json } with the status the client
// saw, or { status, error } when the client throws.
let lastStatus
const client = createSpotifyClient({ config, accessToken: () => tokens.access_token, onResponse: ({ status }) => { lastStatus = status } })
const probe = async call => {
  lastStatus = undefined
  try {
    const json = await call()
    return { status: lastStatus, json: json ?? {} }
  } catch (error) {
    if (error instanceof SpotifyError || error instanceof ReauthError) return { status: error.status ?? 401, error: error.message }
    if (error instanceof RateLimitError) return { status: 429, error: `rate limited, Retry-After ${error.retryAfter}` }
    throw error
  }
}

const specText = await fetch(SPEC_URL, { signal: AbortSignal.timeout(30_000) }).then(response => (response.ok ? response.text() : null), () => null)
const rows = []
const record = (label, spec, expected, result, notes) => {
  const status = result.status === 0 ? `error (${result.error})` : String(result.status)
  rows.push({
    label,
    spec,
    status: result.status === expected ? status : `${status}, EXPECTED ${expected}`,
    notes: notes ?? result.error ?? '',
    unexpected: result.status !== expected || /MISSING|PRESENT|BY HAND/.test(notes ?? ''),
  })
}
const ok = result => result.json !== undefined

const me = await probe(() => client.me())
record('GET /v1/me', ['get', '/me'], 200, me,
  ok(me) ? fieldsOf(me.json, { present: ['id', 'display_name', 'images'], absent: ['email', 'country', 'product', 'followers', 'explicit_content'] }) : undefined)

const top = await probe(() => client.topArtists(15))
const topArtists = top.json?.items ?? []
record('GET /v1/me/top/artists?limit=15', ['get', '/me/top/{type}'], 200, top,
  ok(top) ? `${topArtists.length} artists; first: ${fieldsOf(topArtists[0], { present: ['id', 'name', 'images'], absent: ['popularity', 'followers'], info: ['genres'] })}` : undefined)

const search = await probe(() => client.searchArtist('daft punk'))
const found = search.json?.artists?.items ?? []
record('GET /v1/search?q=daft%20punk&type=artist&limit=1', ['get', '/search'], 200, search,
  ok(search) ? `${found.length} artist; ${fieldsOf(found[0], { present: ['id', 'name', 'images'], absent: ['popularity', 'followers'], info: ['genres'] })}` : undefined)

const searchEleven = await probe(() => client.request('GET', '/v1/search', { query: { q: 'daft punk', type: 'artist', limit: 11 } }))
record('GET /v1/search?q=daft%20punk&type=artist&limit=11', ['get', '/search'], 400, searchEleven,
  ok(searchEleven) ? `${searchEleven.json?.artists?.items?.length ?? 0} artists returned` : undefined)

const artistId = found[0]?.id ?? topArtists[0]?.id
const artist = await probe(() => client.artist(artistId))
record('GET /v1/artists/{id}', ['get', '/artists/{id}'], 200, artist,
  ok(artist) ? fieldsOf(artist.json, { present: ['id', 'name', 'images'], absent: ['popularity', 'followers'], info: ['genres'] }) : undefined)

const recommendations = await probe(() => client.recommendations({ seed_artists: artistId, limit: 1, target_valence: 0.5 }))
record('GET /v1/recommendations?seed_artists={id}&limit=1&market=from_token&target_valence=0.5', ['get', '/recommendations'], 404, recommendations,
  ok(recommendations) ? `${recommendations.json?.tracks?.length ?? 0} tracks` : undefined)

const created = await probe(() => client.createPlaylist({ name: '[Moodmusic test] probe', public: false }))
const playlistId = created.json?.id
record('POST /v1/me/playlists { name, public: false }', ['post', '/me/playlists'], 201, created,
  playlistId ? `${fieldsOf(created.json, { present: ['id', 'public', 'external_urls'], info: ['items', 'tracks'] })}; public = ${created.json.public}` : undefined)

if (playlistId) {
  try {
    const added = await probe(() => client.request('POST', `/v1/playlists/${playlistId}/items`, { body: { uris: [TEST_TRACK] } }))
    record('POST /v1/playlists/{id}/items { uris: [1 track] }', ['post', '/playlists/{playlist_id}/items'], 201, added,
      ok(added) ? (added.json?.snapshot_id ? 'snapshot_id ✓' : 'snapshot_id MISSING') : undefined)
  } finally {
    // The spec replaces the unfollow endpoint with the library one; the old one
    // is only tried if the new one is refused, so the playlist never stays.
    const removed = await probe(() => client.request('DELETE', '/v1/me/library', { query: { uris: `spotify:playlist:${playlistId}` } }))
    record('DELETE /v1/me/library?uris=spotify:playlist:{id}', ['delete', '/me/library'], 200, removed, ok(removed) ? 'test playlist removed' : undefined)
    if (!ok(removed)) {
      const unfollowed = await probe(() => client.request('DELETE', `/v1/playlists/${playlistId}/followers`))
      record('DELETE /v1/playlists/{id}/followers', ['delete', '/playlists/{playlist_id}/followers'], 200, unfollowed,
        ok(unfollowed) ? 'test playlist removed' : `${unfollowed.error}: REMOVE "[Moodmusic test] probe" BY HAND`)
    }
  }
}

const playlists = await probe(() => client.myPlaylists(1))
record('GET /v1/me/playlists?limit=1', ['get', '/me/playlists'], 200, playlists,
  ok(playlists) ? fieldsOf(playlists.json, { present: ['items', 'total'] }) : undefined)

const cell = text => String(text).replaceAll('|', '\\|')
const table = [
  '| Endpoint | Status | Notable fields present/missing | Spec |',
  '|---|---|---|---|',
  ...rows.map(row => `| \`${cell(row.label)}\` | ${cell(row.status)} | ${cell(row.notes)} | ${deprecation(specText, ...row.spec)} |`),
].join('\n')
const when = new Date().toISOString().slice(0, 16).replace('T', ' ')
fs.appendFileSync(DOC, `\n## Spotify probe (${when} UTC)\n\nScopes granted: \`${tokens.scope}\`. Unexpected results are in capitals. No personal data is recorded.\n\n${table}\n`)

console.log(`${table}\n\nAppended to docs/spotify-capabilities.md.`)
const unexpected = rows.filter(row => row.unexpected)
console.log(unexpected.length === 0 ? 'Every answer is as expected.' : `Unexpected: ${unexpected.map(row => row.label).join('; ')}`)
if (topArtists.length > 0) {
  console.log(`\nTop artists (not recorded):\n${topArtists.map(({ id, name }) => `  ${id}  ${name}`).join('\n')}`)
  console.log(`\nNext: npm run probe:reccobeats -- ${topArtists.map(({ id }) => id).join(' ')}`)
}
