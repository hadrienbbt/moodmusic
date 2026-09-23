import { MOODS } from '../../shared/moods.js'

// The Spotify playlist name (plan §1.5.4): the user's name trimmed and cut
// to 25 characters, or else the selected mood states in table order,
// comma-separated, after the "[Moodmusic] " prefix.
export function playlistName(name, selection /* { state: x } */) {
  const given = typeof name === 'string' ? name.trim().slice(0, 25) : ''
  const moods = MOODS.filter(mood => Object.hasOwn(selection, mood.state)).map(mood => mood.state)
  return `[Moodmusic] ${given || moods.join(',')}`
}
