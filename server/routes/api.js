import express from 'express'

import { MOODS } from '../../shared/moods.js'
import { requireUser } from '../auth/routes.js'
import { profileFromMoods } from '../core/index.js'
import { createSpotifyClient } from '../spotify/client.js'

const STATES = MOODS.map(mood => mood.state)

// An artist as the API shows it. Its profile is computed from its moods on
// every read, never stored (plan §4.4).
const artistView = artist => ({
  id: artist.id,
  name: artist.name,
  image: artist.image ?? null,
  moods: artist.moods ?? [],
  profile: profileFromMoods(artist.moods),
})

// The JSON API (plan §4.5). Everything under /me needs a logged-in user and
// only ever reaches that user's own data.
export function apiRoutes({ config, users }) {
  const router = express.Router()
  const spotifyFor = req => createSpotifyClient({ config, req })

  router.get('/session', async (req, res) => {
    const user = req.session.user
    if (!user) return res.status(401).json({ error: 'unauthenticated' })
    const stored = await users.get(user.id)
    // New until one of the user's artists has a mood (onboarding not done).
    const isNew = !(stored?.artists ?? []).some(artist => artist.moods?.length > 0)
    res.json({ user: { id: user.id, displayName: user.displayName, image: user.image, isNew } })
  })

  router.get('/moods', (req, res) => res.json(MOODS.map(({ state, emoji, label, order }) => ({ state, emoji, label, order }))))

  const me = express.Router()
  me.use(requireUser, express.json({ limit: '10kb' }))

  me.get('/artists', async (req, res) => {
    const user = await users.get(req.session.user.id)
    res.json({ artists: (user?.artists ?? []).map(artistView) })
  })

  // Adds the first artist Spotify finds for the name, at the top of the list.
  me.post('/artists', async (req, res) => {
    const query = typeof req.body?.query === 'string' ? req.body.query.trim() : ''
    if (!query) return res.status(400).json({ error: "Écris le nom d'un artiste." })
    const found = (await spotifyFor(req).searchArtist(query))?.artists?.items?.[0]
    if (!found) return res.status(404).json({ error: "L'artiste n'existe pas 🙁" })
    const { artist, added } = await users.addArtist(req.session.user.id, found)
    if (!added) return res.status(409).json({ error: "L'artiste existe déjà 😁" })
    res.status(201).json({ artist: artistView(artist) })
  })

  // The "Réimporter mes top artistes" button; the first login does the same.
  me.post('/artists/import-top', async (req, res) => {
    const top = await spotifyFor(req).topArtists(15)
    const { added } = await users.mergeTopArtists(req.session.user.id, top?.items ?? [])
    res.json({ added })
  })

  // Replaces the artist's moods (V1 toggled them one by one), stored in table order.
  me.put('/artists/:id/moods', async (req, res) => {
    const moods = req.body?.moods
    if (!Array.isArray(moods) || moods.some(mood => typeof mood !== 'string')) {
      return res.status(400).json({ error: 'Les émotions doivent être une liste.' })
    }
    const unknown = moods.find(mood => !STATES.includes(mood))
    if (unknown !== undefined) return res.status(400).json({ error: `Émotion inconnue : ${unknown.slice(0, 40)}` })
    const artist = await users.setArtistMoods(req.session.user.id, req.params.id, STATES.filter(state => moods.includes(state)))
    if (!artist) return res.status(404).json({ error: 'Artiste introuvable' })
    res.json({ artist: artistView(artist) })
  })

  me.delete('/artists/:id', async (req, res) => {
    await users.removeArtist(req.session.user.id, req.params.id)
    res.status(204).end()
  })

  router.use('/me', me)
  return router
}
