import { profileFromMoods } from './artistProfile.js'

// Chooses the seed artists for a target (plan §1.5.3). The gap between an
// artist and the target is the Manhattan distance between its (valence,
// activation) profile and the target's (valence, energy). Artists are taken
// by increasing gap, ties in stored order: the closest one always, then
// others while fewer than 5 are chosen, the last chosen gap is below 0.5,
// and the next gap is at most 0.5.
//
// An artist without valence and activation (no mood, or only "dance") has
// no gap and is never chosen. Neither is anyone when the target has no
// valence and energy (only "dance" selected): V1 behaved the same way, its
// gaps being NaN. Unlike V1, a profile valence of exactly 0 counts (§4.6.1).

export const NO_ARTISTS = "Pas d'artiste représentant cette émotion. Ajoutez d'abord des artistes et choisissez des émotions."
export const NOT_ENOUGH_MOODS = "Pas assez d'émotions sélectionnées. Ajoutez d'abord des émotions aux artistes."

const MAX_ARTISTS = 5
const MAX_GAP = 0.5

const isNumber = value => typeof value === 'number' && Number.isFinite(value)

const gapBetween = (profile, target) => {
  if (!profile || ![profile.valence, profile.activation, target.valence, target.energy].every(isNumber)) return undefined
  return Math.abs(target.valence - profile.valence) + Math.abs(target.energy - profile.activation)
}

// artists: [{ id, name, moods }] in stored order. An artist that already
// carries its `profile` (as GET /api/me/artists returns it) is matched on it.
export function pickArtists(artists, target) {
  if (artists.length === 0) return { error: NO_ARTISTS }
  const candidates = []
  for (const artist of artists) {
    const gap = gapBetween(artist.profile !== undefined ? artist.profile : profileFromMoods(artist.moods), target)
    if (gap !== undefined) candidates.push({ id: artist.id, name: artist.name, gap })
  }
  if (candidates.length === 0) return { error: NOT_ENOUGH_MOODS }
  candidates.sort((a, b) => a.gap - b.gap) // stable: ties keep the stored order

  const chosen = [candidates[0]]
  for (const candidate of candidates.slice(1)) {
    if (chosen.length === MAX_ARTISTS || chosen.at(-1).gap >= MAX_GAP || candidate.gap > MAX_GAP) break
    chosen.push(candidate)
  }
  return { artists: chosen }
}
