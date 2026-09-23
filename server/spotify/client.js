import { RateLimitError, withBackoff } from '../backoff.js'
import { refreshTokens } from './accounts.js'
import { ReauthError, SpotifyError, unreachable } from './errors.js'

export { RateLimitError, ReauthError, SpotifyError }

// The Spotify Web API client (plan appendix I). Paths, parameters and fields
// follow the OpenAPI spec; the comment on each helper is its operation id
// (docs/spotify-capabilities.md).

const REFRESH_MARGIN_MS = 60_000
// Refreshes in flight, by session id: parallel calls of one session refresh
// once, since Spotify may replace the refresh token when it is used.
const refreshing = new Map()

// The session's access token, refreshed when less than 60 s remain. The new
// tokens are written back into the session.
async function sessionAccessToken(req, config, timeoutMs) {
  const tokens = req.session.tokens
  if (!tokens) throw new ReauthError('No Spotify tokens in the session')
  if (tokens.expiresAt - REFRESH_MARGIN_MS > Date.now()) return tokens.access
  let pending = refreshing.get(req.sessionID)
  if (!pending) {
    pending = refreshTokens(config, tokens.refresh, { timeoutMs })
      .then(body => ({ access: body.access_token, refresh: body.refresh_token ?? tokens.refresh, expiresAt: Date.now() + body.expires_in * 1000 }))
      .finally(() => refreshing.delete(req.sessionID))
    refreshing.set(req.sessionID, pending)
  }
  req.session.tokens = await pending
  await new Promise((resolve, reject) => req.session.save(error => (error ? reject(error) : resolve())))
  return req.session.tokens.access
}

// With `req`, the client uses the session's tokens and refreshes them. With
// `accessToken` (a function), it sends that token as is: the login uses it
// before the session exists, and so do the probe scripts. `onResponse` sees
// every answer's status (the probe reports them).
export function createSpotifyClient({ config, req, sleep, timeoutMs = 15_000, accessToken = () => sessionAccessToken(req, config, timeoutMs), onResponse }) {
  async function request(method, path, { query, body } = {}) {
    const url = new URL(path, config.spotifyApiUrl)
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, value)
    const response = await withBackoff('Spotify', async () => {
      const token = await accessToken()
      let answer
      try {
        answer = await fetch(url, {
          method,
          headers: { Authorization: `Bearer ${token}`, ...(body && { 'Content-Type': 'application/json' }) },
          body: body && JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (error) {
        throw unreachable(error, path)
      }
      onResponse?.({ method, path, status: answer.status })
      return answer
    }, { sleep })
    if (response.status === 401) throw new ReauthError('Spotify refused the access token')
    let text
    try {
      text = await response.text()
    } catch (error) {
      throw unreachable(error, path)
    }
    let json
    try { json = JSON.parse(text) } catch {}
    if (!response.ok) throw new SpotifyError(response.status, json ?? (text || response.statusText), path)
    return json ?? null
  }

  return {
    request,
    me: () => request('GET', '/v1/me'), // get-current-users-profile
    topArtists: (limit = 15) => request('GET', '/v1/me/top/artists', { query: { limit } }), // get-users-top-artists-and-tracks
    searchArtist: name => request('GET', '/v1/search', { query: { q: name, type: 'artist', limit: 1 } }), // search
    artist: id => request('GET', `/v1/artists/${encodeURIComponent(id)}`), // get-an-artist
    // get-recommendations: deprecated and unavailable in Development Mode, kept for the V1 reference engine only (§4.7)
    recommendations: params => request('GET', '/v1/recommendations', { query: { market: 'from_token', ...params } }),
    createPlaylist: ({ name, public: isPublic }) => request('POST', '/v1/me/playlists', { body: { name, public: isPublic } }), // create-playlist
    // add-items-to-playlist, at most 100 items per request, in order
    addItems: async (playlistId, uris) => {
      for (let i = 0; i < uris.length; i += 100) {
        await request('POST', `/v1/playlists/${encodeURIComponent(playlistId)}/items`, { body: { uris: uris.slice(i, i + 100) } })
      }
    },
    myPlaylists: (limit = 50) => request('GET', '/v1/me/playlists', { query: { limit } }), // get-a-list-of-current-users-playlists
  }
}
