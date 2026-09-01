# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commit conventions

Do not add `Co-Authored-By: Claude` (or any other AI attribution) lines to commit messages.

## Project Overview

Product Preview Network (PPN) is infrastructure tooling for spinning up a local Polkadot ecosystem with Zombienet. It provides pre-built binaries, WASM runtimes, and configuration for:

- **Relay Chain**: Paseo (6 validators: alice, bob, charlie, dave, eve, ferdie)
- **Parachains**:
  - Asset Hub (ID 1500) - port 10020 - **2-second blocks** via elastic scaling
  - People/Individuality Chain (ID 1502) - port 10010
  - Bulletin Chain (ID 1501) - port 10030
  - Web3 Storage Chain (ID 1600) - port 10040

## Commands

### Quick Start

```bash
make start   # Downloads, generates, and starts (all-in-one)
```

### All Commands

```bash
make start              # Start network (fetches/generates if needed)
make fresh              # Clean, fetch, generate, and start
make fetch              # Download binaries and runtimes
make generate           # Generate chain spec files
make generate-toml      # Regenerate local-dev.toml from @parity/ppn-network-config
make show-network       # What a network is made of (NETWORK=<name>)
make kill               # Stop running network
make pin-design-families # Pin design families to IPFS (also runs automatically via zombienet)
make test               # Run integration tests (spawns a network)
make test-unit          # Run workspace unit tests (config generators, fork/bite)
make bite               # Bite production previewnet into a fork bundle (no start)
make runtime-upgrade    # Upgrade a running chain: CHAIN=<chain> WASM=<path> (see docs/RUNTIME-UPGRADE.md)
make doctor             # Check prerequisites
make clean              # Remove bin/, data/, and design-families/
make clean-bin          # Remove only bin/ (keeps chain data)
make clean-data         # Remove only data/ (keeps binaries)
make clean-chainspecs   # Remove generated chain specs + data/ (keeps binaries)
make clean-design-families # Remove only design-families/
make help               # Show help with examples
```

### Options

Options can be combined with any command:

```bash
DOCKER=1 make start           # Run in Docker (linux/amd64)
make start EPHEMERAL=1        # No persistence (data lost on stop)
make start CLEAN=1            # Wipe chain data before starting
make start REGENERATE=1       # Regenerate chain specs before starting
DATA_DIR=<path> make start    # Custom data directory (default: ./data)
make start FORK=1             # Start from production previewnet state, not genesis
make start FORK=1 NETWORK=devnet  # Fork a different network (networks/*.json)
make start FORK=1 FRESH_BITE=1  # Fork, biting production now instead of using a bundle
```

Fork mode continues from a real block rather than resetting to genesis, so contracts,
registrations and balances are already present. See `docs/FORK.md`.

Only previewnet can start from genesis. Every other network (paseo-next-v2, devnet,
kusama/polkadot stubs) is fork-only, defined by a descriptor in `networks/<name>.json` —
see `networks/README.md` for the schema and per-network status.

A descriptor states, explicitly, which binary each chain runs and from which release,
which runtime it starts from (genesis networks), its services, tools and bite tool.
`config/versions.env` holds only the shared toolchain (zombienet, kubo, postgres,
the backend, design families) that has no per-network dimension. `make show-network`
prints what resolves.

### Prerequisites

- **GitHub auth**: Required for fetch - `gh auth login` or set `GITHUB_TOKEN`
- **Node.js 22+**: Required for tests and startup helper scripts

