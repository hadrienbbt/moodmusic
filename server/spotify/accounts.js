import { ReauthError, SpotifyError, unreachable } from './errors.js'

// Spotify's accounts service (plan §3.3, §4.3): the code exchange at login
// and the token refresh. The client secret only leaves the server in this
// Basic header, to Spotify.
const tokenRequest = async (config, form, timeoutMs) => {
  let response
  try {
    response = await fetch(`${config.spotifyAccountsUrl}/api/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw unreachable(error, '/api/token')
  }
  return { response, body: await response.json().catch(() => ({})) }
}

const refused = (response, body) => new SpotifyError(response.status, { error: { message: body.error_description ?? body.error } }, '/api/token')

// Resolves with { access_token, token_type, scope, expires_in, refresh_token }.
export async function exchangeCode(config, code, { timeoutMs = 15_000 } = {}) {
  const { response, body } = await tokenRequest(config, { grant_type: 'authorization_code', code, redirect_uri: config.redirectUri }, timeoutMs)
  if (!response.ok) throw refused(response, body)
  return body
}

// Resolves with a new access token; refresh_token is only there when Spotify
// replaces it. invalid_grant (the 180-day limit, or revoked access) is final:
// never retried, the user logs in again.
export async function refreshTokens(config, refreshToken, { timeoutMs = 15_000 } = {}) {
  const { response, body } = await tokenRequest(config, { grant_type: 'refresh_token', refresh_token: refreshToken }, timeoutMs)
  if (response.status === 400 && body.error === 'invalid_grant') throw new ReauthError('Spotify refused the refresh token')
  if (!response.ok) throw refused(response, body)
  return body
}
