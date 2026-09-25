import * as reccobeats from './reccobeats.js'
import * as spotify from './spotify.js'

export { NoSeedsError } from './reccobeats.js'

// The engines by their RECOMMENDER name (plan §4.7). config.js refuses any
// other name, and there is no runtime probe: the setting decides.
export const recommenders = { reccobeats, spotify }
