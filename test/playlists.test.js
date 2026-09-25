// Playlist creation (plan §1.5, §4.7, step 6) end to end: the real server,
// the Firestore emulator, the fake Spotify and the fake ReccoBeats. A second
// server runs the V1 reference engine (RECOMMENDER=spotify). Skipped without
// the emulator.
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { startFakeReccoBeats } from './helpers/fake-reccobeats.js'
import { startFakeSpotify } from './helpers/fake-spotify.js'
import { adminFirestore, emulatorHost, readDocument, resetFirestore, skip } from './helpers/firestore.js'
import { login } from './helpers/login.js'
import { createClient, startServer, testEnv } from './helpers/server.js'

const APP_ORIGIN = 'http://moodmusic.test'
const track = (id, valence, energy, extra = {}) => ({ spotifyId: id, features: { valence, energy, danceability: 0.5 }, ...extra })

// Five artists ReccoBeats knows. "happy" at 0.5 aims at valence 0.75 and
// energy 0.5: each artist's closest track is marked ←.
const KNOWN = [
  { spotifyId: 'artist1', name: 'One', tracks: [track('t1a', 0.1, 0.1), track('t1b', 0.74, 0.51) /* ← */, track('t1c', 0.9, 0.9)] },
  { spotifyId: 'artist2', name: 'Two', tracks: [track('t2a', 0.75, 0.5) /* ← */, track('t2b', 0.3, 0.3)] },
  { spotifyId: 'artist3', name: 'Three', tracks: [track('t3a', 0.6, 0.6) /* ← */, { spotifyId: 't3b' } /* no features */] },
  { spotifyId: 'artist4', name: 'Four', tracks: [track('t4a', 0.2, 0.9), track('t4b', 0.8, 0.45) /* ← */] },
  { spotifyId: 'artist5', name: 'Five', tracks: [track('t5a', 0.76, 0.49) /* ← */, track('t5b', 0.1, 0.1, { availableCountries: 'US,GB' })] },
]
// ReccoBeats' answer: one track not sold in FR, one without countries (kept),
// one repeated; 20 remain.
const RECOMMENDED = [
  track('r1', 0.7, 0.5), track('r2', 0.7, 0.5), track('rUS', 0.7, 0.5, { availableCountries: 'US,GB' }), track('rAny', 0.7, 0.5, { availableCountries: '' }),
  ...Array.from({ length: 17 }, (_, i) => track(`r${i + 3}`, 0.7, 0.5)),
  track('r1', 0.7, 0.5),
]
const CHOSEN = ['r1', 'r2', 'rAny', ...Array.from({ length: 17 }, (_, i) => `r${i + 3}`)]
// The artists' own tracks available in FR, by distance to the target (at
// most 3 per artist): the top-up.
const TOP_UP = ['t2a', 't1b', 't5a', 't4b', 't3a', 't1c', 't2b', 't4a', 't1a']

let spotify
let reccobeats
let server
let spotifyEngineServer
let users = 0

before(async () => {
  if (skip) return
  spotify = await startFakeSpotify({ clientId: testEnv.SPOTIFY_CLIENT_ID, clientSecret: testEnv.SPOTIFY_CLIENT_SECRET })
  reccobeats = await startFakeReccoBeats({ artists: KNOWN, recommendations: RECOMMENDED })
  const env = { ...testEnv, APP_ORIGIN, SPOTIFY_ACCOUNTS_URL: spotify.url, SPOTIFY_API_URL: spotify.url, RECCOBEATS_URL: reccobeats.url, FIRESTORE_EMULATOR_HOST: emulatorHost }
  server = await startServer(env)
  spotifyEngineServer = await startServer({ ...env, RECOMMENDER: 'spotify' })
})

after(async () => {
  await server?.stop()
  await spotifyEngineServer?.stop()
  await spotify?.stop()
  await reccobeats?.stop()
})

beforeEach(async () => {
  if (skip) return
  await resetFirestore()
})

// A logged-in browser for a new user whose artists are tagged as given.
const userWith = async (tagged, on = server) => {
  const id = `user${++users}`
  spotify.addUser({ id })
  const client = createClient(on.url)
  await login(spotify, client, { as: id })
  const now = new Date().toISOString()
  const artists = tagged.map(([artistId, moods]) => ({ id: artistId, name: `Name of ${artistId}`, image: null, moods, addedAt: now, refreshedAt: now }))
  await adminFirestore().doc(`users/${id}`).update({ artists })
  return { id, client }
}
const happyFive = [1, 2, 3, 4, 5, 6].map(n => [`artist${n}`, ['happy']])
const create = (client, body) => client.request('/api/playlists', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: APP_ORIGIN },
  body: JSON.stringify(body),
})
const spotifySince = start => spotify.requests.slice(start)
const reccobeatsSince = start => reccobeats.requests.slice(start)

