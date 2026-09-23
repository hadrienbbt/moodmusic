// Step 0 of docs/PLAN.md: how well ReccoBeats (plan §3.4) covers a list of
// Spotify artists, normally the top artists printed by `npm run probe`,
// through the server's ReccoBeats client. For each artist it looks up the
// ReccoBeats id, the artist's tracks and their audio features, then checks
// the largest accepted `size` and `ids` batch and measures response times.
// Details with artist names go to the terminal only; a summary without names
// is appended to docs/spotify-capabilities.md.
//
// Usage: npm run probe:reccobeats -- <Spotify artist ids, separated by spaces or commas>
import fs from 'node:fs'
import path from 'node:path'

import { ReccoBeatsError, createReccoBeatsClient, spotifyId } from '../server/reccobeats/client.js'

const MARKET = process.env.MARKET || 'FR'
const DOC = path.join(import.meta.dirname, '..', 'docs', 'spotify-capabilities.md')
const TRACKS_SIZE = 50 // what appendix J asks for

const artistIds = process.argv.slice(2).flatMap(arg => arg.split(',')).map(id => id.trim()).filter(Boolean)
if (artistIds.length === 0 || artistIds.some(id => !/^[A-Za-z0-9]{22}$/.test(id))) {
  console.error('Usage: npm run probe:reccobeats -- <Spotify artist ids, separated by spaces or commas>')
  process.exit(1)
}

const client = createReccoBeatsClient({ config: { reccobeatsUrl: (process.env.RECCOBEATS_URL || 'https://api.reccobeats.com').replace(/\/+$/, '') } })
const timings = {}
const timed = async (label, call) => {
  const started = performance.now()
  try {
    return await call()
  } finally {
    (timings[label] ??= []).push(performance.now() - started)
  }
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) / 2)]

// 1. Which artists ReccoBeats knows, 2. their first page of tracks and the
// tracks' audio features: the calls of the ReccoBeats engine (appendix J).
let rbIds
try {
  rbIds = await timed('artist lookup', () => client.artistIds(artistIds))
} catch (error) {
  console.error(`Artist lookup failed: ${error.message}`)
  process.exit(1)
}
const report = []
const tracksWithIds = []
const countries = { empty: 0, withMarket: 0, withoutMarket: 0 }
for (const [i, spotifyArtistId] of artistIds.entries()) {
  const rbId = rbIds[i]
  if (!rbId) {
    report.push({ spotifyId: spotifyArtistId, known: false })
    continue
  }
  try {
    const tracks = await timed('artist tracks', () => client.artistTracks(rbId, TRACKS_SIZE))
    for (const track of tracks) {
      if (!track.availableCountries) countries.empty++
      else if (track.availableCountries.split(',').includes(MARKET)) countries.withMarket++
      else countries.withoutMarket++
    }
    const trackIds = [...new Set(tracks.map(track => spotifyId(track.href)).filter(Boolean))]
    tracksWithIds.push(...trackIds)
    const features = await timed('audio features', () => client.audioFeatures(trackIds))
    const name = tracks[0]?.artists?.find(artist => artist.id === rbId)?.name
    report.push({ spotifyId: spotifyArtistId, known: true, name, tracks: trackIds.length, features: trackIds.filter(id => features.has(id)).length })
  } catch (error) {
    report.push({ spotifyId: spotifyArtistId, known: true, tracks: 0, features: 0, error: error.message })
  }
}

// 3. The largest accepted `size` and `ids` batch, found by stepping up until
// ReccoBeats refuses, with raw calls since the client keeps under the limits.
const largestAccepted = async (candidates, request) => {
  let accepted = null
  for (const n of candidates) {
    try {
      await timed('limit checks', () => request(n))
      accepted = n
    } catch (error) {
      if (!(error instanceof ReccoBeatsError)) throw error
      return { accepted, refused: n, message: error.message }
    }
  }
  return { accepted, refused: null }
}
const firstKnown = rbIds.find(Boolean)
const sizeLimit = firstKnown ? await largestAccepted([TRACKS_SIZE, TRACKS_SIZE + 1, 100], n => client.get(`/v1/artist/${firstKnown}/track`, { size: n })) : null
const uniqueTrackIds = [...new Set(tracksWithIds)]
const idsLimit = uniqueTrackIds.length > 40
  ? await largestAccepted([40, 41, 50, 100].filter(n => n <= uniqueTrackIds.length), n => client.get('/v1/audio-features', { ids: uniqueTrackIds.slice(0, n).join(',') }))
  : null

// 4. Report.
const knownRows = report.filter(row => row.known)
const trackCounts = knownRows.map(row => row.tracks)
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
  `- Tracks per known artist, first page of \`size=${TRACKS_SIZE}\`: ${range(trackCounts)}.`,
  `- Tracks with audio features: ${featureSum} of ${trackSum}${trackSum ? ` (${Math.round((featureSum / trackSum) * 100)} %)` : ''}.`,
  `- \`availableCountries\` of those tracks: empty for ${countries.empty}, includes ${MARKET} for ${countries.withMarket}, excludes ${MARKET} for ${countries.withoutMarket}.`,
  `- ${limitLine('Largest accepted `size` for `/v1/artist/{id}/track`', sizeLimit)}`,
  `- ${limitLine('Largest accepted `ids` batch for `/v1/audio-features`', idsLimit)}`,
  `- Response times in ms, median / max: ${timingLine}.`,
].join('\n')
const when = new Date().toISOString().slice(0, 16).replace('T', ' ')
fs.appendFileSync(DOC, `\n## ReccoBeats coverage (${when} UTC)\n\nInput: ${report.length} Spotify artists. Artist names are not recorded here.\n\n${summary}\n`)
console.log(`\n${summary}\n\nAppended to docs/spotify-capabilities.md.`)
