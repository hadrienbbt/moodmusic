import { rankTracks } from '../core/index.js'
import { ReccoBeatsError, spotifyId } from '../reccobeats/client.js'

// None of the chosen artists gave ReccoBeats a seed track (plan §4.5: 422).
export class NoSeedsError extends Error {}

const KEYS = ['valence', 'energy', 'danceability']
const distance = (features, target) => KEYS.filter(key => target[key] !== undefined).reduce((sum, key) => sum + Math.abs(features[key] - target[key]), 0)
// An empty or missing list of countries says nothing: the track is kept.
const availableIn = (market, track) => !track.availableCountries || track.availableCountries.split(',').includes(market)

// The default engine (plan §4.7, appendix J). Each chosen artist's own track
// closest to the target seeds one ReccoBeats recommendation with the same
// targets. Tracks not available in the market are dropped, and the artists'
// own tracks, closest first, top the list up to the limit. An artist unknown
// to ReccoBeats, or without audio features, gives nothing.
export async function recommend({ seedArtists, target, limit, reccobeats, market }) {
  const rbIds = await reccobeats.artistIds(seedArtists.map(artist => artist.id))
  const seeds = []
  const candidates = []
  for (const [i, artist] of seedArtists.entries()) {
    if (!rbIds[i]) continue
    const tracks = await reccobeats.artistTracks(rbIds[i], 50)
    const features = await reccobeats.audioFeatures(tracks.map(track => spotifyId(track.href)).filter(Boolean))
    const withFeatures = tracks
      .map(track => ({ id: spotifyId(track.href), artistId: artist.id, features: features.get(spotifyId(track.href)), availableCountries: track.availableCountries }))
      .filter(track => track.id && track.features)
    if (withFeatures.length === 0) continue
    candidates.push(...withFeatures)
    // The closest track; the first one on a tie.
    const seed = withFeatures.reduce((best, track) => (distance(track.features, target) < distance(best.features, target) ? track : best))
    if (!seeds.includes(seed.id)) seeds.push(seed.id)
  }
  if (seeds.length === 0) throw new NoSeedsError('No chosen artist is known to ReccoBeats')

  let recommended
  try {
    recommended = await reccobeats.recommendation({ seeds, size: limit, targets: target, featureWeight: 2 })
  } catch (error) {
    // ReccoBeats does not know the seed tracks after all.
    if (error instanceof ReccoBeatsError && error.status === 400 && /seed/i.test(error.message)) throw new NoSeedsError(error.message)
    throw error
  }
  const chosen = [...new Set(recommended.filter(track => availableIn(market, track)).map(track => spotifyId(track.href)).filter(Boolean))].slice(0, limit)
  // The candidates carry their countries, so the top-up follows the market too.
  const topUp = chosen.length < limit
    ? rankTracks(candidates.filter(track => availableIn(market, track)), target, { limit: limit - chosen.length, exclude: new Set(chosen) })
    : []
  return { trackUris: [...chosen, ...topUp].map(id => `spotify:track:${id}`), engine: 'reccobeats', seeds: seeds.length, topUp: topUp.length }
}
