'use strict'

const fs = require('fs')

const int = (v, d) => {
  const n = Number.parseInt(v ?? '', 10)
  return Number.isFinite(n) && n >= 0 ? n : d
}

// Same APNs variable names as the proxyit service, so its secrets carry over.
function loadConfig(env = process.env) {
  let apnsKey = env.APNS_KEY ? env.APNS_KEY.replace(/\\n/g, '\n') : ''
  if (!apnsKey && env.APNS_KEY_FILE) apnsKey = fs.readFileSync(env.APNS_KEY_FILE, 'utf8')
  return {
    port: int(env.PORT, 8080),
    dbFile: env.DB_FILE || '/data/sailorguard-push.db',
    trustProxy: env.TRUST_PROXY !== '0',
    adminToken: env.ADMIN_TOKEN || '',
    expoAccessToken: env.EXPO_ACCESS_TOKEN || '',
    expoEndpoint: env.EXPO_ENDPOINT || 'https://exp.host/--/api/v2/push/send',
    apns: {
      key: apnsKey,
      keyId: env.APNS_KEY_ID || '',
      teamId: env.APNS_TEAM_ID || '',
      bundleId: env.APNS_BUNDLE_ID || 'com.akat78.sixpack',
      host: env.APNS_HOST || 'api.push.apple.com'
    },
    limits: {
      installationsPerHour: int(env.LIMIT_INSTALLATIONS_PER_HOUR, 10),
      handlesPerHour: int(env.LIMIT_HANDLES_PER_HOUR, 60),
      handlesPerInstallation: int(env.LIMIT_HANDLES_PER_INSTALLATION, 50),
      notifyBurst: int(env.LIMIT_NOTIFY_BURST, 20),
      notifyPerMinute: int(env.LIMIT_NOTIFY_PER_MINUTE, 10)
    },
    retention: {
      handleDays: int(env.RETAIN_HANDLE_DAYS, 120),
      invalidDays: int(env.RETAIN_INVALID_DAYS, 30),
      installationDays: int(env.RETAIN_INSTALLATION_DAYS, 365)
    }
  }
}

module.exports = { loadConfig }
