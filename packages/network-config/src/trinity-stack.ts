// The running network as a Trinity stack descriptor: the one document hosts and tools read to
// reach it. See docs/TRINITY-STACK.md.
//
// Pure, like the dashboard model it is built from: `ppn service trinity-stack` gathers the
// live facts (genesis hashes, peer ids, the relay's checkpoint) and renders the result.

import type { DashboardModel } from './dashboard-model.js';
import type { ChainKey, NetworkDef } from './networks.js';
import { CHAIN_ARGS, P2P_PORTS, requiredPort } from './toml-generator.js';

/** RFC 0026 roles, plus Web3Storage, which serves tools. */
const ROLES: Record<ChainKey, string> = {
  relay: 'Relay',
  'asset-hub': 'AssetHub',
  people: 'People',
  bulletin: 'Bulletin',
  'web3-storage': 'Web3Storage',
};

/** The TLS ports nginx terminates in front of each chain's P2P WS port, for browsers. */
const P2P_WSS_PORT_KEYS: Record<ChainKey, string> = {
  relay: 'RELAY_ALICE_P2P_WSS_PORT',
  'asset-hub': 'ASSET_HUB_P2P_WSS_PORT',
  people: 'PEOPLE_P2P_WSS_PORT',
  bulletin: 'BULLETIN_P2P_WSS_PORT',
  'web3-storage': 'WEB3_STORAGE_P2P_WSS_PORT',
};

export interface StackSpecFile {
  url: string;
  sha256: string;
}

export interface StackChain {
  role: string;
  genesisHash: string;
  paraId?: number;
  rpc: string[];
  statementStore?: boolean;
  lightSpec?: StackSpecFile;
  fullSpec?: StackSpecFile;
  forkedAt?: { number: number; hash: string };
}

export interface StackService {
  kind: string;
  urls: string[];
  chainId?: number;
}

/** A descriptor without `$v`, `sequence` and `generation`, which publishing adds. */
export interface TrinityStackModel {
  id: string;
  name: string;
  network: string;
  tld: string;
  expiresAt?: number;
  validUntil?: number;
  fork?: { of: { url: string; key?: string }; at: number };
  chains: StackChain[];
  services: StackService[];
}

/** What only the running network knows, per chain key. */
export interface StackChainFacts {
  genesisHash: string;
  lightSpec?: StackSpecFile;
  fullSpec?: StackSpecFile;
  /** A fork's chains only: the source block the chain continues from. */
  forkedAt?: { number: number; hash: string };
}

export interface StackFacts {
  chains: Partial<Record<ChainKey, StackChainFacts>>;
  ethChainId?: number;
  /** A fork only: when it was bitten, in Unix seconds. */
  forkAt?: number;
  faucet?: string;
  expiresAt?: number;
  validUntil?: number;
}

/** The chain key a dashboard chain entry belongs to: every `relay-*` validator is the relay. */
function chainKey(id: string): ChainKey {
  return (id.startsWith('relay-') ? 'relay' : id) as ChainKey;
}

