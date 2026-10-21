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
import { trinityStackModel, trinityStackUrl, type StackFacts } from '../src/trinity-stack.js';

const BASE = 'https://previewnet.substrate.dev';
const WSS = 'wss://previewnet.substrate.dev';
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
  forked: false,
  ...extra,
});

describe('trinityStackModel — previewnet', () => {
  const net = loadDescriptorOnly('previewnet');
  const model = dashboardModel(net, BASE);

  it('describes every chain and service the network runs', () => {
    const relays = ['alice', 'bob', 'charlie', 'dave', 'eve', 'ferdie'].map((v) => `${WSS}/relay/${v}`);
    assert.deepEqual(trinityStackModel(net, model, facts()), {
      id: 'previewnet',
      name: 'Previewnet',
      network: 'paseo',
      tld: 'testnet',
      chains: [
        { role: 'Relay', genesisHash: hash(1), rpc: relays },
        { role: 'AssetHub', genesisHash: hash(2), paraId: 1500, rpc: [`${WSS}/asset-hub`] },
        { role: 'People', genesisHash: hash(3), paraId: 1502, rpc: [`${WSS}/people`], statementStore: true },
        { role: 'Bulletin', genesisHash: hash(4), paraId: 1501, rpc: [`${WSS}/bulletin`] },
        { role: 'Web3Storage', genesisHash: hash(5), paraId: 1600, rpc: [`${WSS}/web3-storage`] },
      ],
      services: [
        { kind: 'dub', urls: [`${BASE}/dub/`] },
        { kind: 'turn', urls: [`${BASE}/dub/`] },
        { kind: 'stun', urls: ['stun:previewnet.substrate.dev:3478'] },
        { kind: 'ipfs-gateway', urls: [`${BASE}/ipfs/`] },
        { kind: 'hop', urls: [`${WSS}/bulletin`] },
        { kind: 'eth-rpc', urls: [`${BASE}/eth-rpc`], chainId: 420420417 },
        { kind: 'storage-provider', urls: [`${BASE}/web3-storage-provider/`] },
      ],
    });
  });

  it('leaves eth-rpc out while its chain id is unknown, since readers require one', () => {
    const stack = trinityStackModel(net, model, facts({ ethChainId: undefined }));
    assert.equal(stack.services.find((s) => s.kind === 'eth-rpc'), undefined);
  });

  it('adds the faucet and lifetimes a deployment configures', () => {
    const configured = trinityStackModel(
      net,
      model,
      facts({ faucet: 'https://faucet.example', expiresAt: 2000000000, validUntil: 1900000000 })
    );
    assert.deepEqual(configured.services.at(-1), { kind: 'faucet', urls: ['https://faucet.example/'] });
    assert.equal(configured.expiresAt, 2000000000);
    assert.equal(configured.validUntil, 1900000000);
  });
});

describe('trinityStackModel — forks', () => {
  const net = loadDescriptorOnly('previewnet');
  const model = dashboardModel(net, 'http://127.0.0.1:8090');

  it('names a fork as one and points at its source', () => {
    const stack = trinityStackModel(net, model, facts({ forked: true, forkAt: 1800000000 }));
    assert.equal(stack.id, 'previewnet-fork');
    assert.equal(stack.name, 'Fork of Previewnet');
    assert.deepEqual(stack.fork, {
      of: { url: 'https://previewnet.substrate.dev/.well-known/trinity-stack.json' },
      at: 1800000000,
    });
    assert.deepEqual(stack.chains.map((c) => c.forkedAt?.number), [10, 20, 30, 40, 50]);
  });

  it('still names a fork as one when the bite was not recorded', () => {
    const stack = trinityStackModel(net, model, facts({ forked: true }));
    assert.equal(stack.id, 'previewnet-fork');
    assert.equal(stack.fork, undefined);
    assert.ok(stack.chains.every((c) => c.forkedAt === undefined));
  });

  it('leaves out fork and forkedAt when the source publishes no descriptor', () => {
    const unpublished = { ...net, stack: undefined };
    const stack = trinityStackModel(unpublished, model, facts({ forked: true, forkAt: 1800000000 }));
    assert.equal(stack.fork, undefined);
    assert.ok(stack.chains.every((c) => c.forkedAt === undefined));
  });

  it('refuses a network with no TLD', () => {
    const devnet = loadDescriptorOnly('devnet');
    assert.throws(() => trinityStackModel(devnet, dashboardModel(devnet, 'http://127.0.0.1:8090'), facts()), /no stack\.tld/);
  });

  it('serves the descriptor at its well-known path', () => {
    assert.equal(trinityStackUrl(`${BASE}/`), `${BASE}/.well-known/trinity-stack.json`);
  });
});
