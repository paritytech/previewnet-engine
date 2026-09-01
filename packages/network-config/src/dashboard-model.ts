// The dashboard's contract: everything a UI needs to render a network, as one document.
//
// This is the single source the dashboard service serves, the SPA renders, the local proxy
// routes by, and the nginx generator emits location blocks from. Nothing downstream may know
// a chain, port, or path this file did not tell it — that rule is what stopped the old
// hand-maintained trio (index.html, nginx template, spawn.html) from ever agreeing.
//
// Pure: no I/O, no environment reads. Callers hand in the loaded network and the base URL,
// which is the one thing that differs per environment (127.0.0.1 vs a domain).

import type { NetworkDef, Parachain } from './networks.js';
import { PORTS, RELAY_BASE_PORT, VALIDATORS, requiredPort } from './toml-generator.js';

/** Bumped when the shape changes incompatibly. Renderers support N and N-1. */
export const DASHBOARD_SCHEMA_VERSION = 1;

export interface DashboardEndpoint {
  /** Stable id — also the log-stream id where a log exists. */
  id: string;
  label: string;
  /** Route path on a domain (`/relay/alice`); also what the local proxy serves. */
  path: string;
  /** Local port the path proxies to. */
  port: number;
  /** 'ws' endpoints speak substrate RPC; 'http' are plain web services. */
  protocol: 'ws' | 'http';
  /** Full URLs, precomputed so no renderer ever assembles one. */
  url: string;
  directUrl: string;
  /** How to probe it. rpc = chain head via WS; http = GET path expecting 200. */
  health: { kind: 'rpc' } | { kind: 'http'; path: string } | null;
  /**
   * Whether a proxy forwards the route's path prefix to the upstream. Chains and most
   * services are mounted at / upstream, so the prefix is stripped; kubo's gateway serves
   * /ipfs/<cid> itself and 404s without it. nginx encodes the same fact per location.
   */
  keepPrefix?: boolean;
  /** Extra links (pjs/papi consoles, docs), keyed by kind. */
  links: Record<string, string>;
  /**
   * Chain-spec basenames this chain might publish, most specific first. Genesis names its
   * spec after the chain id (paseo-local); a fork carries the source's (paseo). Which one
   * exists is a fact about the running network's data directory, so the sidecar resolves
   * these to a `spec` link and drops the ones with no file — a dead download link on a
   * light-client page is worse than none.
   */
  specCandidates?: string[];
}

export interface DashboardChain extends DashboardEndpoint {
  paraId: number | null;
}

export interface DashboardModel {
  schemaVersion: number;
  network: {
    name: string;
    displayName: string;
    genesis: boolean;
  };
  baseUrl: string;
  chains: DashboardChain[];
  services: DashboardEndpoint[];
  /** Ids whose logs the dashboard may stream — the whitelist, nothing else is served. */
  logs: string[];
}

/** ws:// or wss:// according to the base URL's scheme. */
function wsUrl(baseUrl: string, path: string): string {
  return baseUrl.replace(/^http/, 'ws') + path;
}

/** Distinct, defined spec basenames, genesis id first. */
function specNamesOf(...names: (string | undefined)[]): string[] {
  return [...new Set(names.filter((n): n is string => Boolean(n)))];
}

function chainLinks(url: string): Record<string, string> {
  return {
    pjs: `https://polkadot.js.org/apps/?rpc=${encodeURIComponent(url)}#/explorer`,
    papi: `https://dev.papi.how/explorer#networkId=custom&endpoint=${encodeURIComponent(url)}`,
  };
}

/**
 * Whether URLs are path-style (behind a domain / the local proxy) is decided by the caller
 * through `baseUrl` alone: the model always emits both the path URL and the direct port URL,
 * and the renderer chooses which to feature.
 */
