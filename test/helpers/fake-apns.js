'use strict'

// A local HTTP/2 + TLS server that behaves like api.push.apple.com, used by the
// unit and e2e tests. It verifies the ES256 provider token with the public key.

const http2 = require('http2')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

function selfSignedCert() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-apns-'))
  const keyFile = path.join(dir, 'key.pem')
  const certFile = path.join(dir, 'cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' })
  const tls = { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }
  fs.rmSync(dir, { recursive: true, force: true })
  return tls
}

function hasOpenssl() {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const b64urlDecode = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

/**
 * @param {object} opts
 * @param {Record<string, {status: number, reason?: string}>} [opts.responses] deviceToken -> response
 */
async function startFakeApns({ responses = {} } = {}) {
  const signing = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const keyPem = signing.privateKey.export({ type: 'pkcs8', format: 'pem' })
  const requests = []
  const server = http2.createSecureServer(selfSignedCert())
  server.on('stream', (stream, headers) => {
    let body = ''
    stream.setEncoding('utf8')
    stream.on('data', (c) => (body += c))
    stream.on('end', () => {
      const [h, c, sig] = String(headers.authorization || '').replace(/^bearer /, '').split('.')
      const jwtValid = Boolean(sig) && crypto.verify('SHA256', Buffer.from(`${h}.${c}`), { key: signing.publicKey, dsaEncoding: 'ieee-p1363' }, b64urlDecode(sig))
      const deviceToken = headers[':path'].replace('/3/device/', '')
      requests.push({
        deviceToken,
        topic: headers['apns-topic'],
        pushType: headers['apns-push-type'],
        jwtValid,
        jwtHeader: h ? JSON.parse(b64urlDecode(h)) : undefined,
        jwtClaims: c ? JSON.parse(b64urlDecode(c)) : undefined,
        payload: JSON.parse(body)
      })
      const r = !jwtValid ? { status: 403, reason: 'InvalidProviderToken' } : responses[deviceToken] || { status: 200 }
      stream.respond({ ':status': r.status })
      stream.end(r.reason ? JSON.stringify({ reason: r.reason }) : '')
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    host: `127.0.0.1:${server.address().port}`,
    keyPem,
    requests,
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

module.exports = { startFakeApns, hasOpenssl }
