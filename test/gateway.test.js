'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const { openDb } = require('../src/db')
const { createDispatcher } = require('../src/push')
const { createApp } = require('../src/app')
const { loadConfig } = require('../src/config')
const { startFakeApns, hasOpenssl } = require('./helpers/fake-apns')

const ANDROID = 'ExponentPushToken[android-device-1]'
const ANDROID_GONE = 'ExponentPushToken[android-gone]'
const IOS_HEX = 'cd'.repeat(32)
const IOS = `ExponentPushToken[apns:${IOS_HEX}]`

async function setup(t, envOverrides = {}) {
  const apns = await startFakeApns()
  const expoCalls = []
  const fetchImpl = async (url, init) => {
    const messages = JSON.parse(init.body)
    expoCalls.push({ url, auth: init.headers.Authorization, messages })
    const data = messages.map((m) => m.to === ANDROID_GONE
      ? { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }
      : { status: 'ok', id: `t-${expoCalls.length}` })
    return { ok: true, status: 200, text: async () => JSON.stringify({ data }) }
  }
  const config = loadConfig({
    DB_FILE: ':memory:',
    ADMIN_TOKEN: 'admin-secret',
    EXPO_ACCESS_TOKEN: 'expo-secret',
    APNS_KEY: apns.keyPem,
    APNS_KEY_ID: 'KEY123',
    APNS_TEAM_ID: 'TEAM456',
    APNS_HOST: apns.host,
    TRUST_PROXY: '0',
    ...envOverrides
  })
  const db = openDb(':memory:')
  const dispatcher = createDispatcher(config, {
    fetchImpl,
    apnsConnectOptions: { rejectUnauthorized: false },
    onInvalidToken: (token) => db.invalidateToken(token, Date.now())
  })
  const app = createApp({ db, dispatcher, config })
  const server = http.createServer(app)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    app.stop()
    dispatcher.stop()
    await new Promise((r) => server.close(r))
    await apns.close()
    db.close()
  })

  const call = async (method, path, body, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
    })
    return { status: res.status, body: await res.json(), headers: res.headers }
  }
  const newInstallation = async () => {
    const r = await call('POST', '/v1/installations', { name: 'Test boat', pluginVersion: '0.2.0' })
    assert.equal(r.status, 201)
    return { ...r.body, auth: { Authorization: `Bearer ${r.body.credential}` } }
  }
  const newHandle = async (installationId, pushToken, extra = {}) => {
    const r = await call('POST', '/v1/handles', { installationId, pushToken, ...extra })
    assert.ok(r.status === 201 || r.status === 200, JSON.stringify(r.body))
    return r.body.handle
  }
  return { call, newInstallation, newHandle, expoCalls, apns, db }
}

const skip = !hasOpenssl() && 'openssl not available'

test('health reports configured credentials without exposing them', { skip }, async (t) => {
  const { call } = await setup(t)
  const r = await call('GET', '/health')
  assert.deepEqual(r.body, { status: 'ok', apns: true, expoAccessToken: true })
  assert.equal(r.headers.get('cache-control'), 'no-store')
})

test('installation credentials are required and verified', { skip }, async (t) => {
  const { call, newInstallation } = await setup(t)
  const inst = await newInstallation()
  assert.match(inst.installationId, /^sgi_/)
  assert.equal((await call('GET', '/v1/installations/me', undefined, inst.auth)).body.handles, 0)
  assert.equal((await call('GET', '/v1/installations/me')).status, 401)
  const forged = { Authorization: `Bearer ${inst.installationId}.${'A'.repeat(43)}` }
  assert.equal((await call('GET', '/v1/installations/me', undefined, forged)).status, 401)
})

test('handles: validated, idempotent and bound to one installation', { skip }, async (t) => {
  const { call, newInstallation, newHandle } = await setup(t)
  const a = await newInstallation()
  const b = await newInstallation()
  assert.equal((await call('POST', '/v1/handles', { installationId: 'sgi_xxxxxxxxxxxxxxxxxxxxxx', pushToken: ANDROID })).status, 404)
  assert.equal((await call('POST', '/v1/handles', { installationId: a.installationId, pushToken: 'raw-fcm' })).status, 400)
  const h1 = await newHandle(a.installationId, ANDROID)
  assert.match(h1, /^sgh_/)
  assert.equal(await newHandle(a.installationId, ANDROID), h1, 'same token + installation gives the same handle')
  assert.notEqual(await newHandle(b.installationId, ANDROID), h1)
})

test('notify renders server-side templates and delivers to Expo and APNs', { skip }, async (t) => {
  const { call, newInstallation, newHandle, expoCalls, apns } = await setup(t)
  const inst = await newInstallation()
  const hAndroid = await newHandle(inst.installationId, ANDROID, { locale: 'el-GR', platform: 'android' })
  const hIos = await newHandle(inst.installationId, IOS, { locale: 'en', platform: 'ios' })

  const r = await call('POST', '/v1/notify', {
    handles: [hAndroid, hIos],
    type: 'geofence',
    state: 'alarm',
    vessel: 'Thalassa <script>',
    data: { distance: 72.4, radius: 40, bearing: 15 },
    title: 'FREE TEXT IS IGNORED',
    body: 'click http://evil'
  }, inst.auth)
  assert.equal(r.status, 200, JSON.stringify(r.body))
  assert.equal(r.body.sent, 2)

  const [expo] = expoCalls
  assert.equal(expo.auth, 'Bearer expo-secret')
  assert.deepEqual(expo.messages[0], {
    to: ANDROID,
    title: 'Thalassa script: Συναγερμός άγκυρας',
    body: 'Το σκάφος βγήκε από τη ζώνη: 72 m από την άγκυρα (ακτίνα 40 m).',
    sound: 'geofence_alarm.wav',
    channelId: 'geofence-alarms',
    priority: 'high',
    data: { type: 'geofence-alarm', state: 'alarm', distance: 72, radius: 40, bearing: 15, timestamp: expo.messages[0].data.timestamp }
  })

  const [ios] = apns.requests
  assert.equal(ios.deviceToken, IOS_HEX)
  assert.equal(ios.jwtValid, true)
  assert.equal(ios.topic, 'com.akat78.sixpack')
  assert.equal(ios.payload.aps.alert.title, 'Thalassa script: Anchor alarm')
  assert.equal(ios.payload.aps.sound, 'geofence_alarm.caf')
  assert.equal(ios.payload.type, 'geofence-alarm')
})

