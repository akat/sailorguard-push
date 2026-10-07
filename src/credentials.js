'use strict'

const crypto = require('crypto')

const random = (bytes) => crypto.randomBytes(bytes).toString('base64url')
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')

const INSTALLATION_RE = /^sgi_[A-Za-z0-9_-]{22}$/
const HANDLE_RE = /^sgh_[A-Za-z0-9_-]{22}$/

function newInstallation() {
  const id = `sgi_${random(16)}`
  const secret = random(32)
  return { id, secret, secretHash: sha256(secret) }
}

const newHandle = () => `sgh_${random(16)}`

// Plugin credential, sent as `Authorization: Bearer <installationId>.<secret>`.
function parseBearer(header) {
  const m = /^Bearer\s+(sgi_[A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(header || '')
  return m ? { id: m[1], secret: m[2] } : undefined
}

function secretMatches(secret, secretHash) {
  const a = Buffer.from(sha256(secret), 'hex')
  const b = Buffer.from(secretHash, 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest()
  const hb = crypto.createHash('sha256').update(String(b)).digest()
  return crypto.timingSafeEqual(ha, hb)
}

module.exports = { newInstallation, newHandle, parseBearer, secretMatches, safeEqual, INSTALLATION_RE, HANDLE_RE }
