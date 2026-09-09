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
They are bitten on demand instead, and their system-chain specs come from the parachain binary
(`builtin:asset-hub-kusama`, `builtin:people-polkadot`), so nothing has to publish one — except
Polkadot's Bulletin, which is not built in and runs from the spec Parity's own RPC nodes use.
Non-previewnet networks keep their own binaries (`bin/<network>/`, release pinned by the
descriptor's `releases` table), fork bundle (`fork-bundle-<network>/`) and data directory
(`data-fork-<network>/`).

Polkadot forks as relay + Asset Hub 1000 + People 1004 + Bulletin 1010: the three system chains
the fellowship's Individuality release (runtimes 2.5) lands on. See `docs/POLKADOT-FORK.md` for
running that fork on a dedicated machine.

## Upgrading a fork that has no sudo

The reason to fork a live network is usually to answer "does the release we are about to ship
survive contact with real state?" — which means enacting a runtime upgrade on the fork.

On previewnet that is `ppn runtime-upgrade`: sudo dispatches `authorize_upgrade`, then
`apply_authorized_upgrade` carries the blob. Kusama and Polkadot have no Sudo pallet, so that
first call can never be made on a fork of them.

So the authorization is written into state during the bite, which is the state the dispatch
would have produced:

```bash
gh release download v2.5.0 -R polkadot-fellows/runtimes -D runtimes/ -p 'asset-hub-polkadot_*' -p 'people-polkadot_*'
make bite NETWORK=polkadot UPGRADES="asset-hub=runtimes/asset-hub-polkadot_runtime-v2005000.compact.compressed.wasm people=runtimes/people-polkadot_runtime-v2005000.compact.compressed.wasm"
make start FORK=1 NETWORK=polkadot   # spawns, then enacts both upgrades once the chains author
```

`UPGRADES="<chain>=<wasm> ..."` names one blob per chain, from wherever it came — a release
asset, a PR's build artifact, a local build. It also works on `make start FORK=1 FRESH_BITE=1`,
since that bites too. Getting the blobs is `gh`'s job, not PPN's: see `docs/POLKADOT-FORK.md`
for the fellowship's release and pre-release layouts.

The apply half is a transaction, not state, so it runs after the spawn: the `enact-upgrades`
custom process submits `apply_authorized_upgrade` for every seeded chain, parachains first and
the relay last, through the same path `ppn upgrade` uses. It waits for the chains to author,
retries a chain that does not answer yet, and is a no-op on a chain already running the blob —
so a resumed fork does nothing here. All parachains are submitted at once and waited for
together, then the relay.

A parachain's code goes live on the relay's go-ahead, `validation_upgrade_delay` relay blocks
after the PVF pre-check. Live Polkadot sets that to 600 blocks, an hour, and forbids a second
upgrade of the same parachain for `validation_upgrade_cooldown` = 14400, a day — sensible for a
production relay, useless for a fork whose purpose is enacting runtimes under test. A
shared-relay bite therefore patches both into `Configuration::ActiveConfig`, to 30 and 60 relay
blocks (`shared-relay.ts`), in the same rebuild that sets `num_cores`. The pre-check and
go-ahead path is unchanged; only the timers are. So from a fresh bite, all four chains are on
the new runtime within a few minutes of the spawn. A bundle bitten before this patch still
carries the live values, which is why the service waits up to two hours per chain.
`make runtime-upgrade NETWORK=polkadot CHAIN=people` with no `WASM=` does the same for one
chain by hand.

Under the hood `ppn bite --upgrade <chain>=<wasm>` stages the blob into the bundle under
`upgrades/<chain>.wasm`, recording it in `manifest.json` as `seededUpgrades`. Add
`--upgrade-same-spec` to authorize a runtime whose `spec_version` is not bumped — what
replaying production's own runtime against a fork of production's state needs. The
authorization is state inside the snapshot, so a different blob means a new bite; a start that
reuses a bundle prints what it has authorized and refuses `--upgrade`.

What this skips is only the governance dispatch. The blob is still hashed and checked against
the authorization, and on a parachain the upgrade still goes through the relay's PVF pre-check
and go-ahead — which is one of the more valuable things a fork can tell you.

This mirrors zombie-bite's `--rc-upgrade`/`--para-upgrade`
([paritytech/zombie-bite#127](https://github.com/paritytech/zombie-bite/issues/127)) and is
meant to be deleted along with the rest of `packages/cli/src/fork/` once PPN calls zombie-bite
instead of driving doppelganger itself ([#120](https://github.com/paritytech/zombie-bite/issues/120)).

## Seeding what dotNS needs

The same problem as the runtime upgrade, and the same answer. `pallet-dotns-gateway` will not
call its contract until `DispatcherAddress` is set, and `set_dispatcher_address` takes
`RootOrWhitelist` — governance on a real network, and nothing at all on a fork of one without
Sudo. Until it is set, `reserve_name` and `register_name` fail `DispatcherAddressNotSet`: they
are the two calls that reach the contract. No origin on the fork can ever set it.

A network that has Sudo needs none of this: the `set-dispatcher-address` service reads the
same choice out of the fetched dotNS manifest and dispatches it after the spawn. A fork
without Sudo cannot, so its descriptor states the answer and the bite writes it into state:

```json
{ "key": "asset-hub", "dotnsDispatcher": "0xCC93…8a4b", "dotnsDeployer": ["0xd498…f164"] }
```

Deploying the contracts is not blocked by origin, but the wallet that signs it needs money.
`pallet-revive` is live on Polkadot Asset Hub today, so the deploy needs only a funded Ethereum
wallet, and on a fork of a real chain no wallet we hold has funds. `//Alice` does, and can send
them: she cannot sign the deploy, but the account the wallet spends from is an ordinary one she
can transfer to.

A secp256k1 wallet owns no `AccountId32` either, so `pallet-revive` spends from a fallback
account, the twenty address bytes followed by twelve `0xEE`. The bite endows that account for
every wallet `dotnsDeployer` names, so the deploy pays for itself and nobody has to remember
the transfer on the next rebite. Name more than one where the deploy uses more than one key:
dotNS signs the CREATE3 factory from a single-purpose key and the pipeline from another, which
becomes the proxy owner.

Ordering looks circular and is not. dotNS derives every address through CREATE3 from a factory
deployed at nonce 0 of a single-purpose key, so the addresses are the same on any fresh chain —
`DotnsContentResolver` is one address on both previewnet and paseo-next-v2 — and the value is
therefore known before anything is deployed. Seed it, spawn, upgrade, then deploy with the same
factory key and the contracts land where the seed points. If you would rather not predict:
bite, spawn, deploy, read the address off the chain, then re-bite with it.

The bite reports this one as a skipped inject, because the live metadata has no `DotnsGateway`
to check it against. It is written regardless; `dotnsDispatcherInject` in `validators.ts` says
why, and why the descriptor rather than the runtime is what guards it.

What this does not give you is a working personhood flow. `PopRules` reads the precompile over
`AliasAccounts`, fed by ring roots from People's `MembersNotifier`, and a fork of a chain whose
individuality pallets arrive with the upgrade carries no rings to read.

## Seeding the asset Coinage wraps

A Coinage instance wraps one asset as coins, so the asset has to exist before any instance can
be created, and the chain being bitten does not carry it. People is what forces the seed:
`CreateOrigin` for its by-`Location` instance is `EnsureNever`, so no signed origin can register
the foreign representation whatever deposit it offers, and `force_create` takes Root, which on a
fork of Polkadot is a 28-day referendum. Asset Hub would take a signed `create` against a
deposit; the bite seeds both so there is one mechanism and no step to repeat after every rebite.

The descriptor states the asset. `reserve` names the chain that keys it by id, and must be
`asset-hub`: the foreign location the other chains are keyed by hardcodes `PalletInstance` 50,
which is the `Assets` index there. `alsoOn` lists the chains holding it by location.

```json
{ "seedAsset": { "id": 50000413, "reserve": "asset-hub", "alsoOn": ["people"] } }
```

Only the registration is seeded, not any balance. Minting, the conversion pool and the Coinage
instance are ordinary signed calls that run after the spawn and compute their own state, which
is also what keeps the extrinsics the fork exists to test in the path. `seedAssetInjects` in
`overrides.ts` says what the entry holds.

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

**A fork resumes only on its own database.** zombienet restores the bundle's snapshot only into
an empty base path, so a start that finds a database already there silently runs on it instead.
What that cost us once: a genesis run and a fork sharing `./data`, so the fork came up on a
database belonging to a different chain. It looked healthy for a hundred blocks, then three of six
validators panicked with `Trie lookup error: Database missing expected key` ~110 blocks past the
bite point while the other three carried on.

Three things are in place for that. Fork mode has its own `data-fork-<network>` directory, so it
never meets genesis data. The spawn stamp (`spawn.json`, written beside the chain state) records
which bite the databases came from, and `ppn start --fork` compares it with the bundle's
`bittenAt` before deciding: a match resumes where the fork stopped, with any runtime upgrade it
enacted still in force; anything else — a re-bitten bundle, another network's data, no stamp —
is wiped and the snapshot restored. `CLEAN=1` wipes regardless, which is how a fork is put back
at its bite block.

```bash
make start FORK=1 NETWORK=polkadot          # first start: restore the snapshot, block 123
make kill && make start FORK=1 NETWORK=polkadot   # resumes at wherever it stopped
make start FORK=1 NETWORK=polkadot CLEAN=1  # back to block 123
make start FORK=1 NETWORK=polkadot FRESH_BITE=1   # new bite; the old data is wiped by the stamp rule
```

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

**Fork mode must not restate the collator flags.** `packages/network-config/src/fork-toml.ts`
builds them with `buildArgs()` from `toml-generator.ts` and appends only the flags a fork genuinely
adds (`--relay-chain-rpc-urls`, `--discover-local`, `--allow-private-ip`, `--state-pruning`,
`--no-hardware-benchmarks`). Likewise `ppn bite` reads its chain list from the network descriptor
(`networks/<name>.json`, through `packages/cli/src/fork/chains.ts` and the CLI), and the descriptor
keys its chains with the same names as the `Parachain` type, so a bundle manifest is checked
against the descriptor with no mapping table in between.

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

Nothing can be stored at all until an authorizer exists. Live Polkadot Bulletin's
`AllowedAuthorizers` is empty, because authorizers arrive by governance there, and a fork has no
genesis to seed one, so `bulletinAutoAuthorize` fails `BadSigner`. The `bulletinAuthorizer`
descriptor field names the account the bite writes in; `bulletinAuthorizerInjects` in
`validators.ts` says what the entry holds and which reference it deliberately leaves out.

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
`dotns.resolver`). `make fetch` also derives one into `bin/dotns-addresses.json` from dotns's
`deployments/expected.json` at the pinned tag, and the two must agree: the import refuses to run
when they differ, rather than picking one and importing a deployment nobody asked for. Keep `bin/`
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
- `Hrmp::*` / `Dmp::*` — keeps the four HRMP channels (relay pallets). On a *shared* relay the
  channels are kept too, but their queues are reset on both sides — see "Forking a shared relay"
  in `networks/README.md`
- `Paras::Parachains` — keeps all four parachains registered (relay pallet)

Every override value is SCALE-decoded against the live metadata of the chain being bitten before it
is written. That check is what caught a wrong `ParaScheduler::ValidatorGroups` encoding that would
otherwise have silently mis-assigned cores.

## Tests

`06-evm-genesis-balances.zndsl` asserts genesis balances and is expected to fail against a fork.
The rest should pass; the fork-specific ones worth running are `01-asset-hub-revive`,
`02-bulletin-storage`, `03-people-chain`, `04-xcm-channels` and `07-web3-storage`.
