# Product Preview Network

Spin up a local Polkadot ecosystem with one command. Includes relay chain, Asset Hub (with 2-second blocks via elastic scaling), People Chain, Bulletin Chain, and Web3 Storage Chain.

## Quick Start

**Install the CLI:**

```bash
npm install -g @parity/ppn      # puts `ppn` on your PATH
ppn --help
```

or run it without installing: `npx @parity/ppn --help`. Needs Node.js 22+.

**Then point it at a network.** This is the one thing to know: the package ships the engine, not the
network definitions. A network is a descriptor — `networks/<name>.json`, which states which binary
every chain runs, from which release, and what its services are — and descriptors are *your* data,
not ours. `ppn` looks for them in this order:

1. `$PPN_HOME` — set it to a directory that has a `networks/` folder;
2. otherwise, the nearest ancestor of your working directory that has one.

That directory is also where `ppn` keeps its state: `bin/` for downloaded binaries (~500 MB),
`data/` for chain state, `fork-bundle*/` for bitten networks.

```bash
export PPN_HOME=~/my-network      # holds networks/<name>.json
ppn show                          # what resolves: binaries, runtimes, releases, services
ppn start                         # fetch what is missing, generate specs, spawn
ppn kill                          # stop everything
```

`ppn fetch` downloads from GitHub releases, some of them private, so it needs auth — `gh auth login`
(HTTPS, letting it configure git credentials) or `GITHUB_TOKEN`. It fails naming the artifact and
the repository when a token cannot see one, rather than half-populating `bin/`.

See `networks/README.md` for the descriptor schema, and `ppn show --json` for the shape a tool can
read.

**Working on PPN itself** (clone this repo — the descriptors live here):

```bash
git clone https://github.com/paritytech/previewnet-engine.git
cd previewnet-engine
make start
```

`make` is a front door: every target delegates to `ppn`, and a checkout is just a workspace whose
`networks/` the walk-up above finds for you.

## Docker

> **Note**: Docker mode is currently **not supported on Apple Silicon Macs** (M1/M2/M3/M4) due to p2p networking issues under x86_64 emulation. Use native mode (`make start`) on ARM Macs instead.

Run in Docker using the Makefile (recommended):

```bash
DOCKER=1 make start             # Persistent
DOCKER=1 make start EPHEMERAL=1 # No persistence
DOCKER=1 make start CLEAN=1     # Wipe data first
DOCKER=1 make kill              # Stop container
```

Or run directly:

```bash
docker run --rm -it --platform linux/amd64 -p 10000-10030:10000-10030 -p 8545:8545 paritytech/previewnet-engine
```

### Dev Container

Use PPN as your VS Code dev container — it runs the network in the background while giving you a full dev shell (Ubuntu 24.04 + Node 20).

Create `.devcontainer/devcontainer.json` in your project:

```jsonc
{
  "name": "PPN Dev Environment",
  "image": "paritytech/previewnet-engine:latest",
  "overrideCommand": true,
  "runArgs": ["--platform=linux/amd64"],
  "forwardPorts": [10000, 10010, 10020, 10030, 8545],
  "postStartCommand": "/ppn/scripts/docker-entrypoint.sh &"
}
```

Then reopen in VS Code with **Dev Containers: Reopen in Container**. PPN starts automatically in the background. Access endpoints at `ws://localhost:10000` from both inside the container and the host.

> **Note:** Docker mode only works on Linux. macOS (Apple Silicon) is not supported — p2p networking fails under x86_64 emulation. Use native mode (`make start`) instead.

## Prerequisites

- **GitHub auth**: `gh auth login` or set `GITHUB_TOKEN`
- **Node.js 22+**: Required for tests and startup helper scripts

**Mac Users (Apple Silicon)**: Disable IPv6 due to [known bug](https://github.com/paritytech/polkadot-sdk/issues/8918):

```bash
sudo networksetup -setv6off Wi-Fi
# To re-enable: sudo networksetup -setv6automatic Wi-Fi
```

## Commands

```bash
make start              # Start network (fetches/generates if needed)
make kill               # Stop running network
make fresh              # Clean, fetch, generate, and start
make fetch              # Download binaries and runtimes
make generate           # Generate chain spec files
make test               # Run integration tests
make doctor             # Check prerequisites
make clean              # Remove bin/, data/, and design-families/
make clean-bin          # Remove only bin/ (keeps chain data)
make clean-data         # Remove only data/ (keeps binaries)
make help               # Show all commands and options
```

Every target delegates to `ppn`, which takes the same work as flags. `ppn <command> --help`
lists them, including the environment variable each one mirrors:

```bash
ppn start --fork                       # continue from a bitten bundle, not genesis
ppn start --fork --pin-products        # also import this network's DotNS products
ppn start --binary polkadot=file:/b    # run a locally built binary (PPN_BINARIES)
ppn start --runtime asset-hub=file:/w  # start from a locally built runtime (PPN_RUNTIMES)
ppn bite --upgrade asset-hub=./ah.wasm # authorize a runtime at import, for a fork with no sudo
ppn upgrade asset-hub ./ah.wasm        # upgrade a chain that is already running
```

## Network Endpoints

| Node | WebSocket | Notes |
| ------ | ----------- | --------- |
| Relay Alice | `ws://127.0.0.1:10000` | Validator |
| Relay Bob | `ws://127.0.0.1:10001` | Validator |
| Relay Charlie | `ws://127.0.0.1:10002` | Validator |
| Relay Dave | `ws://127.0.0.1:10003` | Validator |
| Relay Eve | `ws://127.0.0.1:10004` | Validator |
| Relay Ferdie | `ws://127.0.0.1:10005` | Validator |
| Asset Hub (collator 1) | `ws://127.0.0.1:10020` | **2-second blocks** (elastic scaling) |
| People Chain | `ws://127.0.0.1:10010` | Individuality pallet |
| Bulletin | `ws://127.0.0.1:10030` | Transaction storage |
| Web3 Storage | `ws://127.0.0.1:10040` | Decentralized storage parachain (ID 1600) |

## Architecture

```tree
product-preview-net/
├── Makefile                  # Entry point (make start)
├── bin/                      # Downloaded binaries and generated specs (gitignored)
├── config/
│   ├── ports.env             # Port configuration for all services
│   └── versions.env          # Shared toolchain versions (zombienet, kubo, etc.)
├── packages/                 # pnpm workspace: network-config (library), cli (the `ppn` tool), dashboard-ui
├── networks/                 # Network descriptors (see networks/README.md)
├── scripts/                  # Launchers zombienet execs + helper scripts
│   ├── run-tests.sh          # Integration test runner
│   ├── assign-cores.sh       # Elastic scaling core assignment
│   └── ipfs-swarm.sh         # IPFS swarm connection
├── zombienet-configs/
│   └── local-dev.toml        # Checked-in reference copy (auto-updated)
└── tests/                    # Zombienet integration tests
```

## Parity's deployment

Parity runs a preview network from this engine at `previewnet.substrate.dev`. That deployment —
its endpoints, server tooling and release pipeline — lives in a separate private repo; this one
is the engine it installs. To stand up your own, see
[docs/DEPLOYING-YOUR-OWN.md](docs/DEPLOYING-YOUR-OWN.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
