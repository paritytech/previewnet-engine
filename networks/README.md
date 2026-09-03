# Network descriptors

One JSON file per network PPN can run. **Only previewnet is spawnable from genesis**
(`"genesis": true`); every other network is fork-only — brought up from a bite of the
live network (`make start FORK=1 NETWORK=<name>`, see `docs/FORK.md`).

A descriptor is self-contained: it states which binary every chain runs, which release
that binary comes from, which runtime the chain starts from (genesis networks), what its
services and tools are, and which build can bite it. Nothing is implied and nothing
resolves elsewhere — `config/versions.env` holds only shared tooling (zombienet, kubo,
postgres, identity, design families) that is the same whichever network is running.

```bash
make show-network                       # what previewnet is made of, resolved
make show-network NETWORK=devnet        # …or any other network
```

The descriptor is consumed by `packages/network-config/src/networks.ts` (loader + validation), which
feeds both TOML generators (`toml-generator.ts` for previewnet's genesis, `fork-toml.ts`
for every fork), `packages/cli/src/fork/chains.ts`, `ppn fetch` (`make fetch`),
`ppn generate`, `ppn bite` (`make bite`) and the Makefile. Select a network with `NETWORK=<name>` on make,
or `PPN_NETWORK=<name>` in the environment of the scripts.

## Schema

