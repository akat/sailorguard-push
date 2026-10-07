'use strict'

const http = require('http')
const { loadConfig } = require('./config')
const { openDb } = require('./db')
const { createDispatcher } = require('./push')
const { createApp } = require('./app')

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`)

const config = loadConfig()
const db = openDb(config.dbFile)
const dispatcher = createDispatcher(config, {
  log,
  onInvalidToken: (token) => {
    const n = db.invalidateToken(token, Date.now())
    if (n) log(`invalidated ${n} handle(s) for an unregistered device`)
  }
})
const app = createApp({ db, dispatcher, config, log })
const server = http.createServer(app)

const prune = () => {
  const r = db.prune(Date.now(), config.retention)
  if (r.handles || r.installations) log(`pruned ${r.handles} handle(s), ${r.installations} installation(s)`)
}
prune()
const pruneTimer = setInterval(prune, 86400000)

server.listen(config.port, () => {
  log(`sailorguard-push listening on ${config.port}`)
  log(`APNs: ${dispatcher.apnsReady ? `enabled (${config.apns.bundleId} @ ${config.apns.host})` : 'DISABLED'}`)
  log(`Expo access token: ${config.expoAccessToken ? 'set' : 'not set'}`)
  if (!config.adminToken) log('ADMIN_TOKEN not set: admin endpoints disabled')
})

function shutdown() {
  log('shutting down')
  clearInterval(pruneTimer)
  app.stop()
  dispatcher.stop()
  server.close(() => {
    db.close()
    process.exit(0)
  })
  setTimeout(() => process.exit(0), 5000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
