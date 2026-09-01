# Runtime upgrades

Upgrade the runtime of a chain that is **already running** — genesis network or fork,
local or remote. This is the on-chain path (`authorize_upgrade` →
`apply_authorized_upgrade`), not the genesis-time WASM substitution the spawner does:
that one cannot touch a fork, because forked state belongs to the runtimes production is
running. Upgrading on-chain is the one correct way to change a fork's runtime.

## Usage

```bash
# Local network (ports resolved from config/ports.env)
make runtime-upgrade CHAIN=asset-hub WASM=path/to/runtime.wasm

# Remote node, e.g. a spawned instance
make runtime-upgrade CHAIN=asset-hub WASM=path/to/runtime.wasm WS=wss://<host>/asset-hub

# Apply a blob whose spec_version is NOT bumped (e.g. production's own runtime on a fork)
make runtime-upgrade CHAIN=asset-hub WASM=path/to/runtime.wasm ALLOW_SAME_SPEC=1
```

`CHAIN` is one of `relay | asset-hub | people | bulletin | web3-storage`. The WASM may be
compact-compressed (what release CI and srtool produce) or raw; anything else is rejected
by magic-byte check before touching the chain.

The command exits 0 only after the new code is **enacted** and the chain has finalized 5
more blocks — so it can gate CI directly. On a parachain, enactment waits for the relay's
PVF pre-check and go-ahead, whose duration varies from seconds to minutes (the default
enactment ceiling is 10 minutes). If the relay aborts the scheduled upgrade instead, that
is reported as an immediate error, not a timeout.

A blob **byte-identical** to what the chain already runs is a no-op: nothing is
submitted, the chain's finality is checked, and the command exits 0
(`already-installed`). This is deliberate — a parachain never receives a relay go-ahead
for a PVF identical to its current one, so submitting it would leave
`ParachainSystem.PendingValidationCode` stuck and block every future upgrade.

## How it works

The logic lives in `packages/cli/src/upgrade/` (unit-tested, `make test-unit`);
`ppn upgrade` is the entry point, and `make runtime-upgrade` builds the workspace first. Per chain, the best available path is picked from metadata:

1. `system.authorizeUpgrade(hash)` under sudo, then `system.applyAuthorizedUpgrade(code)`
   — the normal path on all five chains. `ALLOW_SAME_SPEC=1` swaps in
   `system.authorizeUpgradeWithoutChecks`.
2. `parachainSystem.authorizeUpgrade` / `enactAuthorizedUpgrade` — legacy fallback.
3. `system.setCode` (`setCodeWithoutChecks` under `ALLOW_SAME_SPEC=1`) via
   `sudo.sudoUncheckedWeight` — last resort; still parachain-safe, since cumulus routes
   `OnSetCode` through `schedule_code_upgrade`.

A failed inner sudo call (buried in the `Sudid` event) is surfaced as an error, not
reported as success. So is a rejected apply — `apply_authorized_upgrade` is callable
unsigned, so a bad blob does not fail the extrinsic; the tool detects the authorization
not being consumed and reports it immediately instead of timing out.

Transactions are encoded and signed with polkadot-api (the `next-*` runtimes reject
everything polkadot-js signs), but everything after submission is verified over plain
JSON-RPC: enactment is the finalized `:code` storage hashing to the authorized value,
which needs no event decoding and survives the block that swaps the runtime. When the
chain's code changed within the last ~20 blocks (back-to-back upgrades), the tool first
waits for the node to settle — a polkadot-api client created seconds after an enactment
leaks memory without bound.

## Integration test

`tests/13-runtime-upgrade.zndsl` runs `tests/scripts/test-runtime-upgrade.ts` against
the suite's Asset Hub: a non-sudo signer is refused, a byte-identical blob is a no-op,
and — when a stale chain spec left the chain behind `bin/` — a real full-pipeline
upgrade brings it up to date. To also exercise the pipeline round-trip (upgrade to a
different runtime and back), drop a second valid blob at
`bin/next_asset_hub_paseo_runtime.alt.wasm` (e.g. a previous release's); the leg is
skipped when the file is absent or byte-identical.

## Sudo

`//Alice` is sudo on the relay and all four parachains, in genesis mode and on a fork
(the bite overrides `Sudo::Key`), so locally everything just works. On a
deployable-profile network (see `docs/PROFILES.md`) Alice is stripped: set `PPN_SUDO_URI`
in the environment, or let the script read it from `/etc/ppn/secrets.env` like the other
sudo-signing scripts. The script verifies the signer against the on-chain `sudo.key()`
before submitting anything.

On a fork of production the relay's sudo account is sudo by key override but unable to
pay by state — relay Alice sits at exactly the existential deposit, and an account at
ED cannot pay for anything, so a `sudo(authorize_upgrade)` dies in the tx pool with
`Invalid::Payment`. Before submitting, the script tops the sudo account up with a
transfer from the first funded well-known dev account (Bob, Charlie, …, the stashes —
previewnet's relay genesis endows them all); a funded sudo skips this entirely.
`SKIP_FUNDING=1` disables it. For the record: teleporting from Asset Hub does NOT work
(`UntrustedTeleportLocation` — para 1500 is not a trusted teleporter to the vanilla
paseo relay). A bite-time `System.Account` inject DOES work (verified on-chain), but
only reaches bundles bitten with it; the transfer covers published bundles too.

## The fork → upgrade → test loop (triangle-e2e)

```bash
make start FORK=1                                  # spawn from production state
node bin/ppn.mjs fork wait fork-bundle          # block until every chain finalizes
make runtime-upgrade CHAIN=asset-hub WASM=my.wasm ALLOW_SAME_SPEC=1
make test                                          # run suites against the upgraded fork
```

`ALLOW_SAME_SPEC=1` is needed whenever the blob under test does not bump `spec_version`
relative to what the fork is running.

## Verifying a real spec bump locally

Each chain names the release its runtime comes from in `networks/previewnet.json`, so
roll the relevant entry in that file's `releases` table back one tag (`individuality`
for Asset Hub or People, `paseo-runtimes` for the relay, `bulletin`, `web3-storage`).
`make show-network` prints the current bindings. Then `make fresh` (the network starts
on the older runtime), download the newer one with `gh release download`, and `make
runtime-upgrade` with it — the reported `specVersion` must increase and blocks must
keep finalizing.
