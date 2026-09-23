// The whole login in a browser-like client (helpers/server.js): /auth/login,
// the fake Spotify's consent page, which sends the browser back at once, then
// the callback. Returns every step; `state` replaces the one Spotify sends back.
export async function login(spotify, client, { as, deny = false, state } = {}) {
  if (deny) spotify.denyNextLogin()
  else spotify.loginAs(as)
  const start = await client.request('/auth/login')
  const cookieAfterStart = client.cookies.get('moodmusic.sid')
  const consent = await fetch(start.location, { redirect: 'manual' })
  const back = new URL(consent.headers.get('location'))
  if (state) back.searchParams.set('state', state)
  const callback = await client.request(`${back.pathname}${back.search}`)
  return { start, cookieAfterStart, back, callback }
}

// Resolves once condition() is true, checking every 50 ms.
export async function waitFor(condition, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
