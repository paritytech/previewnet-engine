// Tests for packages/network-config/src/networks.ts and the checked-in descriptors under networks/.
// Run with: tsx --test packages/network-config/tests/networks.test.ts

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  listNetworks,
  currentNetworkName,
  networkBinaries,
  networkRuntimes,
  endpointUrl,
  specSourceUrl,
  asHttp,
  asWs,
  DEFAULT_NETWORK,
} from '../src/networks.js';
import { loadNetwork } from '../src/load.js';
import { pinsProducts } from '../src/fork-toml.js';
import { paraIds, VALID_PARACHAINS } from '../src/toml-generator.js';

describe('network descriptors', () => {
  it('every checked-in descriptor loads and validates', () => {
    const names = listNetworks();
    assert.ok(names.includes('previewnet'));
    for (const name of names) {
      const net = loadNetwork(name);
      assert.equal(net.name, name);
      assert.ok(net.parachains.length >= 1);
    }
  });

  // Previewnet is the network this repo builds; its descriptor restates what the rest of
  // the codebase hardcodes, and this is what keeps the two from drifting.
  it('previewnet matches the hardcoded tables and carries no stubs', () => {
    const net = loadNetwork('previewnet');
    assert.equal(net.genesis, true);
    assert.equal(net.sudo, true);
    assert.equal(net.bite.prebaked, true);
    assert.equal(net.bite.source, 'https://previewnet.substrate.dev');
    assert.deepEqual(net.todos, [], 'previewnet must not be a stub');
    // What tests/10-network-suffix.zndsl asserts the running chains report.
    assert.equal(net.genesisConfig?.networkSuffix, 'testnet');
    assert.deepEqual(
      [...net.parachains.map((p) => p.key)].sort(),
      [...VALID_PARACHAINS].sort()
    );
    for (const p of net.parachains) {
      assert.equal(p.paraId, paraIds()[p.key], `${p.key} para id drifted from ports.env`);
    }
    // The one place bundle spec name and chain key differ.
    assert.equal(net.parachains.find((p) => p.key === 'people')!.spec, 'individuality');
    assert.equal(net.relay.chain, 'paseo');
    assert.equal(net.relay.validators, 6);
  });

  // The rule this whole registry exists to encode.
  it('only previewnet is spawnable from genesis', () => {
    for (const name of listNetworks()) {
      assert.equal(loadNetwork(name).genesis, name === 'previewnet', name);
    }
  });

  // sharedRelay is what makes a fork of somebody else's relay work at all: without it the bite
  // leaves the inherited core layout and HRMP heads in place, our parachains sit on cores no
  // validator group is assigned to, and cumulus panics on `HRMP head mismatch`. previewnet's
  // relay is ours end to end, so it is the one network where the flag is wrong. Every other
  // network forks a relay it shares, and devnet was missing the flag entirely — a gap that
  // could only surface as an unfinalizing fork, and only once its bite blocker was lifted.
  it('every network but previewnet forks a shared relay', () => {
    for (const name of listNetworks()) {
      assert.equal(
        loadNetwork(name).bite.sharedRelay ?? false,
        name !== 'previewnet',
        `${name}: bite.sharedRelay`
      );
    }
  });

  // A no-sudo fork cannot be upgraded after the bite, so a runtime under test has to be
  // injected during the bite — CI cannot pre-bake that choice into a published bundle.
  it('no-sudo networks are never pre-bitten', () => {
    for (const name of listNetworks()) {
      const net = loadNetwork(name);
      if (!net.sudo) assert.equal(net.bite.prebaked, false, `${name} lacks sudo yet is prebaked`);
    }
  });

  it('every parachain key is one the port table knows', () => {
    for (const name of listNetworks()) {
      for (const p of loadNetwork(name).parachains) {
        assert.ok(VALID_PARACHAINS.includes(p.key), `${name}/${p.key}`);
      }
    }
  });

  // Which binary each chain runs, and which release it comes from, is stated in the
  // descriptor — nothing is implied, and nothing resolves against versions.env.
  it('binds every chain to an explicit binary and a declared release', () => {
    for (const name of listNetworks()) {
      const net = loadNetwork(name);
      const check = (what: string, ref: { name: string; release: string }) => {
        assert.ok(ref?.name, `${name}/${what} must declare its binary`);
        assert.ok(net.releases[ref.release], `${name}/${what} release must be declared`);
      };
      check('relay', net.relay.binary);
      for (const p of net.parachains) check(p.key, p.binary);
      // Every resolved artifact carries a real repo and tag.
      for (const b of networkBinaries(net)) {
        assert.ok(b.repo && b.tag, `${name}/${b.name} must resolve to a repo and tag`);
      }
    }
  });

  it('resolves previewnet to its full artifact set', () => {
    const net = loadNetwork('previewnet');
    assert.equal(net.relay.binary.name, 'polkadot');
    assert.ok(net.parachains.every((p) => p.binary.name === 'polkadot-omni-node'));
    assert.deepEqual(
      networkBinaries(net).map((b) => b.name).sort(),
      ['chain-spec-builder', 'eth-rpc', 'polkadot', 'polkadot-omni-node', 'storage-provider-node']
    );
    // Genesis needs one runtime per chain, each from the release that builds it.
    const runtimes = networkRuntimes(net);
    assert.equal(runtimes.length, 5);
    const ah = runtimes.find((r) => r.chain === 'asset-hub')!;
    assert.equal(ah.file, 'next_asset_hub_paseo_runtime.wasm');
    assert.equal(ah.repo, 'paritytech/individuality-community');
    const relay = runtimes.find((r) => r.chain === 'relay')!;
    assert.equal(relay.repo, 'paseo-network/runtimes');
    // The provider ships in a tarball, which the descriptor says explicitly.
    const provider = networkBinaries(net).find((b) => b.name === 'storage-provider-node')!;
    assert.match(provider.archive!, /\{tag\}.*\{triple\}/);
  });

  // A fork carries every runtime in the state it restores.
  it('gives fork-only networks binaries but no runtimes', () => {
    for (const name of listNetworks().filter((n) => n !== 'previewnet')) {
      const net = loadNetwork(name);
      assert.deepEqual(networkRuntimes(net), [], `${name} must declare no runtimes`);
      assert.ok(networkBinaries(net).length > 0);
    }
    // Kusama demonstrates a per-chain binary choice.
    assert.equal(loadNetwork('kusama').parachains[0].binary.name, 'polkadot-parachain');
  });

  // Kusama and Polkadot are biteable: no unresolved stubs, and their Asset Hub spec comes
  // from the parachain binary rather than a host that has to publish one. They stay out of
  // the release matrix (prebaked false) — a bite of either is on demand, not nightly.
  it('has kusama and polkadot wired for an on-demand bite', () => {
    for (const name of ['kusama', 'polkadot']) {
      const net = loadNetwork(name);
      assert.deepEqual(net.todos, [], `${name} still carries stubs, so \`ppn bite\` refuses it`);
      assert.equal(net.sudo, false, `${name} has no sudo`);
      assert.equal(net.bite.prebaked, false, `${name} must not be pre-bitten`);
      const ah = net.parachains.find((p) => p.key === 'asset-hub')!;
      assert.equal(ah.specSource, `builtin:asset-hub-${name}`);
      // Bare `builtin` would resolve to the relay's chain, which is the wrong spec entirely.
      assert.equal(specSourceUrl(net, ah as never), `builtin:asset-hub-${name}`);
      assert.equal(specSourceUrl(net, net.relay as never), `builtin:${net.relay.chain}`);
    }
  });

  // Polkadot runs the three system chains the fellowship's Individuality release lands on, at
  // their real ids, and says where the runtimes to test on a fork of it are published. People
  // is built into polkadot-parachain; Bulletin is not, so its spec is the one Parity's own RPC
  // nodes run from.
  it('forks polkadot as relay + asset hub + people + bulletin, with a runtime table', () => {
    const net = loadNetwork('polkadot');
    assert.deepEqual(
      net.parachains.map((p) => [p.key, p.paraId]),
      [['asset-hub', 1000], ['people', 1004], ['bulletin', 1010]]
    );
    assert.equal(net.parachains.find((p) => p.key === 'people')?.specSource, 'builtin:people-polkadot');
    assert.match(net.parachains.find((p) => p.key === 'bulletin')?.specSource ?? '', /^https:\/\/.*bulletin.*chainspec\.json$/);
    assert.ok(net.parachains.every((p) => p.binary.name === 'polkadot-parachain'));
    assert.equal(net.upgrades?.repo, 'polkadot-fellows/runtimes');
    assert.deepEqual(net.upgrades?.runtimes, {
      relay: 'polkadot',
      'asset-hub': 'asset-hub-polkadot',
      people: 'people-polkadot',
      bulletin: 'bulletin-polkadot',
    });
    // Networks with sudo upgrade after the spawn instead, so they need no table.
    assert.equal(loadNetwork('previewnet').upgrades, undefined);
  });

  it('pins the bite tool per network, since it must run that network\'s runtimes', () => {
    for (const name of listNetworks()) {
      const dg = loadNetwork(name).bite.doppelganger;
      assert.ok(dg?.repo && dg?.tag, `${name} must pin bite.doppelganger`);
    }
  });

  it('rejects unknown networks with the known list', () => {
    assert.throws(() => loadNetwork('mainnet'), /unknown network "mainnet" — known: .*previewnet/);
    assert.throws(() => loadNetwork('../etc/passwd'), /invalid network name/);
  });
});

