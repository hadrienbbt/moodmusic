// Golden tests of the core algorithm (plan §1.5, §4.6.1, appendix C) and a
// property test against a port of V1's code (helpers/v1-reference.js).
// No network, no emulator.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MOODS } from '../shared/moods.js'
import { NO_ARTISTS, NOT_ENOUGH_MOODS, pickArtists, playlistName, profileFromMoods, rankTracks, targetFromSelection } from '../server/core/index.js'
import * as v1 from './helpers/v1-reference.js'

// Same keys, and numbers within the tolerance (appendix C: 1e-4).
const assertClose = (actual, expected, { tolerance = 1e-4, message = '' } = {}) => {
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${message} keys of ${JSON.stringify(actual)}`)
  for (const key of Object.keys(expected)) {
    assert.ok(Math.abs(actual[key] - expected[key]) <= tolerance, `${message} ${key} is ${actual[key]}, expected ${expected[key]}`)
  }
}

// Artists with a given profile, for cases the mood table cannot produce.
const withProfile = (id, valence, activation) => ({ id, name: id, moods: [], profile: { valence, activation } })

test('the mood table keeps V1 moods, order and formulas, except the serene valence', () => {
  assert.deepEqual(MOODS.map(mood => mood.state), v1.V1_MOODS.map(mood => mood.state))
  for (const [i, mood] of MOODS.entries()) {
    const old = v1.V1_MOODS[i]
    assert.deepEqual([mood.emoji, mood.label, mood.order], [old.emoji, old.stateFR, old.ordre], mood.state)
    const oldBase = Object.fromEntries(['valence', 'activation', 'danceability'].filter(key => key in old).map(key => [key, old[key]]))
    assert.deepEqual(mood.base, oldBase, mood.state)
    assert.deepEqual(Object.keys(mood.fn).sort(), Object.keys(old.functions).sort(), mood.state)
    for (let step = 0; step <= 100; step++) {
      const x = step / 100
      for (const [key, fn] of Object.entries(mood.fn)) {
        const expected = mood.state === 'serene' && key === 'valence' ? 0.625 + 0.375 * x : new Function('x', `return ${old.functions[key]}`)(x)
        assert.equal(fn(x), expected, `${mood.state}.${key}(${x})`)
      }
    }
  }
})

test('target of each mood alone at 0.55', () => {
  const expected = {
    excited: { valence: 0.8313, energy: 0.8313 },
    happy: { valence: 0.775, energy: 0.5125 },
    serene: { valence: 0.8313, energy: 0.2375 },
    tired: { valence: 0.475, energy: 0.1687 },
    nostalgic: { valence: 0.3625, energy: 0.5813 },
    sad: { valence: 0.1125, energy: 0.525 },
    upset: { valence: 0.225, energy: 0.8875 },
    dance: { danceability: 0.55 },
  }
  for (const [state, target] of Object.entries(expected)) {
    assertClose(targetFromSelection({ [state]: 0.55 }), target, { message: state })
  }
})

test('target of combined moods is the mean per key', () => {
  assertClose(targetFromSelection({ excited: 1, sad: 0 }), { valence: 0.625, energy: 0.625 })
  assertClose(targetFromSelection({ excited: 0.55, sad: 0.55 }), { valence: 0.4719, energy: 0.6781 })
  assert.deepEqual(targetFromSelection({ excited: 0.55, sad: 0.55 }), { valence: 0.4719, energy: 0.6781 }, 'rounded to 4 decimals')
  assert.deepEqual(targetFromSelection({}), {})
})

test('danceability is averaged whatever the position of "dance" (§4.6.1)', () => {
  assertClose(targetFromSelection({ happy: 0.5, dance: 0.8 }), { valence: 0.75, energy: 0.5, danceability: 0.8 })
  assertClose(targetFromSelection({ dance: 0.8, happy: 0.5 }), { valence: 0.75, energy: 0.5, danceability: 0.8 })
  // V1 lost danceability whenever "dance" was not the first slider.
  const danceLast = [...v1.V1_MOODS.slice(1), v1.V1_MOODS[0]]
  assert.deepEqual(v1.processTunetables(danceLast, { happy: 0.5, dance: 0.8 }), { valence: 0.75, energy: 0.5 })
})

test('less serene lowers the valence (§4.6.1)', () => {
  assert.ok(targetFromSelection({ serene: 0.2 }).valence < targetFromSelection({ serene: 0.8 }).valence)
  assert.equal(targetFromSelection({ serene: 0.5 }).valence, 0.8125, 'the base valence of serene at x = 0.5')
  assert.equal(v1.processTunetables(v1.V1_MOODS, { serene: 0.55 }).valence, 0.4187, 'V1 went the other way')
})

test('artist profile from its moods', () => {
  assert.deepEqual(profileFromMoods(['excited', 'sad']), { valence: 0.46875, activation: 0.65625 })
  assert.deepEqual(profileFromMoods(['dance']), { danceability: 0.5 })
  assert.deepEqual(profileFromMoods(['dance', 'tired']), { valence: 0.4375, activation: 0.3125, danceability: 0.5 })
  assert.equal(profileFromMoods([]), null)
  assert.equal(profileFromMoods(undefined), null)
  assert.deepEqual(profileFromMoods(['sad', 'excited', 'sad', 'grumpy']), { valence: 0.46875, activation: 0.65625 }, 'repeated and unknown states')
  assert.equal(profileFromMoods(['grumpy']), null)
})

test('artist selection: closest first, then while gaps stay within 0.5', () => {
  const target = { valence: 0.8125, energy: 0.8125 }
  const A = { id: 'A', name: 'A', moods: ['excited'] } // gap 0
  const B = { id: 'B', name: 'B', moods: ['happy'] } // gap 0.375
  const C = { id: 'C', name: 'C', moods: ['serene'] } // gap exactly 0.5
  const D = { id: 'D', name: 'D', moods: ['sad'] } // gap 1
  const E = { id: 'E', name: 'E', moods: [] } // no profile

  assert.deepEqual(pickArtists(Object.freeze([D, E, C, B, A]), target), {
    artists: [{ id: 'A', name: 'A', gap: 0 }, { id: 'B', name: 'B', gap: 0.375 }, { id: 'C', name: 'C', gap: 0.5 }],
  }, 'C is kept at exactly 0.5 and ends the selection; D is never considered; E is ignored')
  assert.deepEqual(pickArtists([D], target), { artists: [{ id: 'D', name: 'D', gap: 1 }] }, 'the closest artist is kept whatever its gap')
  assert.deepEqual(pickArtists([D, A], target).artists.map(artist => artist.id), ['A'], 'a next artist over 0.5 is dropped')
  const C2 = { ...C, id: 'C2', name: 'C2' }
  assert.deepEqual(pickArtists([C, C2], target).artists.map(artist => artist.id), ['C'], 'nothing follows a gap of 0.5')
  assert.deepEqual(pickArtists([E], target), { error: NOT_ENOUGH_MOODS })
  assert.deepEqual(pickArtists([], target), { error: NO_ARTISTS })
  assert.equal(NOT_ENOUGH_MOODS, "Pas assez d'émotions sélectionnées. Ajoutez d'abord des émotions aux artistes.")
  assert.equal(NO_ARTISTS, "Pas d'artiste représentant cette émotion. Ajoutez d'abord des artistes et choisissez des émotions.")
})

test('artist selection: at most 5, by gap, ties in stored order', () => {
  const target = { valence: 0.5, energy: 0.5 }
  const artists = [
    withProfile('A', 0.5 + 5 / 64, 0.5), // 5/64
    withProfile('B', 0.5, 0.5 - 1 / 64), // 1/64
    withProfile('C', 0.5 + 2 / 64, 0.5 + 1 / 64), // 3/64
    withProfile('D', 0.5 - 1 / 64, 0.5), // 1/64, after B
    withProfile('E', 0.5, 0.5 + 6 / 64), // 6/64
    withProfile('F', 0.5, 0.5), // 0
    withProfile('G', 0.5 - 2 / 64, 0.5 + 1 / 64), // 3/64, after C
  ]
  const { artists: chosen } = pickArtists(artists, target)
  assert.deepEqual(chosen.map(artist => artist.id), ['F', 'B', 'D', 'C', 'G'])
  assert.deepEqual(chosen.map(artist => artist.gap), [0, 1 / 64, 1 / 64, 3 / 64, 3 / 64])
  assert.deepEqual(pickArtists(artists.slice(0, 5), target).artists.map(artist => artist.id), ['B', 'D', 'C', 'A', 'E'], 'exactly 5 profiled artists')
})

test('artist selection: a valence of 0 counts, dance alone does not (§4.6.1)', () => {
  const zero = withProfile('Z', 0, 0.5)
  assert.deepEqual(pickArtists([zero], { valence: 0.1, energy: 0.5 }), { artists: [{ id: 'Z', name: 'Z', gap: 0.1 }] })
  assert.deepEqual(v1.getArtistsFromMood([{ id: 'Z', name: 'Z', valence: 0, activation: 0.5 }], { valence: 0.1, energy: 0.5 }), { error: NOT_ENOUGH_MOODS }, 'V1 skipped it')

  const dancer = { id: 'X', name: 'X', moods: ['dance'] }
  const tagged = { id: 'T', name: 'T', moods: ['tired', 'dance'] }
  assert.deepEqual(pickArtists([dancer, tagged], { valence: 0.4375, energy: 0.3125 }).artists.map(artist => artist.id), ['T'])
  // Only "dance" selected: no valence or energy to match on, as in V1.
  assert.deepEqual(pickArtists([dancer, tagged], targetFromSelection({ dance: 0.9 })), { error: NOT_ENOUGH_MOODS })
  assert.deepEqual(v1.getArtistsFromMood([{ id: 'T', name: 'T', ...v1.calculerTunetables(v1.V1_MOODS, ['tired', 'dance']) }], { danceability: 0.9 }), { error: NOT_ENOUGH_MOODS })
})

test('tracks ranked by distance to the target, capped per artist', () => {
  const track = (id, artistId, valence, energy, danceability = 0.5) => ({ id, artistId, features: { valence, energy, danceability } })
  const target = { valence: 0.8, energy: 0.8 }
  const candidates = Object.freeze([track('a3', 'A', 0.6, 0.8), track('a1', 'A', 0.8, 0.8), track('b1', 'B', 0.75, 0.8), track('a2', 'A', 0.7, 0.8)])
  assert.deepEqual(rankTracks(candidates, target, { limit: 4 }), ['a1', 'b1', 'a2', 'a3'])
  assert.deepEqual(rankTracks(candidates, target, { limit: 3 }), ['a1', 'b1', 'a2'], 'cap ceil(3/2) + 1 = 3, distance order kept')

  // Cap ceil(4/2) + 1 = 3: A's fourth track gives way to B's distant one.
  const many = [0.8, 0.79, 0.78, 0.77, 0.76].map((valence, i) => track(`a${i + 1}`, 'A', valence, 0.8))
  assert.deepEqual(rankTracks([...many, track('b1', 'B', 0.5, 0.8)], target, { limit: 4 }), ['a1', 'a2', 'a3', 'b1'])

  const exclude = new Set(['a1'])
  assert.deepEqual(rankTracks([...candidates, track('a1', 'B', 0.8, 0.8), track('b1', 'B', 0.8, 0.8)], target, { limit: 10, exclude }), ['b1', 'a2', 'a3'], 'excluded and repeated ids')
  assert.deepEqual([...exclude], ['a1'], 'exclude is left untouched')

  // Only the keys present in the target count, and a track lacking one is left out.
  const byDance = [track('d1', 'A', 0.1, 0.1, 0.9), track('d2', 'A', 0.8, 0.8, 0.2), { id: 'd3', artistId: 'A', features: { valence: 0.8, energy: 0.8 } }]
  assert.deepEqual(rankTracks(byDance, { danceability: 0.9 }, { limit: 5 }), ['d1', 'd2'])
  assert.deepEqual(rankTracks(byDance, target, { limit: 5 }), ['d2', 'd3', 'd1'])
  assert.deepEqual(rankTracks([], target, { limit: 5 }), [])
})

test('playlist name', () => {
  assert.equal(playlistName('Soirée', { excited: 0.55 }), '[Moodmusic] Soirée')
  assert.equal(playlistName('  Soirée  ', { excited: 0.55 }), '[Moodmusic] Soirée')
  assert.equal(playlistName('', { excited: 0.55, sad: 0.55 }), '[Moodmusic] excited,sad')
  assert.equal(playlistName('   ', { sad: 0.55, dance: 0.5, excited: 0.55 }), '[Moodmusic] dance,excited,sad', 'table order')
  assert.equal(playlistName(undefined, { upset: 1 }), '[Moodmusic] upset')
  assert.equal(playlistName('abcdefghijklmnopqrstuvwxyz1234', {}), '[Moodmusic] abcdefghijklmnopqrstuvwxy')
})

// A small seeded generator (mulberry32) so a failure is reproducible.
const seededRandom = seed => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

test('V2 matches the V1 code on 500 random cases, deliberate deviations excluded', () => {
  const random = seededRandom(20260923)
  const integer = (min, max) => min + Math.floor(random() * (max - min + 1))
  const states = MOODS.map(mood => mood.state)
  const selectable = states.filter(state => state !== 'serene')
  const outcomes = {}

  for (let run = 0; run < 500; run++) {
    const context = `run ${run}`
    // 1 to 7 moods other than serene (its valence formula changed), with the
    // slider values V1 could send (0.01 to 1; 0 deselected the mood). V1's
    // table order puts "dance" first, which V1 needed for danceability.
    const selection = {}
    for (const state of selectable) if (random() < 0.35) selection[state] = integer(1, 100) / 100
    if (Object.keys(selection).length === 0) selection[selectable[integer(0, selectable.length - 1)]] = integer(1, 100) / 100
    const v1Target = v1.processTunetables(v1.V1_MOODS, selection)
    const target = targetFromSelection(selection)
    assertClose(target, v1Target, { tolerance: 0, message: context })

    // 0 to 9 artists in stored order, tagged with random moods (serene's base
    // point did not change). One in four gets a random profile instead, so
    // the selection loop also sees values moods cannot produce, except a
    // valence of 0 (V1 skipped those).
    const artists = []
    const v1Artists = []
    for (let i = 0, count = integer(0, 9); i < count; i++) {
      const id = `artist-${i}`
      if (random() < 0.25) {
        const valence = integer(1, 16) / 16
        const activation = integer(0, 16) / 16
        artists.push(withProfile(id, valence, activation))
        v1Artists.push({ id, name: id, valence, activation })
      } else {
        const moods = states.filter(() => random() < 0.3)
        const v1Profile = v1.calculerTunetables(v1.V1_MOODS, moods)
        const expected = v1Profile && Object.fromEntries(Object.entries(v1Profile).filter(([, value]) => !Number.isNaN(value)))
        const profile = profileFromMoods(moods)
        if (expected === null) assert.equal(profile, null, context)
        else assertClose(profile, expected, { tolerance: 0, message: `${context} ${moods}` })
        artists.push({ id, name: id, moods })
        v1Artists.push({ id, name: id, ...v1Profile })
      }
    }

    const expected = v1.getArtistsFromMood(v1Artists, v1Target)
    const actual = pickArtists(artists, target)
    if (expected.error) {
      assert.deepEqual(actual, { error: expected.error }, context)
    } else {
      assert.deepEqual(actual.artists.map(artist => artist.id), expected.ids, context)
      assert.deepEqual(actual.artists.map(artist => artist.gap), expected.gaps, context)
    }
    const outcome = expected.error === NO_ARTISTS ? 'no artists' : expected.error ? 'not enough moods' : `${expected.ids.length} chosen`
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
  }
  // Every outcome of the loop was exercised.
  for (const outcome of ['no artists', 'not enough moods', '1 chosen', '2 chosen', '3 chosen', '4 chosen', '5 chosen']) {
    assert.ok(outcomes[outcome] >= 5, `${outcome}: ${JSON.stringify(outcomes)}`)
  }
})
