// Generates zombienet TOML configuration from parachain selection.
//
// The template below reads like actual TOML with conditional sections.
// Helper `section(flag, text)` includes a block only when flag is true.
// Helper `validatorNodes(count)` generates the validator node blocks.
//
// Usage:
//   import { generateToml } from './toml-generator.js';
//   const toml = generateToml(['asset-hub', 'people', 'bulletin']);
//   const toml = generateToml(['asset-hub'], { logTargets: { relay: { babe: 'debug' } } });

import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './repo-root.js';
import { PARACHAIN_KEYS } from './types.js';
import type { Parachain, ChainKey, ChainDef, LogLevel, GenerateTomlOptions } from './types.js';
import { DEFAULT_NETWORK, type NetworkDef, type NetworkParachain } from './networks.js';
import { loadNetwork } from './load.js';
import { dubCustomProcesses } from './dub.js';
import { addMissing, flagOf, overrideArgs } from './args.js';

const VALIDATORS = ['alice', 'bob', 'charlie', 'dave', 'eve', 'ferdie'] as const;

/**
 * The name of the i-th relay node in fork mode. The first six are the well-known names, which
 * zombienet maps to the well-known dev keys; past them zombienet derives a node's keys from
 * `//<Name>` — the same rule that makes `Collator-<paraId>` work — so any name serves, as long
 * as the bite installs the keys derived from it (cli fork/validators.ts).
 */
function relayNodeName(i: number): string {
  return VALIDATORS[i] ?? `Validator-${i + 1}`;
}

/**
 * The name of the i-th collator of a parachain. The first keeps the name every bite has used,
 * so a bundle bitten before collator counts existed still spawns; the rest are numbered from 2.
 */
function collatorNodeName(paraId: number, i: number): string {
  return i === 0 ? `Collator-${paraId}` : `Collator-${paraId}-${i + 1}`;
}

const VALID_PARACHAINS: Parachain[] = PARACHAIN_KEYS;

// Genesis is previewnet-only by design (see networks/README.md), but everything about
// previewnet that the descriptor states — para ids, chain ids, spec files, binaries,
// per-chain flags, validator count and naming, which services run — is read from it
// here rather than restated, so this generator and fork mode cannot disagree, and
// editing the descriptor changes both.
//
// What stays in code is what the descriptor does not describe: the elastic-scaling
// core count, the HRMP topology, and the bootstrap processes' own arguments.
// Loaded on first use, not at import. A module-level load makes importing this package
// require a descriptor on disk — which is fine in a checkout and fatal once published: a
// consumer that only wants the types or the generators cannot even import it, and the failure
// arrives as an unhandled throw during module evaluation, before any command can report it.
/** Compute once, on first use. Module-scope work that reads a descriptor cannot run at
 * import time: the package must be importable without one. */
function memo<T>(compute: () => T): () => T {
  let value: T | undefined;
  let done = false;
  return () => {
    if (!done) {
      value = compute();
      done = true;
    }
    return value as T;
  };
}

let genesisNetCache: NetworkDef | undefined;
const genesisNet = (): NetworkDef => (genesisNetCache ??= loadNetwork(DEFAULT_NETWORK));

function genesisChainOf(key: ChainKey) {
  const chain = key === 'relay' ? genesisNet().relay : genesisNet().parachains.find((p) => p.key === key);
  if (!chain) throw new Error(`networks/${genesisNet().name}.json declares no chain "${key}"`);
  return chain;
}

/** The chain spec previewnet's genesis builds for a chain: its id and local filename. */
function genesisSpecOf(key: ChainKey) {
  const spec = genesisChainOf(key).genesisSpec;
  if (!spec) throw new Error(`networks/${genesisNet().name}.json declares no genesisSpec for "${key}"`);
  return spec;
}

/** A custom process runs unless the descriptor switches it off. */
function serviceEnabled(name: string): boolean {
  return genesisNet().services[name] !== false;
}

