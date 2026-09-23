// Firestore emulator access for tests: reset between tests, read documents
// through the emulator's REST API with its "Bearer owner" admin credential,
// or use the Admin SDK in the test process. Only a loopback emulator and the
// demo- project are accepted, so tests can never touch a real database.
// Tests using it are skipped unless FIRESTORE_EMULATOR_HOST is set: run them
// with `npm run test:emulator` (needs firebase-tools and Java).
import assert from 'node:assert/strict'
import { initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

export const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST
export const projectId = 'demo-moodmusic'
export const skip = !emulatorHost && 'FIRESTORE_EMULATOR_HOST is not set'

if (emulatorHost) assert.match(emulatorHost, /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/, 'the Firestore emulator must be on a loopback address')

const documentsUrl = `http://${emulatorHost}/v1/projects/${projectId}/databases/(default)/documents`

export async function resetFirestore() {
  const response = await fetch(`http://${emulatorHost}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: 'DELETE' })
  assert.equal(response.status, 200, `emulator reset failed: ${response.status}`)
}

const decodeValue = value => {
  if ('stringValue' in value) return value.stringValue
  if ('integerValue' in value) return Number(value.integerValue)
  if ('doubleValue' in value) return value.doubleValue
  if ('booleanValue' in value) return value.booleanValue
  if ('nullValue' in value) return null
  if ('timestampValue' in value) return new Date(value.timestampValue)
  if ('arrayValue' in value) return (value.arrayValue.values ?? []).map(decodeValue)
  if ('mapValue' in value) return decodeFields(value.mapValue.fields ?? {})
  throw new Error(`unexpected Firestore value ${JSON.stringify(value)}`)
}
const decodeFields = fields => Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeValue(value)]))

// A document's fields, or null when it does not exist.
export async function readDocument(path) {
  const response = await fetch(`${documentsUrl}/${path}`, { headers: { Authorization: 'Bearer owner' } })
  if (response.status === 404) return null
  assert.equal(response.status, 200, `reading ${path} failed: ${response.status}`)
  return decodeFields((await response.json()).fields ?? {})
}

export async function listDocuments(collection) {
  const response = await fetch(`${documentsUrl}/${collection}?pageSize=300`, { headers: { Authorization: 'Bearer owner' } })
  assert.equal(response.status, 200, `listing ${collection} failed: ${response.status}`)
  const { documents = [] } = await response.json()
  return documents.map(doc => ({ id: doc.name.split('/').pop(), data: decodeFields(doc.fields ?? {}) }))
}

// An Admin SDK Firestore on the emulator, for tests that call server code
// directly or write fixtures.
let firestore
export const adminFirestore = () => (firestore ??= getFirestore(initializeApp({ projectId }, 'tests')))
