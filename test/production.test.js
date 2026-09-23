// Runs the server the way production does (plan §4.10): NODE_ENV=production,
// HTTPS with a throwaway self-signed certificate made with openssl, and a
// throwaway service-account key. Skipped when openssl is not available.
// The Secure session cookie is checked when the Firestore emulator is there
// to store the session.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { skip as noEmulator } from './helpers/firestore.js'
import { startServer, throwawayServiceAccount } from './helpers/server.js'

const hasOpenssl = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true } catch { return false } })()
const skip = !hasOpenssl && 'openssl is not available'

// fetch() cannot accept a self-signed certificate per request, so use node:https.
const request = (url, { method = 'GET' } = {}) => new Promise((resolve, reject) => {
  const req = https.request(url, { method, rejectUnauthorized: false }, res => {
    let body = ''
    res.setEncoding('utf8')
    res.on('data', chunk => { body += chunk })
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
  })
  req.on('error', reject)
  req.end()
})

let dir
let env

before(() => {
  if (skip) return
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'moodmusic-production-'))
  const certPath = path.join(dir, 'cert.pem')
  const keyPath = path.join(dir, 'key.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' })
  const serviceAccountPath = path.join(dir, 'service-account.json')
  fs.writeFileSync(serviceAccountPath, JSON.stringify(throwawayServiceAccount('demo-moodmusic')), { mode: 0o600 })
  const publicDir = path.join(dir, 'public')
  fs.mkdirSync(publicDir)
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<!doctype html><title>Moodmusic</title><div id="root">test build</div>')
  env = {
    NODE_ENV: 'production',
    PORT: '0',
    APP_ORIGIN: 'https://moodmusic.test',
    SPOTIFY_CLIENT_ID: 'test-client-id',
    SPOTIFY_CLIENT_SECRET: 'test-client-secret',
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    FIREBASE_KEY_PATH: serviceAccountPath,
    SSL_CERT: certPath,
    SSL_KEY: keyPath,
    PUBLIC_DIR: publicDir,
  }
})

after(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
})

test('in production the server answers over HTTPS with the security headers', { skip }, async t => {
  const server = await startServer(env)
  t.after(server.stop)
  assert.match(server.url, /^https:/)

  const health = await request(`${server.url}/api/health`)
  assert.equal(health.status, 200)
  assert.deepEqual(JSON.parse(health.body), { ok: true, engine: 'reccobeats' })

  const page = await request(`${server.url}/artists`)
  assert.equal(page.status, 200)
  assert.match(page.body, /test build/)
  assert.equal(page.headers['x-content-type-options'], 'nosniff')
  assert.equal(page.headers['x-frame-options'], 'DENY')
  assert.equal(page.headers['referrer-policy'], 'same-origin')
  assert.match(page.headers['content-security-policy'], /^default-src 'self'; /)
  assert.equal(page.headers['x-powered-by'], undefined)
})

test('in production the session cookie is Secure', { skip: skip || noEmulator }, async t => {
  const server = await startServer(env)
  t.after(server.stop)
  const login = await request(`${server.url}/auth/login`)
  assert.equal(login.status, 302)
  assert.match(login.headers.location, /^https:\/\/accounts\.spotify\.com\/authorize\?/)
  const cookie = login.headers['set-cookie'].find(header => header.startsWith('moodmusic.sid='))
  assert.match(cookie, /; Secure/)
  assert.match(cookie, /; HttpOnly/)
  assert.match(cookie, /; SameSite=Lax/)
})

test('the server refuses to start in production without SESSION_SECRET', { skip }, async () => {
  const { SESSION_SECRET, ...withoutSecret } = env
  await assert.rejects(startServer(withoutSecret), error => {
    assert.equal(error.exitCode, 1)
    assert.match(error.output, /SESSION_SECRET is required in production/)
    assert.doesNotMatch(error.output, /Listening/)
    return true
  })
})
