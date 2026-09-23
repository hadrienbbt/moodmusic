import express from 'express'

// The JSON API (plan §4.5). Step 5 adds the artist endpoints.
export function apiRoutes({ users }) {
  const router = express.Router()

  router.get('/session', async (req, res) => {
    const user = req.session.user
    if (!user) return res.status(401).json({ error: 'unauthenticated' })
    const stored = await users.get(user.id)
    // New until one of the user's artists has a mood (onboarding not done).
    const isNew = !(stored?.artists ?? []).some(artist => artist.moods?.length > 0)
    res.json({ user: { id: user.id, displayName: user.displayName, image: user.image, isNew } })
  })

  return router
}
