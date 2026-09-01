// Tests for packages/network-config/src/dashboard-model.ts
// Run with: tsx --test tests/dashboard-model.test.ts
//
// The model is the dashboard's whole contract: the SPA renders it, the local proxy routes by
// it, and the nginx generator emits location blocks from it. A wrong URL here is a wrong URL
// in every environment at once, which is why the two URL modes are pinned exactly.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dashboardModel, DASHBOARD_SCHEMA_VERSION } from '../src/dashboard-model.js';
import { loadDescriptorOnly } from '../src/load.js';

const net = () => loadDescriptorOnly('previewnet');

describe('dashboardModel — localhost mode', () => {
  const m = dashboardModel(net(), 'http://127.0.0.1:8090');

  it('is versioned', () => {
    assert.equal(m.schemaVersion, DASHBOARD_SCHEMA_VERSION);
  });

  it('emits every relay validator on the documented ports', () => {
    const relays = m.chains.filter((c) => c.paraId === null);
    assert.equal(relays.length, 6);
    assert.equal(relays[0].id, 'relay-alice');
    assert.equal(relays[0].path, '/relay/alice');
    assert.equal(relays[0].directUrl, 'ws://127.0.0.1:10000');
    assert.equal(relays[5].directUrl, 'ws://127.0.0.1:10005');
  });

  it('emits every parachain with its para id and port', () => {
    const ah = m.chains.find((c) => c.id === 'asset-hub')!;
    assert.equal(ah.paraId, 1500);
    assert.equal(ah.path, '/asset-hub');
    assert.equal(ah.directUrl, 'ws://127.0.0.1:10020');
  });

  it('path URLs ride the base URL with a ws scheme', () => {
    const ah = m.chains.find((c) => c.id === 'asset-hub')!;
    assert.equal(ah.url, 'ws://127.0.0.1:8090/asset-hub');
  });

  it('deep links target the path URL, encoded', () => {
    const alice = m.chains.find((c) => c.id === 'relay-alice')!;
    assert.match(alice.links.pjs, /^https:\/\/polkadot\.js\.org\/apps\/\?rpc=ws%3A%2F%2F127\.0\.0\.1%3A8090%2Frelay%2Falice/);
    assert.match(alice.links.papi, /endpoint=ws%3A%2F%2F/);
  });

  it('the ipfs gateway keeps its path prefix, and its URL ends where the CID goes', () => {
    const ipfs = m.services.find((s) => s.id === 'ipfs-daemon')!;
    assert.equal(ipfs.keepPrefix, true);
    assert.match(ipfs.url, /\/ipfs\/$/);
    assert.match(ipfs.directUrl, /\/ipfs\/$/);
    // everything else strips: mounted at / upstream
    assert.ok(m.chains.every((c) => !c.keepPrefix));
  });

  it('emits the services with health descriptors', () => {
    const eth = m.services.find((s) => s.id === 'eth-rpc')!;
    assert.equal(eth.directUrl, 'http://127.0.0.1:8545');
    assert.deepEqual(eth.health, { kind: 'http', path: '/health' });
    const dub = m.services.find((s) => s.id === 'dub')!;
    assert.equal(dub.links.docs, 'http://127.0.0.1:8090/dub/docs');
  });

  // The old landing page published these for smoldot; losing them would drop a working,
  // publicly-served capability. Which basename exists is per-mode, so the model offers
  // candidates and the sidecar resolves them against the data directory.
  it('every chain offers its spec basenames, genesis id first', () => {
    const relay = m.chains.find((c) => c.id === 'relay-alice')!;
    assert.deepEqual(relay.specCandidates, ['paseo-local', 'paseo']);
    const ah = m.chains.find((c) => c.id === 'asset-hub')!;
    assert.deepEqual(ah.specCandidates, ['asset-hub-local', 'asset-hub']);
  });

  it('dub carries the integrator links the old page listed', () => {
    const dub = m.services.find((s) => s.id === 'dub')!;
    assert.deepEqual(Object.keys(dub.links).sort(), ['attester', 'docs', 'jwks', 'readyz']);
    assert.match(dub.links.jwks, /\/dub\/\.well-known\/jwks\.json$/);
  });

  it('the log whitelist is exactly the chains and services', () => {
    assert.deepEqual(
      [...m.logs].sort(),
      [...m.chains.map((c) => c.id), ...m.services.map((s) => s.id)].sort()
    );
  });
});

describe('dashboardModel — domain mode', () => {
  const m = dashboardModel(net(), 'https://previewnet.substrate.dev/');

  it('normalises the trailing slash and upgrades ws to wss', () => {
    assert.equal(m.baseUrl, 'https://previewnet.substrate.dev');
    const ah = m.chains.find((c) => c.id === 'asset-hub')!;
    assert.equal(ah.url, 'wss://previewnet.substrate.dev/asset-hub');
  });

  it('direct URLs stay loopback — they are the on-box address, whatever the domain', () => {
    const ah = m.chains.find((c) => c.id === 'asset-hub')!;
    assert.equal(ah.directUrl, 'ws://127.0.0.1:10020');
  });
});

describe('dashboardModel — services follow their chains', () => {
  // devnet runs no web3-storage parachain, so it runs no storage provider: rendering one
  // shows a permanently-down service the network never had. Same gate the spawn applies.
  it('a service whose chain is absent is not emitted', () => {
    const devnet = loadDescriptorOnly('devnet');
    const m = dashboardModel(devnet, 'http://127.0.0.1:8090');
    assert.equal(m.services.find((s) => s.id === 'storage-provider-node'), undefined);
    // devnet does run people, so dub stays.
    assert.ok(m.services.find((s) => s.id === 'dub'));
  });

  it('previewnet, with every chain, emits every service', () => {
    const m = dashboardModel(net(), 'http://127.0.0.1:8090');
    assert.deepEqual(
      m.services.map((s) => s.id).sort(),
      ['dub', 'eth-rpc', 'ipfs-daemon', 'storage-provider-node']
    );
  });
});

describe('dashboardModel — descriptor is the authority', () => {
  it('a disabled service is not emitted', () => {
    const d = net();
    (d.services as Record<string, unknown>)['eth-rpc'] = false;
    const m = dashboardModel(d, 'http://127.0.0.1:8090');
    assert.equal(m.services.find((s) => s.id === 'eth-rpc'), undefined);
    // and therefore not in the log whitelist either
    assert.ok(!m.logs.includes('eth-rpc'));
  });

  it('a relay running fewer validators emits fewer relay entries', () => {
    const d = net();
    d.relay.validators = 3;
    const m = dashboardModel(d, 'http://127.0.0.1:8090');
    assert.equal(m.chains.filter((c) => c.paraId === null).length, 3);
  });
});
