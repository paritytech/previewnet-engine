# Trinity stack descriptor

Every running network writes a [Trinity stack descriptor](https://github.com/paritytech/trinity-user-agents/blob/main/docs/rfcs/trinity-stack-descriptor.md):
one JSON document with its chains, genesis hashes, RPC endpoints, chain specs and services.
Hosts and tools import a network from it, by a link or a QR code, instead of keeping their own
copy of those facts.

## What gets written

`ppn service trinity-stack` runs as a zombienet custom process in genesis and fork spawns.
Once the chains answer, it writes into the data directory:

| File | Served at | What it is |
| --- | --- | --- |
| `trinity-stack.json` | `/.well-known/trinity-stack.json` | The descriptor, signed when the deployment gives a key |
| `<spec>.smol.json` | `/chainspecs/<spec>.smol.json` | Each chain's light-client spec |
| `trinity-stack.state.json` | `/api/stack` | The publish state, the generation, and the pointer and link |

It is a file rather than an API: a signature and a content hash cover exact bytes, and nginx,
CI and the dashboard can all serve the same file. The dashboard serves all three and shows the
link and its QR code on the overview.

The service rewrites the files every `PPN_STACK_REFRESH_SECONDS` (6 hours by default), and at
least twice per `PPN_STACK_VALID_FOR`, so the relay's checkpoint stays recent and no reader
holds a copy past its `validUntil`. `sequence` rises only when the content changes. Until the
relay has finalized a block and eth-rpc answers, it publishes without the relay's light spec and
without eth-rpc, and tries again every 30 seconds.

An `EPHEMERAL=1` run writes nothing: its chains live in a temp directory, so the data directory
holds an earlier run's files.

## Fields

The descriptor is built from the dashboard model, so its URLs are the ones the dashboard shows:

- `id`, `name`: the network's, or `<name>-fork` and `Fork of <displayName>` for a fork.
- `network`: the relay's chain, such as `paseo`.
- `tld`: `stack.tld` in the network file, or `genesisConfig.networkSuffix`. A network with
  neither writes no descriptor.
- `generation`: minted with the data directory, so it changes when the chains restart from
  scratch: a wipe, or a fork started again from its bite.
- `chains`: each chain's genesis hash, its RPC URLs, and its full and light specs with their
  SHA-256.
- `services`: the DUB, TURN and STUN, the IPFS gateway, Bulletin as `hop`, eth-rpc with its
  chain id, and the storage provider.
- `fork` and each chain's `forkedAt`: on a fork whose spawn stamp records the bite and whose
  network file names the source's descriptor in `stack.pointer`. `ppn start --fork` records the
  bite itself. A deployment that spawns zombienet directly runs
  `ppn stamp-spawn --fork-manifest <bundle>/manifest.json`; without it the fork is still named
  as one, but carries no `fork`.

Once the live network signs its descriptor, its network file's `stack.pointer` needs the `key`,
so every fork of it names a signed source.

## Light specs

A light spec is the raw spec with its genesis storage replaced by the genesis state root, and
the relay's also carries a sync checkpoint from `sync_state_genSyncSpec`. Its bootnodes are
the network's own nodes:

- the node's P2P WS port on `BOOTNODE_HOSTNAME`, which native smoldot dials;
- behind `https`, also nginx's TLS port for that chain (`*_P2P_WSS_PORT`), because a browser on
  an https page may only dial `wss`.

Before writing, the service checks that the spec implies the chain's genesis hash, and refuses
a raw spec that names a node on any host other than `BOOTNODE_HOSTNAME`. A fork keeps its
source's genesis hash, so a spec that still lists one of the source's nodes would join the
source network, and nothing on the chain would show it.

## Settings

All optional. zombienet hands custom processes no environment, so a deployment patches them
into `config/ports.env`, where each has an empty default. The key goes in the secrets file.

| Setting | Effect |
| --- | --- |
| `PPN_STACK_SECRET` | `0x` and 64 hex digits, in the secrets file. Signs the descriptor, and the pointer carries its public key. |
| `PPN_STACK_FAUCET_URL` | Adds a `faucet` service. |
| `PPN_STACK_EXPIRES_AT` | Unix seconds when the network is torn down, for spawner instances. |
| `PPN_STACK_VALID_FOR` | Seconds a reader may use a copy before fetching it again. |
| `PPN_STACK_REFRESH_SECONDS` | How often the files are rewritten. |