describe('network selection and URL helpers', () => {
  it('defaults to previewnet, honours PPN_NETWORK', () => {
    const prev = process.env.PPN_NETWORK;
    try {
      delete process.env.PPN_NETWORK;
      assert.equal(currentNetworkName(), DEFAULT_NETWORK);
      process.env.PPN_NETWORK = 'devnet';
      assert.equal(currentNetworkName(), 'devnet');
    } finally {
      if (prev === undefined) delete process.env.PPN_NETWORK;
      else process.env.PPN_NETWORK = prev;
    }
  });

  it('resolves paths against bite.source and passes absolute URLs through', () => {
    const net = loadNetwork('previewnet');
    assert.equal(endpointUrl(net, 'relay/alice'), 'https://previewnet.substrate.dev/relay/alice');
    assert.equal(endpointUrl(net, 'wss://example.com/x'), 'wss://example.com/x');
    assert.equal(endpointUrl(net, 'http://10.0.0.1:9944'), 'http://10.0.0.1:9944');
  });

  it('converts between ws and http forms', () => {
    assert.equal(asHttp('wss://a/b'), 'https://a/b');
    assert.equal(asHttp('ws://a'), 'http://a');
    assert.equal(asHttp('https://a'), 'https://a');
    assert.equal(asWs('https://a/b'), 'wss://a/b');
    assert.equal(asWs('http://a'), 'ws://a');
    assert.equal(asWs('wss://a'), 'wss://a');
  });
});

