# Product Preview Network (PPN)

> [!WARNING]
> The following is a prototype, reference implementation, and proof-of-concept. This open source
> code is provided for research, experimentation, and developer education only. This code has not
> been audited, is actively experimental, and may contain bugs, vulnerabilities, or incomplete
> features. Use at your own risk.

A complete Polkadot ecosystem on your machine, in one command: a relay chain with six
validators, plus Asset Hub (2-second blocks via elastic scaling), People, Bulletin and Web3
Storage, plus the Ethereum RPC, IPFS, identity backend and storage provider those chains
expect, already wired together. The same tool forks a live network, Polkadot included, so the
chains come up carrying real state instead of an empty genesis.

## Start it

```bash
npm install -g @parity/ppn
ppn start
```

Needs **Node.js 24+**. No clone: the CLI ships the network definitions, so `ppn start` downloads
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

### Develop against the whole stack, not a mock

Contracts on Asset Hub through `eth-rpc` at `:8545`, identity on People, storage on Bulletin
and Web3 Storage. Everything speaks to everything, the way it does in production, and `//Alice`
holds sudo and funds on every chain.

```bash
ppn start                # previewnet from genesis; state survives a restart
ppn start --ephemeral    # throw the state away when it stops
ppn start --clean        # wipe the state and start over
```

### Start from real state instead of genesis

A fork continues from a live network's block, so contracts, DotNS registrations, personhood
state and balances are already there. Which network decides where the state comes from and
what you can do with it afterwards:

| Network | What it is | Sudo | A fork starts from |
| --- | --- | --- | --- |
| `previewnet` | Parity's preview network on its own relay. The only network that also starts from genesis | yes | a bundle published nightly |
| `paseo-next-v2` | the next runtimes as parachains on public Paseo | yes | a bundle published nightly |
| `devnet` | the Polkadot Products Devnet on public Paseo, system-chain para ids | yes | a bite of the live network |
| `kusama` | Kusama relay and Asset Hub | no | a bite, with the runtime under test authorized at import |
| `polkadot` | Polkadot relay, Asset Hub, People and Bulletin | no | a bite, with the runtime under test authorized at import |

**Forking a testnet with sudo.** The bundle is bitten for you every night, so a start is a
download. Once the fork runs, sudo is `//Alice`, and anything that needs root works as it
does on genesis: runtime upgrades, HRMP, core assignment, the People grants.

```bash
ppn start --fork                        # previewnet, from last night's bundle
ppn start paseo-next-v2 --fork          # another network
ppn start --fork --fresh-bite           # bite the live network right now instead
ppn start devnet --fork                 # no published bundle, so this bites (several minutes)
```

**Forking a mainnet without sudo.** Nothing on a fork of Kusama or Polkadot can dispatch root,
so a runtime upgrade cannot be authorized after the fact. Name the blob at bite time instead:
the bite writes the authorization into state, and once the chains author, the fork applies the
upgrade on its own, through the relay's PVF pre-check and go-ahead like a real one. This is
how a fellowship release is rehearsed against Polkadot's actual state before it ships.

```bash
gh release download v2.5.0 -R polkadot-fellows/runtimes -D runtimes/ -p 'asset-hub-polkadot_*' -p 'people-polkadot_*'
ppn start polkadot --fork --fresh-bite \
  --upgrade asset-hub=runtimes/asset-hub-polkadot_runtime-v2005000.compact.compressed.wasm \
  --upgrade people=runtimes/people-polkadot_runtime-v2005000.compact.compressed.wasm
```

A `--upgrade` accepts any blob: a release asset, a PR's build artifact, a local build, and
`relay=` for the relay itself. The bite warp-syncs four chains, around 20 minutes, and a
parachain's upgrade goes live an hour after the spawn, because Polkadot's upgrade delay is 600
relay blocks. The dashboard shows the spec version flip; the log of the process applying the
upgrades is under its logs tab. If that process gave up, or you want to redo one chain, submit
the apply step yourself with no blob, and the one the bite authorized is used:

