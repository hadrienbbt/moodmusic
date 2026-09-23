import session from 'express-session'

// Sessions live in the "sessions" collection: { data: JSON string, expiresAt: Timestamp }.
// Expiry follows the cookie (rolling 30 days); expired documents are ignored and deleted on read.
export class FirestoreStore extends session.Store {
  constructor(firestore, { collection = 'sessions', ttlMs = 30 * 24 * 60 * 60 * 1000 } = {}) {
    super()
    this.col = firestore.collection(collection)
    this.ttlMs = ttlMs
  }
  expiry(sess) {
    const expires = sess?.cookie?.expires
    return expires ? new Date(expires) : new Date(Date.now() + this.ttlMs)
  }
  get(sid, cb) {
    this.col.doc(sid).get().then(doc => {
      if (!doc.exists) return cb(null, null)
      const { data, expiresAt } = doc.data()
      if (expiresAt.toMillis() <= Date.now()) return this.destroy(sid, () => cb(null, null))
      cb(null, JSON.parse(data))
    }).catch(cb)
  }
  set(sid, sess, cb) {
    this.col.doc(sid).set({ data: JSON.stringify(sess), expiresAt: this.expiry(sess) }).then(() => cb(null)).catch(cb)
  }
  touch(sid, sess, cb) {
    this.col.doc(sid).update({ expiresAt: this.expiry(sess) }).then(() => cb(null))
      .catch(error => cb(error.code === 5 ? null : error))   // NOT_FOUND: the session was destroyed meanwhile
  }
  destroy(sid, cb) {
    this.col.doc(sid).delete().then(() => cb(null)).catch(cb)
  }
}
