// Step 0 of docs/PLAN.md: checks what the Spotify Web API gives this app, with
// a real login. It serves the loopback redirect URI on 127.0.0.1:8004, prints
// the authorize URL (the scopes of plan §4.3), exchanges the code with the
// client id and secret from .env, then calls each endpoint V2 relies on. The
// table it prints (endpoint, status, notable fields, whether the OpenAPI spec
// deprecates the operation) is appended to docs/spotify-capabilities.md,
// without personal data. It creates a private "[Moodmusic test] probe"
// playlist and removes it again. Tokens are never printed.
//
// Usage: npm run probe
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import dotenv from 'dotenv'

dotenv.config({ quiet: true })

const PORT = 8004
const REDIRECT_URI = `http://127.0.0.1:${PORT}/auth/callback`
const SCOPES = 'user-top-read playlist-modify-public playlist-modify-private'
const ACCOUNTS_URL = (process.env.SPOTIFY_ACCOUNTS_URL || 'https://accounts.spotify.com').replace(/\/+$/, '')
const API_URL = (process.env.SPOTIFY_API_URL || 'https://api.spotify.com').replace(/\/+$/, '')
const SPEC_URL = 'https://developer.spotify.com/reference/web-api/open-api-schema.yaml'
const DOC = path.join(import.meta.dirname, '..', 'docs', 'spotify-capabilities.md')
const TEST_TRACK = 'spotify:track:7tFiyTwD0nx5a1eklYtX2J' // Bohemian Rhapsody, the track of plan §3.4
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000

const clientId = process.env.SPOTIFY_CLIENT_ID
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET
if (!clientId || !clientSecret) {
  console.error('SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set, for example in .env')
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
    const query = new URLSearchParams({ response_type: 'code', client_id: clientId, scope: SCOPES, redirect_uri: REDIRECT_URI, state })
    console.log(`Open this URL and log in with the Spotify account to probe:\n\n${ACCOUNTS_URL}/authorize?${query}\n`)
  })
})

const exchangeCode = async code => {
  const response = await fetch(`${ACCOUNTS_URL}/api/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`Token exchange failed: ${response.status} ${body.error ?? ''} ${body.error_description ?? ''}`.trim())
  return body
}

const call = async (token, method, pathAndQuery, body) => {
  try {
    const response = await fetch(`${API_URL}${pathAndQuery}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body && { 'Content-Type': 'application/json' }) },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
    const text = await response.text()
    let json
    try { json = JSON.parse(text) } catch {}
    return { status: response.status, json, retryAfter: response.headers.get('retry-after') }
  } catch (error) {
    return { status: 0, error: error.message }
  }
}

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
const messageOf = result => result.error ?? result.json?.error?.message ?? (typeof result.json?.error === 'string' ? result.json.error : '')

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

const rows = []
const record = (label, spec, expected, result, notes) => {
  const status = result.status === 0 ? `error (${result.error})` : String(result.status)
  if (result.status === 429) notes = `rate limited, Retry-After ${result.retryAfter}`
  rows.push({
    label,
    spec,
    status: result.status === expected ? status : `${status}, EXPECTED ${expected}`,
    notes,
    unexpected: result.status !== expected || /MISSING|PRESENT|BY HAND/.test(notes),
  })
}

