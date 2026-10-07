# SailorGuard push gateway API (v1)

Base URL: `https://push.sailorguard.com`. All bodies are JSON (`Content-Type: application/json`, at most 16 KB).

## Who talks to the gateway

```
App ──POST /v1/handles──────────▶ Gateway ◀──POST /v1/notify── signalk-sailorguard plugin
     (push token in, handle out)            (handles + alarm type and numbers)
```

There are three parties:

- **The gateway** holds the secrets: the APNs `.p8` key and the Expo access token.
  It is the only party that ever sees raw push tokens.
- **The plugin** on a boat server holds:
  - its own installation credential, issued on first start;
  - the handles of the phones that registered with it.
- **The app** trades its push token for a handle that is bound to one boat's
  installation. It gives the boat only that handle.

## Endpoints

### `POST /v1/installations`: called by the plugin, once

The request body is optional: `{ "name": "Boat name", "pluginVersion": "0.2.0" }`.

Response `201`:

```json
{ "installationId": "sgi_…", "secret": "…", "credential": "sgi_….<secret>" }
```

- The secret is shown once and is stored only as a SHA-256 hash.
- The plugin authenticates with `Authorization: Bearer <credential>`.
- Rate limited per IP (`LIMIT_INSTALLATIONS_PER_HOUR`, default 10).

### `GET /v1/installations/me`: called by the plugin

Response:

```json
{ "installationId": "sgi_…", "handles": 3 }
```

The plugin uses it to check that its stored credential still works. It returns `401` for a credential the gateway doesn't recognise, and `403` if the installation has been revoked.

### `POST /v1/handles`: called by the app

```json
{
  "installationId": "sgi_…",            // from the plugin's GET /api/info
  "pushToken": "ExponentPushToken[…]",   // Android, or ExponentPushToken[apns:<hex>] for iOS
  "platform": "ios", "appInstallationId": "uuid", "appVersion": "1.0.9", "locale": "el-GR"
}
```

The only required fields are `installationId` and `pushToken`.

Response:

```json
{ "handle": "sgh_…" }
```

- **Status codes:** `201` when a new handle is created; `200` when the same token was already registered with that installation, in which case the same handle comes back and is reactivated.
- **Locale:** notifications use the `locale` field, which is Greek for `el*` and English for anything else.
- **Limits:**
  - per IP: `LIMIT_HANDLES_PER_HOUR`, default 60;
  - per installation: at most `LIMIT_HANDLES_PER_INSTALLATION` (default 50) active handles; beyond that the response is `409`.

### `POST /v1/handles/revoke`: called by the app

The body is `{ "handle": "sgh_…", "pushToken": "…" }`. Supplying the push token proves that the caller owns the handle.

### `DELETE /v1/handles/:handle`: called by the plugin, authenticated

Used when a device unregisters from the boat.

### `POST /v1/notify`: called by the plugin, authenticated

```json
{
  "handles": ["sgh_…"],
  "type": "geofence",
  "state": "alarm",
  "vessel": "Thalassa",
  "data": { "distance": 72, "radius": 40, "bearing": 15 }
}
```

**Allowed values for `type` and their `data` fields:**

| `type` | Allowed `data` fields |
|---|---|
| `geofence` | `distance`, `radius`, `bearing` |
| `position` | `secondsWithoutFix` |
| `depth` | `depth`, `threshold` |
| `wind` | `wind`, `threshold`, `source` (`apparent`/`true`) |
| `test` | none |

**Validation rules:**
- `state` is `alarm` (the default) or `normal`.
- Numbers are range-checked and rounded.
- `vessel` is optional. It is reduced to letters, digits and `._'-`, at most 32 characters, and is shown as a prefix in the title.
- **No free text is accepted.** The gateway builds the title and body from its own templates (English and Greek). Any other field in the request, such as `title` or `body`, is ignored.

**Response:**

```json
{ "sent": 1, "results": [{ "handle": "sgh_…", "status": "sent" }] }
```

**Per-handle status:**

| `status` | Meaning | What the plugin does |
|---|---|---|
| `sent` | Accepted by Expo or APNs | nothing |
| `invalid` | The device is no longer registered | forget the handle |
| `unknown` | The handle does not exist, or belongs to another installation | forget the handle |
| `error` | Temporary failure; `error` gives the reason | retry later |

Rate limited per installation: a burst of `LIMIT_NOTIFY_BURST` (default 20), refilled at `LIMIT_NOTIFY_PER_MINUTE` (default 10).

### Admin endpoints (`Authorization: Bearer $ADMIN_TOKEN`)

- `POST /v1/admin/installations/:id/revoke` blocks a misbehaving boat server.
- `GET /v1/admin/stats` returns `{installations, handles, ios, android}`.

### `GET /health`

Response:

```json
{ "status": "ok", "apns": true, "expoAccessToken": true }
```

## Delivery

| Device | How it is delivered |
|---|---|
| Android (`ExponentPushToken[…]`) | Expo push service with `EXPO_ACCESS_TOKEN`; channels `geofence-alarms`, `depth-alarms`, `wind-alarms`; sound `geofence_alarm.wav` |
| iOS (`ExponentPushToken[apns:<hex>]`) | APNs HTTP/2 with an ES256 provider token; sound `geofence_alarm.caf`; the `data` fields are at the top level of the payload |

The push `data` is `{ type: "geofence-alarm" | "position-lost" | "depth-alarm" | "wind-alarm" | "test", state, ...numbers, timestamp }`.

**Dead tokens:**
- Expo `DeviceNotRegistered` (from the ticket, or from the receipt 15 minutes later) and APNs `410` mark every handle with that token as invalid.
- Registering the device again reactivates its handle.

## Retention

| Data | Kept for |
|---|---|
| Handles not refreshed by the app | 120 days |
| Handles marked invalid | 30 days |
| Installations not seen | 365 days |

All three periods are configurable through `RETAIN_*` environment variables.
