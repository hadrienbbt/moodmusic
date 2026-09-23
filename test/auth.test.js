// The login of plan §4.3 and appendix H, end to end: the real server, the
// Firestore emulator and the fake Spotify. Skipped without the emulator (run
// `npm run test:emulator`).
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { fakeArtist, startFakeSpotify } from './helpers/fake-spotify.js'
import { adminFirestore, emulatorHost, listDocuments, readDocument, resetFirestore, skip } from './helpers/firestore.js'
import { login as loginWith } from './helpers/login.js'
import { createClient, startServer, testEnv } from './helpers/server.js'

const APP_ORIGIN = 'http://moodmusic.test'
const SCOPES = 'user-top-read playlist-modify-public playlist-modify-private'
const DAY_MS = 24 * 60 * 60 * 1000
const TOP_ARTISTS = Array.from({ length: 20 }, (_, i) => fakeArtist(`artist-${i + 1}`, `Artist ${i + 1}`))

let spotify
let server
const clients = []

before(async () => {
  if (skip) return
  spotify = await startFakeSpotify({ clientId: testEnv.SPOTIFY_CLIENT_ID, clientSecret: testEnv.SPOTIFY_CLIENT_SECRET })
  server = await startServer({ ...testEnv, APP_ORIGIN, SPOTIFY_ACCOUNTS_URL: spotify.url, SPOTIFY_API_URL: spotify.url, FIRESTORE_EMULATOR_HOST: emulatorHost })
})

after(async () => {
  await server?.stop()
  await spotify?.stop()
})

beforeEach(async () => {
  if (skip) return
  await resetFirestore()
})

const browser = () => {
  const client = createClient(server.url)
  clients.push(client)
  return client
}
const sessionCookie = client => client.cookies.get('moodmusic.sid')
const sessionIdOf = cookie => decodeURIComponent(cookie).match(/^s:(.+)\.[^.]+$/)[1]
const topArtistImports = () => spotify.requests.filter(request => request.path === '/v1/me/top/artists').length

const login = (client, options) => loginWith(spotify, client, options)

test('a first login creates the user with their top 15 artists and a session', { skip }, async () => {
  spotify.addUser({ id: 'alice', displayName: 'Alice Martin', topArtists: TOP_ARTISTS })
  const client = browser()
  const before = await client.request('/api/session')
  assert.equal(before.status, 401)
  assert.deepEqual(before.json, { error: 'unauthenticated' })

  const { start, cookieAfterStart, back, callback } = await login(client, { as: 'alice' })
  assert.equal(start.status, 302)
  const authorize = new URL(start.location)
  assert.equal(`${authorize.origin}${authorize.pathname}`, `${spotify.url}/authorize`)
  const { state, ...params } = Object.fromEntries(authorize.searchParams)
  assert.deepEqual(params, { response_type: 'code', client_id: 'test-client-id', scope: SCOPES, redirect_uri: `${APP_ORIGIN}/auth/callback` })
  assert.match(state, /^[0-9a-f]{32}$/)
  assert.equal(back.searchParams.get('state'), state)

  assert.equal(callback.status, 302)
  assert.equal(callback.location, '/onboarding')
  assert.ok(cookieAfterStart && sessionCookie(client) && sessionCookie(client) !== cookieAfterStart, 'the session id changes at login')

  const exchange = spotify.requests.find(request => request.path === '/api/token')
  assert.deepEqual(Object.fromEntries(new URLSearchParams(exchange.body)), { grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: `${APP_ORIGIN}/auth/callback` })
  assert.equal(spotify.requests.find(request => request.path === '/v1/me/top/artists').query.limit, '15')

  const image = spotify.user('alice').images[0].url
  const session = await client.request('/api/session')
  assert.equal(session.status, 200)
  assert.deepEqual(session.json, { user: { id: 'alice', displayName: 'Alice Martin', image, isNew: true } })

  const user = await readDocument('users/alice')
  assert.equal(user.displayName, 'Alice Martin')
  assert.equal(user.image, image)
  assert.ok(user.createdAt instanceof Date && user.lastLoginAt instanceof Date)
  assert.deepEqual(user.artists.map(artist => artist.id), TOP_ARTISTS.slice(0, 15).map(artist => artist.id), 'Spotify order')
  for (const [i, artist] of user.artists.entries()) {
    assert.equal(artist.name, TOP_ARTISTS[i].name)
    assert.equal(artist.image, TOP_ARTISTS[i].images[1].url, 'the middle-size image')
    assert.deepEqual(artist.moods, [])
    assert.ok(!Number.isNaN(Date.parse(artist.addedAt)))
    assert.equal(artist.refreshedAt, artist.addedAt)
  }

  // The session, tokens included, is on the server only; the cookie holds its id.
  const sessions = await listDocuments('sessions')
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].id, sessionIdOf(sessionCookie(client)))
  const stored = JSON.parse(sessions[0].data.data)
  assert.deepEqual(stored.user, { id: 'alice', displayName: 'Alice Martin', image })
  assert.ok(spotify.issued.includes(stored.tokens.access) && spotify.issued.includes(stored.tokens.refresh))
  assert.ok(stored.tokens.expiresAt > Date.now() + 3500 * 1000)
  assert.equal(stored.oauthState, undefined)
  assert.ok(Math.abs(sessions[0].data.expiresAt.getTime() - (Date.now() + 30 * DAY_MS)) < 60_000)
})

