// A local stand-in for Spotify (plan §4.10) on one port. It plays both
// accounts.spotify.com (/authorize, /api/token) and api.spotify.com in the
// Development Mode shape, with bodies shaped like the OpenAPI spec:
// /v1/recommendations answers 404 unless told otherwise, search refuses a
// limit above 10, and a user can be taken off the app's allow-list (403).
// Tests script answers per path (429 sequences, errors, a hang), expire
// access tokens and revoke refresh tokens. Every request is logged, and every
// token handed out is kept so tests can check that none of them leaks.
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

const paging = (href, items, limit, total = items.length) => ({ href, limit, next: null, offset: 0, previous: null, total, items })

export async function startFakeSpotify({ clientId, clientSecret }) {
  const users = new Map()
  const catalog = new Map() // artists found by search and GET /v1/artists/{id}
  const codes = new Map()
  const accessTokens = new Map() // token → { userId, expiresAt }
  const refreshTokens = new Map() // token → userId
  const playlists = new Map()
  const scripts = new Map() // "METHOD /path" → answers to give before the normal ones
  const issued = []
  const requests = []
  const options = { recommendations: false, newRefreshToken: false }
  let nextLogin

  const token = () => crypto.randomBytes(16).toString('hex')
  const issueAccess = userId => {
    const access = `access-${token()}`
    accessTokens.set(access, { userId, expiresAt: Date.now() + 3600 * 1000 })
    issued.push(access)
    return access
  }
  const issueRefresh = userId => {
    const refresh = `refresh-${token()}`
    refreshTokens.set(refresh, userId)
    issued.push(refresh)
    return refresh
  }
  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...headers })
    res.end(body === undefined ? undefined : JSON.stringify(body))
  }
  const apiError = (res, status, message) => send(res, status, { error: { status, message } })
  const playlistObject = playlist => ({
    collaborative: false,
    description: null,
    external_urls: { spotify: `https://open.spotify.com/playlist/${playlist.id}` },
    href: `https://api.spotify.com/v1/playlists/${playlist.id}`,
    id: playlist.id,
    images: [],
    name: playlist.name,
    owner: { id: playlist.owner, type: 'user', uri: `spotify:user:${playlist.owner}` },
    public: playlist.public,
    snapshot_id: playlist.snapshot,
    items: { href: `https://api.spotify.com/v1/playlists/${playlist.id}/items`, total: playlist.items.length },
    type: 'playlist',
    uri: `spotify:playlist:${playlist.id}`,
  })

  const accounts = (req, res, url, body) => {
    // The consent page: sends the browser back at once, as the test chose.
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
      if (form.get('grant_type') === 'authorization_code') {
        const grant = codes.get(form.get('code'))
        codes.delete(form.get('code')) // single use
        if (!grant || grant.redirectUri !== form.get('redirect_uri')) {
          return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid authorization code' })
        }
        return send(res, 200, { access_token: issueAccess(grant.userId), token_type: 'Bearer', scope: grant.scope, expires_in: 3600, refresh_token: issueRefresh(grant.userId) })
      }
      if (form.get('grant_type') === 'refresh_token') {
        const userId = refreshTokens.get(form.get('refresh_token'))
        if (!userId) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid refresh token' })
        const answer = { access_token: issueAccess(userId), token_type: 'Bearer', expires_in: 3600 }
        // Spotify usually keeps the refresh token; told so, the fake replaces it.
        if (options.newRefreshToken) {
          refreshTokens.delete(form.get('refresh_token'))
          answer.refresh_token = issueRefresh(userId)
        }
        return send(res, 200, answer)
      }
      return send(res, 400, { error: 'unsupported_grant_type' })
    }
  }

  const api = (req, res, url, body) => {
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1]
    const grant = accessTokens.get(bearer)
    if (!grant) return apiError(res, 401, 'Invalid access token')
    if (grant.expiresAt <= Date.now()) return apiError(res, 401, 'The access token expired')
    const user = users.get(grant.userId)
    if (!user?.allowListed) return apiError(res, 403, NOT_REGISTERED)
    const query = url.searchParams
    const route = `${req.method} ${url.pathname}`
    const limitOf = (fallback, max) => {
      const limit = Number(query.get('limit') ?? fallback)
      return Number.isInteger(limit) && limit >= 0 && limit <= max ? limit : null
    }

    if (route === 'GET /v1/me') { // get-current-users-profile, without the fields Development Mode removed
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
    if (route === 'GET /v1/me/top/artists') { // get-users-top-artists-and-tracks
      const limit = limitOf(20, 50)
      if (limit === null) return apiError(res, 400, 'Invalid limit')
      if (user.topArtistsStatus) return apiError(res, user.topArtistsStatus, 'Test failure')
      return send(res, 200, paging(`https://api.spotify.com/v1/me/top/artists?limit=${limit}`, user.topArtists.slice(0, limit), limit, user.topArtists.length))
    }
    if (route === 'GET /v1/search') { // search, with the Development Mode cap of 10 (plan §3.1)
      const limit = limitOf(5, 10)
      if (limit === null) return apiError(res, 400, 'Invalid limit')
      if (!query.get('q')) return apiError(res, 400, 'No search query')
      if (query.get('type') !== 'artist') return apiError(res, 400, 'Unsupported type')
      const found = [...catalog.values()].filter(artist => artist.name.toLowerCase().includes(query.get('q').toLowerCase()))
      return send(res, 200, { artists: paging(`https://api.spotify.com/v1/search?${query}`, found.slice(0, limit), limit, found.length) })
    }
    const artistPath = url.pathname.match(/^\/v1\/artists\/([^/]+)$/)
    if (req.method === 'GET' && artistPath) { // get-an-artist
      const artist = catalog.get(decodeURIComponent(artistPath[1]))
      return artist ? send(res, 200, artist) : apiError(res, 404, 'Resource not found')
    }
    if (route === 'GET /v1/recommendations') { // get-recommendations, gone for Development Mode apps
      if (!options.recommendations) return apiError(res, 404, 'Service not found')
      const limit = limitOf(20, 100) ?? 20
      const tracks = Array.from({ length: limit }, (_, i) => ({ id: `rec${i}`, uri: `spotify:track:rec${i}`, name: `Recommended ${i}`, type: 'track' }))
      return send(res, 200, { seeds: (query.get('seed_artists') ?? '').split(',').map(id => ({ id, type: 'ARTIST' })), tracks })
    }
    if (route === 'POST /v1/me/playlists') { // create-playlist
      const { name, public: isPublic = true } = JSON.parse(body || '{}')
      if (typeof name !== 'string' || !name) return apiError(res, 400, 'Missing required field: name')
      const playlist = { id: `pl${token().slice(0, 20)}`, owner: user.id, name, public: isPublic, items: [], snapshot: token(), inLibrary: true }
      playlists.set(playlist.id, playlist)
      return send(res, 201, playlistObject(playlist))
    }
    const itemsPath = url.pathname.match(/^\/v1\/playlists\/([^/]+)\/items$/)
    if (req.method === 'POST' && itemsPath) { // add-items-to-playlist
      const playlist = playlists.get(decodeURIComponent(itemsPath[1]))
      if (!playlist) return apiError(res, 404, 'Resource not found')
      if (playlist.owner !== user.id) return apiError(res, 403, "You cannot add tracks to a playlist you don't own.")
      const { uris } = JSON.parse(body || '{}')
      if (!Array.isArray(uris) || uris.length === 0) return apiError(res, 400, 'No uris')
      if (uris.length > 100) return apiError(res, 400, 'Too many ids requested')
      playlist.items.push(...uris)
      playlist.snapshot = token()
      return send(res, 201, { snapshot_id: playlist.snapshot })
    }
    if (route === 'GET /v1/me/playlists') { // get-a-list-of-current-users-playlists
      const limit = limitOf(20, 50)
      if (limit === null) return apiError(res, 400, 'Invalid limit')
      const own = [...playlists.values()].filter(playlist => playlist.owner === user.id && playlist.inLibrary)
      return send(res, 200, paging(`https://api.spotify.com/v1/me/playlists?limit=${limit}`, own.slice(0, limit).map(playlistObject), limit, own.length))
    }
    if (route === 'DELETE /v1/me/library') { // remove-library-items
      for (const uri of (query.get('uris') ?? '').split(',')) {
        const playlist = playlists.get(uri.replace(/^spotify:playlist:/, ''))
        if (playlist?.owner === user.id) playlist.inLibrary = false
      }
      return send(res, 200)
    }
    apiError(res, 404, 'Service not found')
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake-spotify')
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body })

    const scripted = scripts.get(`${req.method} ${url.pathname}`)?.shift()
    if (scripted?.hang) return // never answers: the client's timeout has to end it
    if (scripted) return send(res, scripted.status, scripted.body ?? { error: { status: scripted.status, message: scripted.message ?? `Scripted ${scripted.status}` } }, scripted.headers)

    if (url.pathname.startsWith('/v1/')) return api(req, res, url, body)
    accounts(req, res, url, body)
    if (!res.headersSent) apiError(res, 404, 'Service not found')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    issued,
    options,
    playlists,
    // topArtistsStatus: an error status to answer on the top artists instead.
    addUser({ id, displayName = id, topArtists = [], allowListed = true, topArtistsStatus }) {
      users.set(id, { id, displayName, images: images('user', id), topArtists, allowListed, topArtistsStatus })
      for (const artist of topArtists) catalog.set(artist.id, artist)
    },
    addArtists(...artists) {
      for (const artist of artists) catalog.set(artist.id, artist)
    },
    user: id => users.get(id),
    loginAs(userId) { nextLogin = { userId } },
    denyNextLogin() { nextLogin = { deny: true } },
    // Tokens for a user without going through a login, for client tests.
    issueTokens: userId => ({ access: issueAccess(userId), refresh: issueRefresh(userId) }),
    expireAccessTokens() {
      for (const grant of accessTokens.values()) grant.expiresAt = 0
    },
    revokeRefreshTokens() {
      refreshTokens.clear()
    },
    // Answers to give, in order, to the next requests on "METHOD /path":
    // { status, body?, message?, headers? } or { hang: true }.
    script(route, ...answers) {
      scripts.set(route, [...(scripts.get(route) ?? []), ...answers])
    },
    stop: () => new Promise(resolve => {
      server.closeAllConnections()
      server.close(resolve)
    }),
  }
}
