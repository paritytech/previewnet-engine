# The dashboard

One UI for every environment a network runs in: a laptop checkout, an `npm install -g` with a
`~/.ppn` workspace, the staging/production servers, and each spawner VM. It renders what the
network *is* — endpoints, health, provenance, logs — from the same resolution the CLI runs on,
so it can never disagree with `ppn show`.

## Why it exists

Before this, the same facts were maintained by hand in three places: a static landing page
with the production domain hardcoded 31 times, nginx `location` blocks in a template, and the
spawner's own `spawn.html`. Localhost had nothing. Every parachain or service change meant
editing all three, and none of them could say which binaries the network was actually spawned
from.

## Design

One contract, three planes:

```
DATA PLANE      loadNetwork() + ports.env + fork manifest + provenance stamps
                    │  dashboardModel(net, baseUrl)  — pure, unit-tested
                    ▼
CONTRACT        network.json (schemaVersion'd)
                    │
SERVICE PLANE   ppn service dashboard — one zombienet custom_process, like eth-rpc
                    /api/network /api/provenance /api/addresses /api/health /api/logs/:id
                    plus the UI's static assets, plus (locally) a path→port proxy
                    │
UI PLANE        static SPA = render(contract + health polling). Knows no domain, no port.
```

**The rule that keeps it maintainable:** the UI may only know what `network.json` tells it.
Every future feature is a schema field first, a renderer second.

### Routes

The model emits one route table (`/relay/alice`, `/asset-hub`, `/eth-rpc`, …). Two renderers:

- **Servers**: nginx `location` blocks are *generated* from the table; the checked-in template
  keeps only the invariant shell (TLS, certbot, headers, `/` → dashboard). nginx stays in the
  RPC data path — the dashboard never is, so a dashboard crash cannot take down the network's
  public endpoints.
- **Localhost**: the dashboard itself proxies the same paths to the local ports (WebSocket
  included), so `ws://127.0.0.1:<port>/asset-hub` mirrors `wss://<domain>/asset-hub`.
  Disabled on servers with `DASHBOARD_PROXY=0`.

### Provenance is stamped, not derived

"What was this spawned from" is a historical fact. A `latest` pin re-resolved at query time may
point somewhere else, so:

- `ppn fetch` writes `bin/provenance.json` as it downloads: per artifact the pinned tag, the
  **resolved** tag, the probed `--version`, and a sha256. That stamp is also the download cache:
  the next fetch reuses any artifact whose recorded resolved tag and sha256 still match what is
  on disk, and re-downloads the rest (`--force` re-downloads everything). The resolved tag is
  what makes this correct — a `latest` pin that has moved resolves elsewhere, which no size or
  timestamp check on the file could tell you. Three groups — the descriptor's node
  `binaries`, its `runtimes`, and the `toolchain` pinned in `config/versions.env` (the
  device-uniqueness backend, zombienet, kubo, postgres). The toolchain is stamped for the same
  reason the rest is: "which DUB is staging running?" is a question about a deployment, and
  before it was recorded nothing on the box answered it.
- `ppn start` writes `data/spawn.json`: when, which network, genesis or fork (with bite block
  and source), the profile, and PPN's own version. On a server `ppn start` never runs, so
  a deployment calls `ppn stamp-spawn` just before starting the service — the same
  writer (`lib/spawn-stamp.ts`), so a field cannot reach one path and miss the other. See
  *Why a server does not run `ppn start`* below.

The API reads the stamps; it never re-resolves.

**Except what only the running node knows.** A live runtime upgrade — which this dashboard can
perform — moves a chain's `specVersion` without touching a single artifact on disk, so after one
the stamp and the chain disagree. So `/api/health` asks each chain directly, in the same
JSON-RPC batch as the head: `state_getRuntimeVersion` and `system_version`, rendered beside the
block number as `specName/specVersion` and the node's own version. The stamp says what was
*fetched*; health says what is *running*, and both are worth showing.

### Actions are a separate, gated plane

Runtime upgrades (reusing `packages/cli/src/upgrade/`) and binary-swap-with-restart are sudo
calls, so what may run one is decided by **who can reach the socket**:

| `DASHBOARD_HOST` | `DASHBOARD_ACTIONS_TOKEN` | actions |
|---|---|---|
| unset (`127.0.0.1`) | unset | open — only this machine can call |
| anything wider | unset | off, 403 |
| anything wider | set | the exact bearer only, else 401 |