export function dashboardModel(net: NetworkDef, baseUrl: string): DashboardModel {
  const base = baseUrl.replace(/\/$/, '');
  const chains: DashboardChain[] = [];

  // Relay validators. Only the ones this network runs (a fork may run fewer than six).
  for (let i = 0; i < net.relay.validators; i++) {
    const name = VALIDATORS[i];
    const path = `/relay/${name}`;
    const port = RELAY_BASE_PORT + i;
    const url = wsUrl(base, path);
    chains.push({
      id: `relay-${name}`,
      label: `Relay ${name[0].toUpperCase()}${name.slice(1)}`,
      paraId: null,
      path,
      port,
      protocol: 'ws',
      url,
      directUrl: `ws://127.0.0.1:${port}`,
      health: { kind: 'rpc' },
      links: chainLinks(url),
      specCandidates: specNamesOf(net.relay.genesisSpec?.chainId, net.relay.spec),
    });
  }

  for (const p of net.parachains) {
    const path = `/${p.key}`;
    const port = PORTS[p.key as Parachain];
    const url = wsUrl(base, path);
    chains.push({
      id: p.key,
      label: `${p.key} (${p.paraId})`,
      paraId: p.paraId,
      path,
      port,
      protocol: 'ws',
      url,
      directUrl: `ws://127.0.0.1:${port}`,
      health: { kind: 'rpc' },
      links: chainLinks(url),
      specCandidates: specNamesOf(p.genesisSpec?.chainId, p.spec),
    });
  }

  // Services: emitted only when the descriptor has not switched them off AND the chain they
  // serve is part of this network — the same gates the spawn applies (fork-toml's
  // PROCESS_GATES), or the UI shows a permanently-down service the network never runs:
  // devnet has no web3-storage parachain, so it has no storage provider either.
  const present = new Set(net.parachains.map((p) => p.key));
  const services: DashboardEndpoint[] = [];
  const service = (
    id: string,
    label: string,
    path: string,
    portKey: string,
    health: DashboardEndpoint['health'],
    links: Record<string, string> = {},
    needs?: Parachain
  ) => {
    if (net.services[id] === false) return;
    if (needs && !present.has(needs)) return;
    const port = requiredPort(portKey);
    services.push({
      id,
      label,
      path,
      port,
      protocol: 'http',
      url: base + path,
      directUrl: `http://127.0.0.1:${port}`,
      health,
      links,
    });
  };

  service('eth-rpc', 'Ethereum RPC', '/eth-rpc', 'ETH_RPC_PORT', { kind: 'http', path: '/health' }, {}, 'asset-hub');
  service('ipfs-daemon', 'IPFS Gateway', '/ipfs', 'IPFS_GATEWAY_PORT', null, {}, 'bulletin');
  {
    const ipfs = services[services.length - 1];
    if (ipfs && ipfs.id === 'ipfs-daemon') {
      // kubo serves /ipfs/<cid> itself: proxies forward the prefix, and the URL a user
      // copies should end where the CID goes.
      ipfs.keepPrefix = true;
      ipfs.url = `${base}/ipfs/`;
      ipfs.directUrl = `http://127.0.0.1:${ipfs.port}/ipfs/`;
    }
  }
  service('storage-provider-node', 'Web3 Storage Provider', '/web3-storage-provider',
    'WEB3_STORAGE_PROVIDER_PORT', { kind: 'http', path: '/health' }, {}, 'web3-storage');
  // The links an integrator actually reaches for — the old landing page listed all four.
  service('dub', 'Device Uniqueness Backend', '/dub', 'DUB_PORT',
    { kind: 'http', path: '/readyz' },
    {
      docs: `${base}/dub/docs`,
      readyz: `${base}/dub/readyz`,
      jwks: `${base}/dub/.well-known/jwks.json`,
      attester: `${base}/dub/api/v1/attester`,
    },
    'people');

  return {
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    network: { name: net.name, displayName: net.displayName, genesis: net.genesis },
    baseUrl: base,
    chains,
    services,
    logs: [...chains.map((c) => c.id), ...services.map((s) => s.id)],
  };
}
