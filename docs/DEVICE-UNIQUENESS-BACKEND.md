# Identity Backend

Runs [`paritytech/device-uniqueness-backend-community`](https://github.com/paritytech/device-uniqueness-backend-community)
("Identity Backend V2") alongside a spawned PPN network, wired to the local People
Chain instead of a public Paseo endpoint.

As of v0.2.0 upstream publishes binary tarballs on its releases, so PPN fetches them like
every other component and `make start` stays Docker-free. It used to build them itself,
in its own release workflow, because upstream shipped only container images.

## What runs

v0.2.0 collapsed ten binaries into **one**, `dub`, and the service is chosen with
`--role` (`dub --list-roles`). Two of those roles matter here: `all-in-one` runs every
HTTP surface in a single process behind a route table it compiles in, and each worker
role runs one background loop.

v0.3.0 renamed the binary (`ibv2` before it), renamed the identity service to
**device-attestation** — roles, config keys and all — and deleted **dim-tickets** with its
`/api/v1/dim-ticket` routes, taking the standard topology from ten workloads to eight. The
role gate refuses a name it does not know, so a stale `--role` is a boot failure rather
than a service quietly missing.

So PPN runs **every** service the backend has, not a subset — which is new. It used to
run four binaries and a gateway of PPN's own to reassemble the routes; `all-in-one`
owns that mapping upstream now, with its own tests.

All of it against **one** Postgres cluster with several databases. Upstream splits per
service so they can deploy independently, which is not a concern here.

| Process | Role | Purpose | Database |
| --- | --- | --- | --- |
| `dub-postgres` | — | one cluster, N databases | — |
| `dub-api` | `all-in-one` | every HTTP surface on `DUB_PORT` (see below) | all three |
| `device-attestation-chain-writer` | `device-attestation-chain-writer` | drains the reservation outbox onto People Chain | `identity` |
| `registration-queue` | `registration-queue` | queue advancer | `identity` |
| `invite-tickets-pool` | `invite-tickets-pool` | keeps the invite ticket pool topped up | `invite_tickets` |

The database keeps the name `identity` while the key that carries it is
`DEVICE_ATTESTATION_DATABASE_URL`: nothing upstream reads the database's own name, and
renaming it would hand every existing cluster a choice between an authentication failure and
losing the rows in it.

The five surfaces behind the one port, all live:

| Path | Service | Note |
| --- | --- | --- |
| `/api/v1/usernames` (POST, `/available`, `/payment-status`), `/api/v1/attester`, `/.well-known/jwks.json` | device-attestation-api | challenge → attestation → JWT → registration |
| `/api/v1/usernames/search` (GET) | username-indexer | finalized-chain projection + prefix search |
| `/api/v1/invitation-ticket/claim` | invite-tickets-api | |
| `/api/v1/turn/issue` | turn-api | short-lived TURN credentials; needs `TURN_SECRET` (base64) + `TURN_REALM` |
| `/api/v1/notify` | notify-relay | pushes report provider failure until APNs/FCM credentials are set |
| `/readyz`, `/livez`, `/healthcheck`, `/docs` | all-in-one | `/readyz` aggregates every merged service's dependencies |

Two of these work without operator credentials only in the local sense: `turn-api` mints
credentials against a dev secret nothing outside this machine honours, and `notify-relay`
accepts requests and reports a provider failure. They are up, and they answer — that is
enough for a client to develop against, and not enough to deliver a push.

### Two signing accounts, not one

`device-attestation-chain-writer` signs as **Alice**, the ticket writers as **Bob**. That split is
load-bearing, not tidiness. Upstream's rule is "one inviter key = one nonce lane; never
scale it", and running all three writers on Alice breaks it across services instead of
across replicas:

`invite-tickets-pool` submits a batch every ~30 seconds, for ever. With a shared account
the chain writer's registration never wins a nonce — it retries through `Transaction is
outdated`, `priority too low` and `rendered invalid by another extrinsic`, then fails
terminally. The API had already answered `202`, so the username is accepted and simply
never appears. Nothing logs "nonce war"; it reads as the writer being broken.

Two accounts, two lanes. `INVITER_ADDRESS` (generated TOML) and `INVITER_SIGNER_SURI`
(`service.sh`) must name the same account, or the batches get wrapped in `Proxy.proxy` for
a proxy People Chain has no registration for.

### The inviter needs invites

`ppn service grant-invites` sudo-grants 1000 invites to the inviter in both dimensions
(`ProofOfInk.grant_invites`, `Game.grant_invites`; origin `InvitationsOrigin`). It runs as
a custom process next to the attestation-allowance grant, and re-running is safe.

Without it the pool is worse than idle: `AvailableInvites` is 0 on a fresh chain, so every
inner call fails (`submitted=1 registered=0 failed=1`) while still consuming a nonce —
which is how the starvation above was found. It verifies by reading the invite book back
rather than trusting its own submission, because two services signing as sudo at the same
moment do collide here (`Invalid: Stale`), and it retries until the grant is actually
there.

It uses the `dot` CLI rather than `@polkadot/api`, like the allowance grant: People Chain's
runtime carries signed extensions polkadot-js does not know (`AsPerson`, `PeopleLiteAuth`,
`AsResources`…), and an extrinsic it builds anyway dies in `validate_transaction` with a
wasm trap instead of a readable error.

`registration-queue` is only the path out of the registration queue while
`QUEUE_ENABLED=true`, and that defaults to `false`. It is included so the topology
matches production and the flag is flippable, but by default it idles.

## Why running it outside Docker works

Upstream's own deployment is compose + Caddy. What makes a plain binary alongside
zombienet equivalent:

- **No `CREATE EXTENSION`** in any migration. Stock Postgres is sufficient, so a
  portable Postgres build works.
- **Pure-Rust TLS** (ring + rustls). No OpenSSL, no system libraries on either
  platform. `openssl-probe` in the lockfile is cert-store discovery only.
- **Migrations are embedded** via `sqlx::migrate!` and applied on boot under a
  Postgres advisory lock. The wrappers need no migration step.
- **The route table is in the binary**, not in the edge. `all-in-one`'s `crate::routes`
  reproduces the Caddyfile's ownership map and is tested against it upstream, so running
  without Caddy does not mean reconstructing the routing — which is exactly what PPN used
  to do, and what could silently drift.

Postgres is genuinely load-bearing and cannot be swapped for SQLite: the outbox and
queue drains are built on `FOR UPDATE SKIP LOCKED`
(`identity-service/src/chain/outbox.rs`, `identity-service/src/queue.rs`), there are
advisory locks in four production paths (`pg_advisory_xact_lock` serialising
hard-mode DeviceCheck claims in `usernames/register.rs`; `pg_try_advisory_lock`
guarding the indexer's projection pass), and sqlx is compiled with only the
`postgres` driver.

## Build and fetch

**Binary** — from upstream's own release, pinned in `config/versions.env`:

```sh
DUB_REPO=paritytech/device-uniqueness-backend-community
DUB_TAG=v0.2.0
```

`ppn fetch` downloads `dub-<version>-<triple>.tar.gz` (the tag without its leading `v`)
and extracts the single `dub` into `bin/`. PPN no longer builds it: the
`build-identity-backend` job is gone from `.github/workflows/release.yml`, along with the
GitHub App token it needed to clone a private repo, the pinned Rust toolchain and roughly
ten minutes of every release.

The repo is still private, so **the token `ppn fetch` already requires must be able to
read it**. That is the one prerequisite this move adds; a token that cannot fails by name
on the asset rather than half-populating `bin/`.

**API reference** — `all-in-one` serves `/docs` as a directory, so `ppn fetch` puts
`index.html` and `openapi.json` in `bin/identity-docs/` and `scripts/dub/service.sh`
points `GATEWAY_DOCS_ROOT` at it. Those two come out of the backend's **tree** at the
pinned tag (`docs/api-reference/`), not out of its release, which publishes only the
tarballs and `SHA256SUMS`. Absent docs are reported and not fatal: `/docs` 404s and every
API still works.

**Postgres** — from [`theseus-rs/postgresql-binaries`](https://github.com/theseus-rs/postgresql-binaries),
the distribution used by the `postgresql_embedded` crate. It publishes exactly PPN's
two targets at ~12 MB compressed:

```
postgresql-16.14.0-aarch64-apple-darwin.tar.gz
postgresql-16.14.0-x86_64-unknown-linux-gnu.tar.gz
```

16.x matches upstream's `postgres:16-alpine`. That repo is public, so `fetch.sh`
downloads it directly, in the same shape as the Kubo step, with the version pinned in
`config/versions.env`.

## Ports

The backend defaults its HTTP listener to `0.0.0.0:8080`, which **collides with
`IPFS_GATEWAY_PORT`**, and `METRICS_ADDR` to `:9090`. Both are remapped in
`config/ports.env`:

```sh
DUB_PORT=8092   # every HTTP surface, one origin
DUB_POSTGRES_PORT=5433
```

One HTTP port, because `all-in-one` is one listener. The per-service ports this file used
to allocate (`IDENTITY_API_PORT`, `USERNAME_INDEXER_PORT`) are gone with the processes
that bound them.

These stay out of the `10000`-`10040` band deliberately. That band is one RPC port per
chain, so anything next to it reads as another parachain and invites exactly the mixup
it looks like. The identity services are plain HTTP, so they sit with the other
auxiliary services (`ETH_RPC_PORT=8545`, `IPFS_GATEWAY_PORT=8080`), and Postgres keeps
its own well-known number offset by one, so it neither looks like a chain nor collides
with a developer's system Postgres on 5432.

Metrics are off locally (`METRICS_ENABLED=false`), which avoids allocating three more
ports for exporters nothing scrapes — and matters more than it looks, because the
exporter binds before config validation, so a misconfigured service still squats on
9090.

`scripts/validate-ports.sh` needs no change: it compares `ALL_PORTS` against the TOML's
`rpc_port` entries and checks nginx exposure, and these are neither. They must stay out
of `ALL_PORTS` for that check to keep passing.

## Bootstrap

`scripts/dub/postgres.sh` runs `initdb` into `$DATA_DIR/identity-pgdata` on first
boot, creates the databases, then `exec`s `postgres`. Being a plain data directory, it
inherits PPN's `CLEAN=1` and `EPHEMERAL=1` semantics for free, and it follows `DATA_DIR`
so genesis and fork keep separate clusters.

Not `$DATA_DIR/dub-postgres`: zombienet creates a directory named after each
custom_process for its log before running it, and `initdb` refuses a non-empty
directory.

**The cluster has to be exactly as durable as the chain.** The username indexer keeps a
checkpoint of how far it has projected, so a cluster that outlives its chain starts the next
genesis network with a checkpoint past that chain's finalized head. It then resyncs an empty
range on every tick — `blocks_processed=0`, `accounts_upserted=0`, for ever — and every
registration is accepted with a `202` and never appears. Nothing reports an error; it reads
as a slow chain, and it is what two rounds of raising `09-identity-registration`'s timeout
were actually chasing.

So the cluster follows the chain's own lifetime:

| Start | Chain state | Identity cluster |
| --- | --- | --- |
| `ppn start` | `data/` | `data/identity-pgdata` |
| `ppn start CLEAN=1` | wiped | wiped with it |
| `ppn start EPHEMERAL=1` | zombienet's temp dir | `/tmp/zombie-identity-<pid>/` |
| `make test` | a fresh `/tmp/zombie-test-<pid>` | that run's own directory |

`ppn kill` removes both, and takes the identity stack down wrapper-first — `service.sh`
supervises its role and restarts it after 5s, so killing only the port holders left five
wrappers respawning children against whatever network came up next.

The service wrappers follow the `eth-rpc.sh` shape — source `ports.env`, export the
upstream env vars, `exec` the binary — with one addition. Zombienet
`custom_processes` have no `depends_on`, and upstream's compose relies on health
gating (its `device-attestation-api` healthcheck allows a 40s `start_period` covering
"migrations + the blocking People Chain connect at startup"). So each wrapper polls for
Postgres before exec'ing, in the retry style of `ipfs-daemon.sh`. The chain needs no
equivalent wait — the services block on the People Chain connect indefinitely and pick
it up whenever it appears.

### Environment

Every `${VAR:-default}` in upstream's compose file is a **compose-level** default that
the binary does not carry. Dropping compose means the wrappers inherit the job of
reproducing them; a missing one is a boot failure, not a fallback. And because
`all-in-one` starts six services in one process, it requires the union of what all six
need — a var only `turn-api` reads now stops the API from starting.

Hard-required (`ConfigError::Missing`, no in-code default). The non-secret ones are
emitted into the generated TOML by `packages/network-config/src/identity.ts`, so what a
service runs with is visible in the config:

```sh
ATTESTER_ACCOUNT=5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY   # Alice
INVITER_ADDRESS=…                                                    # same account locally
DEVICE_ATTESTATION_DATABASE_URL=postgres://…/identity                # namespaced per service
INDEXER_DATABASE_URL=postgres://…/username_indexer                   #   in v0.2.0; the bare
INVITE_TICKETS_DATABASE_URL=postgres://…/invite_tickets              #   DATABASE_URL, and the
                                                                     #   pre-v0.3.0 names, now
                                                                     #   fail at boot
PEOPLE_RPC_URL=ws://127.0.0.1:$PEOPLE_PORT
PEOPLE_NETWORK=paseo                                                 # westend2|paseo|polkadot
ASSET_HUB_RPC_URL=ws://127.0.0.1:$ASSET_HUB_PORT
TURN_REALM=previewnet.local
```

And the secrets, in `scripts/dub/service.sh` rather than the TOML (see
`docs/PROFILES.md`): `CHAIN_WRITER_SIGNER_SURI`, `INVITER_SIGNER_SURI`,
`JWT_ED25519_SECRET` with `JWT_ED25519_PUBLIC_KEY` derived from it, and `TURN_SECRET` —
which must be **base64**; hex is rejected with `invalid base64 encoding`.

The rest stay dormant under the dev defaults: `PAYMENT_MASTER_ACCOUNT` /
`PAYMENT_AMOUNT_PLANCK` are only read when `PAYMENT_LANE_ENABLED=true` (default false,
and compose sets no payment vars at all), `POC_HMAC_SECRET` only under
`POC_ENABLED=true`, and `APPLE_APP_ATTEST_APP_IDS` / `ANDROID_*` only under
`AUTH_ENABLED=true`. Push credentials (`APNS_*`, FCM) are likewise unset: `notify-relay`
starts, logs that the provider is not configured, and reports a provider failure per
request.

### Attester

`ATTESTER_ACCOUNT` needs no new chain-side setup: PPN's existing
`increase-people-lite-attestation-allowance` custom process already sudo-grants 1000
allowance to `5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY`, the same account
upstream defaults to. `ATTESTER_ALLOWANCE_FLOOR` (default 100) sits comfortably under
that. Ordering between the allowance process and the chain writer still needs
checking — the writer polls allowance every `ATTESTER_RESOURCE_POLL_SECS` (60s), so a
late grant should self-heal, but that should be confirmed rather than assumed.

### Attester under the deployable profile

Everything above describes `PPN_PROFILE=local`. Under the `deployable` profile
(the `deployable` profile work, **not yet merged** — this section is a dependency,
not settled ground), the genesis patcher strips the well-known dev SS58s from `balances`
and funds only `PPN_SUDO_SS58` and `PPN_FAUCET_SS58`. **Alice therefore has neither
sudo nor funds on a deployed server**, and the Alice-based defaults stop working:

- `CHAIN_WRITER_SIGNER_SURI=//Alice` derives a real keypair fine, but the account has
  a zero balance and cannot pay attestation fees.
- `ATTESTER_ACCOUNT` = Alice would hold an allowance that nothing can spend.

Note the failure is quiet. `writer.rs:580` only emits `tracing::warn!` when the signer
is under `ATTESTER_SIGNER_BALANCE_FLOOR_PLANCK` ("registrations will fail to pay
fees") — it does not refuse to start. On a deployed server this surfaces as
registrations silently never landing, so the log line needs to be something we
actually alert on.

Since #140 the allowance recipient is an operator secret, `PPN_ALLOWANCE_SS58`, and
`increase-people-lite-attestation-allowance.sh` hard-fails in deployable mode without
it. The backend attests as that same account, so it needs the matching key alongside
the keys #140 already defines:

```sh
PPN_IDENTITY_ATTESTER_URI="<mnemonic, 0x hex seed, or //derivation for PPN_ALLOWANCE_SS58>"
```

`scripts/dub/service.sh` reads both at exec time and overrides the Alice defaults
the generated TOML carries. Two things are worth knowing about that:

1. **It is a runtime override, not a generate-time one.** A deployment installs the
   committed `local-dev.toml` and never runs `make generate-toml`, so anything resolved
   while generating the config would never reach a server. The public SS58 would
   otherwise belong in the TOML with the rest of the non-secret env.
2. **A missing key is fatal, deliberately.** With `PPN_ALLOWANCE_SS58` set and
   `PPN_IDENTITY_ATTESTER_URI` absent, falling back to `//Alice` would leave the writer
   signing as an account with no allowance: the API keeps returning `202` and every
   registration sits in the outbox failing `NoAttestationAllowance`. The services refuse
   to start instead, matching the allowance script's own hard-fail.

The genesis patcher funds that account at genesis in deployable mode, alongside sudo
and faucet, because it pays the `PeopleLite.attest` fees. Unfunded it is another silent
failure: `writer.rs:580` only *warns* below `ATTESTER_SIGNER_BALANCE_FLOOR_PLANCK`, so
registrations would be accepted and never land. Reusing `PPN_FAUCET_SS58` would avoid
the funding step, but `docs/PROFILES.md` deliberately keeps the faucet's signing key off
the box and `device-attestation-chain-writer` needs its key locally.

Only genesis-mode servers are covered: a deployment installs `local-dev.toml`, so that
is what a deployed network is. A forked chain carries production's balances instead, and
would need the account funded on-chain.

One asymmetry to exploit: `PPN_SUDO_URI` **cannot** be a `//`-prefixed derivation path
(the `dot` CLI rejects it via `--env`), but `CHAIN_WRITER_SIGNER_SURI` goes through
`subxt_signer::SecretUri` (`chain-client/src/lib.rs:74`), which accepts `//Alice`,
BIP-39 mnemonics, `0x`+64-hex seeds, and additionally a `0x`+128-hex expanded
sr25519 secret. So the identity attester key has no `//` restriction — the constraint
in `docs/PROFILES.md` is a `dot` CLI limitation, not a chain or backend one.

Per `docs/PROFILES.md`, tests always run against the `local` profile, so
`08-dub.zndsl` exercises the Alice path only; deployable stays covered by
inspection and the genesis smoke, as with the rest of the profile work.

### Keeping attester and signer equal

Keep the attester and the writer's signer **equal on purpose**:

```rust
fn proxy_target(attester, signer) -> Option<_> { (attester != signer).then_some(attester) }
```

With `ATTESTER_ACCOUNT` = Alice and `CHAIN_WRITER_SIGNER_SURI=//Alice` this is `None`,
so the writer calls `attest` directly. If the two ever diverge, the writer silently
switches to wrapping calls in `Proxy.proxy`, which would require a matching proxy
relationship on People Chain or every submission fails.

Registration in `packages/network-config/src/toml-generator.ts` is a `section(has('people'), …)` block
adding the five `[[custom_processes]]`, so a network spawned without People Chain
brings up no identity backend. `make generate-toml` regenerates the checked-in
`zombienet-configs/local-dev.toml`.

## Tests

`tests/08-dub.zndsl` asserts the surfaces are up and owned by the right
service:

- `/livez`, and `/readyz` reporting every merged service's dependencies up
- `/api/v1/attester` returns the account the allowance was granted to
- `/.well-known/jwks.json` returns a usable key set
- `/api/v1/usernames/search` reaches the indexer
- `turn-api`, `invite-tickets-api` and `notify-relay` each answer
  **401** rather than 404 — mounted and enforcing auth, which is how a dropped role
  shows up
- the `/api/v1/notify` prefix keeps notify-relay's own empty 404 rather than the shared
  body, the one route-ownership detail that does not fall out of the merge for free

`tests/09-dub-registration.zndsl` is the end-to-end one: register a username, then
assert `device-attestation-chain-writer` landed it on People Chain and the indexer projected it.
That is the check that proves the wiring — the writer's lease, the attestation
allowance, the attester's signing key and finalization at once — rather than proving the
processes booted.

## Deferred: running upstream's own suite against PPN

Out of scope for the first cut, but worth recording as the strongest follow-up.

Upstream has four test tiers: offline (`just check`), DB-live (`just test-live-db`,
12 suites / 33 ignored tests — the CI merge gate), chain-live
(`just test-live-chain`), and provider smokes needing APNs/FCM credentials.

The chain-live suites — `payment_watch_live.rs`, `payment_http_live.rs`,
`voucher_http_live.rs` — default to a **public Paseo endpoint**, which is why they sit
outside the merge gate: a shared, mutable, rate-limited testnet cannot be
deterministic, and these suites mutate state. A PPN network is private, disposable and
genesis-fresh, so pointing `PEOPLE_RPC_URL` at it would make them gate-able. That is a
capability the identity repo does not have today.

The obstacle is shallow: upstream's `scripts/run_live_suites.sh` produces its scratch
databases with `docker compose`, pulling Docker back in. But the tests themselves only
read env vars — `IDENTITY_TEST_DATABASE_URL`, `INVITE_TICKETS_TEST_DATABASE_URL`,
`DIM_TICKETS_TEST_DATABASE_URL` and the indexer's — so PPN's own cluster could serve
them by creating four scratch databases and exporting the URLs.

The database half of that is already in place: the bootstrap creates `identity`,
`username_indexer` and `invite_tickets`, because v0.2.0's services each read their own
namespaced URL. Scratch databases for the suites would be additional.

## Known limits

- Upstream publishes macOS **ARM64 only**, so Intel Macs are unserved — the same
  limitation that already applies to the polkadot binaries.
- `DUB_TAG` pins a release, so a PPN release and the backend it runs are
  now tied to a version rather than to whatever `master` was that morning. Moving it is
  a deliberate edit.
- The repo is private, so `ppn fetch` needs a token that can read it. Nothing else PPN
  fetches has that requirement any more.
- `turn-api` and `notify-relay` are up but not usable for real delivery: no coturn, no
  APNs/FCM credentials. Requests are accepted and answered; a push does not arrive.
- **A killed cluster leaks a shared-memory segment, and macOS allows 32.** Postgres takes a
  SysV segment at startup and releases it on shutdown, so anything that SIGKILLs it — a crash,
  or a `ppn kill` before the SIGTERM it now sends first — leaves one behind. Once
  `kern.sysv.shmmni` (32) is reached, every later cluster dies at initdb with

  ```
  FATAL: could not create shared memory segment: No space left on device
  DETAIL: Failed system call was shmget(key=…, size=56, 03600).
  ```

  and the HINT says outright that it is not about disk space. The network still comes up; the
  backend simply is not there, and `/readyz` is unreachable rather than red. `ipcs -m` lists
  the orphans (56 bytes, `NATTCH` 0) and `ipcrm -m <id>` removes them.
