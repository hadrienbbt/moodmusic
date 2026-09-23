// The artists and moods API (plan §4.5, step 5) end to end: the real server,
// the Firestore emulator and the fake Spotify. Skipped without the emulator.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { fakeArtist, startFakeSpotify } from './helpers/fake-spotify.js'
import { adminFirestore, emulatorHost, readDocument, resetFirestore, skip } from './helpers/firestore.js'
import { login, waitFor } from './helpers/login.js'
import { createClient, startServer, testEnv } from './helpers/server.js'

const APP_ORIGIN = 'http://moodmusic.test'
const DAY_MS = 24 * 60 * 60 * 1000
const TOP = Array.from({ length: 17 }, (_, i) => fakeArtist(`top${i + 1}`, `Top ${i + 1}`))
// Images as Spotify can send them: three sizes, a single one, none.
TOP[1] = { ...TOP[1], images: [{ url: 'https://i.scdn.co/image/only-one', height: 64, width: 64 }] }
TOP[2] = { ...TOP[2], images: [] }

let spotify
let server
let users = 0

before(async () => {
  if (skip) return
  spotify = await startFakeSpotify({ clientId: testEnv.SPOTIFY_CLIENT_ID, clientSecret: testEnv.SPOTIFY_CLIENT_SECRET })
  spotify.addArtists(fakeArtist('daftpunk', 'Daft Punk'), fakeArtist('air', 'Air'))
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

// A logged-in browser for a new user with the given top artists.
const newUser = async (topArtists = TOP) => {
  const id = `user${++users}`
  spotify.addUser({ id, topArtists })
  const client = createClient(server.url)
  await login(spotify, client, { as: id })
  return { id, client }
}
const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN }, body: JSON.stringify(body) })
const artistsOf = async client => (await client.request('/api/me/artists')).json.artists

test('the first login imports the top 15 artists, in order, with the middle-size image', { skip }, async () => {
  const { client } = await newUser()
  const artists = await artistsOf(client)
  assert.deepEqual(artists.map(artist => artist.id), TOP.slice(0, 15).map(artist => artist.id))
  assert.equal(artists[0].image, TOP[0].images[1].url, 'the middle one of three')
  assert.equal(artists[1].image, 'https://i.scdn.co/image/only-one', 'else the only one')
  assert.equal(artists[2].image, null, 'else none')
  assert.deepEqual(artists[0], { id: 'top1', name: 'Top 1', image: TOP[0].images[1].url, moods: [], profile: null })
})

test('GET /api/moods lists the eight moods in table order, without login', { skip }, async () => {
  const moods = (await createClient(server.url).request('/api/moods')).json
  assert.deepEqual(moods.map(mood => mood.state), ['dance', 'excited', 'happy', 'serene', 'tired', 'nostalgic', 'sad', 'upset'])
  assert.deepEqual(moods[0], { state: 'dance', emoji: '💃', label: 'dansant', order: 1 })
})

test('the artists API needs a login', { skip }, async () => {
  const anonymous = createClient(server.url)
  for (const [path, init] of [['/api/me/artists'], ['/api/me/artists', json('POST', { query: 'air' })], ['/api/me/artists/import-top', json('POST', {})],
    ['/api/me/artists/top1/moods', json('PUT', { moods: ['happy'] })], ['/api/me/artists/top1', { method: 'DELETE' }]]) {
    const response = await anonymous.request(path, init)
    assert.equal(response.status, 401, path)
    assert.deepEqual(response.json, { error: 'unauthenticated' })
  }
})

test('adding an artist by name: found, not found, already there', { skip }, async () => {
  const { client } = await newUser(TOP.slice(0, 3))
  const start = spotify.requests.length
  const added = await client.request('/api/me/artists', json('POST', { query: '  daft punk ' }))
  assert.equal(added.status, 201)
  assert.deepEqual(added.json, { artist: { id: 'daftpunk', name: 'Daft Punk', image: fakeArtist('daftpunk', 'Daft Punk').images[1].url, moods: [], profile: null } })
  assert.deepEqual(spotify.requests.slice(start).find(request => request.path === '/v1/search').query, { q: 'daft punk', type: 'artist', limit: '1' })
  assert.equal((await artistsOf(client))[0].id, 'daftpunk', 'added at the top, like V1')

  const missing = await client.request('/api/me/artists', json('POST', { query: 'nobody at all' }))
  assert.equal(missing.status, 404)
  assert.deepEqual(missing.json, { error: "L'artiste n'existe pas 🙁" })

  const twice = await client.request('/api/me/artists', json('POST', { query: 'Daft' }))
  assert.equal(twice.status, 409)
  assert.deepEqual(twice.json, { error: "L'artiste existe déjà 😁" })

  for (const body of [{}, { query: '   ' }, { query: 42 }]) {
    assert.equal((await client.request('/api/me/artists', json('POST', body))).status, 400, JSON.stringify(body))
  }
  assert.equal((await artistsOf(client)).length, 4)
})

