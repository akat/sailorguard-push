'use strict'

// SQLite storage (node:sqlite, no native dependencies).
//
// installations: one row per signalk-sailorguard plugin install (a boat server).
//                Only a SHA-256 of the secret is stored.
// handles:       opaque IDs the app gets in exchange for its push token. A
//                handle belongs to exactly one installation, so a boat server
//                can only reach the phones that registered with it, and never
//                sees the raw push token.

const { DatabaseSync } = require('node:sqlite')
const fs = require('fs')
const path = require('path')

const SCHEMA = `
CREATE TABLE IF NOT EXISTS installations (
  id             TEXT PRIMARY KEY,
  secret_hash    TEXT NOT NULL,
  name           TEXT,
  plugin_version TEXT,
  created_at     INTEGER NOT NULL,
  last_seen      INTEGER NOT NULL,
  revoked_at     INTEGER
);
CREATE TABLE IF NOT EXISTS handles (
  handle              TEXT PRIMARY KEY,
  installation_id     TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  push_token          TEXT NOT NULL,
  kind                TEXT NOT NULL,
  platform            TEXT,
  app_installation_id TEXT,
  app_version         TEXT,
  locale              TEXT,
  created_at          INTEGER NOT NULL,
  last_seen           INTEGER NOT NULL,
  invalid_at          INTEGER,
  UNIQUE (installation_id, push_token)
);
CREATE INDEX IF NOT EXISTS handles_push_token ON handles(push_token);
`

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  db.exec(SCHEMA)

  const q = {
    insertInstallation: db.prepare(
      'INSERT INTO installations (id, secret_hash, name, plugin_version, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?)'
    ),
    getInstallation: db.prepare('SELECT * FROM installations WHERE id = ?'),
    touchInstallation: db.prepare('UPDATE installations SET last_seen = ?, plugin_version = COALESCE(?, plugin_version) WHERE id = ?'),
    revokeInstallation: db.prepare('UPDATE installations SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL'),
    getHandleByToken: db.prepare('SELECT * FROM handles WHERE installation_id = ? AND push_token = ?'),
    getHandle: db.prepare('SELECT * FROM handles WHERE handle = ?'),
    insertHandle: db.prepare(
      `INSERT INTO handles (handle, installation_id, push_token, kind, platform, app_installation_id, app_version, locale, created_at, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ),
    refreshHandle: db.prepare(
      `UPDATE handles SET platform = ?, app_installation_id = ?, app_version = ?, locale = ?, last_seen = ?, invalid_at = NULL
       WHERE handle = ?`
    ),
    deleteHandle: db.prepare('DELETE FROM handles WHERE handle = ?'),
    invalidateToken: db.prepare('UPDATE handles SET invalid_at = ? WHERE push_token = ? AND invalid_at IS NULL'),
    countHandles: db.prepare('SELECT COUNT(*) AS n FROM handles WHERE installation_id = ? AND invalid_at IS NULL'),
    pruneHandles: db.prepare('DELETE FROM handles WHERE last_seen < ? OR (invalid_at IS NOT NULL AND invalid_at < ?)'),
    pruneInstallations: db.prepare('DELETE FROM installations WHERE last_seen < ?'),
    stats: db.prepare(
      `SELECT (SELECT COUNT(*) FROM installations WHERE revoked_at IS NULL) AS installations,
              (SELECT COUNT(*) FROM handles WHERE invalid_at IS NULL) AS handles,
              (SELECT COUNT(*) FROM handles WHERE invalid_at IS NULL AND kind = 'apns') AS ios,
              (SELECT COUNT(*) FROM handles WHERE invalid_at IS NULL AND kind = 'expo') AS android`
    )
  }

  return {
    raw: db,
    createInstallation: ({ id, secretHash, name, pluginVersion }, now) =>
      q.insertInstallation.run(id, secretHash, name ?? null, pluginVersion ?? null, now, now),
    getInstallation: (id) => q.getInstallation.get(id),
    touchInstallation: (id, pluginVersion, now) => q.touchInstallation.run(now, pluginVersion ?? null, id),
    revokeInstallation: (id, now) => q.revokeInstallation.run(now, id).changes > 0,

    /** Returns the existing handle for (installation, token) or creates one. */
    upsertHandle(h, now) {
      const existing = q.getHandleByToken.get(h.installationId, h.pushToken)
      if (existing) {
        q.refreshHandle.run(h.platform ?? null, h.appInstallationId ?? null, h.appVersion ?? null, h.locale ?? null, now, existing.handle)
        return { handle: existing.handle, created: false }
      }
      q.insertHandle.run(h.handle, h.installationId, h.pushToken, h.kind, h.platform ?? null, h.appInstallationId ?? null,
        h.appVersion ?? null, h.locale ?? null, now, now)
      return { handle: h.handle, created: true }
    },
    getHandle: (handle) => q.getHandle.get(handle),
    getHandleByToken: (installationId, token) => q.getHandleByToken.get(installationId, token),
    deleteHandle: (handle) => q.deleteHandle.run(handle).changes > 0,
    invalidateToken: (token, now) => q.invalidateToken.run(now, token).changes,
    countHandles: (installationId) => q.countHandles.get(installationId).n,

    prune(now, { handleDays = 120, invalidDays = 30, installationDays = 365 } = {}) {
      const day = 86400000
      const handles = q.pruneHandles.run(now - handleDays * day, now - invalidDays * day).changes
      const installations = q.pruneInstallations.run(now - installationDays * day).changes
      return { handles, installations }
    },
    stats: () => ({ ...q.stats.get() }),
    close: () => db.close()
  }
}

module.exports = { openDb }
