// Errors of the Spotify client (plan appendix I), mapped to answers by the
// API (plan §4.5).

// Spotify no longer accepts the session's tokens (expired refresh token,
// revoked access, a 401): the session ends and the user logs in again.
export class ReauthError extends Error {}

// Any other refusal, carrying Spotify's own message for the user. Status 0
// means Spotify did not answer: timeout or network error.
export class SpotifyError extends Error {
  constructor(status, body, path) {
    super(body?.error?.message ?? (typeof body === 'string' ? body : `Spotify ${status}`))
    this.status = status
    this.path = path
  }
}

export const unreachable = (error, path) =>
  new SpotifyError(0, { error: { message: error.name === 'TimeoutError' ? 'Spotify did not answer in time' : `Spotify could not be reached (${error.cause?.code ?? error.message})` } }, path)
