// Generates the zombienet TOML that spawns a fork bundle — a network resumed from a live
// network's state rather than from genesis. The bundle's manifest names which network it
// is a bite of (networks/<name>.json); old bundles without the field are previewnet's.
// See docs/FORK.md.
//
// Ports, para ids and per-chain flags are imported from toml-generator.ts rather than
// restated here. A forked collator has to run with the same arguments as a genesis one,
// and when the two lists were maintained separately they drifted immediately — a
// hand-copied table dropped `--listen-addr=…/webrtc-direct`, which pairs with
// `--experimental-webrtc`. Only what is genuinely different about a fork is expressed
// below, and there are four such things:
//
//  1. Node names. zombienet maps the well-known names (alice, bob, …) to the well-known
//     dev keys, which is exactly the authority set the bite installs over production's
//     generated keys. PPN's genesis-mode names (`alice-paseo-validator`,
//     `bulletin-collator1`) get generated keys instead, and the network cannot author.
//     Collators must be `Collator-<paraId>` to match the `//Collator-<paraId>` Aura key.
//
//  2. Collators use --relay-chain-rpc-urls rather than an embedded relay node. The relay
//     database came from warp sync: it holds state at the bite block but no bodies before
//     it, so it cannot serve a peer syncing from genesis. An embedded relay sits at #0.
//
//  3. Every relay node needs ZOMBIE_DISPUTE_CANDIDATE_LIFETIME_AFTER_FINALIZATION=1.
//     Without it the dispute scrape reaches for ancestry a warp-synced DB does not have,
//     DetermineUndisputedChain fails, and relay chain-selection pins the finality target
//     to the bite block — blocks are produced but nothing finalizes. zombienet does not
//     forward the parent environment, so it has to be declared per node.
//
//  4. Genesis-time bootstrap processes are omitted. The forked state already carries the
//     HRMP channels, core assignments and dispatcher address, so re-running them is at
//     best a no-op and at worst writes stale values.
//
//     The attestation allowance is the exception, and runs in both modes. It is not
//     bootstrap: it grants allowance to whichever account the identity backend attests
//     with, and a fork carries production's grants — which say nothing about that account
//     once it is not Alice. The grant is additive, so re-running it is safe.
//
// Paths are absolute rather than zombienet's {{BIN}}/{{SCRIPTS}} placeholders: this file
// is generated per machine into a gitignored bundle directory, and the bundle path is not
// an environment variable, so there is nothing to gain by making half of it relocatable.

import fs from 'node:fs';
import {
  VALIDATORS,
  PORTS,
  P2P_PORTS,
  RELAY_BASE_PORT,
  buildArgs,
  addMissing,
  tomlArgs,
  requiredPort,
} from './toml-generator.js';
import type { Parachain } from './types.js';
import type { ForkManifest } from './bundle.js';
import { DEFAULT_NETWORK, type NetworkDef } from './networks.js';
import { loadNetwork } from './load.js';
import { dubCustomProcesses } from './dub.js';

// ---------------------------------------------------------------------------
// Bundle manifest — built by ./fork/manifest.ts, extended with biteBlocks by bite.sh
// ---------------------------------------------------------------------------

export type { ForkManifest, ForkManifestChain } from './bundle.js';

// Services, data loading, and spec publishing — see note 4 above.
//
// patch-bootnodes belongs here even though it sounds like genesis bootstrap: zombienet
// regenerates bootNodes from the running nodes, so the specs it publishes advertise
// /ip4/127.0.0.1/. Without this the chainspecs a spawned instance serves are unusable to
// anything off the box. It rewrites addresses only; it touches no chain state.
// Each process runs only when the parachain it serves is part of the fork (null = always),
// and can be switched off per network via the descriptor's `services` map. Genesis-bootstrap
// processes (HRMP channels, core assignment, the POP controller address) are deliberately
// absent: a fork already carries all of that in state. The attestation allowance is the
// exception — it is not bootstrap but a grant to *our* attester, and the forked state
// carries production's grants, not one for the account IBv2 signs with here.
const PROCESS_GATES: Record<string, Parachain | null> = {
  dashboard: null,
  'eth-rpc': 'asset-hub',
  'ipfs-daemon': 'bulletin',
  'ipfs-swarm': 'bulletin',
  'storage-provider-node': 'web3-storage',
  'pin-design-families': 'people',
  'patch-bootnodes': null,
  // Imports the DotNS products whose bytes a warp-synced bulletin cannot have. Best
  // effort: without it the fork runs, but content published before the bite 404s.
  'pin-bulletin-products': 'bulletin',
  'increase-people-lite-attestation-allowance': 'people',
  // Same reason as the allowance grant: a fork inherits the source network's invites, which
  // say nothing about the account signing here, and without invites the ticket pool fails
  // every batch it submits.
  'grant-invites': 'people',
};

