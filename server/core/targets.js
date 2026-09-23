import { MOODS } from '../../shared/moods.js'

// Target audio features for the selected moods (plan §1.5.1): per key, the
// mean of the values produced by the selected moods that define it, rounded
// to 4 decimals like V1's toFixed(4); a key no selected mood defines is
// absent. Values are summed in table order, as V1 did, so results match V1
// to the last digit. Unlike V1, danceability does not depend on "dance"
// being first (§4.6.1).
const KEYS = ['valence', 'energy', 'danceability']

export function targetFromSelection(selection /* { state: x } */) {
  const values = Object.fromEntries(KEYS.map(key => [key, []]))
  for (const mood of MOODS) {
    if (!Object.hasOwn(selection, mood.state)) continue
    for (const [key, fn] of Object.entries(mood.fn)) values[key].push(fn(selection[mood.state]))
  }
  const target = {}
  for (const key of KEYS) {
    if (values[key].length === 0) continue
    const sum = values[key].reduce((total, value) => total + value, 0)
    target[key] = Number((sum / values[key].length).toFixed(4))
  }
  return target
}
