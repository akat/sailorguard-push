'use strict'

// Apple Push Notification service client (token-based auth, .p8 key), ported
// from the proxyit service. iOS goes straight to APNs because the Expo push
// service does not deliver custom notification sounds on iOS.

const http2 = require('http2')
const crypto = require('crypto')

const base64url = (input) =>
  Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')

function createApnsSender({ keyPem, keyId, teamId, bundleId, sandbox = false, host, connectOptions, timeoutMs = 15000 }) {
  if (!keyPem || !keyId || !teamId || !bundleId) {
    throw new Error('APNs needs key, keyId, teamId and bundleId')
  }
  const key = crypto.createPrivateKey(keyPem.replace(/\\n/g, '\n'))
  const apnsHost = host || (sandbox ? 'api.sandbox.push.apple.com' : 'api.push.apple.com')

  // Provider tokens are valid for up to an hour; refresh after 50 minutes.
  let jwt
  let jwtAt = 0
  function providerToken() {
    const now = Math.floor(Date.now() / 1000)
    if (jwt && now - jwtAt < 3000) return jwt
    const header = base64url(JSON.stringify({ alg: 'ES256', kid: keyId }))
    const claims = base64url(JSON.stringify({ iss: teamId, iat: now }))
    const input = `${header}.${claims}`
    const sig = crypto.sign('SHA256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' })
    jwt = `${input}.${base64url(sig)}`
    jwtAt = now
    return jwt
  }

  function sendOne(client, deviceToken, payload) {
    return new Promise((resolve) => {
      const req = client.request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${providerToken()}`,
        'apns-topic': bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json'
      })
      let status = 0
      let body = ''
      req.setTimeout(timeoutMs, () => req.close(http2.constants.NGHTTP2_CANCEL))
      req.on('response', (h) => {
        status = h[':status']
      })
      req.setEncoding('utf8')
      req.on('data', (c) => {
        body += c
      })
      req.on('end', () => {
        let reason
        try {
          reason = body ? JSON.parse(body).reason : undefined
        } catch (_) {}
        resolve({ status, reason })
      })
      req.on('error', (err) => resolve({ status: 0, reason: err.message }))
      req.end(payload)
    })
  }

  return {
    name: 'apns',
    /**
     * @param items {{token: string, deviceToken: string}[]}
     */
    /** @returns {{results: {token, status, error?}[]}} */
    async send(items, message) {
      const result = { results: [] }
      if (!items.length) return result
      // Plain-string sound: a normal alert sound that respects the silent switch.
      // iOS can only play the bundled CAF, so the Android WAV name is remapped.
      const sound = /^geofence_alarm\.(wav|caf)$/.test(message.sound || '') ? 'geofence_alarm.caf' : message.sound || 'default'
      const payload = JSON.stringify({
        aps: { alert: { title: message.title, body: message.body }, sound },
        ...(message.data || {})
      })
      const client = http2.connect(`https://${apnsHost}`, connectOptions)
      client.on('error', () => {})
      try {
        for (const { token, deviceToken } of items) {
          const { status, reason } = await sendOne(client, deviceToken, payload)
          if (status === 200) {
            result.results.push({ token, status: 'sent' })
          } else if (status === 410 || reason === 'Unregistered') {
            // Only 410 is definitive. BadDeviceToken also happens when a
            // development build is sent to the production host, so keep it.
            result.results.push({ token, status: 'invalid' })
          } else {
            result.results.push({ token, status: 'error', error: `APNs ${status} ${reason || ''}`.trim() })
          }
        }
      } finally {
        client.close()
      }
      return result
    }
  }
}

module.exports = { createApnsSender }