test('moods: replaced as a set in table order, validated, with the profile computed', { skip }, async () => {
  const { client } = await newUser(TOP.slice(0, 3))
  const tagged = await client.request('/api/me/artists/top2/moods', json('PUT', { moods: ['sad', 'excited', 'sad'] }))
  assert.equal(tagged.status, 200)
  assert.deepEqual(tagged.json.artist.moods, ['excited', 'sad'])
  assert.deepEqual(tagged.json.artist.profile, { valence: 0.46875, activation: 0.65625 })
  assert.deepEqual((await artistsOf(client))[1].profile, { valence: 0.46875, activation: 0.65625 }, 'computed on read too')

  const danced = await client.request('/api/me/artists/top2/moods', json('PUT', { moods: ['dance'] }))
  assert.deepEqual([danced.json.artist.moods, danced.json.artist.profile], [['dance'], { danceability: 0.5 }])

  const unknown = await client.request('/api/me/artists/top2/moods', json('PUT', { moods: ['happy', 'grumpy'] }))
  assert.equal(unknown.status, 400)
  assert.deepEqual(unknown.json, { error: 'Émotion inconnue : grumpy' })
  for (const body of [{}, { moods: 'happy' }, { moods: [1] }]) {
    assert.equal((await client.request('/api/me/artists/top2/moods', json('PUT', body))).status, 400, JSON.stringify(body))
  }
  const absent = await client.request('/api/me/artists/nope/moods', json('PUT', { moods: ['happy'] }))
  assert.equal(absent.status, 404)
  assert.deepEqual(absent.json, { error: 'Artiste introuvable' })
  assert.deepEqual((await artistsOf(client))[1].moods, ['dance'], 'refused changes leave the moods alone')

  const cleared = await client.request('/api/me/artists/top2/moods', json('PUT', { moods: [] }))
  assert.deepEqual([cleared.json.artist.moods, cleared.json.artist.profile], [[], null])
})

test('isNew stays true until an artist has a mood', { skip }, async () => {
  const { client } = await newUser(TOP.slice(0, 3))
  assert.equal((await client.request('/api/session')).json.user.isNew, true)
  await client.request('/api/me/artists/top3/moods', json('PUT', { moods: ['upset'] }))
  assert.equal((await client.request('/api/session')).json.user.isNew, false)
  await client.request('/api/me/artists/top3/moods', json('PUT', { moods: [] }))
  assert.equal((await client.request('/api/session')).json.user.isNew, true)
})

test('removing an artist', { skip }, async () => {
  const { client } = await newUser(TOP.slice(0, 3))
  const removed = await client.request('/api/me/artists/top2', { method: 'DELETE', headers: { Origin: APP_ORIGIN } })
  assert.equal(removed.status, 204)
  assert.deepEqual((await artistsOf(client)).map(artist => artist.id), ['top1', 'top3'])
  assert.equal((await client.request('/api/me/artists/top2', { method: 'DELETE' })).status, 204, 'removing twice is harmless')
})

test('importing the top artists again keeps the list, refreshes what is known and appends the rest', { skip }, async () => {
  const { id, client } = await newUser(TOP.slice(0, 3))
  await client.request('/api/me/artists/top2/moods', json('PUT', { moods: ['happy'] }))
  spotify.addUser({ id, topArtists: [{ ...TOP[1], name: 'Top 2, renamed' }, TOP[16], TOP[15]] })
  const imported = await client.request('/api/me/artists/import-top', json('POST', {}))
  assert.equal(imported.status, 200)
  assert.deepEqual(imported.json, { added: 2 })
  const artists = await artistsOf(client)
  assert.deepEqual(artists.map(artist => artist.id), ['top1', 'top2', 'top3', 'top17', 'top16'])
  assert.deepEqual([artists[1].name, artists[1].moods], ['Top 2, renamed', ['happy']])
})

