// A local stand-in for Spotify (plan §4.10) on one port. It plays both
// accounts.spotify.com (/authorize, /api/token) and api.spotify.com in the
// Development Mode shape, with bodies shaped like the OpenAPI spec. Tests add
// users, choose who logs in next, and can take a user off the app's
// allow-list. Every request is logged, and every token handed out is kept so
// tests can check that none of them reaches the browser. Step 4 adds the
// refresh grant, 429 sequences and the remaining endpoints.
import crypto from 'node:crypto'
import http from 'node:http'

export const NOT_REGISTERED = 'User not registered in the Developer Dashboard'

const images = (kind, id) => [640, 300, 64].map(size => ({ url: `https://i.scdn.co/image/${kind}-${id}-${size}`, height: size, width: size }))

export const fakeArtist = (id, name) => ({
  id,
  name,
  type: 'artist',
  uri: `spotify:artist:${id}`,
  href: `https://api.spotify.com/v1/artists/${id}`,
  external_urls: { spotify: `https://open.spotify.com/artist/${id}` },
  images: images('artist', id),
})

export async function startFakeSpotify({ clientId, clientSecret }) {
  const users = new Map()
  const codes = new Map()
  const accessTokens = new Map()
  const issued = []
  const requests = []
  let nextLogin

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
  }
  const apiError = (res, status, message) => send(res, status, { error: { status, message } })
  const token = () => crypto.randomBytes(16).toString('hex')

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake-spotify')
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body })

    // The consent page: sends the browser back at once, as the user tests chose.
    if (req.method === 'GET' && url.pathname === '/authorize') {
      const query = url.searchParams
      if (query.get('client_id') !== clientId || query.get('response_type') !== 'code' || !query.get('redirect_uri')) {
        return send(res, 400, { error: 'invalid_request' })
      }
      const back = new URL(query.get('redirect_uri'))
      if (nextLogin?.deny) {
        back.searchParams.set('error', 'access_denied')
      } else {
        const code = `code-${token()}`
        codes.set(code, { userId: nextLogin?.userId, redirectUri: query.get('redirect_uri'), scope: query.get('scope') })
        back.searchParams.set('code', code)
      }
      if (query.has('state')) back.searchParams.set('state', query.get('state'))
      nextLogin = undefined
      res.writeHead(302, { Location: back.href })
      return res.end()
    }

    if (req.method === 'POST' && url.pathname === '/api/token') {
      if (req.headers.authorization !== `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`) {
        return send(res, 400, { error: 'invalid_client', error_description: 'Invalid client' })
      }
      const form = new URLSearchParams(body)
      if (form.get('grant_type') !== 'authorization_code') return send(res, 400, { error: 'unsupported_grant_type' })
      const grant = codes.get(form.get('code'))
      codes.delete(form.get('code')) // single use
      if (!grant || grant.redirectUri !== form.get('redirect_uri')) {
        return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid authorization code' })
      }
      const access = `access-${token()}`
      const refresh = `refresh-${token()}`
      issued.push(access, refresh)
      accessTokens.set(access, grant.userId)
      return send(res, 200, { access_token: access, token_type: 'Bearer', scope: grant.scope, expires_in: 3600, refresh_token: refresh })
    }

    if (url.pathname.startsWith('/v1/')) {
      const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1]
      const user = users.get(accessTokens.get(bearer))
      if (!user) return apiError(res, 401, 'Invalid access token')
      if (!user.allowListed) return apiError(res, 403, NOT_REGISTERED)

      // get-current-users-profile, without the fields Development Mode removed
      if (req.method === 'GET' && url.pathname === '/v1/me') {
        return send(res, 200, {
          id: user.id,
          display_name: user.displayName,
          images: user.images,
          type: 'user',
          uri: `spotify:user:${user.id}`,
          href: `https://api.spotify.com/v1/users/${user.id}`,
          external_urls: { spotify: `https://open.spotify.com/user/${user.id}` },
        })
      }
      // get-users-top-artists-and-tracks
      if (req.method === 'GET' && url.pathname === '/v1/me/top/artists') {
        const limit = Number(url.searchParams.get('limit') ?? 20)
        if (!Number.isInteger(limit) || limit < 0 || limit > 50) return apiError(res, 400, 'Invalid limit')
        if (user.topArtistsStatus) return apiError(res, user.topArtistsStatus, 'Test failure')
        return send(res, 200, {
          href: `https://api.spotify.com/v1/me/top/artists?limit=${limit}`,
          limit,
          offset: 0,
          next: null,
          previous: null,
          total: user.topArtists.length,
          items: user.topArtists.slice(0, limit),
        })
      }
    }
    apiError(res, 404, 'Service not found')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    issued,
    // topArtistsStatus: an error status to answer on the top artists instead.
    addUser({ id, displayName = id, topArtists = [], allowListed = true, topArtistsStatus }) {
      users.set(id, { id, displayName, images: images('user', id), topArtists, allowListed, topArtistsStatus })
    },
    user: id => users.get(id),
    loginAs(userId) { nextLogin = { userId } },
    denyNextLogin() { nextLogin = { deny: true } },
    stop: () => new Promise(resolve => {
      server.closeAllConnections()
      server.close(resolve)
    }),
  }
}
