import { SpotifyError } from './client.js'

// Spotify's accounts service: the authorization code exchange of the login
// (plan §4.3). The refresh grant comes with step 4. The client secret only
// ever leaves the server in this Basic header, to Spotify.
export async function exchangeCode(config, code) {
  const response = await fetch(`${config.spotifyAccountsUrl}/api/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: config.redirectUri }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new SpotifyError(response.status, { error: { message: body.error_description ?? body.error } }, '/api/token')
  return body // { access_token, token_type, scope, expires_in, refresh_token }
}
