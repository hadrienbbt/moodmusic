// The Spotify client (plan appendix I) against the fake Spotify, in the test
// process: token refresh, the 429 backoff, errors, and the helpers' paths and
// parameters. Waits are recorded instead of slept. No emulator needed.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { createSpotifyClient, RateLimitError, ReauthError, SpotifyError } from '../server/spotify/client.js'
import { fakeArtist, startFakeSpotify } from './helpers/fake-spotify.js'

const CLIENT = { clientId: 'test-client-id', clientSecret: 'test-client-secret' }

let spotify
let config

before(async () => {
  spotify = await startFakeSpotify(CLIENT)
  spotify.addUser({ id: 'alice', topArtists: [fakeArtist('a1', 'Air')] })
  config = { ...CLIENT, spotifyAccountsUrl: spotify.url, spotifyApiUrl: spotify.url, redirectUri: 'http://moodmusic.test/auth/callback' }
})

after(() => spotify.stop())

let sessions = 0
// A request whose session behaves like express-session's, counting saves.
const requestWith = tokens => ({
  sessionID: `session-${++sessions}`,
  session: { tokens, saves: 0, save(callback) { this.saves++; callback() } },
})
const tokensExpiringIn = ms => ({ ...spotify.issueTokens('alice'), expiresAt: Date.now() + ms })
const clientFor = (tokens, options = {}) => createSpotifyClient({ config, req: requestWith(tokens), ...options })
const since = start => spotify.requests.slice(start)
const waitRecorder = () => {
  const waits = []
  return { waits, sleep: async ms => { waits.push(ms) } }
}

test('a token with more than 60 s left is used as is', async () => {
  const tokens = tokensExpiringIn(61_000)
  const req = requestWith(tokens)
  const start = spotify.requests.length
  assert.equal((await createSpotifyClient({ config, req }).me()).id, 'alice')
  const log = since(start)
  assert.deepEqual(log.map(request => `${request.method} ${request.path}`), ['GET /v1/me'])
  assert.equal(log[0].headers.authorization, `Bearer ${tokens.access}`)
  assert.equal(req.session.saves, 0)
})

test('with less than 60 s left, the token is refreshed first and the session saved', async () => {
  const tokens = tokensExpiringIn(59_000)
  const req = requestWith(tokens)
  const start = spotify.requests.length
  await createSpotifyClient({ config, req }).me()
  const [refresh, me] = since(start)
  assert.equal(refresh.path, '/api/token')
  assert.deepEqual(Object.fromEntries(new URLSearchParams(refresh.body)), { grant_type: 'refresh_token', refresh_token: tokens.refresh })
  assert.equal(refresh.headers.authorization, `Basic ${Buffer.from('test-client-id:test-client-secret').toString('base64')}`)
  assert.notEqual(req.session.tokens.access, tokens.access)
  assert.equal(me.headers.authorization, `Bearer ${req.session.tokens.access}`)
  assert.equal(req.session.tokens.refresh, tokens.refresh, 'kept when Spotify sends no new refresh token')
  assert.ok(Math.abs(req.session.tokens.expiresAt - (Date.now() + 3600_000)) < 5000)
  assert.equal(req.session.saves, 1)
})

test('a new refresh token from Spotify replaces the old one', async t => {
  spotify.options.newRefreshToken = true
  t.after(() => { spotify.options.newRefreshToken = false })
  const tokens = tokensExpiringIn(0)
  const req = requestWith(tokens)
  await createSpotifyClient({ config, req }).me()
  assert.notEqual(req.session.tokens.refresh, tokens.refresh)
  assert.ok(spotify.issued.includes(req.session.tokens.refresh))
})

test('parallel calls of one session refresh the token once', async () => {
  const client = clientFor(tokensExpiringIn(0))
  const start = spotify.requests.length
  await Promise.all([client.me(), client.topArtists(), client.me()])
  assert.equal(since(start).filter(request => request.path === '/api/token').length, 1)
})

test('a refused refresh token (invalid_grant) means a new login, without retry', async () => {
  const client = clientFor(tokensExpiringIn(0))
  spotify.revokeRefreshTokens()
  const start = spotify.requests.length
  await assert.rejects(client.me(), ReauthError)
  assert.deepEqual(since(start).map(request => request.path), ['/api/token'])
})

test('a 401 from the API means a new login', async () => {
  const client = clientFor(tokensExpiringIn(3600_000))
  spotify.expireAccessTokens()
  await assert.rejects(client.me(), ReauthError)
})

test('429: waits 1 s, then 2 s, then succeeds', async () => {
  spotify.script('GET /v1/me', { status: 429 }, { status: 429 })
  const { waits, sleep } = waitRecorder()
  assert.equal((await clientFor(tokensExpiringIn(3600_000), { sleep }).me()).id, 'alice')
  assert.deepEqual(waits, [1000, 2000])
})