let tokenBody
try {
  tokenBody = await exchangeCode(await waitForCode(crypto.randomBytes(16).toString('hex')))
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
const token = tokenBody.access_token
console.log('Logged in. Probing…\n')
const specText = await fetch(SPEC_URL, { signal: AbortSignal.timeout(30_000) }).then(response => (response.ok ? response.text() : null), () => null)

const me = await call(token, 'GET', '/v1/me')
record('GET /v1/me', ['get', '/me'], 200, me,
  fieldsOf(me.json, { present: ['id', 'display_name', 'images'], absent: ['email', 'country', 'product', 'followers', 'explicit_content'] }))

const top = await call(token, 'GET', '/v1/me/top/artists?limit=15')
const topArtists = top.json?.items ?? []
record('GET /v1/me/top/artists?limit=15', ['get', '/me/top/{type}'], 200, top,
  `${topArtists.length} artists; first: ${fieldsOf(topArtists[0], { present: ['id', 'name', 'images'], absent: ['popularity', 'followers'], info: ['genres'] })}`)

const search = await call(token, 'GET', '/v1/search?q=daft%20punk&type=artist&limit=1')
const found = search.json?.artists?.items ?? []
record('GET /v1/search?q=daft%20punk&type=artist&limit=1', ['get', '/search'], 200, search,
  `${found.length} artist; ${fieldsOf(found[0], { present: ['id', 'name', 'images'], absent: ['popularity', 'followers'], info: ['genres'] })}`)

const searchEleven = await call(token, 'GET', '/v1/search?q=daft%20punk&type=artist&limit=11')
record('GET /v1/search?q=daft%20punk&type=artist&limit=11', ['get', '/search'], 400, searchEleven,
  searchEleven.status === 200 ? `${searchEleven.json?.artists?.items?.length ?? 0} artists returned` : messageOf(searchEleven))

const artistId = found[0]?.id ?? topArtists[0]?.id
const artist = await call(token, 'GET', `/v1/artists/${artistId}`)
record('GET /v1/artists/{id}', ['get', '/artists/{id}'], 200, artist,
  fieldsOf(artist.json, { present: ['id', 'name', 'images'], absent: ['popularity', 'followers'], info: ['genres'] }))

const recommendations = await call(token, 'GET', `/v1/recommendations?seed_artists=${artistId}&limit=1&market=from_token&target_valence=0.5`)
record('GET /v1/recommendations?seed_artists={id}&limit=1&market=from_token&target_valence=0.5', ['get', '/recommendations'], 404, recommendations,
  recommendations.status === 200 ? `${recommendations.json?.tracks?.length ?? 0} tracks` : messageOf(recommendations))

const created = await call(token, 'POST', '/v1/me/playlists', { name: '[Moodmusic test] probe', public: false })
const playlistId = created.json?.id
record('POST /v1/me/playlists { name, public: false }', ['post', '/me/playlists'], 201, created,
  playlistId ? `${fieldsOf(created.json, { present: ['id', 'public', 'external_urls'], info: ['items', 'tracks'] })}; public = ${created.json.public}` : messageOf(created))

if (playlistId) {
  try {
    const added = await call(token, 'POST', `/v1/playlists/${playlistId}/items`, { uris: [TEST_TRACK] })
    record('POST /v1/playlists/{id}/items { uris: [1 track] }', ['post', '/playlists/{playlist_id}/items'], 201, added,
      added.json?.snapshot_id ? 'snapshot_id ✓' : messageOf(added))
  } finally {
    // The spec replaces the unfollow endpoint with the library one; the old one
    // is only tried if the new one is refused, so the playlist never stays.
    const removed = await call(token, 'DELETE', `/v1/me/library?uris=${encodeURIComponent(`spotify:playlist:${playlistId}`)}`)
    record('DELETE /v1/me/library?uris=spotify:playlist:{id}', ['delete', '/me/library'], 200, removed,
      removed.status === 200 ? 'test playlist removed' : messageOf(removed))
    if (removed.status !== 200) {
      const unfollowed = await call(token, 'DELETE', `/v1/playlists/${playlistId}/followers`)
      record('DELETE /v1/playlists/{id}/followers', ['delete', '/playlists/{playlist_id}/followers'], 200, unfollowed,
        unfollowed.status === 200 ? 'test playlist removed' : `${messageOf(unfollowed)}: REMOVE "[Moodmusic test] probe" BY HAND`)
    }
  }
}

const playlists = await call(token, 'GET', '/v1/me/playlists?limit=1')
record('GET /v1/me/playlists?limit=1', ['get', '/me/playlists'], 200, playlists,
  fieldsOf(playlists.json, { present: ['items', 'total'] }))

const cell = text => String(text).replaceAll('|', '\\|')
const table = [
  '| Endpoint | Status | Notable fields present/missing | Spec |',
  '|---|---|---|---|',
  ...rows.map(row => `| \`${cell(row.label)}\` | ${cell(row.status)} | ${cell(row.notes)} | ${deprecation(specText, ...row.spec)} |`),
].join('\n')
const when = new Date().toISOString().slice(0, 16).replace('T', ' ')
fs.appendFileSync(DOC, `\n## Spotify probe (${when} UTC)\n\nScopes granted: \`${tokenBody.scope}\`. Unexpected results are in capitals. No personal data is recorded.\n\n${table}\n`)

console.log(`${table}\n\nAppended to docs/spotify-capabilities.md.`)
const unexpected = rows.filter(row => row.unexpected)
console.log(unexpected.length === 0 ? 'Every answer is as expected.' : `Unexpected: ${unexpected.map(row => row.label).join('; ')}`)
if (topArtists.length > 0) {
  console.log(`\nTop artists (not recorded):\n${topArtists.map(({ id, name }) => `  ${id}  ${name}`).join('\n')}`)
  console.log(`\nNext: npm run probe:reccobeats -- ${topArtists.map(({ id }) => id).join(' ')}`)
}
