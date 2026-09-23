import express from 'express'

import { page } from './auth/pages.js'
import { authRoutes } from './auth/routes.js'
import { COOKIE_NAME, sessionMiddleware } from './auth/session.js'
import { createUsersRepository } from './repositories/users.js'
import { apiRoutes } from './routes/api.js'
import { staticRoutes } from './routes/static.js'
import { upstreamAnswer } from './upstream-errors.js'

// Plan §4.3. Scripts, styles, API calls and the manifest come from this
// origin only; Spotify images and the Spotify embed player are the only
// third-party content. HSTS is set by Apache.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "img-src 'self' https://i.scdn.co https://*.scdn.co data:",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  'frame-src https://open.spotify.com',
  "base-uri 'none'",
  "form-action 'self'",
].join('; ')

const securityHeaders = (req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  })
  next()
}

// CSRF (plan §4.3): besides the SameSite=Lax cookie, a mutating request whose
// Origin header is another site is refused. Requests without Origin pass.
const sameOrigin = appOrigin => (req, res, next) => {
  const origin = req.get('origin')
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || origin === undefined || origin === appOrigin) return next()
  res.status(403).json({ error: 'Origine non autorisée' })
}

const notFound = (req, res) => res.status(404).json({ error: 'Introuvable' })

// Errors from Firestore's gRPC client carry a numeric code and details.
const isFirestoreError = error => typeof error?.code === 'number' && typeof error?.details === 'string'

// Builds the Express app. Its dependencies are passed in so tests can use the
// Firestore emulator and fake upstream services.
export function createApp({ firestore, config }) {
  const users = createUsersRepository(firestore)
  const app = express()
  app.disable('x-powered-by')
  app.use(securityHeaders)
  app.use(sameOrigin(config.appOrigin))

  app.get('/api/health', (req, res) => res.json({ ok: true, engine: config.recommender }))
  // Only the login and the API use the session, so static files never reach Firestore.
  app.use(['/auth', '/api'], sessionMiddleware({ firestore, config }))
  app.use(authRoutes({ config, users }))
  app.use('/api', apiRoutes({ config, users }))
  app.use('/api', notFound)

  app.use(staticRoutes(config.publicDir))
  app.use(notFound)

  // Express 5 also routes rejected promises from async handlers here.
  // Spotify and ReccoBeats failures are answered as plan §4.5 says; a
  // Spotify refusal of the session's tokens also ends the session.
  app.use((error, req, res, next) => {
    const upstream = upstreamAnswer(error)
    if (!upstream) return next(error)
    if (upstream.log) console.error(`${req.method} ${req.path}: ${error.constructor.name} ${error.status ?? ''} on ${error.path ?? '?'}: ${error.message}`)
    if (res.headersSent) return next(error)
    const send = () => res.status(upstream.status).set(upstream.headers ?? {}).json(upstream.body)
    if (!upstream.endSession || !req.session) return send()
    req.session.destroy(() => {
      res.clearCookie(COOKIE_NAME, { path: '/' })
      send()
    })
  })

  // Errors from express.static and res.sendFile carry their status (404 for
  // a missing file), Firestore failures become a 503 (plan §4.5), anything
  // else is a 500. The login pages are browser navigations, so they get a page.
  app.use((error, req, res, next) => {
    const status = isFirestoreError(error) ? 503 : error.status >= 400 && error.status < 600 ? error.status : 500
    if (status >= 500) console.error(`${req.method} ${req.path} failed:`, error)
    if (res.headersSent) return next(error)
    const message = status === 404 ? 'Introuvable'
      : status === 503 ? 'Service indisponible, réessaie plus tard'
        : status < 500 ? 'Requête invalide' : 'Une erreur est survenue, réessaie plus tard.'
    if (req.path.startsWith('/auth')) return res.status(status).type('html').send(page(message))
    res.status(status).json({ error: message })
  })
  return app
}
