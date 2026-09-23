// Step 0 of docs/PLAN.md: how well ReccoBeats (plan §3.4) covers a list of
// Spotify artists, normally the top artists printed by `npm run probe`. For
// each artist it looks up the ReccoBeats id, the artist's tracks and their
// audio features, then finds the largest accepted `size` and `ids` batch and
// measures response times. Details with artist names go to the terminal only;
// a summary without names is appended to docs/spotify-capabilities.md.
//
// Usage: npm run probe:reccobeats -- <Spotify artist ids, separated by spaces or commas>
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const BASE_URL = (process.env.RECCOBEATS_URL || 'https://api.reccobeats.com').replace(/\/+$/, '')
const MARKET = process.env.MARKET || 'FR'
const DOC = path.join(import.meta.dirname, '..', 'docs', 'spotify-capabilities.md')
const TRACKS_SIZE = 50 // what appendix J asks for
const FEATURES_BATCH = 40 // plan §3.4: "send ≤ 40 ids"

const artistIds = process.argv.slice(2).flatMap(arg => arg.split(',')).map(id => id.trim()).filter(Boolean)
if (artistIds.length === 0 || artistIds.some(id => !/^[A-Za-z0-9]{22}$/.test(id))) {
  console.error('Usage: npm run probe:reccobeats -- <Spotify artist ids, separated by spaces or commas>')
  process.exit(1)
}

