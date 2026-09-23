// The Firestore session store (plan appendix G) against the emulator.
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { FirestoreStore } from '../server/session-store.js'
import { adminFirestore, readDocument, resetFirestore, skip } from './helpers/firestore.js'

const DAY_MS = 24 * 60 * 60 * 1000
const call = (store, method, ...args) => new Promise((resolve, reject) => store[method](...args, (error, value) => (error ? reject(error) : resolve(value))))
const sessionExpiring = at => ({ cookie: { originalMaxAge: 30 * DAY_MS, expires: at.toISOString(), httpOnly: true, path: '/' }, user: { id: 'alice' } })

let store
beforeEach(async () => {
  if (skip) return
  await resetFirestore()
  store = new FirestoreStore(adminFirestore())
})

test('a session is stored as JSON with its expiry, and read back', { skip }, async () => {
  const expires = new Date(Date.now() + 30 * DAY_MS)
  const session = sessionExpiring(expires)
  await call(store, 'set', 'sid-1', session)

  const doc = await readDocument('sessions/sid-1')
  assert.deepEqual(JSON.parse(doc.data), session)
  assert.equal(doc.expiresAt.getTime(), expires.getTime())
  assert.deepEqual(await call(store, 'get', 'sid-1'), session)
})

test('an unknown session id reads as no session', { skip }, async () => {
  assert.equal(await call(store, 'get', 'unknown'), null)
})

test('touch moves the expiry without changing the data', { skip }, async () => {
  const session = sessionExpiring(new Date(Date.now() + DAY_MS))
  await call(store, 'set', 'sid-2', session)
  const later = new Date(Date.now() + 30 * DAY_MS)
  await call(store, 'touch', 'sid-2', sessionExpiring(later))

  const doc = await readDocument('sessions/sid-2')
  assert.equal(doc.expiresAt.getTime(), later.getTime())
  assert.deepEqual(JSON.parse(doc.data), session)
})

test('touching a session destroyed meanwhile is not an error', { skip }, async () => {
  await call(store, 'touch', 'gone', sessionExpiring(new Date(Date.now() + DAY_MS)))
  assert.equal(await readDocument('sessions/gone'), null, 'touch must not recreate the session')
})

test('destroy deletes the session', { skip }, async () => {
  await call(store, 'set', 'sid-3', sessionExpiring(new Date(Date.now() + DAY_MS)))
  await call(store, 'destroy', 'sid-3')
  assert.equal(await readDocument('sessions/sid-3'), null)
  assert.equal(await call(store, 'get', 'sid-3'), null)
})

test('an expired session reads as no session and is deleted', { skip }, async () => {
  await call(store, 'set', 'sid-4', sessionExpiring(new Date(Date.now() - 1000)))
  assert.equal(await call(store, 'get', 'sid-4'), null)
  assert.equal(await readDocument('sessions/sid-4'), null)
})

test('a session without cookie expiry gets the 30-day default', { skip }, async () => {
  const before = Date.now()
  await call(store, 'set', 'sid-5', { user: { id: 'alice' } })
  const { expiresAt } = await readDocument('sessions/sid-5')
  assert.ok(expiresAt.getTime() >= before + 30 * DAY_MS && expiresAt.getTime() <= Date.now() + 30 * DAY_MS)
})