const FORK_PROCESSES = Object.keys(PROCESS_GATES);

// A warp-synced node keeps only recent state, and skipping the hardware benchmark keeps
// the spawn quiet on machines that would otherwise warn on every start.
const FORK_COMMON = ['--state-pruning=256', '--no-hardware-benchmarks'];
// --discover-local/--allow-private-ip on the *validators*, not just the collators. A validator
// only enters an address into the DHT if it passes the non-global filter, and on a local network
// every address is 127.0.0.1 — so without these it publishes nothing resolvable. The collator
// then asks authority discovery for its backing group, resolves no addresses, opens no collation
// substream, and every collation expires unadvertised:
//
//     TRACE collator-protocol: Sending connection request to validators: [Public(d43593c7…)]
//     TRACE collator-protocol: Peer-set updated due to a timeout timeout=4s
//     WARN  collator-protocol: Collation wasn't advertised to any validator
//
// PeerSet::Collation is configured out_peers: 0 with an empty reserved set, and validators never
// dial collators — set_reserved_peers() from a resolved address is the only way that substream
// ever opens. So this is not a nicety; nothing is backed without it.
const FORK_RELAY_ARGS = ['--force-authoring', '--discover-local', '--allow-private-ip', ...FORK_COMMON];
const FORK_COLLATOR_ARGS = ['--discover-local', '--allow-private-ip', ...FORK_COMMON];

// Quieter than the genesis default (runtime=debug); babe and grandpa are what you actually
// want to read when a fork fails to author or finalize.
const FORK_RELAY_LOGS = { runtime: 'info', babe: 'info', grandpa: 'info' } as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readManifest(bundleDir: string): ForkManifest {
  const file = `${bundleDir}/manifest.json`;
  if (!fs.existsSync(file)) {
    throw new Error(`no manifest at ${file} — run \`make bite\` or delete the bundle and retry`);
  }
  const manifest = JSON.parse(fs.readFileSync(file, 'utf-8')) as ForkManifest;
  if (!manifest.biteBlocks || !manifest.chains?.relay?.spec) {
    throw new Error(
      `${file} predates the current bundle format.\n` +
        'Re-bite with `make bite` (or `make clean-fork` and let FORK=1 fetch a current one).'
    );
  }
  return manifest;
}

// A bundle names the network it was bitten from; bundles from before the network registry
// are previewnet's. The descriptor is what the bundle is validated against.
function networkOf(manifest: ForkManifest): NetworkDef {
  return loadNetwork(manifest.network ?? DEFAULT_NETWORK);
}

// The bundle and the network descriptor must agree on which parachains exist. Nothing else
// enforces that, and the failure it prevents is quiet: a five-chain network would simply
// fork as four.
function forkParachains(manifest: ForkManifest, net: NetworkDef): Parachain[] {
  const bundled = Object.keys(manifest.chains)
    .filter((k) => k !== 'relay')
    .sort();
  const known = net.parachains.map((p) => p.key).sort();
  if (bundled.join(',') !== known.join(',')) {
    throw new Error(
      `parachain set mismatch — bundle has [${bundled}], ${net.name} declares [${known}].\n` +
        `Re-bite with \`make bite\`, or update networks/${net.name}.json.`
    );
  }
  for (const p of net.parachains) {
    const bundledId = manifest.chains[p.key].paraId;
    if (bundledId !== p.paraId) {
      throw new Error(
        `para id mismatch for ${p.key} — bundle says ${bundledId}, networks/${net.name}.json says ${p.paraId}`
      );
    }
  }
  return net.parachains.map((p) => p.key);
}