Reachability and not a profile, because a profile cannot get here. This gate used to read
`PPN_PROFILE` and default to `local`, and zombienet strips the environment of custom
processes (see below), so on a deployed host it always read `local` and every caller was
authorized for sudo. Binding is the one input that cannot be silently absent: the socket is
either reachable or it is not.

### Environments

| | who spawns the dashboard | baseUrl | proxy |
|---|---|---|---|
| checkout / npm | zombienet (services table) | `http://127.0.0.1:<DASHBOARD_PORT>` | on |
| a deployment | same table, via the process supervisor | `https://$PPN_DOMAIN` | off (proxy routes) |
| spawner VM | same table, via cloud-init | `https://<name>.<zone>` | off |

zombienet hands custom processes **no environment**, and only a checkout runs `ppn start`
(a deployment spawns `zombie-cli` itself). So everything the dashboard cannot derive has to
reach it through `config/ports.env`, which a deployment patches per deploy:
`PPN_PUBLIC_URL` (else every chain is advertised as `127.0.0.1`) and `PPN_DATA_DIR` (else it
reads `<release>/data`, empty on every deploy — no logs, no spawn stamp, no chain-spec
downloads). A deployment rehearsal starts the dashboard with neither variable in its
environment for exactly this reason.

### Why a server does not run `ppn start`

No design reason — deployments have spawned `zombie-cli` directly since the first server
deploy, which predates the CLI's `start` verb, and nobody revisited it. The cost is that
`ppn start`'s pre-spawn work exists twice: a deployment does the fetch and generate, the unit
restates the environment through `Environment=`, and `ports.env` gets sed-patched with what
`ppn start` would have written to `ports.local.env`. Every fact that has no counterpart on the
server path is a bug waiting to be found on staging — `PPN_PUBLIC_URL`, `PPN_DATA_DIR` and the
spawn stamp each shipped that way.

`ppn stamp-spawn` is a stopgap against the third of those, not a fix for the class. The fix is
a server mode for `ppn start` that the unit can call, omitting what a deploy already did or
must not do under systemd:

| `ppn start` step | server mode |
|---|---|
| `freePorts()` — kills whatever holds a service port | **skip**: under `Restart=on-failure`, a service that kills processes on each restart is a footgun |
| `ensureDeps()` — fetch/generate if missing | **skip**: the deployment did it, staged, where a failure fails the deploy rather than crash-looping the unit |
| writes `ports.local.env` | **keep** — and it replaces a deployment's sed patches, so the custom-process environment has one author |
| writes `spawn.json` | **keep** — this is what `stamp-spawn` stands in for today |
| SIGTERM handling + service sweep | **keep**: exactly what `ExecStop` wants |

A flag (`ppn start --server`) rather than a separate `start-server` verb: it is the same job in
a different environment, and a second verb would duplicate the resolution that already caused
this drift. When it lands, `ppn stamp-spawn` goes with the duplication it papers over.

## Failure behaviour

- Dashboard down ≠ network down: it is additive, never in the prod data path.
- A chain being down is *information* (rendered with its probe error and time), not a blank page.
- Log streaming serves only ids the model names — never caller-supplied paths.
- Health is probed once server-side on an interval and cached; browser tabs read the cache.
  One JSON-RPC batch per chain per tick, with results matched by request id — the spec lets a
  server answer a batch in any order, so reading by position would mislabel the fields.
- A node that answers a header but not `state_getRuntimeVersion` is still up: the head decides
  up-or-down, the version fields are extra detail that is simply omitted when absent.

## Testing

- `dashboardModel`: golden fixtures for both URL modes (port-style and domain-style).
- Stamp writers: unit tests over a fixture workspace.
- Sidecar: API tests on an ephemeral port against a fixture workspace, including the
  path-traversal rejection and the actions gate staying closed by default.
- Publish surface: the UI assets ship in the npm tarball.
- Running runtime/node version: a stub node answers the probe's batch **in reverse**, so a
  regression that read results by position instead of by id fails the test.
- a deployment rehearsal: the installed release serves `/`, advertises its public URL,
  finds its logs, and reports a spawn stamp naming that release's own version — all from a
  process handed no environment.
- `writeSpawnStamp`: the shape every caller produces, and that an interrupted bite's truncated
  manifest cannot take a spawn down with it.
- `npm-install-smoke-test`: after the network spawns, `/api/network` answers, the provenance
  stamp exists and names resolved tags.
