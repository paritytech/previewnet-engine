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
import { DEFAULT_NETWORK, type NetworkDef } from './networks.js';
import { loadNetwork } from './load.js';
import { dubCustomProcesses } from './dub.js';

const VALIDATORS = ['alice', 'bob', 'charlie', 'dave', 'eve', 'ferdie'] as const;

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
       '--experimental-webrtc',
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
      '--unsafe-rpc-external',
      '--rpc-max-response-size=50',
      '--experimental-webrtc',
      `--listen-addr=/ip4/${P2P_LISTEN_IP}/udp/${P2P_PORTS['bulletin']}/webrtc-direct`,
    ],
    defaultLogs: { parachain: 'debug', xcm: 'trace' },
  },
  'web3-storage': {
    required: [
      '--collator',
      '--rpc-max-connections=500',
      '--unsafe-rpc-external',
      '--rpc-max-response-size=50',
      '--experimental-webrtc',
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

// Append only flags the base list has not already set, so the shared per-key table
// wins over descriptor extras and fork defaults rather than being specified twice.
function addMissing(args: string[], extra: string[]): string[] {
  const flag = (a: string) => a.split('=')[0];
  const present = new Set(args.map(flag));
  return [...args, ...extra.filter((a) => !present.has(flag(a)))];
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
  return addMissing(buildArgs(key, logTargets, enableHop), extras);
}

function tomlArgs(args: string[]): string {
  return '[' + args.map((a) => `"${a}"`).join(', ') + ']';
}

function validatorNodes(count: number): string {
  return VALIDATORS.slice(0, count)
    .map(
      (v, i) => `
[[relaychain.nodes]]
name = "${v}-${genesisConfig().validatorNameSuffix}"
validator = true
rpc_port = ${RELAY_BASE_PORT + i}${i === 0 ? `\np2p_port = ${P2P_PORTS.relay}` : ''}
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
  `
## Asset Hub Paseo Next (Parachain ${paraIds()['asset-hub']}) - Elastic Scaling with 2-second blocks
[[parachains]]
id = ${paraIds()['asset-hub']}
cumulus_based = true
chain = "${genesisSpecOf('asset-hub').chainId}"
chain_spec_path = "{{BIN}}/${genesisSpecOf('asset-hub').file}"

[[parachains.collators]]
name = "asset-hub-collator1"
rpc_port = ${PORTS['asset-hub']}
p2p_port = ${P2P_PORTS['asset-hub']}${genesisCollatorEnv('asset-hub')}
command = "{{SCRIPTS}}/omni-node.sh"
args = ${tomlArgs(genesisChainArgs('asset-hub', lt['asset-hub']))}
`
)}${section(
  has('people'),
  `
## People Chain (Parachain ${paraIds().people})
[[parachains]]
id = ${paraIds().people}
cumulus_based = true
chain = "${genesisSpecOf('people').chainId}"
chain_spec_path = "{{BIN}}/${genesisSpecOf('people').file}"

[[parachains.collators]]
name = "people-collator1"
rpc_port = ${PORTS.people}
p2p_port = ${P2P_PORTS.people}${genesisCollatorEnv('people')}
command = "{{SCRIPTS}}/omni-node.sh"
args = ${tomlArgs(genesisChainArgs('people', lt.people))}
`
)}${section(
  has('bulletin'),
  `
## Bulletin Chain (Parachain ${paraIds().bulletin})
[[parachains]]
id = ${paraIds().bulletin}
cumulus_based = true
chain = "${genesisSpecOf('bulletin').chainId}"
chain_spec_path = "{{BIN}}/${genesisSpecOf('bulletin').file}"

[[parachains.collators]]
name = "bulletin-collator1"
rpc_port = ${PORTS.bulletin}
p2p_port = ${P2P_PORTS.bulletin}${genesisCollatorEnv('bulletin')}
command = "{{SCRIPTS}}/omni-node.sh"
args = ${tomlArgs(genesisChainArgs('bulletin', lt.bulletin, options.enableHop))}
`
)}${section(
  has('web3-storage'),
  `
## Web3 Storage Chain (Parachain ${paraIds()['web3-storage']})
[[parachains]]
id = ${paraIds()['web3-storage']}
cumulus_based = true
chain = "${genesisSpecOf('web3-storage').chainId}"
chain_spec_path = "{{BIN}}/${genesisSpecOf('web3-storage').file}"

[[parachains.collators]]
name = "web3-storage-collator1"
rpc_port = ${PORTS['web3-storage']}
p2p_port = ${P2P_PORTS['web3-storage']}${genesisCollatorEnv('web3-storage')}
command = "{{SCRIPTS}}/omni-node.sh"
args = ${tomlArgs(genesisChainArgs('web3-storage', lt['web3-storage']))}
`
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
  })
)}
${section(serviceEnabled('patch-bootnodes'), `
[[custom_processes]]
name = "patch-bootnodes"
command = "{{SCRIPTS}}/patch-bootnodes.sh"
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
  PORTS,
  paraIds,
  RELAY_BASE_PORT,
  buildArgs,
  addMissing,
  tomlArgs,
  requiredPort,
};