test('notify rejects bad input and other installations\' handles', { skip }, async (t) => {
  const { call, newInstallation, newHandle, expoCalls } = await setup(t)
  const a = await newInstallation()
  const b = await newInstallation()
  const hb = await newHandle(b.installationId, ANDROID)
  assert.equal((await call('POST', '/v1/notify', { handles: [hb], type: 'geofence' })).status, 401)
  assert.equal((await call('POST', '/v1/notify', { handles: [hb], type: 'spam' }, a.auth)).status, 400)
  assert.equal((await call('POST', '/v1/notify', { handles: [hb], type: 'depth', data: { depth: 'x' } }, a.auth)).status, 400)
  assert.equal((await call('POST', '/v1/notify', { handles: [], type: 'depth' }, a.auth)).status, 400)
  const r = await call('POST', '/v1/notify', { handles: [hb], type: 'depth', data: { depth: 2 } }, a.auth)
  assert.deepEqual(r.body, { sent: 0, results: [{ handle: hb, status: 'unknown' }] })
  assert.equal(expoCalls.length, 0)
})

test('dead devices are reported as invalid and skipped afterwards', { skip }, async (t) => {
  const { call, newInstallation, newHandle, expoCalls } = await setup(t)
  const inst = await newInstallation()
  const h = await newHandle(inst.installationId, ANDROID_GONE)
  const first = await call('POST', '/v1/notify', { handles: [h], type: 'test' }, inst.auth)
  assert.deepEqual(first.body.results, [{ handle: h, status: 'invalid' }])
  const second = await call('POST', '/v1/notify', { handles: [h], type: 'test' }, inst.auth)
  assert.deepEqual(second.body.results, [{ handle: h, status: 'invalid' }])
  assert.equal(expoCalls.length, 1)
  // Re-registering the device revives the handle.
  assert.equal(await newHandle(inst.installationId, ANDROID_GONE), h)
})

test('notify is rate limited per installation', { skip }, async (t) => {
  const { call, newInstallation, newHandle } = await setup(t, { LIMIT_NOTIFY_BURST: '3', LIMIT_NOTIFY_PER_MINUTE: '1' })
  const inst = await newInstallation()
  const h = await newHandle(inst.installationId, ANDROID)
  const statuses = []
  for (let i = 0; i < 4; i++) statuses.push((await call('POST', '/v1/notify', { handles: [h], type: 'test' }, inst.auth)).status)
  assert.deepEqual(statuses, [200, 200, 200, 429])
})

test('installation registration is rate limited per IP', { skip }, async (t) => {
  const { call } = await setup(t, { LIMIT_INSTALLATIONS_PER_HOUR: '2' })
  const statuses = []
  for (let i = 0; i < 3; i++) statuses.push((await call('POST', '/v1/installations', {})).status)
  assert.deepEqual(statuses, [201, 201, 429])
})

test('handles can be withdrawn by the app (with the token) or by the plugin', { skip }, async (t) => {
  const { call, newInstallation, newHandle } = await setup(t)
  const inst = await newInstallation()
  const other = await newInstallation()
  const h1 = await newHandle(inst.installationId, ANDROID)
  const h2 = await newHandle(inst.installationId, IOS)
  assert.equal((await call('POST', '/v1/handles/revoke', { handle: h1, pushToken: 'ExponentPushToken[wrong]' })).status, 404)
  assert.equal((await call('POST', '/v1/handles/revoke', { handle: h1, pushToken: ANDROID })).status, 200)
  assert.equal((await call('DELETE', `/v1/handles/${h2}`, undefined, other.auth)).status, 404)
  assert.equal((await call('DELETE', `/v1/handles/${h2}`, undefined, inst.auth)).status, 200)
  assert.equal((await call('GET', '/v1/installations/me', undefined, inst.auth)).body.handles, 0)
})

test('admin can revoke an installation', { skip }, async (t) => {
  const { call, newInstallation } = await setup(t)
  const inst = await newInstallation()
  const path = `/v1/admin/installations/${inst.installationId}/revoke`
  assert.equal((await call('POST', path, {}, { Authorization: 'Bearer wrong' })).status, 401)
  assert.equal((await call('POST', path, {}, { Authorization: 'Bearer admin-secret' })).status, 200)
  assert.equal((await call('GET', '/v1/installations/me', undefined, inst.auth)).status, 403)
  const stats = await call('GET', '/v1/admin/stats', undefined, { Authorization: 'Bearer admin-secret' })
  assert.equal(stats.body.installations, 0)
})

test('rejects non-JSON and oversized bodies', { skip }, async (t) => {
  const { call } = await setup(t)
  assert.equal((await call('POST', '/v1/installations', 'x', { 'Content-Type': 'text/plain' })).status, 415)
  assert.equal((await call('POST', '/v1/installations', JSON.stringify({ name: 'x'.repeat(20000) }))).status, 413)
  assert.equal((await call('GET', '/nope')).status, 404)
  assert.equal((await call('DELETE', '/v1/notify')).status, 405)
})