// Read the chain id out of the spec rather than restating the name->id mapping. `chain` is
// mandatory alongside chain_spec_path: without it zombienet applies a single spec to every
// parachain (last one wins) and all collators silently run the same chain, which shows up
// only as the parachains converging on identical block numbers.
function chainIdOf(specPath: string): string {
  return JSON.parse(fs.readFileSync(specPath, 'utf-8')).id;
}

function relayNodes(count: number): string {
  return VALIDATORS.slice(0, count).map(
    (name, i) => `
[[relaychain.nodes]]
name = "${name}"
validator = true
rpc_port = ${RELAY_BASE_PORT + i}${i === 0 ? `\np2p_port = ${P2P_PORTS.relay}` : ''}
env = [{ name = "ZOMBIE_DISPUTE_CANDIDATE_LIFETIME_AFTER_FINALIZATION", value = "1" }]`
  ).join('\n');
}

function parachainSection(
  key: Parachain,
  manifest: ForkManifest,
  bundleDir: string,
  scriptsDir: string,
  enableHop: boolean,
  net: NetworkDef,
  binDirOverride?: string
): string {
  const chain = manifest.chains[key];
  const desc = net.parachains.find((p) => p.key === key)!;
  const paraId = chain.paraId as number;
  const specPath = `${bundleDir}/specs/${chain.spec}.json`;
  const args = addMissing(
    addMissing(
      [
        `--relay-chain-rpc-urls=ws://127.0.0.1:${RELAY_BASE_PORT}`,
        ...buildArgs(key, undefined, key === 'bulletin' && enableHop),
      ],
      desc.extraArgs
    ),
    FORK_COLLATOR_ARGS
  );

  // The collator runs through scripts/omni-node.sh either way (it carries the libp2p
  // fix any cumulus collator needs — see that file). Which binary it execs, and from
  // which bin directory, is the wrapper's PPN_* environment: non-previewnet networks
  // keep their node binaries in bin/<network>, and the descriptor binds each chain's
  // binary explicitly (binary: { name, release }).
  const env: string[] = [];
  if (binDirOverride) env.push(`{ name = "PPN_BIN_DIR", value = "${binDirOverride}" }`);
  if (desc.binary.name !== 'polkadot-omni-node') {
    env.push(`{ name = "PPN_COLLATOR_BINARY", value = "${desc.binary.name}" }`);
  }
  // zombienet files the collator's ed25519 key under `gran`, and its `aura` key is always
  // sr25519 — so on a chain whose Aura is ed25519 the node finds no key it can author with.
  // The wrapper inserts one; see scripts/omni-node.sh.
  if (desc.aura === 'ed25519') {
    env.push(`{ name = "PPN_COLLATOR_AURA", value = "ed25519" }`);
  }
  const envLine = env.length ? `\nenv = [${env.join(', ')}]` : '';

  return `
## ${chain.specName} (${paraId}) — bitten at block ${manifest.biteBlocks[paraId]}
[[parachains]]
id = ${paraId}
cumulus_based = true
chain = "${chainIdOf(specPath)}"
chain_spec_path = "${specPath}"

[[parachains.collators]]
name = "Collator-${paraId}"
rpc_port = ${PORTS[key]}
p2p_port = ${P2P_PORTS[key]}
command = "${scriptsDir}/omni-node.sh"
db_snapshot = "${bundleDir}/snapshots/${paraId}.tgz"${envLine}
args = ${tomlArgs(args)}
`;
}

/**
 * Whether this spawn imports the network's DotNS products.
 *
 * The descriptor decides and PRODUCT_SYNC overrides it, in both directions: whether the content
 * is wanted belongs to the run, not to the network. Forking paseo-next-v2 to test a runtime does
 * not need its products; the same fork opened to browse them does. Unasked, the import walks
 * every product the resolver knows and pulls each one's bytes from the source gateway, which was
 * 659 products and over half an hour the last time it ran on a network that never checked them.
 *
 * PRODUCT_SYNC=0 already meant "skip" inside the service itself; deciding here as well means the
 * process is not spawned at all rather than started and told to do nothing.
 */