const genesisConfig = memo(() => {
  const config = genesisNet().genesisConfig;
  if (!config) {
    throw new Error(
      `networks/${genesisNet().name}.json has no genesisConfig — it cannot be spawned from genesis`
    );
  }
  return config;
});

// Ports come from config/ports.env at the repo root.
function loadPortsEnv(): Record<string, string> {
  const vars: Record<string, string> = {};
  const file = path.join(repoRoot(), 'config', 'ports.env');
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.includes('$')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) vars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).replace(/^["']|["']$/g, '');
  }
  return vars;
}

const portsEnv = memo(loadPortsEnv);

function requiredPort(key: string): number {
  const val = parseInt(portsEnv()[key], 10);
  if (isNaN(val)) throw new Error(`Missing required key in ports.env: ${key}`);
  return val;
}

// Keyed by Parachain/ChainKey rather than string, so that widening the union in types.ts
// fails to compile here instead of silently yielding `rpc_port = undefined` in the config.
const RELAY_BASE_PORT = requiredPort('RELAY_ALICE_PORT');
const PORTS: Record<Parachain, number> = {
  'asset-hub': requiredPort('ASSET_HUB_PORT'),
  people: requiredPort('PEOPLE_PORT'),
  bulletin: requiredPort('BULLETIN_PORT'),
  'web3-storage': requiredPort('WEB3_STORAGE_PORT'),
};

/** The Prometheus port of a node whose RPC port is `rpcPort`. */
function prometheusPort(rpcPort: number): number {
  return rpcPort + requiredPort('PROMETHEUS_PORT_OFFSET');
}

/** RPC ports of a parachain's RPC nodes: the chain's own port + 1..rpcNodes. Throws on a port another chain uses. */
function rpcNodePorts(p: NetworkParachain): number[] {
  const ports = Array.from({ length: p.rpcNodes }, (_, i) => PORTS[p.key] + i + 1);
  const used = [...Object.values(PORTS), ...VALIDATORS.map((_, i) => RELAY_BASE_PORT + i)];
  const clash = ports.find((port) => used.includes(port));
  if (clash !== undefined) {
    throw new Error(`${p.rpcNodes} RPC nodes for ${p.key} would take port ${clash}, which ports.env gives another node`);
  }
  return ports;
}

// Authoring flags a full node does not take, and the collator's fixed listen address.
const COLLATOR_ONLY_FLAGS = new Set(['--collator', '--force-authoring', '--authoring', '--listen-addr']);

/**
 * The `[[parachains.collators]]` blocks of a chain's RPC nodes: non-validators running the
 * collator's args without its authoring flags, with the chain's rpcNodeArgs over them. `launch`
 * holds the lines each block shares with the collator (command, env, snapshot).
 */
function rpcNodeBlocks(p: NetworkParachain, collatorArgs: string[], launch: string): string {
  const args = overrideArgs(collatorArgs.filter((a) => !COLLATOR_ONLY_FLAGS.has(flagOf(a))), p.rpcNodeArgs);
  return rpcNodePorts(p)
    .map(
      (port, i) => `
[[parachains.collators]]
name = "${p.key}-rpc${i + 1}"
validator = false
invulnerable = false
rpc_port = ${port}
prometheus_port = ${prometheusPort(port)}
${launch}
args = ${tomlArgs(args)}
`
    )
    .join('');
}

