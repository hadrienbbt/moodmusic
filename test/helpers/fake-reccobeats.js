// A local stand-in for ReccoBeats (plan §3.4, §4.10) answering from fixtures,
// in the shapes and limits of the live API (docs/spotify-capabilities.md):
// at most 40 ids per lookup, at most 50 tracks per page, lookups answered in
// any order, recommendations needing at least one known seed. Tests script
// answers per path (429, 500, a hang) and can lower the ids limit. Every
// request is logged.
import http from 'node:http'

// artists: [{ spotifyId, name, tracks: [{ spotifyId, title, features: { valence, energy, danceability }, availableCountries? }] }]
// recommendations: the tracks /v1/track/recommendation answers, same shape.
export async function startFakeReccoBeats({ artists = [], recommendations = [] } = {}) {
  const rbArtistId = spotifyId => `rb-artist-${spotifyId}`
  const bySpotifyId = new Map(artists.map(artist => [artist.spotifyId, artist]))
  const byRbId = new Map(artists.map(artist => [rbArtistId(artist.spotifyId), artist]))
  const tracks = new Map(artists.flatMap(artist => artist.tracks.map(track => [track.spotifyId, { ...track, artist }])))
  for (const track of recommendations) {
    if (!tracks.has(track.spotifyId)) tracks.set(track.spotifyId, { ...track, artist: track.artist ?? { spotifyId: 'rec-artist', name: 'Someone' } })
  }
  const scripts = new Map()
  const requests = []
  const limits = { ids: 40 }

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }
  const refuse = (res, path, message) => send(res, 400, { status: 4004, errors: [{ path, message }] })
  const artistObject = artist => ({ id: rbArtistId(artist.spotifyId), name: artist.name, href: `https://open.spotify.com/artist/${artist.spotifyId}` })
  const trackObject = track => ({
    id: `rb-track-${track.spotifyId}`,
    trackTitle: track.title ?? track.spotifyId,
    artists: [artistObject(track.artist)],
    durationMs: 200_000,
    isrc: null,
    href: `https://open.spotify.com/track/${track.spotifyId}`,
    availableCountries: track.availableCountries ?? 'FR,BE,US',
    popularity: 0,
  })
  const idsOf = query => (query.get('ids') ?? '').split(',').filter(Boolean)

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fake-reccobeats')
    const query = url.searchParams
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(query) })

    const scripted = scripts.get(url.pathname)?.shift()
    if (scripted?.hang) return // never answers: the client's timeout has to end it
    if (scripted) return send(res, scripted.status, scripted.body ?? { status: scripted.status, errors: [{ message: `Scripted ${scripted.status}` }] }, scripted.headers)

    if (url.pathname === '/v1/artist') {
      const ids = idsOf(query)
      if (ids.length < 1 || ids.length > limits.ids) return refuse(res, 'getArtists.ids', `size must be between 1 and ${limits.ids}`)
      return send(res, 200, { content: ids.filter(id => bySpotifyId.has(id)).map(id => artistObject(bySpotifyId.get(id))).reverse() })
    }
    const artistTracks = url.pathname.match(/^\/v1\/artist\/([^/]+)\/track$/)
    if (artistTracks) {
      const size = Number(query.get('size') ?? 20)
      if (size > 50) return refuse(res, 'getArtistTrack.size', 'must be less than or equal to 50')
      const artist = byRbId.get(decodeURIComponent(artistTracks[1]))
      if (!artist) return send(res, 404, { status: 404, errors: [{ message: 'Artist not found' }] })
      const content = artist.tracks.slice(0, size).map(track => trackObject({ ...track, artist }))
      return send(res, 200, { content, page: 0, size, totalElements: artist.tracks.length, totalPages: Math.ceil(artist.tracks.length / size) })
    }
    if (url.pathname === '/v1/audio-features') {
      const ids = idsOf(query)
      if (ids.length < 1 || ids.length > limits.ids) return refuse(res, 'getAudioFeatures.ids', `size must be between 1 and ${limits.ids}`)
      const content = ids.filter(id => tracks.get(id)?.features).map(id => ({
        id: `rb-track-${id}`,
        href: `https://open.spotify.com/track/${id}`,
        acousticness: 0.1,
        instrumentalness: 0,
        key: 5,
        liveness: 0.1,
        loudness: -6,
        mode: 1,
        speechiness: 0.05,
        tempo: 120,
        ...tracks.get(id).features,
      }))
      return send(res, 200, { content: content.reverse() })
    }
    if (url.pathname === '/v1/track/recommendation') {
      const seeds = (query.get('seeds') ?? '').split(',').filter(Boolean)
      if (!seeds.some(seed => tracks.has(seed) || tracks.has(seed.replace(/^rb-track-/, '')))) {
        return refuse(res, 'getRecommendation.seeds', 'seeds need at least one track')
      }
      return send(res, 200, { content: recommendations.slice(0, Number(query.get('size') ?? 10)).map(track => trackObject(tracks.get(track.spotifyId))) })
    }
    send(res, 404, { status: 404, errors: [{ message: 'Not found' }] })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    limits,
    rbArtistId,
    // Answers to give, in order, to the next requests on a path:
    // { status, body?, headers? } or { hang: true }.
    script(path, ...answers) {
      scripts.set(path, [...(scripts.get(path) ?? []), ...answers])
    },
    stop: () => new Promise(resolve => {
      server.closeAllConnections()
      server.close(resolve)
    }),
  }
}