export function pinsProducts(net: NetworkDef): boolean {
  const sync = process.env.PRODUCT_SYNC;
  if (sync === '0') return false;
  if (sync === '1') return true;
  return net.dotns?.pinProducts === true;
}

function customProcesses(scriptsDir: string, net: NetworkDef, present: Set<Parachain>): string {
  return FORK_PROCESSES.filter((name) => {
    const gate = PROCESS_GATES[name];
    if (gate !== null && !present.has(gate)) return false;
    if (name === 'pin-bulletin-products' && !pinsProducts(net)) return false;
    return net.services[name] !== false;
  })
    .map(
      (name) => `
[[custom_processes]]
name = "${name}"
command = "${scriptsDir}/${name}.sh"
`
    )
    .join('');
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

export interface GenerateForkTomlOptions {
  /**
   * Root that supplies bin/ (and scripts/, unless scriptsDir overrides it). In a checkout the
   * two live together; installed from npm they do not — bin/ is the workspace's, scripts/ ship
   * inside the package — which is why the launcher dir can be named separately.
   */
  repoDir: string;
  /** Where the shell launchers live. Defaults to <repoDir>/scripts. */
  scriptsDir?: string;
  /** Unpacked fork bundle (manifest.json, specs/, snapshots/, overrides/). */
  bundleDir: string;
  /** Mirrors ENABLE_HOP in genesis mode. */
  enableHop?: boolean;
  /** Overrides <repoDir>/bin — non-previewnet binaries live in bin/<network>. */
  binDir?: string;
}

export function generateForkToml(options: GenerateForkTomlOptions): string {
  const { repoDir, bundleDir, enableHop = true } = options;
  const binDir = options.binDir ?? `${repoDir}/bin`;
  const scriptsDir = options.scriptsDir ?? `${repoDir}/scripts`;

  const manifest = readManifest(bundleDir);
  const net = networkOf(manifest);
  const parachains = forkParachains(manifest, net);
  const present = new Set(parachains);
  const relaySpecPath = `${bundleDir}/specs/${manifest.chains.relay.spec}.json`;
  const relayArgs = addMissing(
    addMissing(buildArgs('relay', FORK_RELAY_LOGS), net.relay.extraArgs),
    FORK_RELAY_ARGS
  );

  // The identity backend rides the people chain, like its attestation-allowance grant.
  const identity =
    present.has('people') && net.services['dub'] !== false
      ? dubCustomProcesses(
          {
            postgres: requiredPort('DUB_POSTGRES_PORT'),
            people: PORTS.people,
            assetHub: PORTS['asset-hub'],
            gateway: requiredPort('DUB_PORT'),
          },
          undefined,
          scriptsDir
        )
      : '';

  const toml = `\
# DO NOT EDIT — regenerate with: ppn fork toml <bundle> <out>
# Forked ${net.name}, bitten ${manifest.bittenAt} from ${manifest.source}
# Production node version at bite time: ${manifest.nodeVersion}
# Bite blocks: ${JSON.stringify(manifest.biteBlocks)}

[settings]
timeout = 1200
node_spawn_timeout = 400

[relaychain]
chain = "${chainIdOf(relaySpecPath)}"
chain_spec_path = "${relaySpecPath}"
default_command = "${binDir}/${net.relay.binary.name}"
default_db_snapshot = "${bundleDir}/snapshots/relay.tgz"
default_args = ${tomlArgs(relayArgs)}
${relayNodes(net.relay.validators)}
${parachains
    .map((p) => parachainSection(p, manifest, bundleDir, scriptsDir, enableHop, net, options.binDir))
    .join('')}
${customProcesses(scriptsDir, net, present)}${identity}`;

  // Collapse 3+ consecutive blank lines into 2
  return toml.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export { FORK_PROCESSES };
