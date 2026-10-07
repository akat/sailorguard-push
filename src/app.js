'use strict'

// HTTP API of the SailorGuard push gateway. See docs/api.md.

const { newInstallation, newHandle, parseBearer, secretMatches, safeEqual, INSTALLATION_RE, HANDLE_RE } = require('./credentials')
const { validateAlarm } = require('./templates')
const { tokenKind } = require('./push')
const { RateLimiter } = require('./rate-limit')

const MAX_BODY = 16 * 1024
const MAX_NOTIFY_HANDLES = 100
const PUSH_TOKEN_RE = /^Expo(?:nent)?PushToken\[[^\]\s]{1,400}\]$/

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message)
    this.status = status
    this.extra = extra
  }
}

const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined)

function createApp({ db, dispatcher, config, log = () => {}, now = Date.now }) {
  const limits = {
    installations: new RateLimiter(config.limits.installationsPerHour, config.limits.installationsPerHour / 60, now),
    handles: new RateLimiter(config.limits.handlesPerHour, config.limits.handlesPerHour / 60, now),
    notify: new RateLimiter(config.limits.notifyBurst, config.limits.notifyPerMinute, now)
  }
  const sweeper = setInterval(() => Object.values(limits).forEach((l) => l.sweep()), 10 * 60000)
  sweeper.unref()

  function clientIp(req) {
    if (config.trustProxy) {
      const fwd = req.headers['x-forwarded-for']
      if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim()
    }
    return req.socket.remoteAddress || 'unknown'
  }

  function limit(limiter, key, what) {
    const wait = limiter.take(key)
    if (wait) throw new HttpError(429, `Too many ${what}, retry in ${wait} s`, { retryAfter: wait })
  }

  function authInstallation(req) {
    const cred = parseBearer(req.headers.authorization)
    const inst = cred && db.getInstallation(cred.id)
    if (!inst || !secretMatches(cred.secret, inst.secret_hash)) throw new HttpError(401, 'Invalid installation credentials')
    if (inst.revoked_at) throw new HttpError(403, 'Installation revoked')
    db.touchInstallation(inst.id, str(req.headers['x-plugin-version'], 40), now())
    return inst
  }

  function authAdmin(req) {
    const token = /^Bearer\s+(.+)$/.exec(req.headers.authorization || '')?.[1]
    if (!config.adminToken || !token || !safeEqual(token, config.adminToken)) throw new HttpError(401, 'Unauthorized')
  }

  const routes = [
    ['GET', /^\/health$/, () => ({
      status: 'ok',
      apns: dispatcher.apnsReady,
      expoAccessToken: dispatcher.expoAccessToken
    })],

    // A plugin install asks for its credentials once and keeps them.
    ['POST', /^\/v1\/installations$/, (req, body) => {
      limit(limits.installations, clientIp(req), 'registrations')
      const inst = newInstallation()
      db.createInstallation({ id: inst.id, secretHash: inst.secretHash, name: str(body.name, 64), pluginVersion: str(body.pluginVersion, 40) }, now())
      log(`installation created ${inst.id}`)
      return [201, { installationId: inst.id, secret: inst.secret, credential: `${inst.id}.${inst.secret}` }]
    }],

    ['GET', /^\/v1\/installations\/me$/, (req) => {
      const inst = authInstallation(req)
      return { installationId: inst.id, handles: db.countHandles(inst.id) }
    }],

    // The app trades its push token for a handle bound to one installation.
    ['POST', /^\/v1\/handles$/, (req, body) => {
      limit(limits.handles, clientIp(req), 'handle requests')
      const installationId = body.installationId
      if (typeof installationId !== 'string' || !INSTALLATION_RE.test(installationId)) throw new HttpError(400, 'installationId is invalid')
      const pushToken = typeof body.pushToken === 'string' ? body.pushToken.trim() : ''
      if (!PUSH_TOKEN_RE.test(pushToken)) throw new HttpError(400, 'pushToken must be ExponentPushToken[...]')
      const inst = db.getInstallation(installationId)
      if (!inst || inst.revoked_at) throw new HttpError(404, 'Unknown installation')
      if (db.countHandles(inst.id) >= config.limits.handlesPerInstallation && !db.getHandleByToken(inst.id, pushToken)) {
        throw new HttpError(409, 'Too many devices registered for this boat')
      }
      const result = db.upsertHandle({
        handle: newHandle(),
        installationId: inst.id,
        pushToken,
        kind: tokenKind(pushToken),
        platform: str(body.platform, 20),
        appInstallationId: str(body.appInstallationId, 100),
        appVersion: str(body.appVersion, 40),
        locale: str(body.locale, 20)
      }, now())
      return [result.created ? 201 : 200, { handle: result.handle }]
    }],

    // The app withdraws a handle; it proves ownership with the push token.
    ['POST', /^\/v1\/handles\/revoke$/, (req, body) => {
      limit(limits.handles, clientIp(req), 'handle requests')
      const row = typeof body.handle === 'string' && db.getHandle(body.handle)
      if (!row || typeof body.pushToken !== 'string' || !safeEqual(body.pushToken.trim(), row.push_token)) {
        throw new HttpError(404, 'Unknown handle')
      }
      db.deleteHandle(row.handle)
      return { ok: true }
    }],

    ['DELETE', /^\/v1\/handles\/(sgh_[A-Za-z0-9_-]{22})$/, (req, body, [, handle]) => {
      const inst = authInstallation(req)
      const row = db.getHandle(handle)
      if (!row || row.installation_id !== inst.id) throw new HttpError(404, 'Unknown handle')
      db.deleteHandle(handle)
      return { ok: true }
    }],

    // The plugin reports an alarm; the gateway renders and delivers it.
    ['POST', /^\/v1\/notify$/, async (req, body) => {
      const inst = authInstallation(req)
      limit(limits.notify, inst.id, 'notifications')
      const v = validateAlarm(body)
      if (!v.ok) throw new HttpError(400, v.error)
      if (!Array.isArray(body.handles) || body.handles.length === 0 || body.handles.length > MAX_NOTIFY_HANDLES) {
        throw new HttpError(400, `handles must be an array of 1-${MAX_NOTIFY_HANDLES} handles`)
      }
      const results = new Map()
      const deliverable = []
      for (const handle of new Set(body.handles)) {
        const row = typeof handle === 'string' && HANDLE_RE.test(handle) ? db.getHandle(handle) : undefined
        if (!row || row.installation_id !== inst.id) results.set(handle, { status: 'unknown' })
        else if (row.invalid_at) results.set(handle, { status: 'invalid' })
        else deliverable.push(row)
      }
      if (deliverable.length) {
        for (const [handle, r] of await dispatcher.deliver(deliverable, v.alarm)) results.set(handle, r)
      }
      const list = [...results].map(([handle, r]) => ({ handle, ...r }))
      const sent = list.filter((r) => r.status === 'sent').length
      log(`notify ${inst.id} ${v.alarm.type}/${v.alarm.state}: ${sent}/${list.length} sent`)
      return { sent, results: list }
    }],

    ['POST', /^\/v1\/admin\/installations\/(sgi_[A-Za-z0-9_-]{22})\/revoke$/, (req, body, [, id]) => {
      authAdmin(req)
      if (!db.revokeInstallation(id, now())) throw new HttpError(404, 'Unknown or already revoked installation')
      log(`installation revoked ${id}`)
      return { ok: true }
    }],

    ['GET', /^\/v1\/admin\/stats$/, (req) => {
      authAdmin(req)
      return db.stats()
    }]
  ]

  function send(res, status, payload, extraHeaders = {}) {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Strict-Transport-Security': 'max-age=31536000',
      ...extraHeaders
    })
    res.end(body)
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      if (req.method === 'GET' || req.method === 'DELETE') return resolve({})
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
        return reject(new HttpError(415, 'Content-Type must be application/json'))
      }
      let size = 0
      const chunks = []
      req.on('data', (c) => {
        size += c.length
        if (size > MAX_BODY) {
          // Stop buffering; the connection is closed after the 413 is sent.
          req.removeAllListeners('data')
          req.pause()
          reject(new HttpError(413, 'Payload too large', { close: true }))
        } else chunks.push(c)
      })
      req.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8')
          const parsed = text ? JSON.parse(text) : {}
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
          resolve(parsed)
        } catch {
          reject(new HttpError(400, 'Body must be a JSON object'))
        }
      })
      req.on('error', reject)
    })
  }

  async function handler(req, res) {
    const started = now()
    const url = new URL(req.url, 'http://localhost')
    let status = 500
    try {
      const candidates = routes.filter(([, re]) => re.test(url.pathname))
      if (!candidates.length) throw new HttpError(404, 'Not found')
      const route = candidates.find(([method]) => method === req.method)
      if (!route) throw new HttpError(405, 'Method not allowed')
      const body = await readBody(req)
      const out = await route[2](req, body, route[1].exec(url.pathname))
      const [code, payload] = Array.isArray(out) ? out : [200, out]
      status = code
      send(res, code, payload)
    } catch (err) {
      status = err instanceof HttpError ? err.status : 500
      if (status === 500) log(`error ${req.method} ${url.pathname}: ${err.stack || err.message}`)
      const headers = {
        ...(err.extra?.retryAfter ? { 'Retry-After': String(err.extra.retryAfter) } : {}),
        ...(err.extra?.close ? { Connection: 'close' } : {})
      }
      send(res, status, { error: status === 500 ? 'Internal error' : err.message }, headers)
      if (err.extra?.close) res.on('finish', () => req.socket.destroy())
    } finally {
      if (url.pathname !== '/health') log(`${req.method} ${url.pathname} ${status} ${now() - started}ms`)
    }
  }

  handler.stop = () => clearInterval(sweeper)
  return handler
}

module.exports = { createApp }
