// How the server fails (plan §4.5, §4.10).
// - Firestore down: a local server refuses every call at once
//   (helpers/failing-firestore.js) rather than a closed port, which the
//   client would retry for about 40 s. Needs no emulator.
// - Spotify failing: the fake Spotify scripts the failures; needs the
//   emulator. The 429 cases really wait (1 + 2 s, then 1 + 2 + 4 s).
// Later steps add the ReccoBeats failures.
import { describe, test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import { startFailingFirestore } from './helpers/failing-firestore.js'
import { fakeArtist, startFakeSpotify } from './helpers/fake-spotify.js'
import { adminFirestore, emulatorHost, listDocuments, resetFirestore, skip as noEmulator } from './helpers/firestore.js'
import { login } from './helpers/login.js'
import { createClient, startServer, testEnv } from './helpers/server.js'

describe('with Firestore down', () => {
  const SESSION_SECRET = crypto.randomBytes(32).toString('hex')
  // A session cookie signed the way express-session signs it, for a session
  // the store has never seen: the server has to ask Firestore about it.
  const signedCookie = sid => {
    const signature = crypto.createHmac('sha256', SESSION_SECRET).update(sid).digest('base64').replace(/=+$/, '')
    return `moodmusic.sid=${encodeURIComponent(`s:${sid}.${signature}`)}`
  }
  let firestore
  let server

  before(async () => {
    firestore = await startFailingFirestore()
    server = await startServer({ ...testEnv, SESSION_SECRET, FIRESTORE_EMULATOR_HOST: firestore.host })
  })
  after(async () => {
    await server?.stop()
    await firestore?.stop()
  })

  test('the API answers 503 and the login shows a page', async () => {
    const client = createClient(server.url)
    const page = await client.request('/auth/login')
    assert.equal(page.status, 503)
    assert.match(page.headers.get('content-type'), /^text\/html/)
    assert.ok(page.text.includes('Service indisponible, réessaie plus tard'))

    const session = await client.request('/api/session', { headers: { Cookie: signedCookie('a-session-id') } })
    assert.equal(session.status, 503)
    assert.deepEqual(session.json, { error: 'Service indisponible, réessaie plus tard' })
    assert.ok(firestore.calls >= 2)
    assert.equal(server.child.exitCode, null, 'the server keeps running')
  })

  test('without a session cookie, nothing asks Firestore', async () => {
    const calls = firestore.calls
    const client = createClient(server.url)
    assert.equal((await client.request('/api/session')).status, 401)
    assert.equal((await client.request('/api/health')).status, 200)
    assert.equal(firestore.calls, calls)
  })
})

describe('with Spotify failing', { skip: noEmulator }, () => {
  const APP_ORIGIN = 'http://moodmusic.test'
  let spotify
  let server
  let users = 0

  before(async () => {
    spotify = await startFakeSpotify({ clientId: testEnv.SPOTIFY_CLIENT_ID, clientSecret: testEnv.SPOTIFY_CLIENT_SECRET })
    spotify.addArtists(fakeArtist('air', 'Air'))
    server = await startServer({ ...testEnv, APP_ORIGIN, SPOTIFY_ACCOUNTS_URL: spotify.url, SPOTIFY_API_URL: spotify.url, FIRESTORE_EMULATOR_HOST: emulatorHost })
  })
  after(async () => {
    await server?.stop()
    await spotify?.stop()
  })
  beforeEach(() => resetFirestore())

  const loggedIn = async () => {
    const id = `user${++users}`
    spotify.addUser({ id })
    const client = createClient(server.url)
    await login(spotify, client, { as: id })
    return client
  }
  // Adding an artist searches Spotify first.
  const addArtist = client => client.request('/api/me/artists', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN },
    body: JSON.stringify({ query: 'air' }),
  })

  test("a Spotify 403 is refused with Spotify's message", async () => {
    const client = await loggedIn()
    spotify.script('GET /v1/search', { status: 403, message: 'Insufficient client scope' })
    const refused = await addArtist(client)
    assert.equal(refused.status, 403)
    assert.deepEqual(refused.json, { error: 'Spotify a refusé la demande : Insufficient client scope' })
  })

  test('429 twice then 200 succeeds after the waits; four times answers 429', async () => {
    const client = await loggedIn()
    spotify.script('GET /v1/search', { status: 429 }, { status: 429 })
    const started = Date.now()
    assert.equal((await addArtist(client)).status, 201)
    assert.ok(Date.now() - started >= 3000, 'waited 1 s, then 2 s')

    spotify.script('GET /v1/search', ...Array(4).fill({ status: 429 }))
    const limited = await addArtist(client)
    assert.equal(limited.status, 429)
    assert.equal(limited.headers.get('retry-after'), '5')
    assert.deepEqual(limited.json, { error: 'Spotify limite les requêtes, réessaie dans 5 secondes.' })
  })

  test('a Retry-After of 30 s is answered at once, with the delay', async () => {
    const client = await loggedIn()
    spotify.script('GET /v1/search', { status: 429, headers: { 'Retry-After': '30' } })
    const started = Date.now()
    const limited = await addArtist(client)
    assert.ok(Date.now() - started < 1000)
    assert.equal(limited.status, 429)
    assert.equal(limited.headers.get('retry-after'), '30')
    assert.deepEqual(limited.json, { error: 'Spotify limite les requêtes, réessaie dans 30 secondes.' })
  })

  test('a Spotify outage answers 503, an unexpected refusal 502', async () => {
    const client = await loggedIn()
    spotify.script('GET /v1/search', { status: 500 })
    const down = await addArtist(client)
    assert.equal(down.status, 503)
    assert.deepEqual(down.json, { error: 'Spotify est indisponible, réessaie plus tard.' })

    spotify.script('GET /v1/search', { status: 400, message: 'Invalid query' })
    const odd = await addArtist(client)
    assert.equal(odd.status, 502)
    assert.deepEqual(odd.json, { error: 'Réponse inattendue de Spotify : Invalid query' })
  })

  test('a refused refresh token ends the session: 401 reauth', async () => {
    const client = await loggedIn()
    // The access token is due for a refresh, and Spotify refuses the refresh token.
    const [session] = await listDocuments('sessions')
    const data = JSON.parse(session.data.data)
    data.tokens.expiresAt = 0
    await adminFirestore().doc(`sessions/${session.id}`).update({ data: JSON.stringify(data) })
    spotify.revokeRefreshTokens()

    const refused = await addArtist(client)
    assert.equal(refused.status, 401)
    assert.deepEqual(refused.json, { error: 'reauth' })
    assert.deepEqual(await listDocuments('sessions'), [])
    assert.equal((await client.request('/api/session')).status, 401)
  })

  test('a 401 from Spotify also ends the session', async () => {
    const client = await loggedIn()
    spotify.expireAccessTokens()
    const refused = await addArtist(client)
    assert.equal(refused.status, 401)
    assert.deepEqual(refused.json, { error: 'reauth' })
    assert.equal((await client.request('/api/session')).status, 401)
  })
})