test('the session cookie is httpOnly, SameSite=Lax, and lasts 30 days', { skip }, async () => {
  const start = await browser().request('/auth/login')
  const cookie = start.setCookies.find(header => header.startsWith('moodmusic.sid='))
  assert.ok(cookie, start.setCookies.join('\n'))
  const attributes = cookie.split(';').slice(1).map(attribute => attribute.trim().toLowerCase())
  assert.ok(attributes.includes('httponly'))
  assert.ok(attributes.includes('samesite=lax'))
  assert.ok(attributes.includes('path=/'))
  assert.ok(!attributes.includes('secure'), 'Secure only in production (production.test.js)')
  const expires = Date.parse(cookie.match(/expires=([^;]+)/i)[1])
  assert.ok(Math.abs(expires - (Date.now() + 30 * DAY_MS)) < 60_000)
})

test('a returning user goes home, keeps their artists and is not imported again', { skip }, async () => {
  spotify.addUser({ id: 'bob', displayName: 'Bob', topArtists: TOP_ARTISTS })
  await login(browser(), { as: 'bob' })
  const first = await readDocument('users/bob')
  const imports = topArtistImports()

  spotify.addUser({ id: 'bob', displayName: 'Bobby', topArtists: TOP_ARTISTS.slice(5) })
  const { callback } = await login(browser(), { as: 'bob' })
  assert.equal(callback.location, '/')
  const again = await readDocument('users/bob')
  assert.equal(again.displayName, 'Bobby')
  assert.deepEqual(again.artists, first.artists)
  assert.equal(again.createdAt.getTime(), first.createdAt.getTime())
  assert.ok(again.lastLoginAt >= first.lastLoginAt)
  assert.equal(topArtistImports(), imports)
})

test('isNew stays true until one of the artists has a mood', { skip }, async () => {
  spotify.addUser({ id: 'nina', topArtists: TOP_ARTISTS })
  const client = browser()
  await login(client, { as: 'nina' })
  assert.equal((await client.request('/api/session')).json.user.isNew, true)

  const ref = adminFirestore().doc('users/nina')
  const { artists } = (await ref.get()).data()
  artists[3].moods = ['happy']
  await ref.update({ artists })
  assert.equal((await client.request('/api/session')).json.user.isNew, false)
})

test('the login succeeds even when the top artists cannot be imported', { skip }, async () => {
  spotify.addUser({ id: 'omar', topArtists: TOP_ARTISTS, topArtistsStatus: 500 })
  const client = browser()
  const { callback } = await login(client, { as: 'omar' })
  assert.equal(callback.location, '/onboarding')
  assert.deepEqual((await readDocument('users/omar')).artists, [])
  assert.equal((await client.request('/api/session')).status, 200)
  assert.match(server.output(), /Top artists import failed/)
})

