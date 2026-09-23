// Configuration parsing (plan §4.9): development defaults, what production
// requires, and refusal of invalid values.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { ConfigError, loadConfig, repoRoot } from '../server/config.js'

const spotify = { SPOTIFY_CLIENT_ID: 'id', SPOTIFY_CLIENT_SECRET: 'secret' }
const production = {
  ...spotify,
  NODE_ENV: 'production',
  APP_ORIGIN: 'https://moodmusic-v2.fedutia.fr',
  SESSION_SECRET: 'a'.repeat(64),
  FIREBASE_KEY_PATH: '/home/pi/webserver/moodmusic/.keys/key.json',
  SSL_CERT: '/etc/letsencrypt/live/fedutia.fr/fullchain.pem',
  SSL_KEY: '/etc/letsencrypt/live/fedutia.fr/privkey.pem',
}

const problemsOf = env => {
  try {
    loadConfig(env)
  } catch (error) {
    assert.ok(error instanceof ConfigError, error)
    return error.problems
  }
  assert.fail('the configuration was accepted')
}

test('development defaults', () => {
  const config = loadConfig(spotify)
  const { sessionSecret, ...rest } = config
  assert.deepEqual(rest, {
    nodeEnv: 'development',
    production: false,
    port: 8004,
    appOrigin: 'http://127.0.0.1:5173',
    clientId: 'id',
    clientSecret: 'secret',
    redirectUri: 'http://127.0.0.1:5173/auth/callback',
    firebaseKeyPath: undefined,
    recommender: 'reccobeats',
    reccobeatsUrl: 'https://api.reccobeats.com',
    market: 'FR',
    spotifyAccountsUrl: 'https://accounts.spotify.com',
    spotifyApiUrl: 'https://api.spotify.com',
    publicDir: path.join(repoRoot, 'app', 'dist'),
    sslCert: undefined,
    sslKey: undefined,
  })
  assert.match(sessionSecret, /^[0-9a-f]{64}$/)
  assert.notEqual(loadConfig(spotify).sessionSecret, sessionSecret, 'a new session secret is generated at each start')
  assert.ok(Object.isFrozen(config))
})

test('the Spotify client id and secret are required in every environment', () => {
  for (const NODE_ENV of ['development', 'test']) {
    assert.deepEqual(problemsOf({ NODE_ENV }), ['SPOTIFY_CLIENT_ID is required', 'SPOTIFY_CLIENT_SECRET is required'])
  }
})

test('production has no development defaults', () => {
  assert.deepEqual(problemsOf({ ...spotify, NODE_ENV: 'production' }), [
    'APP_ORIGIN is required in production',
    'SESSION_SECRET is required in production',
    'FIREBASE_KEY_PATH is required in production',
    'SSL_CERT is required in production',
    'SSL_KEY is required in production',
  ])
  const { SESSION_SECRET, ...withoutSecret } = production
  assert.deepEqual(problemsOf(withoutSecret), ['SESSION_SECRET is required in production'])
  assert.deepEqual(problemsOf({ ...production, SESSION_SECRET: 'ssshhhhh' }), ['SESSION_SECRET must be at least 32 characters long (openssl rand -hex 32)'])
})

test('a complete production configuration', () => {
  const config = loadConfig({ ...production, APP_ORIGIN: 'https://moodmusic-v2.fedutia.fr/', MARKET: 'BE' })
  assert.equal(config.production, true)
  assert.equal(config.appOrigin, 'https://moodmusic-v2.fedutia.fr')
  assert.equal(config.redirectUri, 'https://moodmusic-v2.fedutia.fr/auth/callback')
  assert.equal(config.sessionSecret, production.SESSION_SECRET)
  assert.equal(config.firebaseKeyPath, production.FIREBASE_KEY_PATH)
  assert.equal(config.sslCert, production.SSL_CERT)
  assert.equal(config.sslKey, production.SSL_KEY)
  assert.equal(config.market, 'BE')
})

test('tests can point the server at fake services and another build', () => {
  const config = loadConfig({
    ...spotify,
    NODE_ENV: 'test',
    PORT: '0',
    SPOTIFY_ACCOUNTS_URL: 'http://127.0.0.1:4000/',
    SPOTIFY_API_URL: 'http://127.0.0.1:4000',
    RECCOBEATS_URL: 'http://127.0.0.1:4001',
    SPOTIFY_REDIRECT_URI: 'http://127.0.0.1:8004/auth/callback',
    RECOMMENDER: 'spotify',
    PUBLIC_DIR: '/tmp/build',
  })
  assert.equal(config.nodeEnv, 'test')
  assert.equal(config.port, 0)
  assert.equal(config.spotifyAccountsUrl, 'http://127.0.0.1:4000')
  assert.equal(config.spotifyApiUrl, 'http://127.0.0.1:4000')
  assert.equal(config.reccobeatsUrl, 'http://127.0.0.1:4001')
  assert.equal(config.redirectUri, 'http://127.0.0.1:8004/auth/callback', 'the redirect URI is used exactly as registered')
  assert.equal(config.recommender, 'spotify')
  assert.equal(config.publicDir, '/tmp/build')
  assert.equal(loadConfig({ ...spotify, PUBLIC_DIR: 'build' }).publicDir, path.join(repoRoot, 'build'))
})

test('empty variables count as unset', () => {
  const config = loadConfig({ ...spotify, PORT: '', APP_ORIGIN: ' ', RECOMMENDER: '' })
  assert.equal(config.port, 8004)
  assert.equal(config.appOrigin, 'http://127.0.0.1:5173')
  assert.equal(config.recommender, 'reccobeats')
})

test('invalid values are refused', () => {
  assert.deepEqual(problemsOf({
    ...spotify,
    NODE_ENV: 'staging',
    PORT: '80a',
    APP_ORIGIN: 'https://moodmusic.fedutia.fr/app',
    RECOMMENDER: 'lastfm',
    MARKET: 'fr',
    RECCOBEATS_URL: 'ftp://api.reccobeats.com',
  }), [
    'NODE_ENV must be one of development, test, production, not "staging"',
    'PORT must be a port number, not "80a"',
    'APP_ORIGIN must be an origin such as https://moodmusic.fedutia.fr, not "https://moodmusic.fedutia.fr/app"',
    'RECOMMENDER must be one of reccobeats, spotify, not "lastfm"',
    'MARKET must be a two-letter country code such as FR, not "fr"',
    'RECCOBEATS_URL must be an http or https URL, not "ftp://api.reccobeats.com"',
  ])
  assert.deepEqual(problemsOf({ ...spotify, PORT: '70000' }), ['PORT must be a port number, not "70000"'])
  assert.deepEqual(problemsOf({ ...spotify, SPOTIFY_REDIRECT_URI: 'moodmusic/callback' }), ['SPOTIFY_REDIRECT_URI must be an http or https URL, not "moodmusic/callback"'])
})
