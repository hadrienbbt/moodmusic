// Builds the web app the way the production start script does and serves the
// output with the real server: hashed assets, index.html for client routes
// (SPA fallback), JSON 404 for unknown API routes. The build test is skipped
// when the app's dependencies are not installed (run `npm ci` in app/).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { startServer, testEnv } from './helpers/server.js'

const appDir = path.join(import.meta.dirname, '..', 'app')
const vite = path.join(appDir, 'node_modules', '.bin', 'vite')
const skip = !fs.existsSync(vite) && 'app dependencies are not installed'

const tempDir = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

const assertSecurityHeaders = response => {
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('referrer-policy'), 'same-origin')
  assert.equal(response.headers.get('x-frame-options'), 'DENY')
  assert.equal(response.headers.get('content-security-policy'),
    "default-src 'self'; img-src 'self' https://i.scdn.co https://*.scdn.co data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src https://open.spotify.com; base-uri 'none'; form-action 'self'")
  assert.equal(response.headers.get('x-powered-by'), null)
}

test('the production build is served with an SPA fallback', { skip, timeout: 120000 }, async t => {
  const outDir = tempDir(t, 'moodmusic-app-')
  execFileSync(vite, ['build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'error'], {
    cwd: appDir,
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: 'pipe',
  })
  const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8')
  const script = html.match(/<script type="module" crossorigin src="\/assets\/(index-[\w-]+\.js)"><\/script>/)
  assert.ok(script, html)
  assert.match(html, /<link rel="stylesheet" crossorigin href="\/assets\/index-[\w-]+\.css">/)
  assert.match(html, /<html lang="fr">/)

  const server = await startServer({ ...testEnv, PUBLIC_DIR: outDir })
  t.after(server.stop)

  for (const route of ['/', '/artists', '/playlist/abc']) {
    const response = await fetch(`${server.url}${route}`)
    assert.equal(response.status, 200, route)
    assert.match(response.headers.get('content-type'), /^text\/html/)
    assertSecurityHeaders(response)
    assert.equal(await response.text(), html, route)
  }
  const head = await fetch(`${server.url}/artists`, { method: 'HEAD' })
  assert.equal(head.status, 200)

  const asset = await fetch(`${server.url}/assets/${script[1]}`)
  assert.equal(asset.status, 200)
  assert.match(asset.headers.get('content-type'), /^text\/javascript/)
  assertSecurityHeaders(asset)

  const health = await fetch(`${server.url}/api/health`)
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), { ok: true, engine: 'reccobeats' })
  assertSecurityHeaders(health)

  for (const [method, route] of [['GET', '/api/nope'], ['GET', '/api'], ['POST', '/api/health'], ['GET', '/auth/nope'], ['POST', '/artists']]) {
    const response = await fetch(`${server.url}${route}`, { method })
    assert.equal(response.status, 404, `${method} ${route}`)
    assert.match(response.headers.get('content-type'), /^application\/json/)
    assert.deepEqual(await response.json(), { error: 'Introuvable' })
  }
})

test('without a build the API still works and pages answer a JSON 404', async t => {
  const emptyDir = tempDir(t, 'moodmusic-nobuild-')
  const server = await startServer({ ...testEnv, PUBLIC_DIR: emptyDir })
  t.after(server.stop)
  assert.match(server.output(), /No web app build in/)

  const health = await fetch(`${server.url}/api/health`)
  assert.equal(health.status, 200)
  const page = await fetch(`${server.url}/artists`)
  assert.equal(page.status, 404)
  assert.deepEqual(await page.json(), { error: 'Introuvable' })
  assert.doesNotMatch(server.output(), /failed/, 'a missing build is not a server error')
})
