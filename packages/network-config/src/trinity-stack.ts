// The running network as a Trinity stack descriptor: the one document hosts and tools read to
// reach it. See docs/TRINITY-STACK.md.
//
// Pure, like the dashboard model it is built from: `ppn service trinity-stack` gathers the
// live facts (genesis hashes, the relay's checkpoint) and renders the result.

import type { Block, Chain, Model, Service, SpecFile } from '@parity/trinity-stack';
import type { DashboardModel } from './dashboard-model.js';
import type { ChainKey, NetworkDef } from './networks.js';
import { CHAIN_ARGS } from './toml-generator.js';

/** RFC 0026 roles, plus Web3Storage, which serves tools. */
const ROLES: Record<ChainKey, string> = {
  relay: 'Relay',
  'asset-hub': 'AssetHub',
  people: 'People',
  bulletin: 'Bulletin',
  'web3-storage': 'Web3Storage',
};

/** What only the running network knows about one chain. */
export interface StackChainFacts {
  genesisHash: string;
  lightSpec?: SpecFile;
  fullSpec?: SpecFile;
  /** A fork's chains only: the source block the chain continues from. */
  forkedAt?: Block;
}

export interface StackFacts {
  chains: Partial<Record<ChainKey, StackChainFacts>>;
  /** Left out while eth-rpc does not answer: a descriptor's eth-rpc entry needs it. */
  ethChainId?: number;
  /** The spawn continues from a bite rather than genesis. */
  forked: boolean;
  /** When it was bitten, in Unix seconds, when the spawn recorded it. */
  forkAt?: number;
  faucet?: string;
  expiresAt?: number;
  validUntil?: number;
}

/** The chain key a dashboard chain entry belongs to: every `relay-*` validator is the relay. */
export function chainKey(id: string): ChainKey {
  return (id.startsWith('relay-') ? 'relay' : id) as ChainKey;
}

/** The URL a descriptor is served at, under the network's base URL. */
export function trinityStackUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/.well-known/trinity-stack.json`;
}

/**
 * The descriptor model of a running network.
 *
 * A fork is always named as one. It carries `fork` and each chain's `forkedAt` only when the
 * bite time and every chain's source block are known, and the network file says where the
 * source publishes its own descriptor: `fork.of` is that pointer.
 */
export function trinityStackModel(net: NetworkDef, model: DashboardModel, facts: StackFacts): Model {
  const tld = net.stack?.tld ?? net.genesisConfig?.networkSuffix;
  if (!tld) throw new Error(`networks/${net.name}.json has no stack.tld`);
  // `fork` requires `forkedAt` on every chain, so it is all or nothing.
  const everyForkedAt = Object.values(facts.chains).every((c) => c?.forkedAt);
  const fork =
    facts.forked && facts.forkAt !== undefined && everyForkedAt && net.stack?.pointer
      ? { of: net.stack.pointer, at: facts.forkAt }
      : undefined;

  const chains: Chain[] = [];
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
  const services: Service[] = [];
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
  if (ethRpc && facts.ethChainId !== undefined) {
    services.push({ kind: 'eth-rpc', urls: [ethRpc.url], chainId: facts.ethChainId });
  }
  const storage = service('storage-provider-node');
  if (storage) services.push({ kind: 'storage-provider', urls: [withSlash(storage.url)] });
  if (facts.faucet) services.push({ kind: 'faucet', urls: [withSlash(facts.faucet)] });

  return {
    id: facts.forked ? `${net.name}-fork` : net.name,
    name: facts.forked ? `Fork of ${net.displayName}` : net.displayName,
    network: net.relay.chain,
    tld,
    ...(facts.expiresAt !== undefined && { expiresAt: facts.expiresAt }),
    ...(facts.validUntil !== undefined && { validUntil: facts.validUntil }),
    ...(fork && { fork }),
    chains,
    services,
  };
}
