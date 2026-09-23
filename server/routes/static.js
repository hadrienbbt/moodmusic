import path from 'node:path'
import express from 'express'

// Serves the built web app (app/dist). Any other GET outside /api and /auth
// is a client-side route and gets index.html (SPA fallback). The fallback is
// a plain final middleware because Express 5's path-to-regexp 8 has no '*'
// route. HEAD is answered like GET so `curl -I` works on every page.
export function staticRoutes(publicDir) {
  const indexHtml = path.join(publicDir, 'index.html')
  const router = express.Router()
  router.use(express.static(publicDir))
  router.use((req, res, next) => {
    if ((req.method === 'GET' || req.method === 'HEAD') && !req.path.startsWith('/api') && !req.path.startsWith('/auth')) {
      return res.sendFile(indexHtml)
    }
    next()
  })
  return router
}
