// The eight moods (plan §1.5 and §4.6), one entry per mood, in table order,
// which is also the display order. `base` is the point used to profile an
// artist tagged with the mood (§1.5.2); `fn` maps a slider value x in [0, 1]
// to target audio features (§1.5.1). Imported by the server and by the web
// app (@shared/moods.js).
export const MOODS = [
  { state: 'dance',     emoji: '💃', label: 'dansant',   order: 1,   base: { danceability: 0.5 },              fn: { danceability: x => x } },
  { state: 'excited',   emoji: '😜', label: 'excité',    order: 2,   base: { valence: 0.8125, activation: 0.8125 }, fn: { energy: x => 0.625 + 0.375 * x, valence: x => 0.625 + 0.375 * x } },
  { state: 'happy',     emoji: '😃', label: 'heureux',   order: 2.5, base: { valence: 0.75,   activation: 0.5 },    fn: { energy: x => 0.375 + 0.25 * x,  valence: x => 0.5 + 0.5 * x } },
  { state: 'serene',    emoji: '🙂', label: 'calme',     order: 3,   base: { valence: 0.8125, activation: 0.3125 }, fn: { energy: x => 0.375 - 0.25 * x,  valence: x => 0.625 + 0.375 * x } },   // valence sign fixed, §4.6.1
  { state: 'tired',     emoji: '😴', label: 'fatigué',   order: 4,   base: { valence: 0.4375, activation: 0.3125 }, fn: { energy: x => 0.375 * (1 - x),   valence: x => 0.75 - 0.5 * x } },
  { state: 'nostalgic', emoji: '🙄', label: 'nostalgie', order: 4.5, base: { valence: 0.375,  activation: 0.5625 }, fn: { energy: x => 0.375 * (1 + x),   valence: x => 0.5 - 0.25 * x } },
  { state: 'sad',       emoji: '😢', label: 'triste',    order: 5,   base: { valence: 0.125,  activation: 0.5 },    fn: { energy: x => 0.25 + 0.5 * x,    valence: x => 0.25 * (1 - x) } },
  { state: 'upset',     emoji: '😡', label: 'énervé',    order: 6,   base: { valence: 0.25,   activation: 0.875 },  fn: { energy: x => 0.75 + 0.25 * x,   valence: x => 0.5 * (1 - x) } },
]
