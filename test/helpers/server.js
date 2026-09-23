// Starts the real server (server/index.js) as a child process for tests. It
// runs from a temporary working directory so no .env file is loaded, with
// only the environment the test gives plus PATH, on a port chosen by the
// system. Firestore can only be a loopback address: the emulator when the
// tests run under `npm run test:emulator`, otherwise a closed port.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const entry = path.join(import.meta.dirname, '..', '..', 'server', 'index.js')
const loopback = /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/

// Satisfies the configuration without any real secret.
export const testEnv = {
  NODE_ENV: 'test',
  PORT: '0',
  SPOTIFY_CLIENT_ID: 'test-client-id',
  SPOTIFY_CLIENT_SECRET: 'test-client-secret',
}

// A service-account key that looks real but grants nothing anywhere.
export const throwawayServiceAccount = projectId => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  return {
    type: 'service_account',
    project_id: projectId,
    private_key_id: 'throwaway',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    client_email: `test@${projectId}.iam.gserviceaccount.com`,
    client_id: '0',
    token_uri: 'https://oauth2.googleapis.com/token',
  }
}

// A browser-like client for the server: it keeps its cookies, does not follow
// redirects (tests look at each Location header) and keeps every response,
// so tests can search them all.
export function createClient(baseUrl) {
  const cookies = new Map()
  const responses = []
  const request = async (path, { method = 'GET', headers = {}, body } = {}) => {
    const cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ')
    const response = await fetch(new URL(path, baseUrl), { method, redirect: 'manual', headers: { ...(cookie && { Cookie: cookie }), ...headers }, body })
    const setCookies = response.headers.getSetCookie()
    for (const header of setCookies) {
      const [pair, ...attributes] = header.split(';').map(part => part.trim())
      const name = pair.slice(0, pair.indexOf('='))
      const value = pair.slice(pair.indexOf('=') + 1)
      const expires = attributes.find(attribute => /^expires=/i.test(attribute))
      if (value === '' || (expires && new Date(expires.slice('expires='.length)) <= new Date())) cookies.delete(name)
      else cookies.set(name, value)
    }
    const text = await response.text()
    let json
    try { json = JSON.parse(text) } catch {}
    const result = { status: response.status, headers: response.headers, location: response.headers.get('location'), setCookies, text, json }
    responses.push(result)
    return result
  }
  return { request, cookies, responses }
}

// Resolves with { url, child, output(), stop() } once the server listens. Rejects
// when it exits first, with the exit code and output on the error.
export async function startServer(env) {
  const firestoreHost = env.FIRESTORE_EMULATOR_HOST ?? process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:1'
  if (!loopback.test(firestoreHost)) throw new Error(`Firestore host must be on loopback, not ${firestoreHost}`)
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'moodmusic-server-'))
  const child = spawn(process.execPath, [entry], {
    cwd,
    env: { PATH: process.env.PATH, ...env, FIRESTORE_EMULATOR_HOST: firestoreHost },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise(resolve => child.once('close', resolve))
      child.kill()
      await closed
    }
    fs.rmSync(cwd, { recursive: true, force: true })
  }
  try {
    const listening = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 15000)
      const onData = chunk => {
        output += chunk
        const match = output.match(/Listening (https?) on port (\d+)/)
        if (match) {
          clearTimeout(timer)
          resolve({ protocol: match[1], port: match[2] })
        }
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      // 'close' comes after the output streams end, so the output is complete.
      child.once('close', code => {
        clearTimeout(timer)
        reject(Object.assign(new Error(`server exited with code ${code}:\n${output}`), { exitCode: code, output }))
      })
    })
    return { url: `${listening.protocol}://127.0.0.1:${listening.port}`, child, output: () => output, stop }
  } catch (error) {
    await stop()
    throw error
  }
}
