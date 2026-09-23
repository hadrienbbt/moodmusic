import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import dotenv from 'dotenv'
import { cert, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

import { createApp } from './app.js'
import { ConfigError, loadConfig } from './config.js'

// .env in the working directory never overrides variables that are already
// set, such as those of the Pi's start script.
dotenv.config({ quiet: true })

let config
try {
  config = loadConfig()
} catch (error) {
  if (!(error instanceof ConfigError)) throw error
  console.error(error.message)
  process.exit(1)
}

// Production uses the service-account key. Development and tests use the
// Firestore emulator (firebase.json) and a demo- project, which the emulator
// accepts without credentials and which does not exist on the real service.
if (!config.firebaseKeyPath) process.env.FIRESTORE_EMULATOR_HOST ??= '127.0.0.1:8183'
const firebaseApp = config.firebaseKeyPath
  ? initializeApp({ credential: cert(config.firebaseKeyPath) })
  : initializeApp({ projectId: 'demo-moodmusic' })
const firestore = getFirestore(firebaseApp)

process.on('unhandledRejection', error => console.error('Unhandled rejection:', error))

if (!fs.existsSync(path.join(config.publicDir, 'index.html'))) {
  console.warn(`No web app build in ${config.publicDir} (npm run build); only the API is served`)
}

const app = createApp({ firestore, config })
// Only Apache (production) or the Vite dev server (development) talk to
// Node, both from this machine.
const server = config.production
  ? https.createServer({ cert: fs.readFileSync(config.sslCert), key: fs.readFileSync(config.sslKey) }, app)
  : http.createServer(app)
server.listen(config.port, '127.0.0.1', () => {
  console.log(`Listening ${config.production ? 'https' : 'http'} on port ${server.address().port}`)
})
