# Product Preview Network (PPN)

> [!WARNING]
> The following is a prototype, reference implementation, and proof-of-concept. This open source
> code is provided for research, experimentation, and developer education only. This code has not
> been audited, is actively experimental, and may contain bugs, vulnerabilities, or incomplete
> features. Use at your own risk.

A complete Polkadot ecosystem on your machine, in one command: a Paseo relay chain with six
validators, plus Asset Hub (2-second blocks via elastic scaling), People, Bulletin and Web3
Storage, plus the Ethereum RPC, IPFS, identity backend and storage provider those chains
expect, already wired together.

## Start it

```bash
npm install -g @parity/ppn
ppn start
```

Needs **Node.js 22+**. No clone: the CLI ships the network definitions, so `ppn start` downloads
what it is missing and spawns. The first run pulls ~500 MB of binaries and runtimes into
`~/.ppn` and later runs reuse them. `ppn kill` stops everything.

When it is up, the dashboard at <http://127.0.0.1:8090> lists every chain, service and endpoint.
`ppn show` prints the same as text, and `ppn networks` lists what else this install can run.

Two things worth doing before the first start:

- **Set a GitHub token.** Everything comes from public releases, so this is not about access:
  it is that a fetch pulls a lot of assets and GitHub throttles anonymous requests hard. Run
  `gh auth login`, or set `GITHUB_TOKEN`.
- **On Apple Silicon, disable IPv6**, per
  [polkadot-sdk#8918](https://github.com/paritytech/polkadot-sdk/issues/8918):
  `sudo networksetup -setv6off Wi-Fi` (undo with `-setv6automatic`).

## What you would use it for

**Develop against the whole stack, not a mock.** Contracts on Asset Hub through
`eth-rpc` at `:8545`, identity on People, storage on Bulletin and Web3 Storage. Everything
speaks to everything, the way it does in production.

**Start from real state instead of genesis.** A fork continues from a live network's block,
so contracts, registrations and balances are already there.

```bash
ppn start --fork                 # from the latest published snapshot
ppn start --fork paseo-next-v2   # a different network
```

**Test a build before it ships.** Any binary or runtime can be repointed without editing
anything, which is what makes this useful as a release gate. Run the full network against a
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

## Docker

```bash
DOCKER=1 make start
```

Linux only. p2p networking fails on Apple Silicon under x86_64 emulation, so use `make start`.

Every endpoint in the table above is published to the host. The dashboard is read-only here,
because a published port is reachable from your network and the sudo actions only stay open on
a loopback bind. Set `DASHBOARD_ACTIONS_TOKEN` if you want them.

## Running a network of your own

The networks above are descriptors, not code: `networks/<name>.json` naming the binary, release
and runtime for every chain. Point `ppn` at your own set and it runs those instead.

```bash
export PPN_HOME=~/my-network     # holds networks/my-net.json
ppn networks                     # what it can see
ppn show my-net                  # what that resolves to
```

`$PPN_HOME` is also where state lives: `bin/` for downloaded binaries, `data/` for chain state.
Without it, `ppn` walks up from the working directory looking for a `networks/` folder, then
falls back to `~/.ppn`. See [`networks/README.md`](networks/README.md) for the schema.

## Working on PPN itself

```bash
git clone https://github.com/paritytech/previewnet-engine.git
cd previewnet-engine
make start
```

A clone is a workspace like any other, so the walk-up above finds its `networks/`. What a clone
adds is `make`, a front door for the common things: every target delegates to `ppn`, so
`make start FORK=1 NETWORK=devnet` is `ppn start --fork devnet`. `make help` lists the targets,
`make doctor` checks your machine, and `ppn <command> --help` lists the flags.

`make test` runs the integration suite, which spawns a real network; `make test-unit` is the fast
one. [ARCHITECTURE.md](docs/ARCHITECTURE.md) is the map.

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

> [!WARNING]
> The following is a prototype, reference implementation, and proof-of-concept. This open source
> code is provided for research, experimentation, and developer education only. This code has not
> been audited, is actively experimental, and may contain bugs, vulnerabilities, or incomplete
> features. Use at your own risk.

Concretely: the default profile deliberately runs well-known development keys (`//Alice` and
friends) as funded sudo accounts, so do not point it at anything holding real value. Read
[PROFILES.md](docs/PROFILES.md) before running it anywhere long-lived or reachable by others.

Before deploying this for real use cases, you are responsible for:

- Reviewing the code yourself. We publish a reference, not a hardened production build.
- Checking that the dependencies are up to date and free of known vulnerabilities.
- Securing your own deployment environment: keys, secrets, network configuration.
- Tracking the latest tagged release for security fixes. Older releases are not backported.

To report a vulnerability, follow the
[Parity security policy](https://github.com/paritytech/.github/blob/main/SECURITY.md).

## Parity's deployment

Parity runs a preview network from this engine at `previewnet.substrate.dev`. That deployment,
its server tooling and its release pipeline live in a separate repo; this one is the engine it
installs.

## License

Apache-2.0. See [LICENSE](LICENSE).

Copyright 2026 Parity Technologies
