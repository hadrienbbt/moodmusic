import crypto from 'node:crypto'
import path from 'node:path'

// Reads the server configuration from the environment (plan §4.9). Every
// problem is reported at once and the server refuses to start. Production
// has no development defaults: its origin, secrets, Firebase key and TLS
// certificate must all be given.

export const repoRoot = path.join(import.meta.dirname, '..')

const NODE_ENVS = ['development', 'test', 'production']
const RECOMMENDERS = ['reccobeats', 'spotify']

export class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid configuration:\n${problems.map(problem => `- ${problem}`).join('\n')}`)
    this.problems = problems
  }
}

const parseUrl = text => {
  try {
    const url = new URL(text)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

export function loadConfig(env = process.env) {
  const problems = []
  // An empty variable counts as unset.
  const read = name => env[name]?.trim() || undefined
  const required = name => {
    const value = read(name)
    if (value === undefined) problems.push(`${name} is required`)
    return value
  }

  const nodeEnv = read('NODE_ENV') ?? 'development'
  if (!NODE_ENVS.includes(nodeEnv)) problems.push(`NODE_ENV must be one of ${NODE_ENVS.join(', ')}, not "${nodeEnv}"`)
  const production = nodeEnv === 'production'
  const requiredInProduction = (name, developmentDefault) => {
    const value = read(name)
    if (value !== undefined || !production) return value ?? developmentDefault
    problems.push(`${name} is required in production`)
  }
  const httpUrl = (name, fallback) => {
    const value = read(name) ?? fallback
    if (value === undefined || parseUrl(value)) return value
    problems.push(`${name} must be an http or https URL, not "${value}"`)
  }
  // Base URLs of the upstream services, kept without a trailing slash.
  const baseUrl = (name, fallback) => httpUrl(name, fallback)?.replace(/\/+$/, '')

  const portText = read('PORT') ?? '8004'
  const port = Number(portText)
  if (!/^\d+$/.test(portText) || port > 65535) problems.push(`PORT must be a port number, not "${portText}"`)

  const appOriginText = requiredInProduction('APP_ORIGIN', 'http://127.0.0.1:5173')
  const appOriginUrl = appOriginText && parseUrl(appOriginText)
  const appOrigin = appOriginUrl && appOriginUrl.pathname === '/' && !appOriginUrl.search && !appOriginUrl.hash && !appOriginUrl.username
    ? appOriginUrl.origin
    : undefined
  if (appOriginText && !appOrigin) problems.push(`APP_ORIGIN must be an origin such as https://moodmusic.fedutia.fr, not "${appOriginText}"`)

  let sessionSecret = requiredInProduction('SESSION_SECRET', crypto.randomBytes(32).toString('hex'))
  if (production && sessionSecret && sessionSecret.length < 32) {
    problems.push('SESSION_SECRET must be at least 32 characters long (openssl rand -hex 32)')
    sessionSecret = undefined
  }

  const recommender = read('RECOMMENDER') ?? 'reccobeats'
  if (!RECOMMENDERS.includes(recommender)) problems.push(`RECOMMENDER must be one of ${RECOMMENDERS.join(', ')}, not "${recommender}"`)

  const market = read('MARKET') ?? 'FR'
  if (!/^[A-Z]{2}$/.test(market)) problems.push(`MARKET must be a two-letter country code such as FR, not "${market}"`)

  const firebaseKeyPath = requiredInProduction('FIREBASE_KEY_PATH')
  const sslCert = requiredInProduction('SSL_CERT')
  const sslKey = requiredInProduction('SSL_KEY')

  const config = {
    nodeEnv,
    production,
    port,
    appOrigin,
    clientId: required('SPOTIFY_CLIENT_ID'),
    clientSecret: required('SPOTIFY_CLIENT_SECRET'),
    redirectUri: httpUrl('SPOTIFY_REDIRECT_URI', appOrigin && `${appOrigin}/auth/callback`),
    sessionSecret,
    firebaseKeyPath: firebaseKeyPath && path.resolve(firebaseKeyPath),
    recommender,
    reccobeatsUrl: baseUrl('RECCOBEATS_URL', 'https://api.reccobeats.com'),
    market,
    spotifyAccountsUrl: baseUrl('SPOTIFY_ACCOUNTS_URL', 'https://accounts.spotify.com'),
    spotifyApiUrl: baseUrl('SPOTIFY_API_URL', 'https://api.spotify.com'),
    publicDir: path.resolve(repoRoot, read('PUBLIC_DIR') ?? 'app/dist'),
    sslCert: sslCert && path.resolve(sslCert),
    sslKey: sslKey && path.resolve(sslKey),
  }
  if (problems.length > 0) throw new ConfigError(problems)
  return Object.freeze(config)
}
