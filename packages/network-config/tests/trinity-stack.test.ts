// Tests for packages/network-config/src/trinity-stack.ts
// Run with: tsx --test tests/trinity-stack.test.ts
//
// The descriptor is what a host imports to reach the network, so a wrong URL or a missing
// chain here is a stack nobody can use. The previewnet case is pinned whole against the
// RFC's example; forks are pinned on what makes them a fork.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dashboardModel } from '../src/dashboard-model.js';
import { loadDescriptorOnly } from '../src/load.js';
import {
  foreignBootnodes,
  lightClientBootnode,
  lightSpec,
  trinityStackModel,
  trinityStackUrl,
  type StackFacts,
} from '../src/trinity-stack.js';

const BASE = 'https://previewnet.substrate.dev';
const hash = (digit: number) => `0x${String(digit).repeat(64)}`;
const facts = (extra: Partial<StackFacts> = {}): StackFacts => ({
  chains: {
    relay: { genesisHash: hash(1), forkedAt: { number: 10, hash: hash(6) } },
    'asset-hub': { genesisHash: hash(2), forkedAt: { number: 20, hash: hash(7) } },
    people: { genesisHash: hash(3), forkedAt: { number: 30, hash: hash(8) } },
    bulletin: { genesisHash: hash(4), forkedAt: { number: 40, hash: hash(9) } },
    'web3-storage': { genesisHash: hash(5), forkedAt: { number: 50, hash: hash(0) } },
  },
  ethChainId: 420420417,
  ...extra,
});

describe('trinityStackModel — previewnet', () => {
  const net = loadDescriptorOnly('previewnet');
  const stack = trinityStackModel(net, dashboardModel(net, BASE), facts());

  it('describes every chain and service the network runs', () => {
    const relays = ['alice', 'bob', 'charlie', 'dave', 'eve', 'ferdie'].map((v) => `wss://previewnet.substrate.dev/relay/${v}`);
    assert.deepEqual(stack, {
      id: 'previewnet',
      name: 'Previewnet',
      network: 'paseo',
      tld: 'testnet',
      chains: [
        { role: 'Relay', genesisHash: hash(1), rpc: relays },
        { role: 'AssetHub', genesisHash: hash(2), paraId: 1500, rpc: [`${BASE.replace('https', 'wss')}/asset-hub`] },
        { role: 'People', genesisHash: hash(3), paraId: 1502, rpc: [`${BASE.replace('https', 'wss')}/people`], statementStore: true },
        { role: 'Bulletin', genesisHash: hash(4), paraId: 1501, rpc: [`${BASE.replace('https', 'wss')}/bulletin`] },
        { role: 'Web3Storage', genesisHash: hash(5), paraId: 1600, rpc: [`${BASE.replace('https', 'wss')}/web3-storage`] },
      ],
      services: [
        { kind: 'dub', urls: [`${BASE}/dub/`] },
        { kind: 'turn', urls: [`${BASE}/dub/`] },
        { kind: 'stun', urls: ['stun:previewnet.substrate.dev:3478'] },
        { kind: 'ipfs-gateway', urls: [`${BASE}/ipfs/`] },
        { kind: 'hop', urls: ['wss://previewnet.substrate.dev/bulletin'] },
        { kind: 'eth-rpc', urls: [`${BASE}/eth-rpc`], chainId: 420420417 },
        { kind: 'storage-provider', urls: [`${BASE}/web3-storage-provider/`] },
      ],
    });
  });

  it('adds the faucet and lifetimes a deployment configures', () => {
    const configured = trinityStackModel(
      net,
      dashboardModel(net, BASE),
      facts({ faucet: 'https://faucet.example', expiresAt: 2000000000, validUntil: 1900000000 })
    );
    assert.deepEqual(configured.services.at(-1), { kind: 'faucet', urls: ['https://faucet.example/'] });
    assert.equal(configured.expiresAt, 2000000000);
    assert.equal(configured.validUntil, 1900000000);
  });
});

describe('trinityStackModel — forks', () => {
  it('names a fork as one and points at its source', () => {
    const net = loadDescriptorOnly('previewnet');
    const stack = trinityStackModel(net, dashboardModel(net, 'http://127.0.0.1:8090'), facts({ forkAt: 1800000000 }));
    assert.equal(stack.id, 'previewnet-fork');
    assert.equal(stack.name, 'Fork of Previewnet');
    assert.deepEqual(stack.fork, {
      of: { url: 'https://previewnet.substrate.dev/.well-known/trinity-stack.json' },
      at: 1800000000,
    });
    assert.deepEqual(stack.chains.map((c) => c.forkedAt?.number), [10, 20, 30, 40, 50]);
  });

  it('leaves out fork and forkedAt when the source publishes no descriptor', () => {
    const net = { ...loadDescriptorOnly('previewnet'), stack: undefined };
    const stack = trinityStackModel(net, dashboardModel(net, 'http://127.0.0.1:8090'), facts({ forkAt: 1800000000 }));
    assert.equal(stack.fork, undefined);
    assert.ok(stack.chains.every((c) => c.forkedAt === undefined));
  });

  it('refuses a network with no TLD', () => {
    const net = loadDescriptorOnly('devnet');
    assert.throws(() => trinityStackModel(net, dashboardModel(net, 'http://127.0.0.1:8090'), facts()), /no stack\.tld/);
  });
});

describe('light specs', () => {
  it('dials nginx TLS ports behind https and the node WS ports otherwise', () => {
    assert.equal(lightClientBootnode(BASE, 'relay', 'PEER'), '/dns4/previewnet.substrate.dev/tcp/31334/wss/p2p/PEER');
    assert.equal(lightClientBootnode('http://127.0.0.1:8090', 'people', 'PEER'), '/ip4/127.0.0.1/tcp/30336/ws/p2p/PEER');
  });

  it('replaces the genesis storage, the bootnodes and adds a checkpoint', () => {
    const full = { id: 'paseo-local', bootNodes: ['/ip4/127.0.0.1/tcp/1/ws/p2p/A'], genesis: { raw: { top: {} } } };
    assert.deepEqual(lightSpec(full, hash(1), ['/dns4/h/tcp/2/wss/p2p/A'], { finalizedBlockHeader: '0x' }), {
      id: 'paseo-local',
      bootNodes: ['/dns4/h/tcp/2/wss/p2p/A'],
      genesis: { stateRootHash: hash(1) },
      lightSyncState: { finalizedBlockHeader: '0x' },
    });
  });

  it("finds a source network's bootnodes left in a fork's spec", () => {
    const nodes = ['/dns4/previewnet.substrate.dev/tcp/30334/ws/p2p/A', '/dns/rpc.polkadot.io/tcp/30333/p2p/B', '/ip4/127.0.0.1/tcp/1/ws/p2p/C'];
    assert.deepEqual(foreignBootnodes(nodes, ['previewnet.substrate.dev', '127.0.0.1']), [nodes[1]]);
  });

  it('serves the descriptor at its well-known path', () => {
    assert.equal(trinityStackUrl(`${BASE}/`), `${BASE}/.well-known/trinity-stack.json`);
  });
});
