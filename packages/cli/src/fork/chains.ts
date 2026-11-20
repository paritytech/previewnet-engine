// The chains a bite covers, derived from the selected network's descriptor
// (networks/<name>.json, selected via PPN_NETWORK, default previewnet).
//
// Para ids, bundle spec names and RPC endpoints all come from the descriptor — this file
// only reshapes them for the bite tooling. The `endpoint` field stays exactly what the
// descriptor says (a path under bite.source, or an absolute URL); resolve it with
// endpointOf() at the point of use, because bite.sh may override the base URL.

import { loadCurrentNetwork, endpointUrl, asHttp, type NetworkDef } from '@parity/ppn-network-config';
import type { AuraScheme, ChainKey, Parachain } from '@parity/ppn-network-config';

export interface ForkChain {
  key: ChainKey;
  /** File name inside the bundle, which differs from the key for People on previewnet. */
  spec: string;
  /** As written in the descriptor: a path under the source base URL, or an absolute URL. */
  endpoint: string;
  /** null for the relay chain. */
  paraId: number | null;
}

export interface ForkParachain extends ForkChain {
  key: Parachain;
  paraId: number;
  /** Curve this chain's Aura keys are on, as the descriptor declares it. */
  aura?: AuraScheme;
}

export function parachainsOf(net: NetworkDef): ForkParachain[] {
  return net.parachains.map((p) => ({
    key: p.key,
    spec: p.spec,
    endpoint: p.rpc,
    paraId: p.paraId,
    aura: p.aura,
  }));
}

export function chainsOf(net: NetworkDef): ForkChain[] {
  return [
    { key: 'relay', spec: net.relay.spec, endpoint: net.relay.rpc, paraId: null },
    ...parachainsOf(net),
  ];
}

/** Absolute http(s) JSON-RPC URL for a chain, resolved against an overridable base URL. */
export function endpointOf(chain: ForkChain, net: NetworkDef, baseUrl?: string): string {
  const resolved = /^(wss?|https?):\/\//.test(chain.endpoint)
    ? chain.endpoint
    : `${baseUrl ?? net.bite.source}/${chain.endpoint}`;
  return asHttp(resolved);
}

export { endpointUrl };

// The selected network's tables, resolved once at load — what cli.js and bite.sh consume.
export const NETWORK: NetworkDef = loadCurrentNetwork();
export const PARACHAINS: ForkParachain[] = parachainsOf(NETWORK);
export const CHAINS: ForkChain[] = chainsOf(NETWORK);
