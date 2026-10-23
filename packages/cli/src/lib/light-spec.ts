// Light-client chain specs for the Trinity stack descriptor. See docs/TRINITY-STACK.md.

import { P2P_PORTS, requiredPort, type ChainKey } from '@parity/ppn-network-config';

/** The TLS ports nginx terminates in front of each chain's P2P WS port, for browsers. */
const P2P_WSS_PORT_KEYS: Record<ChainKey, string> = {
  relay: 'RELAY_ALICE_P2P_WSS_PORT',
  'asset-hub': 'ASSET_HUB_P2P_WSS_PORT',
  people: 'PEOPLE_P2P_WSS_PORT',
  bulletin: 'BULLETIN_P2P_WSS_PORT',
  'web3-storage': 'WEB3_STORAGE_P2P_WSS_PORT',
};

const hostPart = (host: string) => (/^\d+\.\d+\.\d+\.\d+$/.test(host) ? `/ip4/${host}` : `/dns4/${host}`);

/**
 * Where a light client dials a chain's node: its P2P WS port on the advertised host, and behind
 * https also nginx's TLS port on the public host. A browser on an https page may dial only
 * `wss`, and native smoldot only `ws`, so each skips the address it cannot use.
 */
export function lightClientBootnodes(baseUrl: string, bootnodeHost: string, key: ChainKey, peerId: string): string[] {
  const url = new URL(baseUrl);
  const ws = `${hostPart(bootnodeHost)}/tcp/${P2P_PORTS[key]}/ws/p2p/${peerId}`;
  if (url.protocol !== 'https:') return [ws];
  return [ws, `${hostPart(url.hostname)}/tcp/${requiredPort(P2P_WSS_PORT_KEYS[key])}/wss/p2p/${peerId}`];
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
