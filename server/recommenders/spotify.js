// The V1 reference engine (plan §4.7): V1's request to Spotify to the letter,
// plus market=from_token. /v1/recommendations is gone for Development Mode
// apps (and deprecated in the spec), so this only works against the fake
// Spotify; with the real one, the API answers the "mode développement" 503.
export async function recommend({ seedArtists, target, limit, spotify }) {
  const params = { seed_artists: seedArtists.map(artist => artist.id).join(','), limit }
  for (const key of ['valence', 'energy', 'danceability']) {
    if (target[key] !== undefined) params[`target_${key}`] = target[key]
  }
  const { tracks = [] } = await spotify.recommendations(params)
  return { trackUris: tracks.map(track => track.uri), engine: 'spotify', seeds: seedArtists.length }
}
