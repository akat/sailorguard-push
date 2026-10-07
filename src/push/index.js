'use strict'

// Delivers a validated alarm to a set of handles: Android (Expo tokens) via
// the Expo push service, iOS (ExponentPushToken[apns:<hex>]) straight to APNs.

const { createExpoSender } = require('./expo')
const { createApnsSender } = require('./apns')
const { render } = require('../templates')

const APNS_RE = /^ExponentPushToken\[apns:([0-9a-fA-F]{32,200})\]$/
const RECEIPT_DELAY_MS = 15 * 60 * 1000

const tokenKind = (token) => (APNS_RE.test(token) ? 'apns' : 'expo')
const apnsDeviceToken = (token) => APNS_RE.exec(token)?.[1]

function createDispatcher(config, { onInvalidToken, log = () => {}, fetchImpl, apnsConnectOptions } = {}) {
  const expo = createExpoSender({ accessToken: config.expoAccessToken, endpoint: config.expoEndpoint, fetchImpl })
  let apns
  let apnsError
  if (config.apns.key) {
    try {
      apns = createApnsSender({ ...config.apns, keyPem: config.apns.key, connectOptions: apnsConnectOptions })
    } catch (err) {
      apnsError = `APNs disabled: ${err.message}`
    }
  } else {
    apnsError = 'APNs key not configured'
  }
  if (apnsError) log(apnsError)

  const receiptTimers = new Set()
  function scheduleReceipts(tickets) {
    if (!tickets.length) return
    const timer = setTimeout(async () => {
      receiptTimers.delete(timer)
      try {
        for (const token of await expo.checkReceipts(tickets)) onInvalidToken(token)
      } catch (err) {
        log(`Expo receipt check failed: ${err.message}`)
      }
    }, RECEIPT_DELAY_MS)
    timer.unref?.()
    receiptTimers.add(timer)
  }

  /**
   * @param rows handle rows from the database
   * @returns {Promise<Map<string, {status, error?}>>} handle -> result
   */
  async function deliver(rows, alarm) {
    const byToken = new Map()
    const results = new Map()
    const groups = new Map() // locale -> rows
    for (const row of rows) {
      byToken.set(row.push_token, row.handle)
      const lang = row.locale?.toLowerCase().startsWith('el') ? 'el' : 'en'
      if (!groups.has(lang)) groups.set(lang, [])
      groups.get(lang).push(row)
    }

    const record = ({ token, status, error }) => {
      results.set(byToken.get(token), error ? { status, error } : { status })
      if (status === 'invalid') onInvalidToken(token)
    }

    for (const [lang, group] of groups) {
      const message = render(alarm, lang)
      const expoTokens = group.filter((r) => r.kind === 'expo').map((r) => r.push_token)
      const apnsItems = group
        .filter((r) => r.kind === 'apns')
        .map((r) => ({ token: r.push_token, deviceToken: apnsDeviceToken(r.push_token) }))

      const [expoResult, apnsResult] = await Promise.all([
        expoTokens.length ? expo.send(expoTokens, message) : { results: [], tickets: [] },
        apnsItems.length && apns ? apns.send(apnsItems, message) : { results: [] }
      ])
      expoResult.results.forEach(record)
      scheduleReceipts(expoResult.tickets)
      apnsResult.results.forEach(record)
      if (apnsItems.length && !apns) {
        for (const { token } of apnsItems) record({ token, status: 'error', error: apnsError })
      }
    }
    return results
  }

  return {
    deliver,
    apnsReady: Boolean(apns),
    expoAccessToken: Boolean(config.expoAccessToken),
    stop() {
      receiptTimers.forEach(clearTimeout)
      receiptTimers.clear()
    }
  }
}

module.exports = { createDispatcher, tokenKind }
