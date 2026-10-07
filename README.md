# sailorguard-push

This is the push gateway that runs at **https://push.sailorguard.com**. Boat servers
running the public `signalk-sailorguard` plugin use it to send alarms to the
SailorGuard / 6Pack app. The gateway is the **only** place that holds:

- the APNs `.p8` key (for iOS),
- the Expo access token (for Android),
- the users' raw push tokens.

None of these ever reaches a boat server or the npm package.

**Security model:**
- **Per-boat credentials.** Each plugin install gets its own credential. The gateway stores only a hash of it, and the credential can be revoked.
- **Handles instead of tokens.** The app trades its push token for a handle, and that handle is bound to one boat. A boat can only notify the phones that registered with it.
- **No free text.** Plugins send an alarm type and validated numbers. The gateway renders the text itself, in English or Greek.
- **Rate limits.** Requests are limited per IP and per installation. HTTPS is terminated by Traefik.

The API is described in [docs/api.md](docs/api.md).

## Run

The service needs Node ≥ 22.13 and has no npm dependencies. It stores its data in SQLite using the built-in `node:sqlite` module.

```sh
npm test
DB_FILE=./data/push.db PORT=8080 npm start
```

## Configuration (environment)

All variables are listed in [.env.example](.env.example). Copy it to `.env` and fill in the
values. `.env` is ignored by git. In Portainer, upload it, or set the same variables as stack variables.

| Variable | Default | Notes |
|---|---|---|
| `APNS_KEY` / `APNS_KEY_FILE` | | The `.p8` PEM, either inline (`\n` escaped) or as a file path. These are the same names as in proxyit. |
| `APNS_KEY_ID`, `APNS_TEAM_ID` | | |
| `APNS_BUNDLE_ID` | `com.akat78.sixpack` | |
| `APNS_HOST` | `api.push.apple.com` | |
| `EXPO_ACCESS_TOKEN` | | Required once "Enhanced push security" is enabled in Expo. |
| `ADMIN_TOKEN` | | Enables the admin endpoints. Use a long random value. |
| `DB_FILE` | `/data/sailorguard-push.db` | |
| `TRUST_PROXY` | `1` | Takes the client IP from `X-Forwarded-For`. Set it to `0` if the service is exposed directly. |
| `LIMIT_*`, `RETAIN_*` | see [src/config.js](src/config.js) | |

## Deploy

1. Push to GitHub. The workflow runs the tests and publishes `ghcr.io/<owner>/sailorguard-push`.
2. Point DNS `push.sailorguard.com` to the Traefik host.
3. In Portainer, create a stack from [portainer-stack.yml](portainer-stack.yml) and set these stack variables: `ADMIN_TOKEN`, `APNS_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID` and `EXPO_ACCESS_TOKEN`. Traefik (entrypoint `websecure`, resolver `le`) issues the certificate.
4. Check that it is up: `curl https://push.sailorguard.com/health` should return `"apns": true`.

The SQLite database is kept in the `sailorguard-push-data` volume, so include that volume in your backups.

## Securing Expo push

Turn on **Enhanced push security** for the Expo project (expo.dev → project → Credentials), and set the resulting access token as `EXPO_ACCESS_TOKEN`. Until you do this, anyone who knows an Android device's `ExponentPushToken` can push to it directly through Expo, without going through the gateway.

Do this only **after** every sender has the token. The old proxyit service, which the ESP32 firmware still uses, would also need the token, otherwise Android pushes sent through it will stop.
