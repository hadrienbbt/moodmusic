import { RateLimitError, withBackoff } from '../backoff.js'

export { RateLimitError }

// The ReccoBeats client (plan §3.4, appendix J): Spotify ids in, ReccoBeats
// data out, no key. Every call has a 10 s timeout and the 429 policy of
// appendix I. Artist ids, artist tracks and audio features are cached in
// memory for 24 h, for at most 500 artists; recommendations never are.
// Nothing from ReccoBeats is stored anywhere else.

// Status 0: ReccoBeats did not answer (timeout or network error).
export class ReccoBeatsError extends Error {
  constructor(status, message, path) {
    super(message)
    this.status = status
    this.path = path
  }
}

// The Spotify id in a ReccoBeats `href` (open.spotify.com/track/… or /artist/…).
export const spotifyId = href => href?.match(/open\.spotify\.com\/(?:track|artist)\/([A-Za-z0-9]+)/)?.[1]

// /v1/artist and /v1/audio-features take at most 40 ids (docs/spotify-capabilities.md).
const MAX_IDS = 40
const DAY_MS = 24 * 60 * 60 * 1000

// A Map whose entries expire; the oldest go first when it is full.
class Cache {
  constructor({ ttlMs, maxEntries, now }) {
    Object.assign(this, { ttlMs, maxEntries, now, entries: new Map() })
  }
  // { value } when the key is cached (null values included), else undefined.
  lookup(key) {
    const entry = this.entries.get(key)
    if (entry && entry.expires > this.now()) return entry
    this.entries.delete(key)
  }
  set(key, value) {
    this.entries.delete(key)
    this.entries.set(key, { value, expires: this.now() + this.ttlMs })
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value)
  }
}

export function createReccoBeatsClient({ config, sleep, timeoutMs = 10_000, now = Date.now, ttlMs = DAY_MS, maxArtists = 500 }) {
  const artistIdCache = new Cache({ ttlMs, maxEntries: maxArtists, now }) // Spotify artist id → ReccoBeats id or null
  const tracksCache = new Cache({ ttlMs, maxEntries: maxArtists, now }) // ReccoBeats artist id and size → tracks
  const featuresCache = new Cache({ ttlMs, maxEntries: maxArtists * 50, now }) // Spotify track id → features or null

  async function get(path, query = {}) {
    const url = new URL(path, config.reccobeatsUrl)
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, value)
    const response = await withBackoff('ReccoBeats', async () => {
      try {
        return await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
      } catch (error) {
        throw new ReccoBeatsError(0, error.name === 'TimeoutError' ? 'ReccoBeats did not answer in time' : `ReccoBeats could not be reached (${error.cause?.code ?? error.message})`, path)
      }
    }, { sleep })
    let body
    try {
      body = await response.json()
    } catch (error) {
      // Not JSON is only a problem for a success; losing the answer midway is an outage.
      if (error.name !== 'SyntaxError') throw new ReccoBeatsError(0, error.name === 'TimeoutError' ? 'ReccoBeats did not answer in time' : 'ReccoBeats answer lost', path)
    }
    if (!response.ok) throw new ReccoBeatsError(response.status, body?.errors?.map(error => error.message).join('; ') || response.statusText, path)
    return body
  }

  // Asks for ids in batches of at most 40. A batch refused with a 400 (the
  // limit went down) is split in two; a single id refused counts as unknown.
  async function inBatches(path, ids, collect) {
    const queue = []
    for (let i = 0; i < ids.length; i += MAX_IDS) queue.push(ids.slice(i, i + MAX_IDS))
    while (queue.length > 0) {
      const batch = queue.shift()
      try {
        collect((await get(path, { ids: batch.join(',') }))?.content ?? [])
      } catch (error) {
        if (!(error instanceof ReccoBeatsError) || error.status !== 400) throw error
        if (batch.length > 1) queue.unshift(batch.slice(0, Math.ceil(batch.length / 2)), batch.slice(Math.ceil(batch.length / 2)))
      }
    }
  }

  // id → value for every id: cached values, then the missing ones fetched;
  // those the answer leaves out are unknown (null), and cached as such.
  async function cached(cache, ids, path, keyOf, valueOf) {
    const values = new Map()
    const missing = new Set()
    for (const id of ids) {
      const hit = cache.lookup(id)
      if (hit) values.set(id, hit.value)
      else missing.add(id)
    }
    await inBatches(path, [...missing], items => {
      for (const item of items) if (missing.has(keyOf(item))) values.set(keyOf(item), valueOf(item))
    })
    for (const id of missing) {
      if (!values.has(id)) values.set(id, null)
      cache.set(id, values.get(id))
    }
    return values
  }

  return {
    get,

    // The ReccoBeats id of each Spotify artist, in order (null when unknown).
    async artistIds(spotifyIds) {
      const ids = await cached(artistIdCache, spotifyIds, '/v1/artist', item => spotifyId(item.href), item => item.id)
      return spotifyIds.map(id => ids.get(id))
    },

    // The first `size` tracks of a ReccoBeats artist (at most 50 per page).
    async artistTracks(rbId, size = 50) {
      const key = `${rbId}:${size}`
      const hit = tracksCache.lookup(key)
      if (hit) return hit.value
      const tracks = (await get(`/v1/artist/${encodeURIComponent(rbId)}/track`, { size }))?.content ?? []
      tracksCache.set(key, tracks)
      return tracks
    },

    // Spotify track id → audio features, for the tracks ReccoBeats knows.
    async audioFeatures(spotifyIds) {
      const features = await cached(featuresCache, spotifyIds, '/v1/audio-features', item => spotifyId(item.href), item => item)
      return new Map([...features].filter(([, value]) => value !== null))
    },

    // Tracks close to the seeds (1 to 5 Spotify or ReccoBeats track ids) and
    // to the targets ({ valence, energy, danceability }, keys present only).
    async recommendation({ seeds, size, targets = {}, featureWeight }) {
      const query = { size, seeds: seeds.join(','), featureWeight, ...targets }
      return (await get('/v1/track/recommendation', query))?.content ?? []
    },
  }
}
