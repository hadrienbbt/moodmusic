// The ReccoBeats client (plan §3.4, appendix J) against the fake ReccoBeats,
// in the test process: batching, the cache, the 429 backoff, timeouts and
// href parsing. Waits are recorded instead of slept. No emulator needed.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { createReccoBeatsClient, RateLimitError, ReccoBeatsError, spotifyId } from '../server/reccobeats/client.js'
import { startFakeReccoBeats } from './helpers/fake-reccobeats.js'

const track = (id, valence = 0.5, energy = 0.5, danceability = 0.5) => ({ spotifyId: id, features: { valence, energy, danceability } })
const MANY = Array.from({ length: 90 }, (_, i) => ({ spotifyId: `artist${i}`, name: `Artist ${i}`, tracks: [track(`t${i}`)] }))
const ARTISTS = [
  { spotifyId: 'artistA', name: 'A', tracks: Array.from({ length: 60 }, (_, i) => track(`a${i}`, i / 100)) },
  { spotifyId: 'artistB', name: 'B', tracks: [track('b1', 0.9, 0.8, 0.7), { spotifyId: 'b2' }] }, // b2 has no audio features
  ...MANY,
]

let reccobeats
before(async () => {
  reccobeats = await startFakeReccoBeats({ artists: ARTISTS, recommendations: [track('a1'), track('b1'), track('t3')] })
})
after(() => reccobeats.stop())

const clientWith = (options = {}) => createReccoBeatsClient({ config: { reccobeatsUrl: reccobeats.url }, ...options })
const since = start => reccobeats.requests.slice(start)
const idCounts = requests => requests.map(request => request.query.ids.split(',').length)
const waitRecorder = () => {
  const waits = []
  return { waits, sleep: async ms => { waits.push(ms) } }
}

test('spotifyId reads the id in a track or artist href', () => {
  assert.equal(spotifyId('https://open.spotify.com/track/7tFiyTwD0nx5a1eklYtX2J'), '7tFiyTwD0nx5a1eklYtX2J')
  assert.equal(spotifyId('https://open.spotify.com/track/7tFiyTwD0nx5a1eklYtX2J?si=abc'), '7tFiyTwD0nx5a1eklYtX2J')
  assert.equal(spotifyId('https://open.spotify.com/artist/4tZwfgrHOc3mvqYlEYSvVi'), '4tZwfgrHOc3mvqYlEYSvVi')
  assert.equal(spotifyId('https://example.com/track/abc'), undefined)
  assert.equal(spotifyId(undefined), undefined)
})

test('artistIds keeps the order, marks unknown artists null, and asks at most 40 at a time', async () => {
  const client = clientWith()
  assert.deepEqual(await client.artistIds(['artistB', 'nobody', 'artistA']), [reccobeats.rbArtistId('artistB'), null, reccobeats.rbArtistId('artistA')])

  const start = reccobeats.requests.length
  const ids = MANY.map(artist => artist.spotifyId)
  assert.deepEqual(await client.artistIds(ids), ids.map(reccobeats.rbArtistId))
  assert.deepEqual(idCounts(since(start)), [40, 40, 10])
})

test('audioFeatures batches by 40, matches answers by href, and leaves out tracks without features', async () => {
  const client = clientWith()
  const ids = [...ARTISTS[0].tracks.map(t => t.spotifyId), 'b1', 'b2']
  const start = reccobeats.requests.length
  const features = await client.audioFeatures(ids)
  assert.deepEqual(idCounts(since(start)), [40, 22])
  assert.equal(features.size, 61)
  assert.equal(features.get('a7').valence, 0.07, 'answers come back reversed; the href decides')
  assert.deepEqual([features.get('b1').valence, features.get('b1').energy, features.get('b1').danceability], [0.9, 0.8, 0.7])
  assert.equal(features.has('b2'), false)
})

test('a batch refused with a 400 is split in two', async t => {
  reccobeats.limits.ids = 25
  t.after(() => { reccobeats.limits.ids = 40 })
  const client = clientWith()
  const ids = ARTISTS[0].tracks.slice(0, 40).map(t => t.spotifyId)
  const start = reccobeats.requests.length
  assert.equal((await client.audioFeatures(ids)).size, 40)
  assert.deepEqual(idCounts(since(start)), [40, 20, 20])
})

