// How the server fails (plan §4.5, §4.10). Firestore is replaced by a local
// server that refuses every call at once (helpers/failing-firestore.js)
// rather than a closed port, which the client would retry for about 40 s.
// Runs without the emulator. Later steps add the Spotify and ReccoBeats
// failures.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

import { startFailingFirestore } from './helpers/failing-firestore.js'
import { createClient, startServer, testEnv } from './helpers/server.js'

const SESSION_SECRET = crypto.randomBytes(32).toString('hex')
// A session cookie signed the way express-session signs it, for a session
// the store has never seen: the server has to ask Firestore about it.
const signedCookie = sid => {
  const signature = crypto.createHmac('sha256', SESSION_SECRET).update(sid).digest('base64').replace(/=+$/, '')
  return `moodmusic.sid=${encodeURIComponent(`s:${sid}.${signature}`)}`
}

let firestore
let server

before(async () => {
  firestore = await startFailingFirestore()
  server = await startServer({ ...testEnv, SESSION_SECRET, FIRESTORE_EMULATOR_HOST: firestore.host })
})

after(async () => {
  await server?.stop()
  await firestore?.stop()
})

test('when Firestore fails, the API answers 503 and the login shows a page', async () => {
  const client = createClient(server.url)
  const login = await client.request('/auth/login')
  assert.equal(login.status, 503)
  assert.match(login.headers.get('content-type'), /^text\/html/)
  assert.ok(login.text.includes('Service indisponible, réessaie plus tard'))

  const session = await client.request('/api/session', { headers: { Cookie: signedCookie('a-session-id') } })
  assert.equal(session.status, 503)
  assert.deepEqual(session.json, { error: 'Service indisponible, réessaie plus tard' })
  assert.ok(firestore.calls >= 2)
  assert.equal(server.child.exitCode, null, 'the server keeps running')
})

test('without a session cookie, nothing asks Firestore', async () => {
  const calls = firestore.calls
  const client = createClient(server.url)
  assert.equal((await client.request('/api/session')).status, 401)
  assert.equal((await client.request('/api/health')).status, 200)
  assert.equal(firestore.calls, calls)
})