/** The URL a descriptor is served at, under the network's base URL. */
export function trinityStackUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/.well-known/trinity-stack.json`;
}

/**
 * The descriptor model of a running network.
 *
 * A fork is named as one, and carries `fork` and each chain's `forkedAt` only when the network
 * file says where the source publishes its own descriptor: `fork.of` is that pointer.
 */
export function trinityStackModel(
  net: NetworkDef,
  model: DashboardModel,
  facts: StackFacts
): TrinityStackModel {
  const tld = net.stack?.tld ?? net.genesisConfig?.networkSuffix;
  if (!tld) throw new Error(`networks/${net.name}.json has no stack.tld`);
  const forked = facts.forkAt !== undefined;
  const fork = forked && net.stack?.pointer ? { of: net.stack.pointer, at: facts.forkAt! } : undefined;

  const chains: StackChain[] = [];
  for (const entry of model.chains) {
    const key = chainKey(entry.id);
    const existing = chains.find((c) => c.role === ROLES[key]);
    if (existing) {
      existing.rpc.push(entry.url);
      continue;
    }
    const known = facts.chains[key];
    if (!known) throw new Error(`no genesis hash for ${key}`);
    chains.push({
      role: ROLES[key],
      genesisHash: known.genesisHash,
      ...(entry.paraId !== null && { paraId: entry.paraId }),
      rpc: [entry.url],
      ...(CHAIN_ARGS[key].required.includes('--enable-statement-store') && { statementStore: true }),
      ...(known.lightSpec && { lightSpec: known.lightSpec }),
      ...(known.fullSpec && { fullSpec: known.fullSpec }),
      ...(fork && known.forkedAt && { forkedAt: known.forkedAt }),
    });
  }

  const service = (id: string) => model.services.find((s) => s.id === id);
  const withSlash = (url: string) => (url.endsWith('/') ? url : `${url}/`);
  const services: StackService[] = [];
  const dub = service('dub');
  if (dub) services.push({ kind: 'dub', urls: [withSlash(dub.url)] });
  if (dub && model.ice) {
    services.push({ kind: 'turn', urls: [withSlash(dub.url)] });
    const stun = model.ice.servers.find((s) => s.id === 'stun');
    if (stun) services.push({ kind: 'stun', urls: [stun.url] });
  }
  const ipfs = service('ipfs-daemon');
  if (ipfs) services.push({ kind: 'ipfs-gateway', urls: [withSlash(ipfs.url)] });
  const bulletin = model.chains.find((c) => c.id === 'bulletin');
  if (bulletin) services.push({ kind: 'hop', urls: [bulletin.url] });
  const ethRpc = service('eth-rpc');
  if (ethRpc) {
    services.push({
      kind: 'eth-rpc',
      urls: [ethRpc.url],
      ...(facts.ethChainId !== undefined && { chainId: facts.ethChainId }),
    });
  }
  const storage = service('storage-provider-node');
  if (storage) services.push({ kind: 'storage-provider', urls: [withSlash(storage.url)] });
  if (facts.faucet) services.push({ kind: 'faucet', urls: [withSlash(facts.faucet)] });

  return {
    id: forked ? `${net.name}-fork` : net.name,
    name: forked ? `Fork of ${net.displayName}` : net.displayName,
    network: net.relay.chain,
    tld,
    ...(facts.expiresAt !== undefined && { expiresAt: facts.expiresAt }),
    ...(facts.validUntil !== undefined && { validUntil: facts.validUntil }),
    ...(fork && { fork }),
    chains,
    services,
  };
}

/**
 * Where a light client dials a chain's node. Behind https a browser may only dial `wss`, so
 * the address is nginx's TLS port for that chain; otherwise the node's own P2P WS port.
 */
export function lightClientBootnode(baseUrl: string, key: ChainKey, peerId: string): string {
  const url = new URL(baseUrl);
  const host = url.hostname;
  const hostPart = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? `/ip4/${host}` : `/dns4/${host}`;
  return url.protocol === 'https:'
    ? `${hostPart}/tcp/${requiredPort(P2P_WSS_PORT_KEYS[key])}/wss/p2p/${peerId}`
    : `${hostPart}/tcp/${P2P_PORTS[key]}/ws/p2p/${peerId}`;
}

/**
 * The light-client spec of a chain: the full spec with its genesis storage replaced by the
 * genesis state root, the given bootnodes and, for a relay, its sync checkpoint.
 */
export function lightSpec(
  full: Record<string, unknown>,
  stateRootHash: string,
  bootNodes: string[],
  lightSyncState?: unknown
): Record<string, unknown> {
  return {
    ...full,
    bootNodes,
    genesis: { stateRootHash },
    ...(lightSyncState !== undefined && { lightSyncState }),
  };
}

/**
 * The bootnodes on a host other than the given ones. A fork keeps its source's genesis hash, so
 * a spec that still names one of the source's nodes joins the source network and nothing in
 * the chain says so.
 */
export function foreignBootnodes(bootNodes: string[], hosts: string[]): string[] {
  return bootNodes.filter((addr) => {
    const host = /^\/(?:ip4|ip6|dns|dns4|dns6)\/([^/]+)\//.exec(addr)?.[1];
    return !host || !hosts.includes(host);
  });
}
