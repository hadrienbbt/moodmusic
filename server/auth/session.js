import session from 'express-session'

import { FirestoreStore } from '../session-store.js'

export const COOKIE_NAME = 'moodmusic.sid'
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

// Plan §4.3: the browser only holds the signed session id, in an httpOnly,
// SameSite=Lax cookie that is Secure in production. The session itself, the
// Spotify tokens included, lives in Firestore. Every request extends it
// (rolling), so it ends after 30 days without a visit.
export const sessionMiddleware = ({ firestore, config }) => session({
  name: COOKIE_NAME,
  secret: config.sessionSecret,
  store: new FirestoreStore(firestore),
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, secure: config.production, sameSite: 'lax', maxAge: THIRTY_DAYS_MS },
})
