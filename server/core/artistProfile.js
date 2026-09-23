import { MOODS } from '../../shared/moods.js'

// An artist's profile from the moods it is tagged with (plan §1.5.2): per
// key, the mean of the base points of its moods that define it. So valence
// and activation average the moods other than "dance", and danceability is
// 0.5 when "dance" is among them; a key no mood defines is absent. No mood
// at all means no profile (null): the artist is ignored when matching.
// Unknown states are ignored and a repeated state counts once.
const KEYS = ['valence', 'activation', 'danceability']
const baseByState = new Map(MOODS.map(mood => [mood.state, mood.base]))

export function profileFromMoods(moods = []) {
  const bases = [...new Set(moods)].filter(state => baseByState.has(state)).map(state => baseByState.get(state))
  if (bases.length === 0) return null
  const profile = {}
  for (const key of KEYS) {
    const values = bases.filter(base => key in base).map(base => base[key])
    if (values.length > 0) profile[key] = values.reduce((total, value) => total + value, 0) / values.length
  }
  return profile
}
