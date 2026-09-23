// Ranks candidate tracks by closeness to the target (plan §4.6), for the
// ReccoBeats engine's top-up (appendix J). The distance is the sum, over the
// keys present in the target, of |features[key] − target[key]|. Tracks are
// taken in increasing distance (stable), skipping a track once its artist
// has ceil(limit / number of artists) + 1 tracks, so the result keeps the
// distance order while no artist fills the playlist alone. Excluded ids,
// repeated ids and tracks missing a needed feature are left out.
const KEYS = ['valence', 'energy', 'danceability']

const isNumber = value => typeof value === 'number' && Number.isFinite(value)

export function rankTracks(candidates /* [{ id, artistId, features: { valence, energy, danceability } }] */, target, { limit, exclude = new Set() }) {
  const keys = KEYS.filter(key => isNumber(target[key]))
  const seen = new Set(exclude)
  const ranked = []
  for (const track of candidates) {
    if (seen.has(track.id) || !keys.every(key => isNumber(track.features?.[key]))) continue
    seen.add(track.id)
    ranked.push({ track, distance: keys.reduce((total, key) => total + Math.abs(track.features[key] - target[key]), 0) })
  }
  ranked.sort((a, b) => a.distance - b.distance)

  const cap = Math.ceil(limit / new Set(ranked.map(({ track }) => track.artistId)).size) + 1
  const perArtist = new Map()
  const ids = []
  for (const { track } of ranked) {
    if (ids.length >= limit) break
    const count = perArtist.get(track.artistId) ?? 0
    if (count >= cap) continue
    perArtist.set(track.artistId, count + 1)
    ids.push(track.id)
  }
  return ids
}
