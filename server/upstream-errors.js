import { RateLimitError } from './backoff.js'
import { ReccoBeatsError } from './reccobeats/client.js'
import { ReauthError, SpotifyError } from './spotify/errors.js'

// How failures of Spotify and ReccoBeats reach the user (plan §4.5): a status
// and a French message, with Spotify's own message where it helps. Returns
// { status, body, headers?, endSession?, log? }, or undefined for any other
// error.
export function upstreamAnswer(error) {
  if (error instanceof ReauthError) return { status: 401, body: { error: 'reauth' }, endSession: true }
  if (error instanceof RateLimitError) {
    const who = error.service === 'Spotify' ? 'Spotify' : 'Le moteur de recommandation'
    return {
      status: 429,
      body: { error: `${who} limite les requêtes, réessaie dans ${error.retryAfter} secondes.` },
      headers: { 'Retry-After': String(error.retryAfter) },
    }
  }
  if (error instanceof SpotifyError) {
    if (error.status === 0 || error.status >= 500) return { status: 503, body: { error: 'Spotify est indisponible, réessaie plus tard.' }, log: true }
    if (error.status === 403) return { status: 403, body: { error: `Spotify a refusé la demande : ${error.message}` } }
    if (error.status === 404 && error.path === '/v1/recommendations') {
      return { status: 503, body: { error: "Le moteur Spotify n'est pas disponible pour cette application (mode développement)." } }
    }
    if (error.status === 404) return { status: 404, body: { error: `Introuvable sur Spotify : ${error.message}` } }
    // A 400 or another 4xx: a bug on our side or a change of the API.
    return { status: 502, body: { error: `Réponse inattendue de Spotify : ${error.message}` }, log: true }
  }
  if (error instanceof ReccoBeatsError) {
    if (error.status === 0 || error.status >= 500) return { status: 503, body: { error: 'Le moteur de recommandation est indisponible, réessaie plus tard.' }, log: true }
    return { status: 502, body: { error: 'Réponse inattendue du moteur de recommandation.' }, log: true }
  }
}
