// Spotify Web API client (plan appendix I). Step 3 only needs the calls made
// at login; token refresh, the backoff on 429 and the other endpoints come
// with step 4. Paths and fields follow the OpenAPI spec (operation ids in the
// comments, see docs/spotify-capabilities.md).

// The access token is no longer accepted: the user must log in again.
export class ReauthError extends Error {}

// Carries Spotify's own message, which the API shows to the user (plan §4.5).
export class SpotifyError extends Error {
  constructor(status, body, path) {
    super(body?.error?.message ?? (typeof body === 'string' ? body : `Spotify ${status}`))
    this.status = status
    this.path = path
  }
}

// accessToken: a function returning the bearer token to send.
export function createSpotifyClient({ config, accessToken }) {
  async function request(method, path, { query } = {}) {
    const url = new URL(path, config.spotifyApiUrl)
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, value)
    const response = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${await accessToken()}` },
      signal: AbortSignal.timeout(15_000),
    })
    if (response.status === 401) throw new ReauthError('Spotify refused the access token')
    if (!response.ok) throw new SpotifyError(response.status, await response.json().catch(() => response.statusText), path)
    return response.status === 204 ? null : response.json()
  }

  return {
    me: () => request('GET', '/v1/me'), // get-current-users-profile
    topArtists: (limit = 15) => request('GET', '/v1/me/top/artists', { query: { limit } }), // get-users-top-artists-and-tracks
  }
}