**Mac Users (Apple Silicon)**: Disable IPv6 due to [known bug](https://github.com/paritytech/polkadot-sdk/issues/8918):

```bash
sudo networksetup -setv6off Wi-Fi
```

## Architecture

```tree
Dockerfile                    # Docker image for running PPN
Makefile                      # make targets wrap the `ppn` CLI (bin/ppn.mjs)
bin/ppn.mjs                   # CLI launcher; the rest of bin/ is downloaded (gitignored)

packages/                     # pnpm workspace (boundaries enforced by dependency-cruiser)
├── network-config/           # @parity/ppn-network-config: descriptor loading, ports, config generators
│   └── src/                  # toml-generator, fork-toml, networks loader, dub env, nginx routes
├── cli/                      # @parity/ppn: the `ppn` CLI
│   ├── src/commands/         # One file per command: fetch, generate, start, bite, fork, upgrade, dist, ...
│   ├── src/fork/             # Bite logic: chains, SCALE codec, overrides, manifest, verify
│   ├── src/upgrade/          # Live runtime upgrade of a running chain (make runtime-upgrade)
│   └── tests/                # Unit tests, incl. the publish-surface guard for both tarballs
└── dashboard-ui/             # Svelte dashboard, vite-built into packages/cli/web/ (never committed)

networks/                     # Network descriptors (see networks/README.md)
├── previewnet.json           # The default; the only genesis-spawnable network
├── paseo-next-v2.json        # Fork-only: paseo relay, previewnet para-id band
├── devnet.json               # Fork-only: paseo relay, system-chain para ids (1000+)
├── kusama.json               # Stub: fork-only, no sudo, on-the-fly bite
└── polkadot.json             # Stub: fork-only, no sudo, on-the-fly bite

config/
├── ports.env                 # Port configuration for all services
└── versions.env              # Shared toolchain versions (zombienet, kubo, postgres, design families)

docs/
├── ARCHITECTURE.md           # Workspace layout: packages, boundaries, publish surface
├── DASHBOARD.md              # The dashboard: one live status UI for every environment
├── DEPLOYING-YOUR-OWN.md     # Run your own deployment
├── DEVICE-UNIQUENESS-BACKEND.md # dub roles, env, endpoints
├── FORK.md                   # Fork mode: spawn from production state
├── PROFILES.md               # dev/prod profiles: funded accounts, sudo, signing keys
└── RUNTIME-UPGRADE.md        # Upgrade the runtime of a running chain

bin/                          # Output directory (gitignored except ppn.mjs)
├── polkadot                  # Relay chain binary (+ execute/prepare PVF workers)
├── polkadot-omni-node        # Universal parachain collator binary
├── chain-spec-builder        # Chain spec generation tool
├── eth-rpc                   # Ethereum RPC compatibility binary
├── ipfs                      # IPFS binary (Kubo)
├── *.wasm                    # Runtime WASM blobs
└── *.json                    # Generated chain specs

design-families/              # Proof of Ink design families (fetched, gitignored)

scripts/                      # Shell launchers zombienet execs; the logic lives in the CLI
├── lib/workspace.sh          # Workspace resolution, sourced by every launcher
├── omni-node.sh              # Collator wrapper: forces libp2p on the relay-chain side
├── assign-cores.sh           # Elastic scaling core assignment
├── eth-rpc.sh                # eth-rpc launcher
├── ipfs-daemon.sh            # IPFS daemon launcher
├── ipfs-swarm.sh             # IPFS swarm connection
├── dashboard.sh              # Launcher over `ppn service dashboard`
├── storage-provider-node.sh  # Launcher over `ppn service storage-provider-node`
├── set-dispatcher-address.sh # Launcher over `ppn service set-dispatcher-address`
├── pin-design-families.sh    # Pins design families to IPFS
├── pin-bulletin-products.sh  # Launcher over `ppn service pin-bulletin-products`
├── force-open-hrmp.sh        # Force-open HRMP channels
├── patch-bootnodes.sh        # Patch bootnode addresses
├── grant-invites.sh          # Grants the backend's inviter account invites (both dims)
├── increase-people-lite-attestation-allowance.sh # Attestation allowance config
├── docker-entrypoint.sh      # Docker container entrypoint
├── ensure-dot-cli.sh         # Installs dot CLI tool
├── install.sh                # Installation script
├── kill-port.sh              # Kill processes on specific ports
├── validate-ports.sh         # Port configuration validator
├── run-tests.sh              # Integration test runner
└── dub/                      # device-uniqueness-backend (see docs/DEVICE-UNIQUENESS-BACKEND.md)
    ├── postgres.sh           # Postgres cluster: initdb, create databases, run
    └── service.sh            # Runs one role of dub: secrets, wait-for-db, restart

tests/
├── 00-network-health.zndsl   # Basic health checks for all nodes
├── 01-asset-hub-revive.zndsl # Asset Hub pallet-revive tests
├── 02-bulletin-storage.zndsl # Bulletin Chain transactionStorage tests
├── 03-people-chain.zndsl     # People Chain individuality pallet tests
├── 04-xcm-channels.zndsl     # XCM channel tests
├── 05-dotns-contracts.zndsl  # DotNS genesis contract tests
├── 06-evm-genesis-balances.zndsl # EVM genesis balance tests
├── 07-web3-storage.zndsl     # Web3 Storage Chain smoke tests
├── 08-dub.zndsl              # device-uniqueness-backend smoke tests
├── 09-dub-registration.zndsl # dub registration flow
├── 10-network-suffix.zndsl   # Genesis set the product-context namespace on both chains
├── 13-runtime-upgrade.zndsl  # Live runtime upgrade on Asset Hub
└── scripts/                  # Custom TS test scripts the .zndsl suites call

zombienet-configs/
└── local-dev.toml            # Checked-in reference copy (auto-updated by make generate-toml)

.github/workflows/
├── release.yml               # Stable semver release: dist tarball, changelog, Docker image
├── nightly-bites.yml         # Nightly bite → the rolling `bites` pre-release (bundles only)
├── bite-network.yml          # Bite one network on demand (artifact, not a release)
├── npm-release.yml           # Publish the npm packages (on npm-v* tags)
└── zombienet-tests.yml       # PR gates: lint, drift, npm smoke, integration, fork-e2e
```

## Network Endpoints (local)

| Node | WebSocket | Parachain ID |
|------|-----------|--------------|
| Relay Alice | `ws://127.0.0.1:10000` | - |
| Relay Bob | `ws://127.0.0.1:10001` | - |
| Relay Charlie | `ws://127.0.0.1:10002` | - |
| Relay Dave | `ws://127.0.0.1:10003` | - |
| Relay Eve | `ws://127.0.0.1:10004` | - |
| Relay Ferdie | `ws://127.0.0.1:10005` | - |
| Asset Hub | `ws://127.0.0.1:10020` | 1500 |
| People Chain | `ws://127.0.0.1:10010` | 1502 |
| Bulletin | `ws://127.0.0.1:10030` | 1501 |
| Web3 Storage | `ws://127.0.0.1:10040` | 1600 |

### Auxiliary Services (local)

| Service | URL | Description |
| --- | --- | --- |
| Ethereum RPC | `http://127.0.0.1:8545` | JSON-RPC (connected to Asset Hub) |
| IPFS Gateway | `http://127.0.0.1:8080` | IPFS content gateway |
| IPFS API | `http://127.0.0.1:5001` | IPFS RPC API |
| IPFS Swarm | `127.0.0.1:4001` | P2P swarm port |
| Web3 Storage Provider | `http://127.0.0.1:3333` | HTTP API connected to Web3 Storage Chain |
| Device Uniqueness Backend | `http://127.0.0.1:8092` | Auth, usernames, tickets, TURN, notify (one origin, all services) |
| DUB API Reference | `http://127.0.0.1:8092/docs` | Generated OpenAPI reference |

## Elastic Scaling (Asset Hub)

Asset Hub runs with 2-second block times using elastic scaling:
- 6 validators required for 5 cores (3 parachains + 2 extra for Asset Hub)
- Core assignment via `scripts/assign-cores.sh` (runs automatically as custom_process)

## Testing

```bash
make test                              # Run all tests
make test ARGS=00-network-health.zndsl # Run specific test
```

### Test Logs

```bash
ls -la /tmp/zombie-*/                           # Find zombienet temp dirs
cat /tmp/zombie-*/alice-paseo-validator.log    # View specific node logs
```

## CI/CD

### Release (`.github/workflows/release.yml`)

- Manual dispatch with a semver `version`, or called by `zombienet-tests.yml` as a PR dry run
- Packs the deployable dist tarball, builds and pushes `paritytech/previewnet-engine`
- Cuts a GitHub release with generated notes as the changelog; stable releases own `latest`

### Nightly bites (`.github/workflows/nightly-bites.yml`)

- Cron 18:30 UTC and manual dispatch only — never from a pull request, because these jobs
  use self-hosted runners and read production endpoints
- Bites the live networks and refreshes ONE rolling pre-release tagged `bites`, carrying only
  fork bundles. `ppn fork fetch-bundle` reads that tag (`PPN_BITE_TAG` in
  `config/versions.env`), so bundles churn nightly without moving what a deploy resolves

### Integration tests (`.github/workflows/zombienet-tests.yml`)

- On every PR and push to main: `workflow-lint`, `toml-drift-check`, `npm-install-smoke-test`,
  `integration-tests` (spawns the full network and runs `tests/*.zndsl`), `fork-e2e` for each
  pre-bitten network, plus the release dry run

### npm (`.github/workflows/npm-release.yml`)

- On `npm-v*` tags: packs `@parity/ppn-network-config` and `@parity/ppn` with pnpm (which
  rewrites `workspace:*` to concrete versions) and hands them to `npm_publish_automation`

### On-demand bite (`.github/workflows/bite-network.yml`)

- Manual dispatch for a single network, uploading the bundle as a workflow artifact rather
  than publishing it

## Deployment

Not in this repo. Parity's preview network is deployed from a separate private repo that
installs the dist tarball this engine releases and overlays its own server tooling; the
engine's side of that contract is the tarball layout, `config/ports.env` key names and the
spawn-environment contract exported at `@parity/ppn/spawn-env`. For your own deployment see
`docs/DEPLOYING-YOUR-OWN.md`.