test('a callback with the wrong state is refused and leaves no session', { skip }, async () => {
  spotify.addUser({ id: 'carl', topArtists: TOP_ARTISTS })
  const client = browser()
  const { back, callback } = await login(client, { as: 'carl', state: 'f'.repeat(32) })
  assert.equal(callback.status, 400)
  assert.match(callback.headers.get('content-type'), /^text\/html/)
  assert.ok(callback.text.includes('Connexion impossible, réessaie.'))
  assert.ok(callback.text.includes('<a href="/auth/login">Réessayer</a>'))
  assert.ok(!spotify.requests.some(request => request.path === '/api/token' && request.body.includes(back.searchParams.get('code'))), 'the code is never exchanged')
  assert.deepEqual(await listDocuments('sessions'), [])
  assert.equal(await readDocument('users/carl'), null)
  assert.equal((await client.request('/api/session')).status, 401)
})

test('a callback without a login started, or refused on Spotify, leaves no session', { skip }, async () => {
  const direct = await browser().request('/auth/callback?code=abc&state=def')
  assert.equal(direct.status, 400)
  const { callback } = await login(browser(), { deny: true })
  assert.equal(callback.status, 400)
  assert.ok(callback.text.includes('Connexion impossible, réessaie.'))
  assert.deepEqual(await listDocuments('sessions'), [])
})

test('an account missing from the allow-list gets the dedicated page and no session', { skip }, async () => {
  spotify.addUser({ id: 'dora', topArtists: TOP_ARTISTS, allowListed: false })
  const client = browser()
  const { callback } = await login(client, { as: 'dora' })
  assert.equal(callback.status, 403)
  assert.match(callback.headers.get('content-type'), /^text\/html/)
  assert.ok(callback.text.includes('Compte non autorisé : Moodmusic est une application Spotify en mode développement limitée à 5 utilisateurs. Demande à Hadrien d&#39;ajouter ton compte, puis reconnecte-toi.'))
  assert.ok(callback.text.includes('<a href="/auth/login">Réessayer</a>'))
  assert.deepEqual(await listDocuments('sessions'), [])
  assert.equal(await readDocument('users/dora'), null)
  assert.equal((await client.request('/api/session')).status, 401)
})

test('logout destroys the session', { skip }, async () => {
  spotify.addUser({ id: 'emma', topArtists: TOP_ARTISTS })
  const client = browser()
  await login(client, { as: 'emma' })
  const cookie = sessionCookie(client)
  assert.equal((await listDocuments('sessions')).length, 1)

  const logout = await client.request('/auth/logout', { method: 'POST', headers: { Origin: APP_ORIGIN } })
  assert.equal(logout.status, 204)
  assert.ok(logout.setCookies.some(header => header.startsWith('moodmusic.sid=;')), 'the cookie is cleared')
  assert.deepEqual(await listDocuments('sessions'), [])
  const replayed = await browser().request('/api/session', { headers: { Cookie: `moodmusic.sid=${cookie}` } })
  assert.equal(replayed.status, 401, 'the old cookie no longer opens a session')
})

test('a POST from another origin is refused', { skip }, async () => {
  spotify.addUser({ id: 'finn', topArtists: TOP_ARTISTS })
  const client = browser()
  await login(client, { as: 'finn' })
  const forged = await client.request('/auth/logout', { method: 'POST', headers: { Origin: 'https://evil.example' } })
  assert.equal(forged.status, 403)
  assert.deepEqual(forged.json, { error: 'Origine non autorisée' })
  assert.equal((await client.request('/api/session')).status, 200, 'the session is still there')
  const withoutOrigin = await client.request('/auth/logout', { method: 'POST' })
  assert.equal(withoutOrigin.status, 204, 'a request without Origin is not cross-site')
})

// Runs last: covers every response of this file.
test('no Spotify token ever reaches the browser or the server log', { skip }, async () => {
  assert.ok(spotify.issued.length >= 10)
  const responses = clients.flatMap(client => client.responses)
  assert.ok(responses.length >= 30)
  for (const response of responses) {
    const visible = [response.text, response.location ?? '', ...response.setCookies].join('\n')
    for (const token of spotify.issued) assert.ok(!visible.includes(token), `a token is in a ${response.status} response`)
  }
  for (const token of spotify.issued) assert.ok(!server.output().includes(token), 'a token is in the server log')
})