| Field | Meaning |
| --- | --- |
| `name` | Network id; must match the filename. |
| `genesis` | May be spawned from genesis. Previewnet only — the genesis machinery (runtimes, chain-spec presets, DotNS genesis) is previewnet's. |
| `sudo` | The live network has sudo. Networks without it (Kusama, Polkadot) cannot be upgraded after the fork, so a runtime under test must be injected at bite time — which is why they cannot be pre-bitten by CI. |
| `bite.prebaked` | CI bites this network on release and publishes `fork-bundle-<name>.tar.gz` (`fork-bundle-previewnet.tar.gz` for previewnet). Only meaningful for sudo networks with a real `bite.source`. |
| `bite.source` | Base URL of the live network to bite. Per-chain `rpc` values that are paths resolve against it. When every `rpc` is an absolute URL (public networks like devnet), it serves as provenance (`manifest.source`) and as the origin `pin-bulletin-products` fetches product bytes from (`<source>/ipfs/<cid>`), so point it at the network's IPFS gateway. |
| `releases` | The version table: `{ "<your-name>": { "repo": "...", "tag": "..." } }`. Every binary and runtime reference names one of these, so a version is written once per network. Names are yours — there are no reserved or special-cased names, and nothing resolves against `config/versions.env`. An unused entry is an error. |
| `relay.binary`, `parachains[].binary` | **Required, explicit**: `{ "name": "...", "release": "..." }` — which binary this chain runs (`polkadot`, `polkadot-omni-node`, `polkadot-parachain`, …) and which release it comes from. Both TOML generators (fork *and* previewnet's genesis) follow these bindings; `fetch.sh` downloads exactly this set (`polkadot` brings its two PVF workers along). Add `"archive": "name-{tag}-{triple}.tar.gz"` when the binary ships inside a tarball. One binary name cannot be bound to two releases within a network — the files would collide in bin/. |
| `relay.runtime`, `parachains[].runtime` | `{ "asset": "...", "release": "...", "file": "..." }` — the runtime WASM this chain starts from, the release it comes from, and the local filename. **Required on a genesis network** (previewnet) and absent on fork-only ones, which restore every runtime from state. `ppn generate` builds each spec from the `file` named here, so download and build cannot drift. |
| `relay.genesisSpec`, `parachains[].genesisSpec` | `{ "chainId", "name", "preset", "file" }` — the chain spec a genesis network builds for this chain. `ppn generate` passes them to `chain-spec-builder` (`-i`, `-n`, `named-preset`, output filename) and the genesis TOML generator points zombienet at `chainId` + `file`. **Required on a genesis network**, absent on fork-only ones (a fork uses the specs inside its bundle). |
| `genesisConfig` | `{ "chainType", "properties", "validatorNameSuffix", "networkSuffix" }` — settings every chain in a genesis network shares: `chain-spec-builder -t`, `--properties`, and the relay node-name suffix zombienet derives validator keys from (`alice-paseo-validator`). Required on a genesis network. `networkSuffix` is optional: the namespace product contexts derive in, written into the genesis of the chains whose runtime carries the pallet holding it (People and Asset Hub). At most 16 bytes. Leave it out to keep whatever the runtime presets ship — a fork needs nothing here, since its runtime already has the value set. |
| *(para ids)* | `parachains[].paraId` is the single source: the genesis TOML, the fork TOML, `ppn generate` and `assign-cores.sh` all read it from here. `config/ports.env` deliberately holds no para ids — those belong to the network, not the machine. |
| `relay.extraArgs`, `parachains[].extraArgs` | Extra node flags for that chain, appended to the shared per-key flag table (existing flags win over duplicates). |
| `services` | Per-service switches and binaries: `false` disables a service; `{ "binary": { … } }` says what it runs. `eth-rpc` must match the revive pallet in the network's Asset Hub runtime, which is exactly why it is pinned per network rather than shared. |
| `tools` | Local tools this network needs that are neither a chain nor a service — previewnet's `chain-spec-builder`, for instance, which only a genesis network uses. |
| `bite.doppelganger` | `{repo, tag}` of the bite tool. Per network, because the build has to be able to execute the runtimes of the network being bitten. |
| *(bin layout)* | Only node binaries are network-versioned: previewnet's live in `bin/`, every other network's in `bin/<name>/` (plus `dg/` for bites). Shared tooling with no per-network dimension — zombie-cli, ipfs, postgres, identity, design families — lives in plain `bin/` and is pinned in `config/versions.env`. Collators run through `scripts/omni-node.sh` regardless of binary; it carries the libp2p fix and picks binary/dir from `PPN_COLLATOR_BINARY`/`PPN_BIN_DIR`. |
| `relay.chain` | Built-in chain name doppelganger runs with (`ZOMBIE_CHAIN`), e.g. `paseo`, `kusama`. |
| `relay.spec` | Basename of the relay spec inside the bundle (`specs/<spec>.json`). |
| `relay.rpc`, `parachains[].rpc` | RPC endpoint: an absolute `ws(s)://`/`http(s)://` URL, or a path resolved against `bite.source`. |
| `rpcAlternates` | Informational: other public providers for the same chain, for when the primary is re-homed. Not consumed by tooling (yet). |
| `relay.specSource`, `parachains[].specSource` | Explicit location of the chain spec the bite warp-syncs from (it must carry the live network's bootnodes): an absolute URL, a path resolved against `bite.source` (previewnet uses `chainspecs/<spec>-local.json`, so biting a different instance follows the base-URL override), or `"builtin"` (generated with `build-spec --chain <relay.chain> --raw`, relay only). |
| `relay.validators` | Number of dev-key validators the fork runs with (max 6: alice…ferdie). |
| `parachains[].key` | One of `asset-hub`, `people`, `bulletin`, `web3-storage` — the keys PPN's port table and per-chain flags are defined for. |
| `parachains[].paraId` | The network's real para id. Previewnet/paseo-next-v2 use the 1500 band; devnet and real networks the 1000 band. |
| `parachains[].spec` | Basename of the parachain spec inside the bundle. |
| `services` | Optional `{ "<process>": false }` map to disable custom processes that would otherwise run for the present parachains (e.g. eth-rpc for asset-hub, ipfs for bulletin). |
| `dotns.resolver` | DotnsContentResolver address for `pin-bulletin-products` — per network, since every DotNS deployment has its own. Omitted → read from `bin/dotns-addresses.json` (previewnet's release artifact); still absent → the import is skipped. |
| `dotns.gateway` | IPFS gateway the product bytes are fetched from. Omitted → `bite.source`, which is right where the source network's front door is also its gateway (previewnet, devnet) and wrong where it is not: paseo-next-v2's `https://dot.li` is a single-page app that returns its own HTML for every path, 200 included. |

`_todo` fields (at any level) are blocking stubs: human notes about what still has
to be confirmed. The loader ignores them; `make bite` refuses to bite a network
whose descriptor still carries any. `_note` fields are informational only — context
worth keeping next to a value — and never block anything.

## Where the node binaries come from

Every descriptor's `polkadot-sdk` release points at **`paritytech/release-automation@latest`**,
not at `paritytech/polkadot-sdk`. That is deliberate, and it is the reason webrtc works.

`CHAIN_ARGS` passes `--experimental-webrtc` to asset-hub, bulletin and web3-storage. That flag
comes from polkadot-sdk PR #12315, merged to master on 2026-06-23. The `stable2606` line was
branched off master on 2026-06-02 — three weeks earlier — so the flag is in **no** stable
release, including `stable2606-1`, and stable patch releases only take backports. An
omni-node from a stable tag exits immediately with `unexpected argument
'--experimental-webrtc'`, which kills three of the four collators.

`release-automation` cuts a weekly branch from master and publishes the full set of binaries —
`polkadot`, `polkadot-omni-node`, both PVF workers, `chain-spec-builder`, `eth-rpc` — for
linux-x86_64 and macos-arm64, under exactly the asset names `ppn fetch` already expects. So
this is a pins-only change; no fetch code knows the difference.

One thing to know:

- **`latest` is a moving tag, and this channel has published partial re-builds** — 1, 4 and 11
  assets against a normal 47. `ppn fetch` now fails, loudly and by name, when the descriptor
  asks for something the release does not have, instead of leaving `bin/` half-populated. If
  that fires, pin a complete tag here (e.g. `polkadot-weekly2026w33-rc2`) rather than
  `latest`.

Once the flag reaches a stable release — the next line, `stable2609`, will carry it since it
is already on master — this can go back to `paritytech/polkadot-sdk` and a fixed tag.

## Forking a shared relay

`bite.sharedRelay` marks a network whose live relay carries parachains we do not run — Paseo,
Kusama, Polkadot. Previewnet's relay is ours end to end, so it inherits state that is already
correct and the bite leaves it alone. A shared relay inherits three things that are wrong for six
dev validators, and all three are silent:

| what | inherited state | why it breaks | what the bite writes |
| --- | --- | --- | --- |
| cores | ~18 registered parachains, so ~18 cores | the runtime splits 6 validators into 18 groups; 12 come out empty and ours sit on cores no group is assigned to, so nothing backs their blocks | ours on cores 0-N from `ParaScheduler::CoreDescriptors`, groups to match, `num_cores` cut to N (one byte of `Configuration::ActiveConfig`, so `EnabledHostFunction(EccRfc163)` survives) |
| upgrade timing | `validation_upgrade_delay` 600 and `validation_upgrade_cooldown` 14400 on Polkadot | a runtime under test goes live an hour after its apply, and the same parachain cannot be upgraded again for a day — the fork exists to do exactly that, several times | both patched in the same `ActiveConfig` rebuild, to 30 and 60 relay blocks (`FORK_VALIDATION_UPGRADE_DELAY`/`_COOLDOWN` in `shared-relay.ts`); the pre-check and go-ahead path is unchanged, only the timers |
| HRMP / DMP | channel heads from a relay snapshot newer than the parachain ones | messages delivered in that window are pruned from the relay but counted in its `mqc_head`, so cumulus panics `HRMP head mismatch` and builds no block at all | every channel touching one of our paras (read off the relay's own indexes) keeps its `Hrmp::HrmpChannels` entry with `mqc_head` cleared and counters zeroed, its `HrmpChannelContents` emptied and the recipient's `HrmpChannelDigests` emptied; `Dmp::DownwardMessageQueueHeads` zeroed per para; the parachain's own `ParachainSystem::LastDmqMqcHead` zeroed and `LastHrmpMqcHeads` emptied to match — both halves or neither. Channels stay open, which matters on a relay without sudo where nothing could reopen them |
| stored-data proofs | Bulletin's `RetentionPeriod` of 201,600 against a chain at ~1.5M | `pallet-transaction-storage` asserts a periodic proof of historical data a bite does not carry, so no block can be built | `RetentionPeriod` pushed past any height we fork, applied only to a runtime that has the pallet |

Two things that are *not* part of this, both established by trying them: `Paras::Parachains` is
inert on an agile-coretime relay (the runtime reconciles it back from `ParaLifecycles`), and a
parachain's lifecycle being `Parathread` rather than `Parachain` does not affect backing.

Separately, a fork's relay validators need `--discover-local` and `--allow-private-ip` — not just
its collators. A validator will not put a loopback address into the DHT without them, so the
collator resolves nobody, and since the collation peer set has `out_peers: 0` and validators never
dial collators, a resolved address is the only way that substream ever opens.

## Current status

| Network | Genesis | Fork | Pre-bitten by CI | State |
| --- | --- | --- | --- | --- |
| previewnet | yes | yes | yes | working |
| paseo-next-v2 | no | yes | yes | working — forks, and `fork-e2e` spawns it on every push. Getting there needed three overrides a shared relay turns out to require: cores remapped onto the ones six dev validators staff, inherited HRMP/DMP queues reset on both sides, and the transaction-storage proof schedule pushed out. See "Forking a shared relay" |
| devnet | no | yes | once its `_todo` clears | sources filled from docs.polkadotcommunity.foundation; one open question — whether doppelganger can warp-sync Asset Hub from the published smol (stateRootHash) spec. Verify with `make bite NETWORK=devnet`, then drop the `_todo`. It shares a relay with other parachains, so it needs `bite.sharedRelay` too — already set |
| kusama | no | on-the-fly only | no (no sudo) | wired. Asset Hub's spec comes from the parachain binary (`builtin:asset-hub-kusama`). A runtime under test is authorized at bite time — `ppn bite --upgrade asset-hub=<wasm>` — since nothing can dispatch root after the fork; see docs/FORK.md. Upstream equivalent: [zombie-bite#127](https://github.com/paritytech/zombie-bite/issues/127) |
| polkadot | no | on-the-fly only | no (no sudo) | relay + Asset Hub 1000 + People 1004 + Bulletin 1010, all live at runtimes 2.4; the fellowship's 2.5 (Individuality on People and Asset Hub) is what a fork of it is for — `make bite NETWORK=polkadot UPGRADES="asset-hub=<wasm> people=<wasm>"` authorizes the blobs at import. All six HRMP channels between the three exist live and survive the bite (reset, not cleared). ~50 registered parachains makes the core remapping above load-bearing rather than a nicety. Runbook: docs/POLKADOT-FORK.md |