// Which networks get the shared-relay bite overrides, pinned as policy rather than left to
// whoever edits a descriptor next. previewnet's relay carries only our own parachains, so its
// inherited core layout and HRMP state are correct and the bite must keep leaving them alone —
// rewriting them there would break 04-xcm-channels to fix a problem it does not have.
describe('bite.sharedRelay', () => {
  it('is off for previewnet, whose relay is ours end to end', () => {
    assert.equal(loadNetwork('previewnet').bite.sharedRelay, false);
  });

  it('is on for every fork of a relay someone else also uses', () => {
    for (const name of ['paseo-next-v2', 'kusama', 'polkadot']) {
      assert.equal(loadNetwork(name).bite.sharedRelay, true, name);
    }
  });
});

describe('aura scheme', () => {
  it('is the descriptor\'s to state, and defaults to sr25519', () => {
    assert.equal(loadNetwork('polkadot').parachains.find((p) => p.key === 'asset-hub')?.aura, 'ed25519');
    assert.equal(loadNetwork('kusama').parachains.find((p) => p.key === 'asset-hub')?.aura, undefined);
  });
});

describe('product import', () => {
  it('is previewnet\'s, stated in the descriptor like every other setting', () => {
    const pn = loadNetwork('previewnet');
    assert.equal(pn.dotns?.pinProducts, true);
    assert.equal(pinsProducts(pn), true);
    assert.equal(pn.dotns?.resolver, '0x7F74D7CD50f5a834270E2ad395a01b01891AB37d');
    // No gateway: previewnet's products come from wherever the bundle was bitten, so pinning
    // production here would send a staging fork to the real network for its bytes.
    assert.equal(pn.dotns?.gateway, undefined);
  });

  it('stays off for a network that could import but was not asked to', () => {
    const pnv2 = loadNetwork('paseo-next-v2');
    // Not a vacuous pass: pnv2 knows where its products are, so the import is skipped because
    // nobody asked, not because the network lacks what it would need.
    assert.ok(pnv2.dotns?.resolver && pnv2.dotns?.gateway, 'pnv2 names a resolver and a gateway');
    assert.equal(pinsProducts(pnv2), false);
    assert.equal(pinsProducts(loadNetwork('devnet')), false);
  });
});
