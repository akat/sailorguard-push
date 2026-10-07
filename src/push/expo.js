'use strict'

// Expo push service client (Android) with ticket and receipt handling.
// https://docs.expo.dev/push-notifications/sending-notifications/

const SEND_URL = 'https://exp.host/--/api/v2/push/send'
const RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts'
const CHUNK = 100

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function createExpoSender({ accessToken, endpoint, timeoutMs = 15000, fetchImpl = globalThis.fetch }) {
  const sendUrl = endpoint || SEND_URL
  const receiptsUrl = endpoint ? endpoint.replace(/\/send$/, '/getReceipts') : RECEIPTS_URL
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {})
  }

  async function post(url, payload) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs)
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`Expo responded ${res.status}: ${text.slice(0, 200)}`)
    return JSON.parse(text)
  }

  return {
    name: 'expo',
    /** @returns {{results: {token, status, error?}[], tickets: {id, token}[]}} */
    async send(tokens, message) {
      const result = { results: [], tickets: [] }
      for (const group of chunk(tokens, CHUNK)) {
        const messages = group.map((to) => ({
          to,
          title: message.title,
          body: message.body,
          sound: message.sound,
          channelId: message.channelId,
          priority: 'high',
          data: message.data
        }))
        try {
          const { data: tickets = [] } = await post(sendUrl, messages)
          group.forEach((token, i) => {
            const ticket = tickets[i]
            if (ticket?.status === 'ok') {
              result.results.push({ token, status: 'sent' })
              if (ticket.id) result.tickets.push({ id: ticket.id, token })
            } else if (ticket?.details?.error === 'DeviceNotRegistered') {
              result.results.push({ token, status: 'invalid' })
            } else {
              result.results.push({ token, status: 'error', error: ticket?.message || 'no ticket' })
            }
          })
        } catch (err) {
          for (const token of group) result.results.push({ token, status: 'error', error: err.message })
        }
      }
      return result
    },

    /** @returns {Promise<string[]>} tokens reported as DeviceNotRegistered */
    async checkReceipts(tickets) {
      const invalid = []
      for (const group of chunk(tickets, 300)) {
        const { data = {} } = await post(receiptsUrl, { ids: group.map((t) => t.id) })
        for (const ticket of group) {
          const receipt = data[ticket.id]
          if (receipt?.status === 'error' && receipt.details?.error === 'DeviceNotRegistered') {
            invalid.push(ticket.token)
          }
        }
      }
      return invalid
    }
  }
}

module.exports = { createExpoSender }
