// A port of V1's core algorithm (hadrienbbt/mood-music, web/src) for the
// property test of core.test.js, kept as close to the original as possible,
// bugs included:
// - processTunetables (public/js/functionMoodMusic.js) without jQuery: the
//   mood formulas are strings evaluated with new Function instead of eval;
// - the arithmetic of GET /calculerTunetables (app.js), without MongoDB;
// - the do … while loop of GET /getArtistsFromMood (app.js), without the
//   session and the redirect chain.

// V1's mood table as its /getMoods served it (plan appendix B).
export const V1_MOODS = [
  { state: 'dance', emoji: '💃', stateFR: 'dansant', ordre: 1, danceability: 0.5, functions: { danceability: 'x' } },
  { state: 'excited', emoji: '😜', stateFR: 'excité', ordre: 2, valence: 0.8125, activation: 0.8125, functions: { energy: '0.625 + x * 0.375', valence: '0.625 + x * 0.375' } },
  { state: 'happy', emoji: '😃', stateFR: 'heureux', ordre: 2.5, valence: 0.75, activation: 0.5, functions: { energy: '0.375 + x * 0.25', valence: '0.5 + x * 0.5' } },
  { state: 'serene', emoji: '🙂', stateFR: 'calme', ordre: 3, valence: 0.8125, activation: 0.3125, functions: { energy: '0.375 - x * 0.25', valence: '0.625 - x * 0.375' } },
  { state: 'tired', emoji: '😴', stateFR: 'fatigué', ordre: 4, valence: 0.4375, activation: 0.3125, functions: { energy: '0.375 * (1-x)', valence: '0.75 - x * 0.5' } },
  { state: 'nostalgic', emoji: '🙄', stateFR: 'nostalgie', ordre: 4.5, valence: 0.375, activation: 0.5625, functions: { energy: '0.375 * (1+x)', valence: '0.5 - x * 0.25' } },
  { state: 'sad', emoji: '😢', stateFR: 'triste', ordre: 5, valence: 0.125, activation: 0.5, functions: { energy: '0.25 + x * 0.5', valence: '0.25 * (1-x)' } },
  { state: 'upset', emoji: '😡', stateFR: 'énervé', ordre: 6, valence: 0.25, activation: 0.875, functions: { energy: '0.75 + x * 0.25', valence: '0.5 * (1-x)' } },
]

// Fonction qui retourne la moyenne des éléments du tableau
function moyenne(tab) {
  var somme = 0
  for (var i = 0, j = tab.length; i < j; i++) {
    somme += parseFloat(tab[i])
  }
  return ((somme / tab.length).toFixed(4))
}

// moods: the table in display order (one slider per mood, in that order).
// selection: { state: x } for the moods switched on ("on" class), x being
// the slider value.
export function processTunetables(moods, selection) {
  var tunetables = { danceability: [], energy: [], valence: [] }
  var nbSliders = 0

  // Création d'un tableau associatif (mood -> functions)
  var functionsTunetables = {}
  for (var i = 0; i < moods.length; i++) {
    functionsTunetables[moods[i].state] = moods[i].functions
  }

  // on regarde tous les sliders visibles
  for (const { state } of moods) {
    if (Object.hasOwn(selection, state)) {
      var x = selection[state]

      // Evaluer les fonctions associées à l'humeur courante
      // Ajouter dans une nouvelle case l'image de chaque fonction
      for (var tunetable in functionsTunetables[state])
        tunetables[tunetable][nbSliders] = new Function('x', `return ${functionsTunetables[state][tunetable]}`)(x)

      if (state != 'dance') nbSliders++
    }
  }

  // On fait la moyenne et si ça marche pas on enlève l'attribut;
  for (var tunetable in tunetables) {
    tunetables[tunetable] = parseFloat(moyenne(tunetables[tunetable]))
    if (isNaN(tunetables[tunetable])) delete tunetables[tunetable]
  }
  return tunetables
}

// The fields /calculerTunetables leaves on the artist for its mood_related
// list: { valence, activation[, danceability] }, or null when they are all
// $unset (no mood). With "dance" as the only mood, valence and activation
// are 0 / 0 = NaN, which /getArtistsFromMood skips like a missing value.
export function calculerTunetables(moods, mood_related) {
  var valence = 0
  var activation = 0
  var nbMood = parseInt(mood_related.length)
  if (nbMood == 0) return null
  var dance = false
  var danceability
  for (var j = 0; j < nbMood; j++) {
    var response = moods.filter(mood => mood.state === mood_related[j]) // db.collection("mood").find({ state })
    if (response[0].state != 'dance') {
      valence += parseFloat(response[0].valence)
      activation += parseFloat(response[0].activation)
    } else {
      dance = true
      danceability = response[0].danceability
    }
  }
  valence = dance ? valence / (nbMood - 1) : valence / nbMood
  activation = dance ? activation / (nbMood - 1) : activation / nbMood
  return dance ? { valence, activation, danceability } : { valence, activation }
}

// artistesPrefs: the user's tabArtistesPref in stored order, [{ id, name,
// valence, activation }]. tunetables: the target the browser sent.
// Returns { ids, gaps } (gaps were only logged by V1) or { error }.
export function getArtistsFromMood(artistesPrefs, tunetables) {
  artistesPrefs = artistesPrefs.slice() // V1 spliced the array it read from MongoDB
  var tabIdArtists = new Array()
  var gaps = []
  var error_throwed

  // Tunetables
  var valence_base = tunetables.valence
  var activation_base = tunetables.energy

  if (artistesPrefs.length == 0) {
    return { error: "Pas d'artiste représentant cette émotion. Ajoutez d'abord des artistes et choisissez des émotions." }
  }
  var artiste_proche
  var ecartAbsolu
  do {
    ecartAbsolu = 2 // valeur absurde
    for (var i = 0; i < artistesPrefs.length; i++) {
      var artisteCourant = artistesPrefs[i]
      if (artisteCourant.valence) {
        var ecartRelatif = Math.abs(valence_base - artisteCourant.valence) + Math.abs(activation_base - artisteCourant.activation)
        if (ecartRelatif < ecartAbsolu) {
          ecartAbsolu = ecartRelatif
          artiste_proche = artisteCourant
        }
      }
    }
    if (artiste_proche) {
      // traitement sur les tableaux avant de recommencer
      tabIdArtists.push(artiste_proche.id) // ajouter l'artiste au tableau
      gaps.push(ecartAbsolu)
      artistesPrefs.splice(artistesPrefs.indexOf(artiste_proche), 1) // supprimer de l'autre tableau l'artiste qu'on vient d'ajouter
    } else {
      error_throwed = true
    }
  } while (ecartAbsolu < 0.5 && tabIdArtists.length < 5) // On ne met pas d'artiste inutilement ni trop
  if (ecartAbsolu > 0.5 && tabIdArtists.length > 1) { // Supprimer l'artiste qui a un trop grand écart si on peut
    tabIdArtists.pop()
    gaps.pop()
  }
  if (error_throwed) {
    return { error: "Pas assez d'émotions sélectionnées. Ajoutez d'abord des émotions aux artistes." }
  }
  return { ids: tabIdArtists, gaps }
}
