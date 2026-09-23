// A local stand-in for Firestore that rejects every call with
// PERMISSION_DENIED, which the client does not retry, so reads and writes
// fail at once instead of after the client's ~40 s of retries.
import http2 from 'node:http2'

const startFailingFirestore = async () => {
  const server = http2.createServer()
  const sessions = new Set()
  const state = { calls: 0 }
  server.on('session', session => {
    sessions.add(session)
    session.on('close', () => sessions.delete(session))
  })
  server.on('stream', stream => {
    state.calls++
    stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true })
    stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '7', 'grpc-message': 'denied by test' }))
    stream.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  state.host = `127.0.0.1:${server.address().port}`
  state.stop = () => new Promise(resolve => {
    // close() waits for open sessions, and the client keeps its connection.
    for (const session of sessions) session.destroy()
    server.close(resolve)
  })
  return state
}

export { startFailingFirestore }