// Para ids belong to the network, not the machine, so they come from the descriptor —
// ports.env keeps only what is local (which port each chain listens on).
const paraIds = memo((): Record<Parachain, number> => {
  const ids = Object.fromEntries(genesisNet().parachains.map((p) => [p.key, p.paraId]));
  const missing = VALID_PARACHAINS.filter((k) => ids[k] === undefined);
  if (missing.length) {
    throw new Error(
      `networks/${genesisNet().name}.json declares no para id for: ${missing.join(', ')} — ` +
        'the genesis network must cover every parachain PPN knows'
    );
  }
  return ids as Record<Parachain, number>;
});
const P2P_PORTS: Record<ChainKey, number> = {
  relay: requiredPort('RELAY_ALICE_P2P_PORT'),
  'asset-hub': requiredPort('ASSET_HUB_P2P_PORT'),
  people: requiredPort('PEOPLE_P2P_PORT'),
  bulletin: requiredPort('BULLETIN_P2P_PORT'),
  'web3-storage': requiredPort('WEB3_STORAGE_P2P_PORT'),
};
// The interface the webrtc-direct collators bind. Loopback on a laptop; a server sets its
// public IP so browser peers can reach the collators at all — webrtc-direct advertises what
// it is bound to, so a 127.0.0.1 listener is unreachable from anywhere else. The environment
// wins over ports.env so a one-off `P2P_LISTEN_IP=… make start` needs no file edit.
const P2P_LISTEN_IP = process.env.P2P_LISTEN_IP || portsEnv().P2P_LISTEN_IP || '127.0.0.1';
// Per-chain required args (always included) and default log targets
const CHAIN_ARGS: Record<ChainKey, ChainDef> = {
  relay: {
    required: [
      '--network-backend=libp2p',
      '--unsafe-rpc-external',
      '--rpc-max-response-size=50', 
    ],
    defaultLogs: { runtime: 'debug', xcm: 'trace' },
  },
  'asset-hub': {
    required: [
      "--rpc-max-connections=500",
       '--force-authoring',
       '--authoring=slot-based',
       '--unsafe-rpc-external',
       '--rpc-max-response-size=50',
       `--listen-addr=/ip4/${P2P_LISTEN_IP}/udp/${P2P_PORTS['asset-hub']}/webrtc-direct`,
     ],
    defaultLogs: { xcm: 'trace' },
  },
  people: {
    required: [
      "--rpc-max-connections=500",
      '--force-authoring',
      '--enable-statement-store',
      '--network-backend=libp2p',
      '--authoring=slot-based',
      '--unsafe-rpc-external',
      '--rpc-max-response-size=50',
    ],
    defaultLogs: { parachain: 'debug', xcm: 'trace' },
  },
  bulletin: {
    required: [
      "--rpc-max-connections=500",
      '--force-authoring',
      '--ipfs-server',
      '--authoring=slot-based',
      '--unsafe-rpc-external',
      '--rpc-max-response-size=50',
      `--listen-addr=/ip4/${P2P_LISTEN_IP}/udp/${P2P_PORTS['bulletin']}/webrtc-direct`,
    ],
    defaultLogs: {
      parachain: 'debug',
      xcm: 'trace',
      'sub-libp2p::bitswap': 'trace',
      'runtime::transaction-storage': 'trace',
    },
  },
  'web3-storage': {
    required: [
      '--collator',
      '--rpc-max-connections=500',
      '--unsafe-rpc-external',
      '--rpc-max-response-size=50',
      `--listen-addr=/ip4/${P2P_LISTEN_IP}/udp/${P2P_PORTS['web3-storage']}/webrtc-direct`,
      ],
    defaultLogs: { runtime: 'info' },
  },
};

const POPULAR_LOG_TARGETS: string[] = [
  'runtime', 'xcm', 'parachain', 'babe', 'grandpa',
  'p2p', 'txpool', 'sync', 'aura', 'sc_network',
  'sub-libp2p', 'litep2p', 'pallet_revive', 'pallet_contracts',
];

const LOG_LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function section(condition: boolean, text: string): string {
  if (!condition) return '';
  return text;
}

function buildArgs(chainKey: ChainKey, logTargets?: Record<string, LogLevel>, enableHop?: boolean): string[] {
  const def = CHAIN_ARGS[chainKey];
  const targets = logTargets || def.defaultLogs;
  const args: string[] = [];

  const entries = Object.entries(targets);
  if (entries.length > 0) {
    const logStr = entries.map(([t, l]) => `${t}=${l}`).join(',');
    args.push(`-l${logStr}`);
  }

  args.push(...def.required);
  // HOP promotion tuned for tests: 1h retention, promotion window opens at half the retention
  // (buffer = retention / 2 = 1800s), so an unacked entry is promoted ~30min after submit.
  if (enableHop)
    args.push(
      '--enable-hop',
      '--hop-retention-secs=3600',
      '--hop-promotion-buffer-secs=1800',
      '--hop-check-interval=60'
    );
  return args;
}