test('429 four times: gives up after waiting 1, 2 and 4 s', async () => {
  spotify.script('GET /v1/me', ...Array(4).fill({ status: 429 }))
  const { waits, sleep } = waitRecorder()
  const start = spotify.requests.length
  await assert.rejects(clientFor(tokensExpiringIn(3600_000), { sleep }).me(),
    error => error instanceof RateLimitError && error.service === 'Spotify' && error.retryAfter === 5)
  assert.deepEqual(waits, [1000, 2000, 4000])
  assert.equal(since(start).length, 4)
})

test('Retry-After is honoured up to 8 s; above that the request ends at once', async () => {
  spotify.script('GET /v1/me', { status: 429, headers: { 'Retry-After': '3' } }, { status: 429, headers: { 'Retry-After': '8' } })
  const honoured = waitRecorder()
  await clientFor(tokensExpiringIn(3600_000), { sleep: honoured.sleep }).me()
  assert.deepEqual(honoured.waits, [3000, 8000])

  spotify.script('GET /v1/me', { status: 429, headers: { 'Retry-After': '30' } })
  const refused = waitRecorder()
  await assert.rejects(clientFor(tokensExpiringIn(3600_000), { sleep: refused.sleep }).me(),
    error => error instanceof RateLimitError && error.retryAfter === 30)
  assert.deepEqual(refused.waits, [])
})

test("Spotify's refusals carry its status and message", async () => {
  const client = clientFor(tokensExpiringIn(3600_000))
  for (const status of [400, 403, 404, 500, 503]) {
    spotify.script('GET /v1/me', { status, message: `Message ${status}` })
    await assert.rejects(client.me(), error => error instanceof SpotifyError && error.status === status && error.message === `Message ${status}` && error.path === '/v1/me')
  }
})

test('a timeout or an unreachable Spotify is a SpotifyError with status 0', async () => {
  spotify.script('GET /v1/me', { hang: true })
  const started = Date.now()
  await assert.rejects(clientFor(tokensExpiringIn(3600_000), { timeoutMs: 300 }).me(),
    error => error instanceof SpotifyError && error.status === 0 && /in time/.test(error.message))
  assert.ok(Date.now() - started < 3000)
  const unreachable = createSpotifyClient({ config: { ...config, spotifyApiUrl: 'http://127.0.0.1:1' }, req: requestWith(tokensExpiringIn(3600_000)) })
  await assert.rejects(unreachable.me(), error => error instanceof SpotifyError && error.status === 0)
})

test('the helpers use the paths, parameters and bodies of the OpenAPI spec', async () => {
  spotify.addArtists(fakeArtist('dp', 'Daft Punk'))
  const client = clientFor(tokensExpiringIn(3600_000))
  const start = spotify.requests.length

  assert.equal((await client.searchArtist('daft punk')).artists.items[0].id, 'dp')
  assert.equal((await client.artist('dp')).name, 'Daft Punk')
  assert.equal((await client.topArtists()).items.length, 1)
  const playlist = await client.createPlaylist({ name: '[Moodmusic] Soirée', public: false })
  assert.equal(playlist.public, false)
  const uris = Array.from({ length: 250 }, (_, i) => `spotify:track:t${i}`)
  await client.addItems(playlist.id, uris)
  assert.deepEqual(spotify.playlists.get(playlist.id).items, uris, 'every item, in order')
  assert.equal((await client.myPlaylists()).items[0].id, playlist.id)

  const log = since(start)
  const items = `POST /v1/playlists/${playlist.id}/items`
  assert.deepEqual(log.map(request => `${request.method} ${request.path}`),
    ['GET /v1/search', 'GET /v1/artists/dp', 'GET /v1/me/top/artists', 'POST /v1/me/playlists', items, items, items, 'GET /v1/me/playlists'])
  assert.deepEqual(log[0].query, { q: 'daft punk', type: 'artist', limit: '1' })
  assert.deepEqual(log[2].query, { limit: '15' })
  assert.deepEqual(JSON.parse(log[3].body), { name: '[Moodmusic] Soirée', public: false })
  assert.deepEqual(log.slice(4, 7).map(request => JSON.parse(request.body).uris.length), [100, 100, 50])
  assert.deepEqual(log[7].query, { limit: '50' })
})

test('the V1 recommendations call sends market=from_token and meets the Development Mode 404', async t => {
  const client = clientFor(tokensExpiringIn(3600_000))
  const params = { seed_artists: 'a1,a2', limit: 30, target_valence: 0.4719, target_energy: 0.6781 }
  const start = spotify.requests.length
  await assert.rejects(client.recommendations(params), error => error instanceof SpotifyError && error.status === 404)
  assert.deepEqual(since(start)[0].query, { market: 'from_token', seed_artists: 'a1,a2', limit: '30', target_valence: '0.4719', target_energy: '0.6781' })

  spotify.options.recommendations = true
  t.after(() => { spotify.options.recommendations = false })
  assert.equal((await client.recommendations(params)).tracks.length, 30)
})
