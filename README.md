# Product Preview Network

A complete Polkadot ecosystem on your machine, in one command: a Paseo relay chain with six
validators, plus Asset Hub (2-second blocks via elastic scaling), People, Bulletin and Web3
Storage — with the Ethereum RPC, IPFS, identity backend and storage provider those chains
expect, already wired together.

```bash
git clone https://github.com/paritytech/previewnet-engine.git
cd previewnet-engine
make start
```

First run downloads ~500 MB of binaries and runtimes, then spawns. When it is up, the
dashboard at <http://127.0.0.1:8090> shows every chain, service and endpoint.

## What you would use it for

**Develop against the whole stack, not a mock.** Contracts on Asset Hub through
`eth-rpc` at `:8545`, identity on People, storage on Bulletin and Web3 Storage. Everything
speaks to everything, the way it does in production.

**Start from real state instead of genesis.** A fork continues from a live network's block,
so contracts, registrations and balances are already there.

```bash
make start FORK=1                      # from the latest published snapshot
make start FORK=1 NETWORK=paseo-next-v2
```

**Test a build before it ships.** Any binary or runtime can be repointed without editing
anything, which is what makes this useful as a release gate — run the full network against a
candidate and see what breaks.

```bash
ppn start --binary polkadot-omni-node=file:/path/to/your/build
ppn start --runtime asset-hub=file:/path/to/runtime.wasm
ppn start --binary polkadot-omni-node=paritytech/release-automation@polkadot-weekly2026w33-rc2
```

**Rehearse a runtime upgrade.** Authorize and apply one against a chain that is already
running, and watch it cross the boundary.

```bash
ppn upgrade asset-hub ./asset_hub_runtime.wasm
```

**Run a preview network for your team.** See
[docs/DEPLOYING-YOUR-OWN.md](docs/DEPLOYING-YOUR-OWN.md).

## The network

| | Endpoint | |
| --- | --- | --- |
| Relay (alice … ferdie) | `ws://127.0.0.1:10000` – `10005` | 6 validators, Paseo |
| Asset Hub | `ws://127.0.0.1:10020` | **2-second blocks**, elastic scaling |
| People | `ws://127.0.0.1:10010` | individuality |
| Bulletin | `ws://127.0.0.1:10030` | transaction storage |
| Web3 Storage | `ws://127.0.0.1:10040` | storage parachain |
| Dashboard | <http://127.0.0.1:8090> | status UI and API for all of the above |
| Ethereum RPC | `http://127.0.0.1:8545` | JSON-RPC onto Asset Hub |
| IPFS | `:8080` gateway, `:5001` API | |
| Identity backend | `http://127.0.0.1:8092` | auth, usernames, tickets; `/docs` for the API |

## Prerequisites

- **Node.js 22+**
- **GitHub auth** — `gh auth login`, or set `GITHUB_TOKEN`. Binaries and runtimes come from
  GitHub releases, some private.
- **Apple Silicon**: disable IPv6, per
  [polkadot-sdk#8918](https://github.com/paritytech/polkadot-sdk/issues/8918):
  `sudo networksetup -setv6off Wi-Fi` (undo with `-setv6automatic`).

`make doctor` checks all of this. `make help` lists every target; each one delegates to `ppn`,
so `ppn <command> --help` is the fuller reference.

## Docker

```bash
DOCKER=1 make start
```

Linux only. p2p networking fails on Apple Silicon under x86_64 emulation — use `make start`.

## Using it against your own network

The `ppn` CLI is [published separately](https://www.npmjs.com/package/@parity/ppn) and is not
tied to the networks defined here. It reads *descriptors* — `networks/<name>.json`, naming the
binary, release and runtime for every chain — so you can point it at your own instead of
cloning this repo.

```bash
npm install -g @parity/ppn
export PPN_HOME=~/my-network     # holds networks/my-net.json
ppn show                         # what resolves: binaries, runtimes, releases, services
```

See [`packages/cli/README.md`](packages/cli/README.md) for that path, and
[`networks/README.md`](networks/README.md) for the descriptor schema.

## Docs

| | |
| --- | --- |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | workspace layout, package boundaries, what a release contains |
| [FORK.md](docs/FORK.md) | how forking works, and what a bundle is |
| [DASHBOARD.md](docs/DASHBOARD.md) | the status UI, its API, and the action plane |
| [PROFILES.md](docs/PROFILES.md) | `local` vs `deployable`: funded accounts, sudo, signing keys |
| [RUNTIME-UPGRADE.md](docs/RUNTIME-UPGRADE.md) | upgrading a chain that is running |
| [DEVICE-UNIQUENESS-BACKEND.md](docs/DEVICE-UNIQUENESS-BACKEND.md) | identity backend roles and endpoints |
| [DEPLOYING-YOUR-OWN.md](docs/DEPLOYING-YOUR-OWN.md) | running this for a team |

## Security

This is development and preview-network tooling. It has **not** been audited, and the default
profile deliberately runs well-known development keys (`//Alice` and friends) as funded sudo
accounts. Do not point it at anything holding real value, and read
[PROFILES.md](docs/PROFILES.md) before running it anywhere long-lived or reachable by others.

To report a vulnerability, follow the
[Parity security policy](https://github.com/paritytech/.github/blob/main/SECURITY.md).

## Parity's deployment

Parity runs a preview network from this engine at `previewnet.substrate.dev`. That deployment,
its server tooling and its release pipeline live in a separate repo; this one is the engine it
installs.

## License

Apache-2.0. See [LICENSE](LICENSE).

Copyright 2026 Parity Technologies