// The genesis collator command is always the omni-node.sh wrapper (it carries the
// libp2p fix any cumulus collator needs); which binary it execs comes from the
// descriptor via env. Empty for the default binary, keeping previewnet's TOML stable.
function genesisCollatorEnv(key: Parachain): string {
  const name = genesisNet().parachains.find((p) => p.key === key)?.binary.name;
  return name && name !== 'polkadot-omni-node'
    ? `\nenv = [{ name = "PPN_COLLATOR_BINARY", value = "${name}" }]`
    : '';
}

function genesisChainArgs(key: ChainKey, logTargets?: Record<string, LogLevel>, enableHop?: boolean): string[] {
  const extras =
    key === 'relay'
      ? genesisNet().relay.extraArgs
      : genesisNet().parachains.find((p) => p.key === key)?.extraArgs ?? [];
  return overrideArgs(buildArgs(key, logTargets, enableHop), extras);
}

function tomlArgs(args: string[]): string {
  return '[' + args.map((a) => `"${a}"`).join(', ') + ']';
}

function genesisParachainSection(key: Parachain, title: string, args: string[]): string {
  const launch = `command = "{{SCRIPTS}}/omni-node.sh"${genesisCollatorEnv(key)}`;
  return `
## ${title}
[[parachains]]
id = ${paraIds()[key]}
cumulus_based = true
chain = "${genesisSpecOf(key).chainId}"
chain_spec_path = "{{BIN}}/${genesisSpecOf(key).file}"

[[parachains.collators]]
name = "${key}-collator1"
rpc_port = ${PORTS[key]}
p2p_port = ${P2P_PORTS[key]}
prometheus_port = ${prometheusPort(PORTS[key])}
${launch}
args = ${tomlArgs(args)}
${rpcNodeBlocks(genesisChainOf(key) as NetworkParachain, args, launch)}`;
}

function validatorNodes(count: number): string {
  return VALIDATORS.slice(0, count)
    .map(
      (v, i) => `
[[relaychain.nodes]]
name = "${v}-${genesisConfig().validatorNameSuffix}"
validator = true
rpc_port = ${RELAY_BASE_PORT + i}${i === 0 ? `\np2p_port = ${P2P_PORTS.relay}` : ''}
prometheus_port = ${prometheusPort(RELAY_BASE_PORT + i)}
balance = 1000000000000000`
    )
    .join('\n');
}

/** Which parachains talk to each other. Both directions are opened for each pair. */
const HRMP_PAIRS: [Parachain, Parachain][] = [
  ['people', 'bulletin'],
  ['people', 'asset-hub'],
];

export interface HrmpChannel {
  sender: number;
  recipient: number;
  maxCapacity: number;
  maxMessageSize: number;
}

/**
 * The HRMP channels a network wants, in both directions. The genesis config declares them
 * and the force-open-hrmp service opens them on a running chain — from this one list, so
 * the two cannot disagree. `present` narrows it to a spawned subset.
 */
export function hrmpChannels(present?: Parachain[]): HrmpChannel[] {
  const have = new Set(present ?? genesisNet().parachains.map((p) => p.key));
  const ids = paraIds();
  const out: HrmpChannel[] = [];
  for (const [a, b] of HRMP_PAIRS) {
    if (!have.has(a) || !have.has(b)) continue;
    out.push({ sender: ids[a], recipient: ids[b], maxCapacity: 8, maxMessageSize: 1048576 });
    out.push({ sender: ids[b], recipient: ids[a], maxCapacity: 8, maxMessageSize: 1048576 });
  }
  return out;
}

function hrmpPair(idA: number, idB: number): string {
  return `
[[hrmp_channels]]
sender = ${idA}
recipient = ${idB}
max_capacity = 8
max_message_size = 1048576

[[hrmp_channels]]
sender = ${idB}
recipient = ${idA}
max_capacity = 8
max_message_size = 1048576`;
}

