import { FieldValue } from 'firebase-admin/firestore'

// users/{spotifyUserId} (plan §4.4): the profile shown in the app and the
// user's artists with the moods they tagged. The artists array is only
// changed read-modify-write inside a transaction. Step 5 adds the artist
// operations of the API.

// The middle-size image, like V1's images[1], else the only one, else none.
export const imageOf = images => images?.[1]?.url ?? images?.[0]?.url ?? null

export function createUsersRepository(firestore) {
  const users = firestore.collection('users')

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

    // Merges Spotify's top artists into the user's list (plan §4.5): an
    // artist already there keeps its place and moods and gets its name and
    // image refreshed; the others are appended in Spotify's order.
    mergeTopArtists: (id, topArtists) => firestore.runTransaction(async transaction => {
      const ref = users.doc(id)
      const doc = await transaction.get(ref)
      if (!doc.exists) throw new Error(`No user ${id}`)
      const now = new Date().toISOString()
      const artists = [...(doc.data().artists ?? [])]
      let added = 0
      for (const top of topArtists) {
        const refreshed = { name: top.name, image: imageOf(top.images), refreshedAt: now }
        const index = artists.findIndex(artist => artist.id === top.id)
        if (index === -1) {
          artists.push({ id: top.id, ...refreshed, moods: [], addedAt: now })
          added++
        } else {
          artists[index] = { ...artists[index], ...refreshed }
        }
      }
      transaction.update(ref, { artists })
      return { added }
    }),
  }
}
