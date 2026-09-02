# Forking Polkadot with the fellowship runtimes

A runbook for one dedicated machine that keeps a fork of Polkadot running with a fellowship
runtime release enacted on it — currently 2.5, the release that lands Individuality on People
Polkadot and Asset Hub Polkadot. Everything here is `make` on top of what `docs/FORK.md`
explains; read that for the why.

## What the fork is

| Chain | Live para id | Runtime live (2026-09) | Runtime under test |
| --- | --- | --- | --- |
| Relay | | polkadot 2004000 | polkadot 2005000 (version bump only) |
| Asset Hub | 1000 | statemint 2004000 | pallet-revive 0.19.1, Individuality pallets |
| People | 1004 | people-polkadot 2004000 | Individuality pallets |
| Bulletin | 1010 | bulletin-polkadot 2004000 | version bump only |

Six dev validators, one collator per parachain, PPN's normal ports. All six HRMP channels
between the three parachains exist on live Polkadot and survive the bite. Polkadot has no sudo,
so the runtimes are authorized at bite time and enacted after the spawn; nothing else on the
fork can dispatch root, which is why the People-side grants (attestation allowance, invites)
do not run here and Web3 Storage is not part of it.

## One-time setup

Linux x86_64 or macOS arm64, Node 22+, pnpm, `gh` authenticated (or `GITHUB_TOKEN`), and the
usual `make doctor`. Then:

```bash
git clone https://github.com/paritytech/previewnet-engine && cd previewnet-engine
pnpm install
make fetch NETWORK=polkadot              # polkadot, polkadot-parachain, eth-rpc into bin/polkadot/
make fetch-doppelganger NETWORK=polkadot # the bite tool, into bin/polkadot/dg/
```

## Get the runtimes

2.5 is not a release yet; it is the open release PR
([polkadot-fellows/runtimes#1265](https://github.com/polkadot-fellows/runtimes/pull/1265)),
whose build workflow uploads one artifact per runtime on every push. Fetch straight from those:

```bash
make fetch-runtimes NETWORK=polkadot RUNTIMES=pr-1265
```

That resolves the PR's current head commit, takes each chain's runtime from the newest build
run that produced it, and puts `<chain>.wasm` under `bin/polkadot/runtimes/pr-1265/`. Re-run
it after the PR is pushed to and the blobs follow. Artifacts expire after 90 days, and the
directory is what you keep.

Once 2.5 is cut, the same command takes the tag and reads the release assets instead:

```bash
make fetch-runtimes NETWORK=polkadot RUNTIMES=v2.5.0
```

Either way the `upgrades` table in `networks/polkadot.json` says which repo and what each
chain's runtime is called there.

## Bite and start

```bash
make bite NETWORK=polkadot RUNTIMES=pr-1265   # ~20 min: warp-syncs all four chains, authorizes the blobs
make start FORK=1 NETWORK=polkadot            # spawns from fork-bundle-polkadot/
```

`make bite` prints, per chain, the runtime it authorized. Watch the relay finalize
(`ws://127.0.0.1:10000`) and the collators author before upgrading. Then, one chain at a time:

```bash
make runtime-upgrade NETWORK=polkadot CHAIN=asset-hub   # no WASM=: uses the blob the bite authorized
make runtime-upgrade NETWORK=polkadot CHAIN=people
```

Each submits `apply_authorized_upgrade` unsigned, waits for the relay's PVF pre-check and
go-ahead, and reports `OK <chain>: <spec> 2004000 -> 2005000`. The relay and bulletin blobs are
authorized too; enact them the same way when you want the whole release on the fork.

To authorize a single blob by hand instead of a whole tag:

```bash
make bite NETWORK=polkadot UPGRADES="asset-hub=/path/to/ah.wasm people=/path/to/people.wasm"
```

## Day to day

| You want | Run |
| --- | --- |
| Stop | `make kill` |
| Start again where it stopped, upgrades still enacted | `make start FORK=1 NETWORK=polkadot` |
| Back to the bite block, upgrades authorized but not enacted | `make start FORK=1 NETWORK=polkadot CLEAN=1` |
| Fresh state from live Polkadot, same runtimes | `make bite NETWORK=polkadot RUNTIMES=pr-1265` then start |
| The PR was pushed to, pick up its new build | `make fetch-runtimes NETWORK=polkadot RUNTIMES=pr-1265`, then a new bite |
| Different runtimes | a new bite with a different `RUNTIMES=` or `UPGRADES=` — the authorization is state inside the bundle |
| Throw the bundle away | `make clean-fork NETWORK=polkadot` |

A start decides between resuming and wiping from the spawn stamp in `data-fork-polkadot/`: if
it names the bite the bundle carries, the fork continues; if the bundle was re-bitten since,
the old data goes. A start that reuses a bundle prints what that bundle has authorized.

Node logs are under `/tmp/zombie-*/`; the bite's own logs under `fork-bundle-polkadot-logs/`.

## Services on this fork

Asset Hub's eth-rpc, Bulletin's IPFS daemon, the dashboard and the identity backend (dub)
start with the chains. dub talks to the Individuality pallets, so it only does anything once
People runs 2.5; before that its chain writer errors and can be ignored. What does not run,
because each needs root on a chain that has none: the attestation allowance and invite grants
on People, HRMP opening and core assignment (both already in state), and the DotNS genesis
steps on Asset Hub. Polkadot's Asset Hub carries no DotNS deployment, so there are no products
to import into Bulletin either.

## What is not verified yet

- A real bite of Polkadot with three parachains, end to end, on this branch. The override
  generation was run against live Polkadot (79 HRMP channels reset, six between our chains,
  every value round-trips through the live metadata); the warp sync of Bulletin from its
  published spec has not been.
- Stop and resume of a running fork. Mechanically it is only skipping the wipe, and each node
  restarts on its own database, but nobody has watched six validators come back after an hour.
- Whether dub works against the fellowship's People runtime rather than previewnet's build.

Tell the runbook what you find.
