import { FieldValue } from 'firebase-admin/firestore'

// users/{spotifyUserId} (plan §4.4): the profile shown in the app and the
// user's artists with the moods they tagged, in their order. The artists array
// is only changed read-modify-write inside a transaction.

// The middle-size image, like V1's images[1], else the only one, else none.
export const imageOf = images => images?.[1]?.url ?? images?.[0]?.url ?? null

const STALE_MS = 7 * 24 * 60 * 60 * 1000
const REFRESH_PER_ROUND = 30

const newArtist = (spotifyArtist, now) => ({
  id: spotifyArtist.id,
  name: spotifyArtist.name,
  image: imageOf(spotifyArtist.images),
  moods: [],
  addedAt: now,
  refreshedAt: now,
})

export function createUsersRepository(firestore) {
  const users = firestore.collection('users')

  // Runs change(artists, now) on the user's artists in a transaction. It
  // returns { artists } to write them, with anything else to pass back.
  const changeArtists = (id, change) => firestore.runTransaction(async transaction => {
    const ref = users.doc(id)
    const doc = await transaction.get(ref)
    if (!doc.exists) throw new Error(`No user ${id}`)
    const { artists, ...result } = change([...(doc.data().artists ?? [])], new Date().toISOString())
    if (artists) transaction.update(ref, { artists })
    return result
  })

  return {
    async get(id) {
      const doc = await users.doc(id).get()
      return doc.exists ? doc.data() : null
    },

    // Creates the user at the first login, else refreshes the name and image.
    upsertOnLogin: profile => firestore.runTransaction(async transaction => {
      const ref = users.doc(profile.id)
      const doc = await transaction.get(ref)
      const fields = { displayName: profile.displayName, image: profile.image, lastLoginAt: FieldValue.serverTimestamp() }
      if (doc.exists) {
        transaction.update(ref, fields)
        return { created: false }
      }
      transaction.set(ref, { ...fields, createdAt: FieldValue.serverTimestamp(), artists: [] })
      return { created: true }
    }),

    // Adds an artist found on Spotify at the top of the list, like V1.
    // Resolves with { artist, added }; added is false when it was already there.
    addArtist: (id, spotifyArtist) => changeArtists(id, (artists, now) => {
      const existing = artists.find(artist => artist.id === spotifyArtist.id)
      if (existing) return { artist: existing, added: false }
      const artist = newArtist(spotifyArtist, now)
      return { artists: [artist, ...artists], artist, added: true }
    }),

    // Resolves with { removed }.
    removeArtist: (id, artistId) => changeArtists(id, artists => {
      const kept = artists.filter(artist => artist.id !== artistId)
      return kept.length === artists.length ? { removed: false } : { artists: kept, removed: true }
    }),

    // Replaces the artist's moods. Resolves with the artist, or null when the
    // user does not have it.
    setArtistMoods: (id, artistId, moods) => changeArtists(id, artists => {
      const index = artists.findIndex(artist => artist.id === artistId)
      if (index === -1) return { artist: null }
      artists[index] = { ...artists[index], moods }
      return { artists, artist: artists[index] }
    }).then(result => result.artist),

    // Merges Spotify's top artists into the user's list (plan §4.5): an
    // artist already there keeps its place and moods and gets its name and
    // image refreshed; the others are appended in Spotify's order. Resolves
    // with { added }.
    mergeTopArtists: (id, topArtists) => changeArtists(id, (artists, now) => {
      let added = 0
      for (const top of topArtists) {
        const index = artists.findIndex(artist => artist.id === top.id)
        if (index === -1) {
          artists.push(newArtist(top, now))
          added++
        } else {
          artists[index] = { ...artists[index], name: top.name, image: imageOf(top.images), refreshedAt: now }
        }
      }
      return { artists, added }
    }),

    // Refreshes the name and image of the artists last refreshed more than 7
    // days ago, oldest first, at most 30 per round (plan §4.4).
    // fetchArtist(artistId) resolves with Spotify's artist; with null when
    // Spotify no longer has it, which only removes the image; with undefined
    // to leave it for another round. If it throws, the round stops. Resolves
    // with { refreshed }.
    async refreshStaleArtists(id, fetchArtist, { now = Date.now() } = {}) {
      const doc = await users.doc(id).get()
      const stale = (doc.data()?.artists ?? [])
        .filter(artist => !(Date.parse(artist.refreshedAt) > now - STALE_MS))
        .sort((a, b) => (Date.parse(a.refreshedAt) || 0) - (Date.parse(b.refreshedAt) || 0))
        .slice(0, REFRESH_PER_ROUND)
      const fresh = new Map()
      for (const artist of stale) {
        const found = await fetchArtist(artist.id)
        if (found !== undefined) fresh.set(artist.id, found)
      }
      if (fresh.size === 0) return { refreshed: 0 }
      return changeArtists(id, (artists, nowIso) => ({
        artists: artists.map(artist => {
          if (!fresh.has(artist.id)) return artist
          const found = fresh.get(artist.id)
          return found === null
            ? { ...artist, image: null, refreshedAt: nowIso }
            : { ...artist, name: found.name, image: imageOf(found.images), refreshedAt: nowIso }
        }),
        refreshed: fresh.size,
      }))
    },
  }
}