test('a playlist from ReccoBeats: seeds, recommendation, market, top-up, then Spotify and the history', { skip }, async () => {
  const { id, client } = await userWith(happyFive)
  const [spotifyStart, reccobeatsStart] = [spotify.requests.length, reccobeats.requests.length]
  const created = await create(client, { moods: { happy: 0.5 } })
  assert.equal(created.status, 201, created.text)

  // Five seed artists in gap order (ties in stored order, artist6 left out).
  const artists = [1, 2, 3, 4, 5].map(n => ({ id: `artist${n}`, name: `Name of artist${n}`, gap: 0 }))
  const { playlist } = created.json
  assert.deepEqual(created.json, {
    playlist: { id: playlist.id, name: '[Moodmusic] happy', url: `https://open.spotify.com/playlist/${playlist.id}`, trackCount: 29, engine: 'reccobeats', public: false },
    artists,
    target: { valence: 0.75, energy: 0.5 },
  })

  // ReccoBeats: one lookup, each artist's tracks and features, one recommendation.
  const asked = reccobeatsSince(reccobeatsStart)
  assert.deepEqual(asked.filter(request => request.path === '/v1/artist').map(request => request.query.ids), ['artist1,artist2,artist3,artist4,artist5'])
  assert.equal(asked.filter(request => request.path.endsWith('/track')).length, 5)
  assert.ok(asked.filter(request => request.path.endsWith('/track')).every(request => request.query.size === '50'))
  const recommendation = asked.filter(request => request.path === '/v1/track/recommendation')
  assert.equal(recommendation.length, 1)
  assert.deepEqual(recommendation[0].query, { size: '30', seeds: 't1b,t2a,t3a,t4b,t5a', featureWeight: '2', valence: '0.75', energy: '0.5' },
    'the closest track of each artist, and only the targets present')

  // Spotify: a private playlist, then the tracks in order, in one request of at most 100.
  const sent = spotifySince(spotifyStart)
  const creation = sent.find(request => request.path === '/v1/me/playlists' && request.method === 'POST')
  assert.deepEqual(JSON.parse(creation.body), { name: '[Moodmusic] happy', public: false })
  const items = sent.filter(request => request.path === `/v1/playlists/${playlist.id}/items`)
  assert.equal(items.length, 1)
  const expected = [...CHOSEN, ...TOP_UP].map(trackId => `spotify:track:${trackId}`)
  assert.deepEqual(JSON.parse(items[0].body).uris, expected)
  assert.deepEqual(spotify.playlists.get(playlist.id).items, expected)
  assert.equal(spotify.playlists.get(playlist.id).public, false)

  // The history keeps what the playlist was made from.
  const saved = await readDocument(`users/${id}/playlists/${playlist.id}`)
  assert.ok(saved.createdAt instanceof Date)
  delete saved.createdAt
  assert.deepEqual(saved, {
    name: '[Moodmusic] happy', public: false, url: playlist.url, trackCount: 29, engine: 'reccobeats',
    moods: { happy: 0.5 }, target: { valence: 0.75, energy: 0.5 }, artists,
  })
  const history = await client.request('/api/me/playlists')
  assert.equal(history.json.playlists.length, 1)
  assert.equal(history.json.playlists[0].id, playlist.id)
  assert.match(server.output(), new RegExp(`playlist user=${id} engine=reccobeats seeds=5/5 tracks=29 ms=\\d+ topup=9`))
})

test('the name: the given one cut to 25 characters, else the moods in table order; public when asked', { skip }, async () => {
  const { client } = await userWith(happyFive)
  const named = await create(client, { moods: { happy: 0.6 }, name: '  Un nom beaucoup trop long pour Spotify ', public: true })
  assert.equal(named.json.playlist.name, '[Moodmusic] Un nom beaucoup trop long')
  assert.equal(named.json.playlist.public, true)
  assert.equal(spotify.playlists.get(named.json.playlist.id).public, true)

  const unnamed = await create(client, { moods: { sad: 0.4, excited: 0.9 }, name: '' })
  assert.equal(unnamed.json.playlist.name, '[Moodmusic] excited,sad')
  assert.equal(unnamed.json.playlist.public, false)
})

