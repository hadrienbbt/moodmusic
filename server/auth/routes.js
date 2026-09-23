import crypto from 'node:crypto'
import express from 'express'

import { exchangeCode } from '../spotify/accounts.js'
import { SpotifyError, createSpotifyClient } from '../spotify/client.js'
import { LOGIN_FAILED, NOT_ALLOWLISTED, page } from './pages.js'
import { COOKIE_NAME } from './session.js'

// The Authorization Code flow, run entirely by the server (plan §4.3,
// appendix H). `state` ties the callback to the browser that started the
// login, the session id changes once the user is known (no session
// fixation), and the Spotify tokens never leave the server.
export const SCOPES = 'user-top-read playlist-modify-public playlist-modify-private'

const inSession = (req, method) => new Promise((resolve, reject) => req.session[method](error => (error ? reject(error) : resolve())))

export function authRoutes({ config, users }) {
  const router = express.Router()

  // Ends a failed login without leaving a session behind.
  const fail = (req, res, status, message) => req.session.destroy(() => {
    res.clearCookie(COOKIE_NAME, { path: '/' })
    res.status(status).type('html').send(page(message))
  })

  router.get('/auth/login', (req, res, next) => {
    const state = crypto.randomBytes(16).toString('hex')
    req.session.oauthState = state
    req.session.save(error => {
      if (error) return next(error)
      const params = new URLSearchParams({ response_type: 'code', client_id: config.clientId, scope: SCOPES, redirect_uri: config.redirectUri, state })
      res.redirect(`${config.spotifyAccountsUrl}/authorize?${params}`)
    })
  })

  router.get('/auth/callback', async (req, res) => {
    const { code, state, error } = req.query
    const expected = req.session.oauthState
    delete req.session.oauthState
    if (error || typeof code !== 'string' || typeof state !== 'string' || !expected || state !== expected) {
      return fail(req, res, 400, LOGIN_FAILED)
    }

    let tokens
    let me
    try {
      tokens = await exchangeCode(config, code)
      me = await createSpotifyClient({ config, accessToken: () => tokens.access_token }).me()
    } catch (error) {
      // A 403 on GET /v1/me: the account is not on the app's allow-list (plan §3.1).
      if (tokens && error instanceof SpotifyError && error.status === 403) return fail(req, res, 403, NOT_ALLOWLISTED)
      console.error(`Login failed: ${error.message}`)
      return fail(req, res, 502, LOGIN_FAILED)
    }

    const user = { id: me.id, displayName: me.display_name ?? me.id, image: me.images?.[0]?.url ?? null }
    const { created } = await users.upsertOnLogin(user)
    await inSession(req, 'regenerate')
    req.session.user = user
    req.session.tokens = { access: tokens.access_token, refresh: tokens.refresh_token, expiresAt: Date.now() + tokens.expires_in * 1000 }
    await inSession(req, 'save')
    if (created) {
      // The login succeeds even if the import fails: artists can be added by hand.
      try {
        const top = await createSpotifyClient({ config, accessToken: () => tokens.access_token }).topArtists(15)
        await users.mergeTopArtists(user.id, top.items ?? [])
      } catch (error) {
        console.error(`Top artists import failed: ${error.message}`)
      }
    }
    res.redirect(created ? '/onboarding' : '/')
  })

  router.post('/auth/logout', (req, res, next) => req.session.destroy(error => {
    if (error) return next(error)
    res.clearCookie(COOKIE_NAME, { path: '/' })
    res.status(204).end()
  }))

  return router
}

// For the API routes that need a logged-in user (plan §4.5).
export const requireUser = (req, res, next) => (req.session?.user ? next() : res.status(401).json({ error: 'unauthenticated' }))
