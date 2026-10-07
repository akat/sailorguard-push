'use strict'

// Notification texts are built here, never taken from the boat server. A
// plugin can only send an alarm type, a state and a few validated numbers, so
// the gateway cannot be used to deliver arbitrary text to the app's users.

const TYPES = {
  geofence: { dataType: 'geofence-alarm', channelId: 'geofence-alarms' },
  position: { dataType: 'position-lost', channelId: 'geofence-alarms' },
  depth: { dataType: 'depth-alarm', channelId: 'depth-alarms' },
  wind: { dataType: 'wind-alarm', channelId: 'wind-alarms' },
  test: { dataType: 'test', channelId: 'geofence-alarms' }
}

// Allowed numeric fields per type: [min, max, decimals].
const FIELDS = {
  geofence: { distance: [0, 1e6, 0], radius: [0, 1e5, 0], bearing: [0, 360, 0] },
  position: { secondsWithoutFix: [0, 1e7, 0] },
  depth: { depth: [0, 12000, 1], threshold: [0, 12000, 1] },
  wind: { wind: [0, 250, 1], threshold: [0, 250, 1] },
  test: {}
}

const TEXT = {
  en: {
    geofence: {
      alarm: ['Anchor alarm', (d) => `Vessel left the geofence: ${d.distance ?? '?'} m from the anchor (radius ${d.radius ?? '?'} m).`],
      normal: ['Anchor alarm cleared', () => 'The vessel is back inside the geofence.']
    },
    position: {
      alarm: ['Anchor alarm: GPS lost', (d) => d.secondsWithoutFix != null
        ? `No GPS position for ${d.secondsWithoutFix} s. The anchor alarm cannot watch the boat.`
        : 'No GPS position received. The anchor alarm cannot watch the boat.'],
      normal: ['GPS position restored', () => 'The anchor alarm is watching the boat again.']
    },
    depth: {
      alarm: ['Depth alarm', (d) => `Depth ${d.depth ?? '?'} m (limit ${d.threshold ?? '?'} m).`],
      normal: ['Depth alarm cleared', () => 'Depth is back above the limit.']
    },
    wind: {
      alarm: ['Wind alarm', (d) => `${d.source === 'true' ? 'True' : 'Apparent'} wind ${d.wind ?? '?'} kn (limit ${d.threshold ?? '?'} kn).`],
      normal: ['Wind alarm cleared', () => 'Wind is back below the limit.']
    },
    test: {
      alarm: ['SailorGuard test', () => 'Push notifications from your boat are working.'],
      normal: ['SailorGuard test', () => 'Push notifications from your boat are working.']
    }
  },
  el: {
    geofence: {
      alarm: ['Συναγερμός άγκυρας', (d) => `Το σκάφος βγήκε από τη ζώνη: ${d.distance ?? '?'} m από την άγκυρα (ακτίνα ${d.radius ?? '?'} m).`],
      normal: ['Ο συναγερμός άγκυρας έληξε', () => 'Το σκάφος είναι ξανά μέσα στη ζώνη.']
    },
    position: {
      alarm: ['Συναγερμός άγκυρας: χάθηκε το GPS', (d) => d.secondsWithoutFix != null
        ? `Δεν υπάρχει θέση GPS για ${d.secondsWithoutFix} s. Ο συναγερμός άγκυρας δεν μπορεί να παρακολουθήσει το σκάφος.`
        : 'Δεν λαμβάνεται θέση GPS. Ο συναγερμός άγκυρας δεν μπορεί να παρακολουθήσει το σκάφος.'],
      normal: ['Το GPS επανήλθε', () => 'Ο συναγερμός άγκυρας παρακολουθεί ξανά το σκάφος.']
    },
    depth: {
      alarm: ['Συναγερμός βάθους', (d) => `Βάθος ${d.depth ?? '?'} m (όριο ${d.threshold ?? '?'} m).`],
      normal: ['Ο συναγερμός βάθους έληξε', () => 'Το βάθος είναι ξανά πάνω από το όριο.']
    },
    wind: {
      alarm: ['Συναγερμός ανέμου', (d) => `${d.source === 'true' ? 'Πραγματικός' : 'Φαινόμενος'} άνεμος ${d.wind ?? '?'} kn (όριο ${d.threshold ?? '?'} kn).`],
      normal: ['Ο συναγερμός ανέμου έληξε', () => 'Ο άνεμος είναι ξανά κάτω από το όριο.']
    },
    test: {
      alarm: ['Δοκιμή SailorGuard', () => 'Οι ειδοποιήσεις από το σκάφος σας λειτουργούν.'],
      normal: ['Δοκιμή SailorGuard', () => 'Οι ειδοποιήσεις από το σκάφος σας λειτουργούν.']
    }
  }
}

function pickLocale(locale) {
  return typeof locale === 'string' && locale.toLowerCase().startsWith('el') ? 'el' : 'en'
}

/**
 * Validate the plugin's alarm request.
 * @returns {{ok: true, alarm} | {ok: false, error}}
 */
function validateAlarm(body) {
  const type = body?.type
  if (!TYPES[type]) return { ok: false, error: `type must be one of ${Object.keys(TYPES).join(', ')}` }
  const state = body.state ?? 'alarm'
  if (state !== 'alarm' && state !== 'normal') return { ok: false, error: 'state must be alarm or normal' }

  const input = body.data && typeof body.data === 'object' ? body.data : {}
  const data = {}
  for (const [key, [min, max, decimals]] of Object.entries(FIELDS[type])) {
    const v = input[key]
    if (v === undefined || v === null) continue
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      return { ok: false, error: `data.${key} must be a number between ${min} and ${max}` }
    }
    const f = 10 ** decimals
    data[key] = Math.round(v * f) / f
  }
  if (type === 'wind' && (input.source === 'true' || input.source === 'apparent')) data.source = input.source

  // Optional boat name, shown as a title prefix. Restricted charset and length.
  let vessel
  if (typeof body.vessel === 'string') {
    vessel = body.vessel.normalize('NFC').replace(/[^\p{L}\p{N} ._'-]/gu, '').trim().slice(0, 32) || undefined
  }
  return { ok: true, alarm: { type, state, data, vessel } }
}

/** Build the push message for one recipient locale. */
function render(alarm, locale, now = Date.now()) {
  const lang = pickLocale(locale)
  const [title, body] = TEXT[lang][alarm.type][alarm.state]
  const meta = TYPES[alarm.type]
  const isAlarm = alarm.state === 'alarm'
  return {
    title: alarm.vessel ? `${alarm.vessel}: ${title}` : title,
    body: body(alarm.data),
    sound: isAlarm ? 'geofence_alarm.wav' : 'default',
    channelId: meta.channelId,
    data: { type: meta.dataType, state: alarm.state, ...alarm.data, timestamp: new Date(now).toISOString() }
  }
}

module.exports = { validateAlarm, render, pickLocale, TYPES }