test('an artist ReccoBeats does not know gives nothing; all unknown is a 422', { skip }, async () => {
  const { id, client } = await userWith([['unknown1', ['happy']], ['artist2', ['happy']]])
  const start = reccobeats.requests.length
  const created = await create(client, { moods: { happy: 0.5 } })
  assert.equal(created.status, 201)
  assert.deepEqual(created.json.artists.map(artist => artist.id), ['unknown1', 'artist2'])
  assert.equal(reccobeatsSince(start).find(request => request.path === '/v1/track/recommendation').query.seeds, 't2a')
  assert.match(server.output(), new RegExp(`playlist user=${id} engine=reccobeats seeds=1/2 `))

  const { client: stranger } = await userWith([['unknown1', ['happy']], ['unknown2', ['happy']]])
  const spotifyStart = spotify.requests.length
  const refused = await create(stranger, { moods: { happy: 0.5 } })
  assert.equal(refused.status, 422)
  assert.deepEqual(refused.json, { error: "Aucun des artistes choisis n'est connu du moteur de recommandation. Ajoute d'autres artistes favoris ou change d'émotion." })
  assert.ok(!spotifySince(spotifyStart).some(request => request.path === '/v1/me/playlists'), 'no playlist is created')
})

test("the choice of artists refuses like V1 (§1.5.3), and the selection is checked", { skip }, async () => {
  const { client: empty } = await userWith([])
  const none = await create(empty, { moods: { happy: 0.5 } })
  assert.equal(none.status, 422)
  assert.deepEqual(none.json, { error: "Pas d'artiste représentant cette émotion. Ajoutez d'abord des artistes et choisissez des émotions." })

  const { client } = await userWith([['artist1', []], ['artist2', ['dance']]])
  const untagged = await create(client, { moods: { happy: 0.5 } })
  assert.equal(untagged.status, 422)
  assert.deepEqual(untagged.json, { error: "Pas assez d'émotions sélectionnées. Ajoutez d'abord des émotions aux artistes." })

  for (const [body, message] of [
    [{}, 'Sélectionne au moins une émotion'],
    [{ moods: {} }, 'Sélectionne au moins une émotion'],
    [{ moods: ['happy'] }, 'Sélectionne au moins une émotion'],
    [{ moods: { grumpy: 0.5 } }, 'Émotion inconnue : grumpy'],
    [{ moods: { happy: 1.2 } }, 'Valeur invalide pour happy'],
    [{ moods: { happy: '0.5' } }, 'Valeur invalide pour happy'],
  ]) {
    const refused = await create(client, body)
    assert.equal(refused.status, 400, JSON.stringify(body))
    assert.deepEqual(refused.json, { error: message })
  }
  assert.equal((await create(createClient(server.url), { moods: { happy: 0.5 } })).status, 401, 'a login is needed')
})

test('the history lists the newest 50 first', { skip }, async () => {
  const { id, client } = await userWith(happyFive)
  const batch = adminFirestore().batch()
  for (let i = 0; i < 55; i++) {
    batch.set(adminFirestore().doc(`users/${id}/playlists/pl${String(i).padStart(2, '0')}`), { name: `[Moodmusic] ${i}`, createdAt: new Date(Date.UTC(2026, 8, 1, 0, i)) })
  }
  await batch.commit()
  const { playlists } = (await client.request('/api/me/playlists')).json
  assert.equal(playlists.length, 50)
  assert.equal(playlists[0].id, 'pl54')
  assert.equal(playlists[49].id, 'pl05')
  assert.equal(playlists[0].createdAt, '2026-09-01T00:54:00.000Z')
})

test('RECOMMENDER=spotify sends V1\'s request plus market=from_token', { skip }, async t => {
  spotify.options.recommendations = true
  t.after(() => { spotify.options.recommendations = false })
  const { id, client } = await userWith(happyFive, spotifyEngineServer)
  const start = spotify.requests.length
  const created = await create(client, { moods: { happy: 0.5, dance: 0.8 } })
  assert.equal(created.status, 201, created.text)
  assert.equal(created.json.playlist.engine, 'spotify')
  const asked = spotifySince(start).find(request => request.path === '/v1/recommendations')
  assert.deepEqual(asked.query, {
    market: 'from_token', seed_artists: 'artist1,artist2,artist3,artist4,artist5', limit: '30',
    target_valence: '0.75', target_energy: '0.5', target_danceability: '0.8',
  })
  assert.deepEqual(spotify.playlists.get(created.json.playlist.id).items, Array.from({ length: 30 }, (_, i) => `spotify:track:rec${i}`))
  assert.equal((await readDocument(`users/${id}/playlists/${created.json.playlist.id}`)).engine, 'spotify')
})

test('RECOMMENDER=spotify meets the Development Mode 404 with the "mode développement" 503', { skip }, async () => {
  const { client } = await userWith(happyFive, spotifyEngineServer)
  const refused = await create(client, { moods: { happy: 0.5 } })
  assert.equal(refused.status, 503)
  assert.deepEqual(refused.json, { error: "Le moteur Spotify n'est pas disponible pour cette application (mode développement)." })
})
