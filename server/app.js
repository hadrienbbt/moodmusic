import express from 'express'

import { staticRoutes } from './routes/static.js'

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

const notFound = (req, res) => res.status(404).json({ error: 'Introuvable' })

// Builds the Express app. Its dependencies are passed in so tests can use the
// Firestore emulator and fake upstream services; firestore is first used by
// the session store (step 3).
export function createApp({ firestore, config }) {
  const app = express()
  app.disable('x-powered-by')
  app.use(securityHeaders)

  app.get('/api/health', (req, res) => res.json({ ok: true, engine: config.recommender }))
  app.use('/api', notFound)

  app.use(staticRoutes(config.publicDir))
  app.use(notFound)

  // Express 5 also routes rejected promises from async handlers here. Errors
  // from express.static and res.sendFile carry their status (404 for a
  // missing file); anything else is logged and answered with a 500.
  app.use((error, req, res, next) => {
    const status = error.status >= 400 && error.status < 600 ? error.status : 500
    if (status >= 500) console.error(`${req.method} ${req.path} failed:`, error)
    if (res.headersSent) return next(error)
    const message = status === 404 ? 'Introuvable' : status < 500 ? 'Requête invalide' : 'Une erreur est survenue, réessaie plus tard.'
    res.status(status).json({ error: message })
  })
  return app
}