test('at login, artists not refreshed for 7 days get their name and image back from Spotify', { skip }, async () => {
  const { id } = await newUser(TOP.slice(0, 4))
  const old = new Date(Date.now() - 8 * DAY_MS).toISOString()
  const ref = adminFirestore().doc(`users/${id}`)
  const { artists } = (await ref.get()).data()
  artists[0] = { ...artists[0], refreshedAt: old, moods: ['sad'] } // renamed on Spotify
  artists[1] = { ...artists[1], refreshedAt: old } // gone from Spotify
  artists[2] = { ...artists[2], refreshedAt: new Date(Date.now() - 6 * DAY_MS).toISOString() } // not stale yet
  await ref.update({ artists })
  spotify.addArtists({ ...fakeArtist('top1', 'Top 1, renamed') })
  spotify.removeArtists('top2')
  const before = spotify.requests.length

  await login(spotify, createClient(server.url), { as: id })
  await waitFor(async () => (await readDocument(`users/${id}`)).artists[1].refreshedAt !== old, 'the refresh')
  const after = (await readDocument(`users/${id}`)).artists
  assert.deepEqual([after[0].name, after[0].image, after[0].moods], ['Top 1, renamed', fakeArtist('top1').images[1].url, ['sad']])
  assert.ok(Date.parse(after[0].refreshedAt) > Date.now() - 60_000)
  assert.deepEqual([after[1].id, after[1].name, after[1].image], ['top2', 'Top 2', null], 'a 404 keeps the artist and drops its image')
  assert.ok(Date.parse(after[1].refreshedAt) > Date.now() - 60_000)
  assert.deepEqual(after.slice(2), artists.slice(2), 'fresh artists are left alone')
  assert.deepEqual(spotify.requests.slice(before).filter(request => request.path.startsWith('/v1/artists/')).map(request => request.path).sort(), ['/v1/artists/top1', '/v1/artists/top2'])
  spotify.addArtists(TOP[0], TOP[1])
})

test('one login refreshes at most 30 artists, the oldest first', { skip }, async () => {
  const { id } = await newUser([])
  const many = Array.from({ length: 35 }, (_, i) => fakeArtist(`old${i}`, `Old ${i}`))
  spotify.addArtists(...many)
  const artists = many.map((artist, i) => ({ id: artist.id, name: artist.name, image: null, moods: [], addedAt: '2026-01-01T00:00:00.000Z', refreshedAt: new Date(Date.now() - (40 - i) * DAY_MS).toISOString() }))
  await adminFirestore().doc(`users/${id}`).update({ artists })

  await login(spotify, createClient(server.url), { as: id })
  const refreshed = stored => stored.filter(artist => artist.image !== null)
  await waitFor(async () => refreshed((await readDocument(`users/${id}`)).artists).length === 30, '30 refreshed artists')
  const after = (await readDocument(`users/${id}`)).artists
  assert.deepEqual(refreshed(after).map(artist => artist.id), many.slice(0, 30).map(artist => artist.id))
  assert.deepEqual(after.slice(30).map(artist => artist.refreshedAt), artists.slice(30).map(artist => artist.refreshedAt))
})

test("a user can neither read nor change another user's artists", { skip }, async () => {
  const alice = await newUser(TOP.slice(0, 3))
  const bob = await newUser([TOP[5]])
  assert.deepEqual((await artistsOf(bob.client)).map(artist => artist.id), ['top6'])

  assert.equal((await bob.client.request('/api/me/artists/top1/moods', json('PUT', { moods: ['sad'] }))).status, 404)
  assert.equal((await bob.client.request('/api/me/artists/top1', { method: 'DELETE' })).status, 204)
  const aliceArtists = await artistsOf(alice.client)
  assert.deepEqual(aliceArtists.map(artist => [artist.id, artist.moods]), [['top1', []], ['top2', []], ['top3', []]])
  assert.equal((await readDocument(`users/${bob.id}`)).artists.length, 1)
})