const timings = {}
// GET with a 10 s timeout; a 429 waits for Retry-After (at most 8 s) up to 3 times.
const get = async (label, pathAndQuery) => {
  for (let attempt = 0; ; attempt++) {
    const started = performance.now()
    let response
    try {
      response = await fetch(`${BASE_URL}${pathAndQuery}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) })
    } catch (error) {
      return { status: 0, error: error.message }
    }
    const body = await response.json().catch(() => null)
    ;(timings[label] ??= []).push(performance.now() - started)
    if (response.status === 429 && attempt < 3) {
      const wait = Math.min(Number(response.headers.get('retry-after')) || 2 ** attempt, 8)
      console.log(`  429 on ${label}, waiting ${wait} s`)
      await sleep(wait * 1000)
      continue
    }
    return { status: response.status, body }
  }
}
const spotifyIdOf = href => href?.match(/open\.spotify\.com\/(?:artist|track)\/([A-Za-z0-9]+)/)?.[1]
const refusal = result => result.body?.errors?.map(error => error.message).join('; ') || result.error || `HTTP ${result.status}`
const median = values => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)]
const chunks = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size))

// 1. Which artists ReccoBeats knows.
const lookup = await get('artist lookup', `/v1/artist?ids=${artistIds.join(',')}`)
if (lookup.status !== 200) {
  console.error(`Artist lookup failed: ${refusal(lookup)}`)
  process.exit(1)
}
const known = new Map((lookup.body?.content ?? []).map(artist => [spotifyIdOf(artist.href), { rbId: artist.id, name: artist.name }]))

// 2. Each known artist's first page of tracks and their audio features.
const report = []
const allTrackIds = []
const countries = { empty: 0, withMarket: 0, withoutMarket: 0 }
for (const spotifyId of artistIds) {
  const artist = known.get(spotifyId)
  if (!artist) {
    report.push({ spotifyId, known: false })
    continue
  }
  const page = await get('artist tracks', `/v1/artist/${artist.rbId}/track?size=${TRACKS_SIZE}`)
  const tracks = page.status === 200 ? page.body?.content ?? [] : []
  for (const track of tracks) {
    if (!track.availableCountries) countries.empty++
    else if (track.availableCountries.split(',').includes(MARKET)) countries.withMarket++
    else countries.withoutMarket++
  }
  const trackIds = [...new Set(tracks.map(track => spotifyIdOf(track.href)).filter(Boolean))]
  allTrackIds.push(...trackIds)
  const withFeatures = new Set()
  for (const batch of chunks(trackIds, FEATURES_BATCH)) {
    const features = await get('audio features', `/v1/audio-features?ids=${batch.join(',')}`)
    for (const item of features.status === 200 ? features.body?.content ?? [] : []) withFeatures.add(spotifyIdOf(item.href))
  }
  report.push({ spotifyId, known: true, name: artist.name, tracks: trackIds.length, total: page.body?.totalElements, features: trackIds.filter(id => withFeatures.has(id)).length, error: page.status === 200 ? null : refusal(page) })
}

// 3. The largest accepted `size` and `ids` batch, found by stepping up until
// ReccoBeats refuses. These calls are timed apart from the ones above.
const largestAccepted = async (candidates, request) => {
  let accepted = null
  for (const n of candidates) {
    const result = await request(n)
    if (result.status === 200) accepted = n
    else return { accepted, refused: n, message: refusal(result) }
  }
  return { accepted, refused: null }
}
const firstKnown = report.find(row => row.known && row.tracks > 0)
const sizeLimit = firstKnown
  ? await largestAccepted([TRACKS_SIZE, TRACKS_SIZE + 1, 100, 200], n => get('limit checks', `/v1/artist/${known.get(firstKnown.spotifyId).rbId}/track?size=${n}`))
  : null
const uniqueTrackIds = [...new Set(allTrackIds)]
const idsLimit = uniqueTrackIds.length > FEATURES_BATCH
  ? await largestAccepted([FEATURES_BATCH, FEATURES_BATCH + 1, 50, 100].filter(n => n <= uniqueTrackIds.length), n => get('limit checks', `/v1/audio-features?ids=${uniqueTrackIds.slice(0, n).join(',')}`))
  : null

// 4. Report.
const knownRows = report.filter(row => row.known)
const trackCounts = knownRows.map(row => row.tracks)
const totals = knownRows.map(row => row.total).filter(Number.isInteger)
const trackSum = trackCounts.reduce((sum, n) => sum + n, 0)
const featureSum = knownRows.reduce((sum, row) => sum + row.features, 0)
const range = values => (values.length ? `min ${Math.min(...values)}, median ${median(values)}, max ${Math.max(...values)}` : 'none')
const limitLine = (what, limit) => !limit ? `${what}: not measured (not enough data).`
  : `${what}: ${limit.accepted ?? 'none'}${limit.refused ? ` (${limit.refused} refused: "${limit.message}").` : ' (every size tried was accepted).'}`
const timingLine = Object.entries(timings).map(([label, values]) => `${label} ${Math.round(median(values))} / ${Math.round(Math.max(...values))}`).join(', ')

console.log('\nArtist                                  ReccoBeats  tracks  with features')
for (const row of report) {
  console.log(`${(row.name ?? row.spotifyId).slice(0, 38).padEnd(40)}${(row.known ? 'known' : 'unknown').padEnd(12)}${String(row.tracks ?? '–').padEnd(8)}${row.features ?? '–'}${row.error ? `  (${row.error})` : ''}`)
}
const summary = [
  `- Artists known to ReccoBeats: ${knownRows.length} of ${report.length}.`,
  `- Tracks per known artist, first page of \`size=${TRACKS_SIZE}\`: ${range(trackCounts)}. All of the artist's tracks on ReccoBeats: ${range(totals)}.`,
  `- Tracks with audio features: ${featureSum} of ${trackSum}${trackSum ? ` (${Math.round((featureSum / trackSum) * 100)} %)` : ''}.`,
  `- \`availableCountries\` of those tracks: empty for ${countries.empty}, includes ${MARKET} for ${countries.withMarket}, excludes ${MARKET} for ${countries.withoutMarket}.`,
  `- ${limitLine('Largest accepted `size` for `/v1/artist/{id}/track`', sizeLimit)}`,
  `- ${limitLine('Largest accepted `ids` batch for `/v1/audio-features`', idsLimit)}`,
  `- Response times in ms, median / max: ${timingLine}.`,
].join('\n')
const when = new Date().toISOString().slice(0, 16).replace('T', ' ')
fs.appendFileSync(DOC, `\n## ReccoBeats coverage (${when} UTC)\n\nInput: ${report.length} Spotify artists. Artist names are not recorded here.\n\n${summary}\n`)
console.log(`\n${summary}\n\nAppended to docs/spotify-capabilities.md.`)