test('artist ids, tracks and features are cached, unknown ones too', async () => {
  const client = clientWith()
  await client.artistIds(['artistA', 'nobody'])
  await client.artistTracks(reccobeats.rbArtistId('artistA'), 50)
  await client.audioFeatures(['a1', 'a2', 'b2'])
  const start = reccobeats.requests.length
  assert.deepEqual(await client.artistIds(['nobody', 'artistA']), [null, reccobeats.rbArtistId('artistA')])
  assert.equal((await client.artistTracks(reccobeats.rbArtistId('artistA'), 50)).length, 50)
  assert.deepEqual([...(await client.audioFeatures(['b2', 'a2', 'a1'])).keys()].sort(), ['a1', 'a2'])
  assert.equal(since(start).length, 0, 'every second call is answered from the cache')

  await client.audioFeatures(['a1', 'a3'])
  assert.deepEqual(since(start).map(request => request.query.ids), ['a3'], 'only what is missing is asked')
})

test('the cache forgets after 24 hours, and the oldest artists first when full', async () => {
  let clock = Date.now()
  const client = clientWith({ now: () => clock, maxArtists: 2 })
  await client.artistIds(['artistA'])
  let start = reccobeats.requests.length
  clock += 24 * 60 * 60 * 1000 - 1
  await client.artistIds(['artistA'])
  assert.equal(since(start).length, 0, 'still fresh')
  clock += 2
  await client.artistIds(['artistA'])
  assert.equal(since(start).length, 1, 'expired')

  await client.artistIds(['artistB'])
  await client.artistIds(['artist0']) // a third artist: artistA, the oldest, goes
  start = reccobeats.requests.length
  await client.artistIds(['artistB', 'artist0'])
  assert.equal(since(start).length, 0)
  await client.artistIds(['artistA'])
  assert.equal(since(start).length, 1)
})

test('artistTracks asks one page of the given size', async () => {
  const start = reccobeats.requests.length
  const tracks = await clientWith().artistTracks(reccobeats.rbArtistId('artistA'), 50)
  assert.equal(tracks.length, 50)
  assert.equal(spotifyId(tracks[0].href), 'a0')
  assert.deepEqual(since(start)[0].query, { size: '50' })
})

test('recommendation sends seeds, size, weight and targets, and is never cached', async () => {
  const client = clientWith()
  const query = { seeds: ['a1', 'b1'], size: 30, targets: { valence: 0.4719, energy: 0.6781 }, featureWeight: 2 }
  const start = reccobeats.requests.length
  const tracks = await client.recommendation(query)
  assert.deepEqual(tracks.map(t => spotifyId(t.href)), ['a1', 'b1', 't3'])
  await client.recommendation(query)
  const log = since(start)
  assert.equal(log.length, 2)
  assert.deepEqual(log[0].query, { size: '30', seeds: 'a1,b1', featureWeight: '2', valence: '0.4719', energy: '0.6781' })

  await assert.rejects(client.recommendation({ seeds: ['unknown'], size: 30 }),
    error => error instanceof ReccoBeatsError && error.status === 400 && error.message === 'seeds need at least one track')
})

test('429: the same backoff as for Spotify', async () => {
  reccobeats.script('/v1/artist', { status: 429 })
  const retried = waitRecorder()
  assert.deepEqual(await clientWith({ sleep: retried.sleep }).artistIds(['artistA']), [reccobeats.rbArtistId('artistA')])
  assert.deepEqual(retried.waits, [1000])

  reccobeats.script('/v1/artist', { status: 429, headers: { 'Retry-After': '30' } })
  await assert.rejects(clientWith().artistIds(['artistA']), error => error instanceof RateLimitError && error.service === 'ReccoBeats' && error.retryAfter === 30)

  reccobeats.script('/v1/artist', ...Array(4).fill({ status: 429 }))
  const exhausted = waitRecorder()
  await assert.rejects(clientWith({ sleep: exhausted.sleep }).artistIds(['artistA']), RateLimitError)
  assert.deepEqual(exhausted.waits, [1000, 2000, 4000])
})

test('a timeout, an unreachable ReccoBeats or a 500 is a ReccoBeatsError', async () => {
  reccobeats.script('/v1/track/recommendation', { hang: true })
  const started = Date.now()
  await assert.rejects(clientWith({ timeoutMs: 300 }).recommendation({ seeds: ['a1'], size: 5 }),
    error => error instanceof ReccoBeatsError && error.status === 0 && /in time/.test(error.message))
  assert.ok(Date.now() - started < 3000)

  const unreachable = createReccoBeatsClient({ config: { reccobeatsUrl: 'http://127.0.0.1:1' } })
  await assert.rejects(unreachable.artistIds(['artistA']), error => error instanceof ReccoBeatsError && error.status === 0)

  reccobeats.script('/v1/audio-features', { status: 500 })
  await assert.rejects(clientWith().audioFeatures(['a1']), error => error instanceof ReccoBeatsError && error.status === 500)
})
