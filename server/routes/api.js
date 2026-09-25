import express from 'express'

import { MOODS } from '../../shared/moods.js'
import { requireUser } from '../auth/routes.js'
import { pickArtists, playlistName, profileFromMoods, targetFromSelection } from '../core/index.js'
import { recommenders } from '../recommenders/index.js'
import { createSpotifyClient } from '../spotify/client.js'

const STATES = MOODS.map(mood => mood.state)
const PLAYLIST_TRACKS = 30
const NO_TRACKS = "Aucun titre trouvé pour ces émotions. Ajoute d'autres artistes favoris ou change d'émotion."

// What is wrong with a mood selection ({ state: x }), if anything.
const selectionProblem = moods => {
  if (moods === null || typeof moods !== 'object' || Array.isArray(moods) || Object.keys(moods).length === 0) return 'Sélectionne au moins une émotion'
  for (const [state, x] of Object.entries(moods)) {
    if (!STATES.includes(state)) return `Émotion inconnue : ${state.slice(0, 40)}`
    if (typeof x !== 'number' || !(x >= 0 && x <= 1)) return `Valeur invalide pour ${state}`
  }
}

// An artist as the API shows it. Its profile is computed from its moods on
// every read, never stored (plan §4.4).
const artistView = artist => ({
  id: artist.id,
  name: artist.name,
  image: artist.image ?? null,
  moods: artist.moods ?? [],
  profile: profileFromMoods(artist.moods),
})

// The JSON API (plan §4.5). Everything under /me and /playlists needs a
// logged-in user and only ever reaches that user's own data.
export function apiRoutes({ config, users, playlists, reccobeats }) {
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

  me.get('/playlists', async (req, res) => res.json({ playlists: await playlists.list(req.session.user.id) }))

  // The whole pipeline of plan §1.5 and §4.7: target, seed artists, the
  // configured engine, then the playlist on Spotify and in the history.
  router.post('/playlists', requireUser, express.json({ limit: '10kb' }), async (req, res) => {
    const started = Date.now()
    const { moods, name, public: isPublic } = req.body ?? {}
    const problem = selectionProblem(moods)
    if (problem) return res.status(400).json({ error: problem })
    const userId = req.session.user.id
    const target = targetFromSelection(moods)
    const picked = pickArtists((await users.get(userId))?.artists ?? [], target)
    if (picked.error) return res.status(422).json({ error: picked.error })

    const spotify = spotifyFor(req)
    const { trackUris, engine, seeds, topUp } = await recommenders[config.recommender].recommend({
      seedArtists: picked.artists, target, limit: PLAYLIST_TRACKS, spotify, reccobeats, market: config.market,
    })
    if (trackUris.length === 0) return res.status(422).json({ error: NO_TRACKS })
    const playlist = { name: playlistName(name, moods), public: isPublic === true }
    const created = await spotify.createPlaylist(playlist)
    await spotify.addItems(created.id, trackUris)
    const result = { id: created.id, ...playlist, url: `https://open.spotify.com/playlist/${created.id}`, trackCount: trackUris.length, engine }
    await playlists.save(userId, { ...result, moods, target, artists: picked.artists })
    console.log(`playlist user=${userId} engine=${engine} seeds=${seeds}/${picked.artists.length} tracks=${trackUris.length} ms=${Date.now() - started}${topUp === undefined ? '' : ` topup=${topUp}`}`)
    res.status(201).json({ playlist: { id: result.id, name: result.name, url: result.url, trackCount: result.trackCount, engine, public: result.public }, artists: picked.artists, target })
  })

  router.use('/me', me)
  return router
}
