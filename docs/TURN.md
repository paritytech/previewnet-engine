# TURN / STUN

Peer-to-peer clients (WebRTC) need a relay when two peers cannot reach each other directly.
PPN runs [eturnal](https://eturnal.net) for that, next to the device-uniqueness backend (DUB),
whose `turn-api` mints the short-lived credentials the relay accepts.

## How a client uses it

1. Sign in to DUB and hold its JWT.
2. `POST /dub/api/v1/turn/issue` with `Authorization: Bearer <jwt>`. The response is
   `{ servers, username, password, ttl }`.
3. Pass `servers` as the ICE server URLs, with `username` and `password` as the credential.

Clients never configure a password themselves. The dashboard lists the same servers under
**TURN / STUN**, and so does `/api/network` under `ice`.

| URL | Where it goes |
| --- | --- |
| `stun:<host>:3478` | eturnal, UDP, direct |
| `turn:<host>:3478?transport=udp` | eturnal, UDP, direct |
| `turn:<host>:3478?transport=tcp` | eturnal, TCP, direct |
| `turns:<host>:5349?transport=tcp` | nginx (TLS) → eturnal on `127.0.0.1:3479`, PROXY protocol. Only listed behind https |

`<host>` is the hostname of `PPN_PUBLIC_URL`, or `127.0.0.1` locally. Ports come from
`config/ports.env` (`TURN_*`).

STUN and plain TURN cannot go through nginx: STUN answers with the address it sees the
request come from, and behind a proxy that address is the proxy's own. nginx only handles TLS,
and passes the client's address on with the PROXY protocol.

## Installing eturnal

- **Linux**: `ppn fetch` downloads the self-contained release from eturnal.net
  (`ETURNAL_VERSION` in `config/versions.env`) into `bin/eturnal/`.
- **macOS**: eturnal.net publishes no macOS build. Use the processone tap:

  ```sh
  brew tap processone/eturnal https://github.com/processone/eturnal
  brew install processone/eturnal/eturnal
  ```

  `ppn fetch` and `make doctor` fail until it is installed.

## The shared secret

`TURN_SECRET` is base64, which is what turn-api reads. turn-api signs with the decoded
bytes, while eturnal takes its secret as a string, so the decoded value must be printable ASCII
or the two derive different passwords. Both `ppn service turn` and `dub-api` read the secret
through `turnSecret()` in `packages/network-config/src/turn.ts`, and both refuse a value that
breaks this rule.

Locally the secret defaults to a public value. A deployment (one that sets `PPN_SECRETS_FILE`)
must set its own there:

```sh
TURN_SECRET=$(openssl rand -hex 24 | tr -d '\n' | base64)
```

The secret never goes into `eturnal.yml`. eturnal reads it from `ETURNAL_SECRET`.

## Deploying

- `P2P_LISTEN_IP` is the address eturnal binds and relays from, just as it is for the
  webrtc-direct collators. On a server it must be the public IP that `PPN_PUBLIC_URL`'s host
  resolves to.
- Open `TURN_PORT` (UDP and TCP), `TURN_TLS_PORT` (TCP) and
  `TURN_RELAY_MIN_PORT`–`TURN_RELAY_MAX_PORT` (UDP) in the firewall.
- `ppn nginx-conf` emits the TLS stream block at a `    # {{GENERATED_STREAMS}}` marker. That
  marker belongs inside the template's `stream {}` block, which must set `ssl_certificate` and
  `ssl_certificate_key` for the domain at that level. When the network runs the relay, the
  marker is required.

Under `DOCKER=1` the relay runs but cannot be reached from the host: it binds the
container's loopback, and the TURN ports are not published.

A descriptor can switch the relay off with `"services": { "turn": false }`. DUB still runs,
and its credentials then point at nothing.