function calcValidatorCount(parachains: Parachain[] | null): number {
  const selected = new Set(
    (parachains || []).filter((p) => VALID_PARACHAINS.includes(p))
  );
  // Asset Hub's elastic scaling needs two extra validators for the extra cores. The
  // ceiling is what the descriptor says this network runs with.
  return Math.max(
    4,
    Math.min(genesisNet().relay.validators, selected.size + (selected.has('asset-hub') ? 2 : 0) + 1)
  );
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateOptions(options?: GenerateTomlOptions): void {
  if (!options) return;

  if (options.logTargets) {
    const validChains: ChainKey[] = ['relay', ...VALID_PARACHAINS];
    for (const [chain, targets] of Object.entries(options.logTargets)) {
      if (!validChains.includes(chain as ChainKey)) {
        throw new Error(`Unknown chain for log targets: ${chain}`);
      }
      if (typeof targets !== 'object' || targets === null) {
        throw new Error(`Log targets for "${chain}" must be an object`);
      }
      for (const [target, level] of Object.entries(targets)) {
        if (!/^[a-zA-Z0-9_:-]+$/.test(target)) {
          throw new Error(`Invalid log target name: ${target}`);
        }
        if (!/^[a-zA-Z0-9]+$/.test(level)) {
          throw new Error(`Invalid log level "${level}" for target "${target}"`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

function generateToml(parachains: Parachain[] | null, options: GenerateTomlOptions = {}): string {
  if (!parachains || parachains.length === 0) {
    throw new Error('At least one parachain must be selected');
  }
  const selected = new Set(parachains);
  for (const p of selected) {
    if (!VALID_PARACHAINS.includes(p)) throw new Error(`Unknown parachain: ${p}`);
  }

  validateOptions(options);

  const has = (name: Parachain) => selected.has(name);
  const both = (a: Parachain, b: Parachain) => has(a) && has(b);
  const lt = options.logTargets || {};

  const validatorCount = calcValidatorCount(parachains);

  const hasChannels = both('people', 'bulletin') || both('people', 'asset-hub');

  const relayArgsList = genesisChainArgs('relay', lt.relay);
  if (options.relayWasmOverrides) {
    relayArgsList.push(`--wasm-runtime-overrides=${options.relayWasmOverrides}`);
  }
  const relayArgs = tomlArgs(relayArgsList);

  const toml = `\
[settings]
timeout = 600
node_spawn_timeout = 240
${section(
  has('asset-hub'),
  `
# Elastic scaling: 2 extra cores for Asset Hub 2-second blocks
[relaychain.genesis.configuration.config.scheduler_params]
num_cores = 2
max_validators_per_core = 1
`
)}
[relaychain]
chain = "${genesisSpecOf('relay').chainId}"
chain_spec_path = "{{BIN}}/${genesisSpecOf('relay').file}"
default_command = "{{BIN}}/${genesisNet().relay.binary.name}"
default_args = ${relayArgs}
${validatorNodes(validatorCount)}
${section(
  has('asset-hub'),
  genesisParachainSection(
    'asset-hub',
    `Asset Hub Paseo Next (Parachain ${paraIds()['asset-hub']}) - Elastic Scaling with 2-second blocks`,
    genesisChainArgs('asset-hub', lt['asset-hub'])
  )
)}${section(
  has('people'),
  genesisParachainSection('people', `People Chain (Parachain ${paraIds().people})`, genesisChainArgs('people', lt.people))
)}${section(
  has('bulletin'),
  genesisParachainSection(
    'bulletin',
    `Bulletin Chain (Parachain ${paraIds().bulletin})`,
    genesisChainArgs('bulletin', lt.bulletin, options.enableHop)
  )
)}${section(
  has('web3-storage'),
  genesisParachainSection(
    'web3-storage',
    `Web3 Storage Chain (Parachain ${paraIds()['web3-storage']})`,
    genesisChainArgs('web3-storage', lt['web3-storage'])
  )
)}${section(both('people', 'bulletin'), hrmpPair(paraIds().people, paraIds().bulletin))}
${section(both('people', 'asset-hub'), hrmpPair(paraIds().people, paraIds()['asset-hub']))}
${section(
  has('asset-hub') && serviceEnabled('eth-rpc'),
  `
[[custom_processes]]
name = "eth-rpc"
command = "{{SCRIPTS}}/eth-rpc.sh"
`
)}${section(
  serviceEnabled('dashboard'),
  `
[[custom_processes]]
name = "dashboard"
command = "{{SCRIPTS}}/dashboard.sh"
`
)}${section(
  has('bulletin') && serviceEnabled('ipfs-daemon'),
  `
[[custom_processes]]
name = "ipfs-daemon"
command = "{{SCRIPTS}}/ipfs-daemon.sh"

[[custom_processes]]
name = "ipfs-swarm"
command = "{{SCRIPTS}}/ipfs-swarm.sh"
`
)}${section(
  has('web3-storage') && serviceEnabled('storage-provider-node'),
  `
[[custom_processes]]
name = "storage-provider-node"
command = "{{SCRIPTS}}/storage-provider-node.sh"
`
)}${section(
  hasChannels && serviceEnabled('force-open-hrmp'),
  `
[[custom_processes]]
name = "force-open-hrmp"
command = "{{SCRIPTS}}/force-open-hrmp.sh"
`
)}${section(
  has('people') && serviceEnabled('increase-people-lite-attestation-allowance'),
  `
[[custom_processes]]
name = "increase-people-lite-attestation-allowance"
command = "{{SCRIPTS}}/increase-people-lite-attestation-allowance.sh"
`
)}${section(
  has('people') && has('asset-hub') && serviceEnabled('increase-dotns-attestation-allowance'),
  `
[[custom_processes]]
name = "increase-dotns-attestation-allowance"
command = "{{SCRIPTS}}/increase-dotns-attestation-allowance.sh"
`
)}${section(
  has('people') && serviceEnabled('dub'),
  `
[[custom_processes]]
name = "grant-invites"
command = "{{SCRIPTS}}/grant-invites.sh"
`
)}${section(
  has('people') && serviceEnabled('dub'),
  dubCustomProcesses({
    postgres: requiredPort('DUB_POSTGRES_PORT'),
    people: PORTS.people,
    assetHub: PORTS['asset-hub'],
    gateway: requiredPort('DUB_PORT'),
  }, undefined, undefined, serviceEnabled('turn'))
)}
${section(serviceEnabled('patch-bootnodes'), `
[[custom_processes]]
name = "patch-bootnodes"
command = "{{SCRIPTS}}/patch-bootnodes.sh"
`)}
${section(serviceEnabled('trinity-stack'), `
[[custom_processes]]
name = "trinity-stack"
command = "{{SCRIPTS}}/trinity-stack.sh"
`)}
${section(serviceEnabled('pin-design-families'), `
[[custom_processes]]
name = "pin-design-families"
command = "{{SCRIPTS}}/pin-design-families.sh"
`)}${section(
  has('asset-hub') && serviceEnabled('assign-cores'),
  `
[[custom_processes]]
name = "assign-cores"
command = "{{SCRIPTS}}/assign-cores.sh"

[[custom_processes]]
name = "set-dispatcher-address"
command = "{{SCRIPTS}}/set-dispatcher-address.sh"
`
)}`;

  // Collapse 3+ consecutive blank lines into 2
  return toml.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

export {
  generateToml,
  calcValidatorCount,
  VALID_PARACHAINS,
  CHAIN_ARGS,
  P2P_PORTS,
  POPULAR_LOG_TARGETS,
  LOG_LEVELS,
  // Shared with fork-toml.ts so that fork mode and genesis mode cannot drift apart.
  VALIDATORS,
  relayNodeName,
  collatorNodeName,
  PORTS,
  paraIds,
  RELAY_BASE_PORT,
  buildArgs,
  addMissing,
  tomlArgs,
  requiredPort,
  prometheusPort,
  rpcNodePorts,
  rpcNodeBlocks,
};
