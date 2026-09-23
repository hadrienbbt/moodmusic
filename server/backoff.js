import { setTimeout as delay } from 'node:timers/promises'

// The retry policy for 429 answers, shared by the Spotify and ReccoBeats
// clients (plan §3.5, appendix I): up to 3 retries, each after
// max(Retry-After, 1 s, 2 s, 4 s). A Retry-After above 8 s gives up at once,
// so the user can be told when to try again instead of waiting.
export const MAX_WAIT_S = 8

export class RateLimitError extends Error {
  constructor(service, retryAfter) {
    super(`${service} is rate limiting: retry in ${retryAfter} s`)
    this.service = service
    this.retryAfter = retryAfter
  }
}

// send() makes one attempt and resolves with its Response.
export async function withBackoff(service, send, { sleep = ms => delay(ms) } = {}) {
  for (let attempt = 0; ; attempt++) {
    const response = await send()
    if (response.status !== 429) return response
    await response.body?.cancel()
    const retryAfter = Number(response.headers.get('retry-after')) || 0
    if (retryAfter > MAX_WAIT_S) throw new RateLimitError(service, retryAfter)
    if (attempt >= 3) throw new RateLimitError(service, retryAfter || 5)
    await sleep(Math.max(retryAfter, 2 ** attempt) * 1000)
  }
}