```bash
ppn upgrade people --enact-timeout 70    # apply what the bite authorized for People
```

Since the authorization is state inside the bundle, a different blob means a new bite.
[docs/POLKADOT-FORK.md](docs/POLKADOT-FORK.md) is the runbook for keeping such a fork running
on a dedicated machine.

**Living with a fork.** A fork stopped and started again resumes where it was, with any
upgrade it enacted still in force. Every network keeps its own bundle and data directory, so
forks of different networks do not disturb one another.

```bash
ppn kill && ppn start polkadot --fork    # resume where it stopped
ppn start polkadot --fork --clean        # back to the bite block
ppn start --fork --pin-products          # import the DotNS products, to browse them on the fork
```

A fork has no block history before the bite: block numbers continue, but querying an earlier
block fails. Bulletin lists content it does not hold until `--pin-products` imports it.
[docs/FORK.md](docs/FORK.md) has the rest.

### Test a build before it ships

Any binary or runtime can be repointed without editing anything, which is what makes this
useful as a release gate. Run the full network against a candidate and see what breaks.

```bash
ppn start --binary polkadot-omni-node=file:/path/to/your/build
ppn start --runtime asset-hub=file:/path/to/runtime.wasm
ppn start --binary polkadot-omni-node=paritytech/release-automation@polkadot-weekly2026w37-rc1
```

The same flags apply to a bite (`ppn bite`), so a fork can run on the node binary under test.

### Rehearse a runtime upgrade

Authorize and apply one against a chain that is already running, genesis or fork, and watch it
cross the boundary. The command exits 0 only once the new code is enacted and five more blocks
have finalized, so it gates CI directly.

```bash
ppn upgrade asset-hub ./asset_hub_runtime.wasm
ppn upgrade people --ws wss://my-host/people ./people_runtime.wasm   # a remote instance
```

Sudo dispatches the authorization, so this is for genesis and for forks of a sudo network. On
a fork of Kusama or Polkadot the authorization comes from the bite, as described under
"Forking a mainnet without sudo" above. See
[docs/RUNTIME-UPGRADE.md](docs/RUNTIME-UPGRADE.md).

### Produce a fork bundle without starting it

A bite can be run on its own, for a CI job or to hand a snapshot to someone else, and it can be
pointed at your own instance of a network rather than the one the descriptor names.

```bash
PPN_NETWORK=paseo-next-v2 ppn bite                     # into fork-bundle-paseo-next-v2/
ppn bite --source https://my-previewnet.example.org    # bite your own deployment of previewnet
```

Spawning a bundle needs only the regular node binaries; the bite tooling is fetched when a bite
runs. Parity's nightly bites publish previewnet's and paseo-next-v2's bundles to the rolling
`bites` pre-release, which is what a `--fork` start of those two downloads.

### Run a preview network for your team

The engine ends at "a network is running and these are its ports". Parity's own preview
network at `previewnet.substrate.dev` is deployed from a separate repo that installs this
engine's release tarball. [docs/DEPLOYING-YOUR-OWN.md](docs/DEPLOYING-YOUR-OWN.md) describes
the contract to build yours against, and [docs/PROFILES.md](docs/PROFILES.md) the profile that
strips the dev keys from anything long-lived.

## The network

| | Endpoint | |
| --- | --- | --- |
| Relay (alice … ferdie) | `ws://127.0.0.1:10000` – `10005` | 6 validators |
| Asset Hub | `ws://127.0.0.1:10020` | **2-second blocks**, elastic scaling |
| People | `ws://127.0.0.1:10010` | individuality |
| Bulletin | `ws://127.0.0.1:10030` | transaction storage |
| Web3 Storage | `ws://127.0.0.1:10040` | storage parachain, previewnet only |
| Dashboard | <http://127.0.0.1:8090> | status UI and API for all of the above |
| Ethereum RPC | `http://127.0.0.1:8545` | JSON-RPC onto Asset Hub |
| IPFS | `:8080` gateway, `:5001` API | |
| Identity backend | `http://127.0.0.1:8092` | auth, usernames, tickets; `/docs` for the API |

