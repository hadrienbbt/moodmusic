import { FieldValue } from 'firebase-admin/firestore'

// users/{spotifyUserId}/playlists/{spotifyPlaylistId} (plan §4.4): what each
// playlist was made from, for the history. The tracks stay on Spotify only.
export function createPlaylistsRepository(firestore) {
  const playlistsOf = userId => firestore.collection('users').doc(userId).collection('playlists')

  return {
    save: (userId, { id, ...playlist }) => playlistsOf(userId).doc(id).set({ ...playlist, createdAt: FieldValue.serverTimestamp() }),

    // Newest first.
    async list(userId, limit = 50) {
      const snapshot = await playlistsOf(userId).orderBy('createdAt', 'desc').limit(limit).get()
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data(), createdAt: doc.data().createdAt?.toDate().toISOString() ?? null }))
    },
  }
}
