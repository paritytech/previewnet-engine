# Fork mode

Start a local network carrying **a live network's state**, continuing from a real block
instead of resetting to genesis. Contracts, DotNS registrations, proof-of-personhood state and
balances are all present.

```bash
make start FORK=1                  # download the latest published previewnet bundle and spawn
make start FORK=1 FRESH_BITE=1     # bite production right now, then spawn
make start FORK=1 NETWORK=devnet   # fork a different network (see networks/README.md)
make bite                          # just produce a bundle, do not start
make bite NETWORK=paseo-next-v2    # bundle of another network
make clean-fork                    # remove the bundle
make start                         # unchanged: genesis (previewnet only)
```

## Which networks

Previewnet is the default and the only network that can also start from genesis; every other
network is fork-only. What a network is — its chains, para ids, RPC endpoints, spec sources,
DotNS resolver — lives in `networks/<name>.json` (schema and current status:
`networks/README.md`). The bundle's `manifest.json` records which network it was bitten from,
and everything downstream (config generation, validation, service selection) follows the
bundle, not the environment.

Networks without sudo (Kusama, Polkadot) are not pre-bitten by CI — their bundles would be
stale by the time anyone used one, and biting a public chain nightly is load nobody asked for.
They are bitten on demand instead, and their Asset Hub spec comes from the parachain binary
(`builtin:asset-hub-kusama`), so nothing has to publish one. Non-previewnet networks keep their
own binaries (`bin/<network>/`, release pinned by the descriptor's `releases` table), fork
bundle (`fork-bundle-<network>/`) and data directory (`data-fork-<network>/`).

## Upgrading a fork that has no sudo

The reason to fork a live network is usually to answer "does the release we are about to ship
survive contact with real state?" — which means enacting a runtime upgrade on the fork.

On previewnet that is `ppn runtime-upgrade`: sudo dispatches `authorize_upgrade`, then
`apply_authorized_upgrade` carries the blob. Kusama and Polkadot have no Sudo pallet, so that
first call can never be made on a fork of them.

So the authorization is written into state during the bite, which is the state the dispatch
would have produced:

```bash
PPN_NETWORK=kusama ppn bite --upgrade asset-hub=./ah-kusama-runtime.wasm
PPN_NETWORK=kusama ppn start --fork
PPN_NETWORK=kusama ppn runtime-upgrade asset-hub    # submits the apply half, unsigned
```

`--upgrade` takes one `<chain>=<wasm>` per chain and stages the blob into the bundle under
`upgrades/<chain>.wasm`, recording it in `manifest.json` as `seededUpgrades`. Add
`--upgrade-same-spec` to authorize a runtime whose `spec_version` is not bumped — what
replaying production's own runtime against a fork of production's state needs.

What this skips is only the governance dispatch. The blob is still hashed and checked against
the authorization, and on a parachain the upgrade still goes through the relay's PVF pre-check
and go-ahead — which is one of the more valuable things a fork can tell you.

This mirrors zombie-bite's `--rc-upgrade`/`--para-upgrade`
([paritytech/zombie-bite#127](https://github.com/paritytech/zombie-bite/issues/127)) and is
meant to be deleted along with the rest of `packages/cli/src/fork/` once PPN calls zombie-bite
instead of driving doppelganger itself ([#120](https://github.com/paritytech/zombie-bite/issues/120)).

## What you get, and what you don't

The fork resumes at the bite block and diverges from there — it is a real fork, not a mirror. It
runs six relay validators and one collator per parachain, on PPN's normal ports, with Asset Hub's
2-second elastic scaling intact.

**There is no block history before the bite point.** Warp sync delivers finality proofs plus the
state at the target, not the chain. Block *numbers* continue from the bite block, but querying an
earlier block will fail. If you need history, fork mode is the wrong tool.

State is as of the bite. A published bundle is rebuilt nightly, so it can be up to a day old; use
`FRESH_BITE=1` for current state.

## How it works

Two steps, and they use different binaries.

**Bite** (`ppn bite`, implemented in `packages/cli/src/fork/`) needs the `doppelganger` binaries. It warp-syncs each chain from production
and, as the state is imported, rewrites the on-chain authority set to the well-known dev keys —
which is what makes the fork drivable, since production's validators use generated keys we do not
hold. Parachains are bitten first; the relay is then bitten with their heads injected over
`Paras::Heads`, so the relay is made to agree with wherever the parachains actually landed.

**Spawn** uses the **regular** `polkadot` and `polkadot-omni-node`. Nothing about restoring a bundle
needs doppelganger, which is why `FORK=1` works with no extra binaries.

A bundle is:

```
fork-bundle/
  manifest.json          what was bitten, when, from which production version
  specs/<chain>.json     production's specs with bootNodes stripped
  overrides/*.json       the storage overrides doppelganger applies
  snapshots/*.tgz        the bitten databases (~70 MB; ~107 MB for the bundle)
  fork.toml              generated zombienet config
```

`fork.toml` is generated per machine, not shipped: it holds absolute paths. It is regenerated
on every `make start FORK=1` by `packages/network-config/src/fork-toml.ts`, which shares its ports, para ids
and per-chain flags with the genesis generator — see below.

## Things that will bite you if you change this

Each of these was a real failure during development; none of them announces itself clearly.

**A fork cannot resume — every start wipes `DATA_DIR`.** zombienet restores the bundle's snapshot
only into an empty base path, so a start that finds a database already there silently runs on it
instead. What that cost us once: a genesis run and a fork sharing `./data`, so the fork came up on a
database belonging to a different chain. It looked healthy for a hundred blocks, then three of six
validators panicked with `Trie lookup error: Database missing expected key` ~110 blocks past the
bite point while the other three carried on.

Fork mode now gets its own `data-fork` directory (`DATA_DIR` is suffixed under `FORK=1`), so that
particular collision can no longer happen. `make start FORK=1` still wipes, because resuming a
fork's *own* database is untested and `--state-pruning=256` leaves little margin for it; genesis
mode resumes normally.

**`chain` is mandatory alongside `chain_spec_path`.** Without it zombienet applies one spec to every
parachain, last one wins, and all collators silently run the same chain. The symptom is parachains
converging on identical block numbers — not an error.

**Spawn specs must have `bootNodes` cleared.** Otherwise the forked nodes rejoin previewnet and
follow its longer chain. This looks like success on every metric — the chain is at a plausible
height and finalizing — while not being a fork at all. The bite genuinely needs the bootnodes, so
`ppn bite` keeps the as-published specs in its work directory and puts only the
stripped copies in the bundle.

**Collators must run via `scripts/omni-node.sh`, not the binary directly.** A collator runs a
relay-chain node in the same process, configured by the args after `--`, which zombienet owns and
which carry no `--network-backend`. The relay side therefore takes the default — litep2p — and its
websocket listener dies a few seconds in:

```
litep2p::websocket: [Relaychain] Websocket listener terminated error=Kind(InvalidInput)
sc_service::task_manager: [Relaychain] Essential task `network-worker` failed.
```

`network-worker` is essential, so the collator exits, typically just after authoring its first
block. This is not fork-specific — it takes down three or four collators on a plain `make start`
too. The wrapper appends `--network-backend=libp2p` to the relay-chain args, which is what PPN
already does for every relay validator; the relay side of a collator was the one relay node still
getting the default. Measured on macOS arm64 with `1.24.0-2f2eeb2b81d`: default backend → 3–4
collators dead per start; libp2p → none.

**Fork mode must not restate the collator flags.** It did once, as a hand-copied table, and
drifted immediately: the copy dropped `--listen-addr=…/webrtc-direct`, which pairs with
`--experimental-webrtc`. `packages/network-config/src/fork-toml.ts` now imports `CHAIN_ARGS`, `PORTS`, `PARA_IDS`
and `P2P_PORTS` from `toml-generator.ts` and appends only the flags a fork genuinely adds
(`--relay-chain-rpc-urls`, `--discover-local`, `--allow-private-ip`, `--state-pruning`,
`--no-hardware-benchmarks`). Likewise `ppn bite` reads its chain list from the
network descriptor (`networks/<name>.json`, through `packages/cli/src/fork/chains.ts` and
the CLI), and the descriptor keys its chains with the same names as the `Parachain`
type, so a bundle manifest is checked against the descriptor with no mapping table in between.

**Relay nodes must be named `alice`…`eve`, collators `Collator-<paraId>`.** zombienet maps the
well-known names to the well-known dev keys, which is exactly the authority set the bite installs.
PPN's genesis-mode names (`alice-paseo-validator`, …) get generated keys instead, and the network
cannot author. This is why fork mode has its own config rather than overlaying `local-dev.toml`.

**Every relay node needs `ZOMBIE_DISPUTE_CANDIDATE_LIFETIME_AFTER_FINALIZATION=1`.** A warp-synced
database has no ancestry before the bite block, so the dispute scrape fails,
`DetermineUndisputedChain` errors, and relay chain-selection pins the finality target to the bite
block forever. Blocks are produced but nothing finalizes. zombienet does not forward the parent
environment, so it must be declared per node.

**Collators must use `--relay-chain-rpc-urls`.** A warp-synced relay cannot serve history to an
embedded relay node, which then sits at `#0` at 0.0 bps indefinitely.

**A parachain cannot be hosted by fewer validators than availability erasure coding requires.** With
too few, `Failed to submit collation err=Erasure(NotEnoughValidators)`, and the collator halts once
its unincluded segment fills — exactly three blocks in.

## Bulletin content

A fork carries chain state but not bulletin's stored bytes: those live in block bodies, and the
bite is a warp sync. So a forked bulletin *lists* content it does not hold, and anything published
before the bite is unreachable. Content uploaded after the fork works normally.

Copying all of it is not an option — measured on paseo-next-v2, bulletin holds **35 GiB** across
33k entries, and the chain's own `size` field understates it badly (it records only the root block
for dag-pb entries, which are 12% of entries but two thirds of the bytes).

`scripts/pin-bulletin-products.sh` copies only what DotNS points at:

```
Revive::AccountInfoOf[DotnsContentResolver]  -> the contract's trie id
its child trie                              -> every storage word it owns
words beginning e3 01 01                    -> ENS EIP-1577 contenthash records
intersect with bulletin's own entries       -> the ones still within retention
```

On paseo-next-v2 that is **799 products, 3.0 GiB** — 8.6% of the total, about six minutes at the
9.3 MiB/s a gateway sustains at 8-way concurrency. Most registered contenthashes (4,603 of 5,525)
point at content already pruned, and every superseded publish is skipped. previewnet's entire
content set is under 1 GiB, so there it barely matters.

Each product is a single UnixFS file whose bytes are a CAR archive of the whole site, so fetching
the root is the whole product — there are no child objects to chase.

The resolver address comes from the network descriptor (`networks/<name>.json`,
`dotns.resolver`). `make fetch` also derives one into `bin/dotns-addresses.json` from the dotns
deployments manifest at the pinned tag, and the two must agree: the import refuses to run when
they differ, rather than picking one and importing a deployment nobody asked for. Keep `bin/`
current either way: an outdated one points at a *previous* deployment's resolver, which is still
a live contract holding zero contenthash records, so the step reports "0 products" and imports
nothing, with no error. `make fetch` is the fix. Measured on previewnet with a current `bin/`:
55 records -> 37 products, 194 MiB, about 20 seconds.

A DotNS deployment has one resolver wherever it is deployed: previewnet and paseo-next-v2 share
an address, because the factory deployer key pins the CREATE3 addresses. devnet is a separate
deployment and has its own. That is why the address belongs in the descriptor, per network.

## Whose products get imported

Only a network that asks. `dotns.pinProducts` says so, and previewnet is the only one that sets
it: importing 659 products over half an hour from an external gateway is not something to do to
every fork by default, and a fork spawned to test a runtime never looks at them.

```bash
ppn start --fork --pin-products      # import them anyway (PRODUCT_SYNC=1)
ppn start --fork --no-pin-products   # skip them on a network that does ask (PRODUCT_SYNC=0)
```

The flag decides the run, the descriptor decides the default. A network that does not import
still records its `resolver` and `gateway`, so asking for the content is all it takes.

Two things worth knowing if you touch this:

- **Which CIDs are needed is decided from the fork's own state**, so the step never guesses. Only
  the bytes come from the source, over HTTP: kubo cannot bitswap with the source network, so the
  import is `ipfs dag import` of a CAR rather than `ipfs pin add`.
- **`--allow-big-block` is required.** A product's CAR contains blocks over kubo's 1 MiB bitswap
  limit and the import is refused outright without it. The imported root is byte-identical either
  way (verified: 7,345,851 bytes in, 7,345,851 out); the limit only affects bitswap exchange, and
  dot.li reads these over the HTTP gateway.

This serves dot.li's `rpc-gateway` backend. Its default is smoldot, which fetches content with
`bitswap_v1_get` **against the Bulletin Chain** — that path needs the bytes inside the bulletin
node itself, which only a full bulletin database would give.

## Deliberately not overridden

`packages/cli/src/fork/validators.ts` leaves three things alone that zombie-bite's defaults would replace,
because production's values are the ones we want:

- `Configuration::ActiveConfig` — the **relay's** host configuration for every parachain
  (`polkadot_runtime_parachains::configuration`; parachains do not have this pallet). Its
  `scheduler_params` holds `numCores`, of which the relay hands Asset Hub three — that is what
  gives Asset Hub its 2-second blocks. Its `executor_params` holds
  `EnabledHostFunction(EccRfc163)`, without which the relay's validators reject People's PVFs.
  One key, two things depending on it, which is why overriding it wholesale costs both.
- `Hrmp::*` / `Dmp::*` — keeps the four HRMP channels (relay pallets)
- `Paras::Parachains` — keeps all four parachains registered (relay pallet)

Every override value is SCALE-decoded against the live metadata of the chain being bitten before it
is written. That check is what caught a wrong `ParaScheduler::ValidatorGroups` encoding that would
otherwise have silently mis-assigned cores.

## Tests

`06-evm-genesis-balances.zndsl` asserts genesis balances and is expected to fail against a fork.
The rest should pass; the fork-specific ones worth running are `01-asset-hub-revive`,
`02-bulletin-storage`, `03-people-chain`, `04-xcm-channels` and `07-web3-storage`.