The ports are the same whichever network runs. A fork runs the chains its network has, so a
Polkadot fork has no Web3 Storage and Kusama has only the relay and Asset Hub.

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
and runtime for every chain, and the live endpoints a bite reads. Point `ppn` at your own set
and it runs those instead.

```bash
export PPN_HOME=~/my-network     # holds networks/my-net.json
ppn networks                     # what it can see
ppn show my-net                  # what that resolves to
```

`$PPN_HOME` is also where state lives: `bin/` for downloaded binaries, `data/` for chain state,
`fork-bundle-<network>/` for bites. Without it, `ppn` walks up from the working directory
looking for a `networks/` folder, then falls back to `~/.ppn`. See
[`networks/README.md`](networks/README.md) for the schema.

## Working on PPN itself

```bash
git clone https://github.com/paritytech/previewnet-engine.git
cd previewnet-engine
make start
```

A clone is a workspace like any other, so the walk-up above finds its `networks/`. What a clone
adds is `make`, a front door for the common things: every target delegates to `ppn`, so
`make start FORK=1 NETWORK=devnet` is `ppn start devnet --fork`, `make bite NETWORK=polkadot
UPGRADES="people=<wasm>"` is a bite with `--upgrade`, and `make runtime-upgrade CHAIN=people
WASM=<wasm>` is `ppn upgrade`. `make help` lists the targets, `make doctor` checks your
machine, and `ppn <command> --help` lists the flags.

`make test` runs the integration suite, which spawns a real network; `make test-unit` is the fast
one. [ARCHITECTURE.md](docs/ARCHITECTURE.md) is the map.

## Docs

| | |
| --- | --- |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | workspace layout, package boundaries, what a release contains |
| [FORK.md](docs/FORK.md) | how forking works, what a bundle is, upgrading a fork without sudo |
| [POLKADOT-FORK.md](docs/POLKADOT-FORK.md) | runbook: a Polkadot fork with the fellowship runtimes on a dedicated machine |
| [networks/README.md](networks/README.md) | the descriptor schema and the status of every network |
| [DASHBOARD.md](docs/DASHBOARD.md) | the status UI, its API, and the action plane |
| [PROFILES.md](docs/PROFILES.md) | `local` vs `deployable`: funded accounts, sudo, signing keys |
| [RUNTIME-UPGRADE.md](docs/RUNTIME-UPGRADE.md) | upgrading a chain that is running |
| [DEVICE-UNIQUENESS-BACKEND.md](docs/DEVICE-UNIQUENESS-BACKEND.md) | identity backend roles and endpoints |
| [DEPLOYING-YOUR-OWN.md](docs/DEPLOYING-YOUR-OWN.md) | running this for a team |

## Security

The warning at the top of this file is the policy. Concretely: the default profile deliberately
runs well-known development keys (`//Alice` and friends) as funded sudo accounts, so do not
point it at anything holding real value. A fork of Kusama or Polkadot carries real accounts
and real balances, but its validators are the dev keys too: it is a sandbox, not the network.
Read [PROFILES.md](docs/PROFILES.md) before running anything long-lived or reachable by others.

Before deploying this for real use cases, you are responsible for:

- Reviewing the code yourself. We publish a reference, not a hardened production build.
- Checking that the dependencies are up to date and free of known vulnerabilities.
- Securing your own deployment environment: keys, secrets, network configuration.
- Tracking the latest tagged release for security fixes. Older releases are not backported.

To report a vulnerability, follow the
[Parity security policy](https://github.com/paritytech/.github/blob/main/SECURITY.md).

## License

Apache-2.0. See [LICENSE](LICENSE).

Copyright 2026 Parity Technologies
