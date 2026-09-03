// Tests for packages/network-config/src/fork-toml.ts
// Run with: tsx --test packages/network-config/tests/fork-toml.test.ts

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateForkToml, FORK_PROCESSES } from '../src/fork-toml.js';
import { paraIds, PORTS, P2P_PORTS, RELAY_BASE_PORT, buildArgs } from '../src/toml-generator.js';
import type { ForkManifest } from '../src/fork-toml.js';
import type { Parachain } from '../src/types.js';

const REPO = '/repo';

// Spec basename in the bundle, per chain. `people` is `individuality` — the one place the
// bundle name and the parachain key differ.
const SPECS: Record<string, string> = {
  relay: 'paseo',
  'asset-hub': 'asset-hub',
  people: 'individuality',
  bulletin: 'bulletin',
  'web3-storage': 'web3-storage',
};

function baseManifest(): ForkManifest {
  const chain = (key: string, paraId: number | null) => ({
    paraId,
    spec: SPECS[key],
    specName: `${key}-paseo`,
    specVersion: 1,
    headAtStart: 100,
    genesis: '0xabc',
  });
  return {
    bittenAt: '2026-07-30T22:22:35.661Z',
    source: 'https://previewnet.substrate.dev',
    nodeVersion: '1.24.0-2f2eeb2b81d',
    epochDuration: 10,
    chains: {
      relay: chain('relay', null),
      'asset-hub': chain('asset-hub', paraIds()['asset-hub']),
      bulletin: chain('bulletin', paraIds().bulletin),
      people: chain('people', paraIds().people),
      'web3-storage': chain('web3-storage', paraIds()['web3-storage']),
    },
    biteBlocks: {
      relay: 21816,
      [paraIds()['asset-hub']]: 52283,
      [paraIds().bulletin]: 19447,
      [paraIds().people]: 17434,
      [paraIds()['web3-storage']]: 19616,
    },
  };
}

/** Write a bundle on disk containing just what the generator reads: a manifest and specs. */
function makeBundle(mutate?: (m: ForkManifest) => void): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fork-bundle-'));
  const manifest = baseManifest();
  mutate?.(manifest);
  fs.mkdirSync(path.join(dir, 'specs'));
  for (const [key, spec] of Object.entries(SPECS)) {
    // The relay spec's id is what the generator writes as `chain = …` — previewnet's is
    // paseo-local, matching what generate.sh builds and what the live network publishes.
    const id = key === 'relay' ? 'paseo-local' : `${key}-local`;
    fs.writeFileSync(path.join(dir, 'specs', `${spec}.json`), JSON.stringify({ id }));
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return dir;
}

function generate(mutate?: (m: ForkManifest) => void, enableHop = true): string {
  return generateForkToml({ repoDir: REPO, bundleDir: makeBundle(mutate), enableHop });
}

/** Pull one collator's args array out of the generated TOML. */
function collatorArgs(toml: string, paraId: number): string[] {
  const block = toml.split(`name = "Collator-${paraId}"`)[1];
  assert.ok(block, `no collator block for ${paraId}`);
  const line = block.split('\n').find((l) => l.startsWith('args = '));
  assert.ok(line, `no args for Collator-${paraId}`);
  return [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe('generateForkToml — bundle validation', () => {
  it('throws when there is no manifest', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-bundle-'));
    assert.throws(() => generateForkToml({ repoDir: REPO, bundleDir: dir }), /no manifest at/);
  });

  it('throws on a manifest written before the current bundle format', () => {
    assert.throws(
      () => generate((m) => delete (m.chains.relay as Partial<typeof m.chains.relay>).spec),
      /predates the current bundle format/
    );
    assert.throws(
      () => generate((m) => delete (m as Partial<ForkManifest>).biteBlocks),
      /predates the current bundle format/
    );
  });

  // The failure this prevents is silent: a five-chain network would simply fork as four.
  it('throws when the bundle has a different parachain set than PPN', () => {
    assert.throws(() => generate((m) => delete m.chains.bulletin), /parachain set mismatch/);
    assert.throws(
      () => generate((m) => (m.chains.surprise = { ...m.chains.people, paraId: 1700 })),
      /parachain set mismatch/
    );
  });

  it('throws when a para id disagrees with ports.env', () => {
    assert.throws(() => generate((m) => (m.chains.people.paraId = 9999)), /para id mismatch for people/);
  });
});

// Installed from npm, the workspace (bin/, bundles) and the package (launchers) are two
// different trees; in a checkout they coincide, which is exactly why a wrong path here passed
// every checkout-based test and then failed on a user's machine with zombienet's misleading
// "Missing binary .../scripts/omni-node.sh, please compile it."
describe('generateForkToml — split workspace and package', () => {
  it('takes the launchers from scriptsDir when it differs from repoDir', () => {
    const toml = generateForkToml({
      repoDir: REPO,
      scriptsDir: '/package/scripts',
      bundleDir: makeBundle(),
    });
    assert.match(toml, /command = "\/package\/scripts\/omni-node\.sh"/);
    assert.doesNotMatch(toml, /\/repo\/scripts\//);
    // Binaries stay with the workspace: only the launchers move.
    assert.match(toml, /default_command = "\/repo\/bin\/polkadot"/);
  });

  it('keeps the launchers beside the repo when scriptsDir is not given', () => {
    const toml = generate();
    assert.match(toml, /command = "\/repo\/scripts\/omni-node\.sh"/);
  });
});

describe('generateForkToml — relay chain', () => {
  const toml = generate();

  it('uses the bundle spec and snapshot', () => {
    assert.match(toml, /chain = "paseo-local"/);
    assert.match(toml, /chain_spec_path = ".*\/specs\/paseo\.json"/);
    assert.match(toml, /default_db_snapshot = ".*\/snapshots\/relay\.tgz"/);
    assert.ok(toml.includes(`default_command = "${REPO}/bin/polkadot"`));
  });

  // zombienet derives keys from the node name, and the bite installs the well-known dev
  // keys. PPN's genesis names (alice-paseo-validator) would get generated keys instead.
  it('names validators with the well-known dev names, on the documented ports', () => {
    for (const [i, name] of ['alice', 'bob', 'charlie', 'dave', 'eve', 'ferdie'].entries()) {
      assert.ok(toml.includes(`name = "${name}"\nvalidator = true\nrpc_port = ${RELAY_BASE_PORT + i}`),
        `${name} missing or on the wrong port`);
    }
    assert.ok(!toml.includes('paseo-validator'), 'genesis-style validator name leaked in');
  });

  // Without this the dispute scrape reaches for ancestry a warp-synced DB does not have and
  // nothing ever finalizes. zombienet does not forward the parent environment.
  it('sets the dispute lifetime env var on every relay node', () => {
    const nodes = toml.split('[[relaychain.nodes]]').length - 1;
    const envs = toml.split('ZOMBIE_DISPUTE_CANDIDATE_LIFETIME_AFTER_FINALIZATION').length - 1;
    assert.equal(nodes, 6);
    assert.equal(envs, 6);
  });

  it('only gives a p2p port to the first node', () => {
    assert.equal(toml.split('p2p_port = ' + P2P_PORTS.relay).length - 1, 1);
  });
});

describe('generateForkToml — collators', () => {
  const toml = generate();

  it('emits one collator per parachain, named for its para id', () => {
    for (const id of Object.values(paraIds())) {
      assert.ok(toml.includes(`name = "Collator-${id}"`), `no collator for ${id}`);
    }
  });

  // Without `chain`, zombienet applies one spec to every parachain — last one wins — and
  // all collators silently run the same chain.
  it('sets `chain` alongside every chain_spec_path', () => {
    const specPaths = toml.split('chain_spec_path = ').length - 1;
    const chains = toml.split(/^chain = /m).length - 1;
    assert.equal(specPaths, 5);
    assert.equal(chains, 5);
    assert.match(toml, /chain = "people-local"/);
  });

  it('wires each collator to its own snapshot and spec', () => {
    assert.match(toml, new RegExp(`db_snapshot = ".*/snapshots/${paraIds().people}\\.tgz"`));
    assert.match(toml, /chain_spec_path = ".*\/specs\/individuality\.json"/);
  });

  // A warp-synced relay cannot serve history to an embedded relay node, which then sits at #0.
  it('points every collator at the relay over RPC', () => {
    for (const id of Object.values(paraIds())) {
      assert.ok(
        collatorArgs(toml, id).includes(`--relay-chain-rpc-urls=ws://127.0.0.1:${RELAY_BASE_PORT}`),
        `Collator-${id} is not using the relay RPC`
      );
    }
  });

  // The collator's relay-side node otherwise defaults to litep2p, whose websocket listener
  // dies and takes the essential network-worker task — and the collator — with it.
  it('runs collators through the omni-node wrapper, not the bare binary', () => {
    assert.equal(toml.split(`command = "${REPO}/scripts/omni-node.sh"`).length - 1, 4);
    assert.ok(!toml.includes('polkadot-omni-node'), 'a collator bypasses the wrapper');
  });

  // Previewnet's binaries live in plain bin/ and every chain runs the default binary,
  // so its collators carry no wrapper env — keeping the generated TOML unchanged.
  it('adds no wrapper env for previewnet', () => {
    assert.ok(!toml.includes('PPN_BIN_DIR'));
    assert.ok(!toml.includes('PPN_COLLATOR_BINARY'));
  });

  it('uses the ports from ports.env', () => {
    for (const key of Object.keys(paraIds()) as Parachain[]) {
      const block = toml.split(`name = "Collator-${paraIds()[key]}"`)[1];
      assert.ok(block.includes(`rpc_port = ${PORTS[key]}`), `${key} rpc port`);
      assert.ok(block.includes(`p2p_port = ${P2P_PORTS[key]}`), `${key} p2p port`);
    }
  });
});

// The regression this file exists for: fork mode used to keep a hand-copied table of
// collator flags, which drifted from the genesis one immediately.
describe('generateForkToml — no drift from genesis mode', () => {
  const toml = generate();

  it('keeps every genesis flag for every parachain', () => {
    for (const key of Object.keys(paraIds()) as Parachain[]) {
      const genesis = buildArgs(key, undefined, key === 'bulletin');
      const fork = collatorArgs(toml, paraIds()[key]);
      const missing = genesis.filter((a) => !fork.includes(a));
      assert.deepEqual(missing, [], `${key} lost genesis flags`);
    }
  });

  it('adds only the flags a fork needs, and no duplicates', () => {
    const forkOnly = ['--relay-chain-rpc-urls', '--discover-local', '--allow-private-ip',
      '--state-pruning', '--no-hardware-benchmarks'];
    for (const key of Object.keys(paraIds()) as Parachain[]) {
      const genesis = buildArgs(key, undefined, key === 'bulletin');
      const fork = collatorArgs(toml, paraIds()[key]);
      const extra = fork.filter((a) => !genesis.includes(a)).map((a) => a.split('=')[0]);
      assert.deepEqual(extra.sort(), [...forkOnly].sort(), `${key} has unexpected extra flags`);

      const flags = fork.map((a) => a.split('=')[0]);
      assert.equal(new Set(flags).size, flags.length, `${key} specifies a flag twice`);
    }
  });

  // The specific flag a hand-copied table dropped; it pairs with --experimental-webrtc.
  it('keeps the webrtc listen address on the chains that enable webrtc', () => {
    for (const key of ['asset-hub', 'bulletin', 'web3-storage'] as Parachain[]) {
      const args = collatorArgs(toml, paraIds()[key]);
      assert.ok(args.includes('--experimental-webrtc'), `${key} lost --experimental-webrtc`);
      assert.ok(
        args.includes(`--listen-addr=/ip4/127.0.0.1/udp/${P2P_PORTS[key]}/webrtc-direct`),
        `${key} lost its webrtc listen address`
      );
    }
  });

  it('honours enableHop the same way genesis mode does', () => {
    assert.ok(collatorArgs(generate(undefined, true), paraIds().bulletin).includes('--enable-hop'));
    assert.ok(!collatorArgs(generate(undefined, false), paraIds().bulletin).includes('--enable-hop'));
  });
});

describe('generateForkToml — custom processes', () => {
  const toml = generate();

  // Not genesis bootstrap: zombienet publishes chainspecs advertising /ip4/127.0.0.1/, so
  // without this a spawned instance's specs are unusable off the box.
  it('publishes chainspecs with reachable bootnodes', () => {
    assert.ok(generate().includes(`${REPO}/scripts/patch-bootnodes.sh`));
  });

  it('runs the service processes', () => {
    // enact-upgrades depends on the bundle having seeded runtimes; covered below.
    for (const name of FORK_PROCESSES.filter((n) => n !== 'enact-upgrades')) {
      assert.ok(toml.includes(`command = "${REPO}/scripts/${name}.sh"`), `${name} missing`);
    }
  });

  // The forked state already carries these; re-running them is a no-op at best, and
  // set-dispatcher-address would write an address from the wrong release.
  it('skips the genesis-time bootstrap processes', () => {
    for (const name of ['assign-cores', 'force-open-hrmp', 'set-dispatcher-address']) {
      assert.ok(!toml.includes(name), `${name} should not run against a fork`);
    }
  });

  // The attestation allowance is the one former exception that came back. It is
  // not genesis bootstrap: it grants allowance to whichever account the identity
  // backend attests with, and a fork carries production's grants rather than
  // one for that account. The grant is additive and idempotent enough to re-run.
  it('still grants the attestation allowance, for the identity backend attester', () => {
    assert.ok(toml.includes('increase-people-lite-attestation-allowance'));
  });

  it('runs the identity backend against a fork too', () => {
    for (const name of ['dub-postgres', 'dub-api', 'device-attestation-chain-writer',
        'registration-queue', 'invite-tickets-pool']) {
      assert.ok(toml.includes(`name = "${name}"`), `${name} missing from fork toml`);
    }
    // Fork mode resolves paths at generate time; the placeholder must not survive.
    assert.ok(!toml.includes('{{SCRIPTS}}'), 'fork toml must not carry placeholders');
    assert.ok(toml.includes(`command = "${REPO}/scripts/dub/service.sh"`));
  });

  it('carries no genesis config, since state comes from the snapshots', () => {
    assert.ok(!toml.includes('[relaychain.genesis'));
    assert.ok(!toml.includes('[[hrmp_channels]]'));
  });
});

// A bundle bitten from another network: validated against that network's descriptor, laid
// out with its para ids, and running only the services its parachains call for.
describe('generateForkToml — non-previewnet bundles', () => {
  function makeNetBundle(network: string, chains: Record<string, { paraId: number | null; spec: string; specId: string }>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fork-bundle-${network}-`));
    fs.mkdirSync(path.join(dir, 'specs'));
    const manifestChains: ForkManifest['chains'] = {};
    const biteBlocks: ForkManifest['biteBlocks'] = { relay: 100 };
    for (const [key, c] of Object.entries(chains)) {
      manifestChains[key] = {
        paraId: c.paraId,
        spec: c.spec,
        specName: `${key}-spec`,
        specVersion: 1,
        headAtStart: 100,
        genesis: '0xabc',
      };
      if (c.paraId !== null) biteBlocks[c.paraId] = 100;
      fs.writeFileSync(path.join(dir, 'specs', `${c.spec}.json`), JSON.stringify({ id: c.specId }));
    }
    const manifest: ForkManifest = {
      bittenAt: '2026-08-13T00:00:00.000Z',
      source: 'https://devnet.example',
      network,
      nodeVersion: '1.24.0-test',
      epochDuration: 600,
      chains: manifestChains,
      biteBlocks,
    };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
    return dir;
  }

  const devnetToml = () =>
    generateForkToml({
      repoDir: REPO,
      bundleDir: makeNetBundle('devnet', {
        relay: { paraId: null, spec: 'paseo', specId: 'paseo' },
        'asset-hub': { paraId: 1000, spec: 'asset-hub', specId: 'asset-hub' },
        people: { paraId: 1004, spec: 'people', specId: 'people' },
        bulletin: { paraId: 1010, spec: 'bulletin', specId: 'bulletin' },
      }),
    });

  it('lays out a devnet bundle with system-chain para ids', () => {
    const toml = devnetToml();
    assert.match(toml, /# Forked devnet, bitten/);
    assert.match(toml, /chain = "paseo"/);
    for (const id of [1000, 1004, 1010]) {
      assert.ok(toml.includes(`name = "Collator-${id}"`), `no collator for ${id}`);
    }
    assert.ok(!toml.includes('Collator-1500'), 'previewnet para id leaked into a devnet fork');
  });

  // The wrapper env is what points collators at bin/<network> and at a per-chain
  // collator binary. Previewnet gets neither (bin/, omni-node) so its TOML is unchanged.
  it('routes collators at the per-network bin dir via the wrapper env', () => {
    const toml = generateForkToml({
      repoDir: REPO,
      binDir: `${REPO}/bin/devnet`,
      bundleDir: makeNetBundle('devnet', {
        relay: { paraId: null, spec: 'paseo', specId: 'paseo' },
        'asset-hub': { paraId: 1000, spec: 'asset-hub', specId: 'asset-hub' },
        people: { paraId: 1004, spec: 'people', specId: 'people' },
        bulletin: { paraId: 1010, spec: 'bulletin', specId: 'bulletin' },
      }),
    });
    assert.ok(toml.includes(`default_command = "${REPO}/bin/devnet/polkadot"`));
    assert.equal(
      toml.split(`{ name = "PPN_BIN_DIR", value = "${REPO}/bin/devnet" }`).length - 1,
      3,
      'every collator must be pointed at the network bin dir'
    );
  });

  it('picks the descriptor collator binary via the wrapper env', () => {
    const toml = generateForkToml({
      repoDir: REPO,
      bundleDir: makeNetBundle('kusama', {
        relay: { paraId: null, spec: 'kusama', specId: 'kusama' },
        'asset-hub': { paraId: 1000, spec: 'asset-hub', specId: 'asset-hub-kusama' },
      }),
    });
    assert.ok(
      toml.includes('{ name = "PPN_COLLATOR_BINARY", value = "polkadot-parachain" }'),
      'kusama asset-hub declares command: polkadot-parachain'
    );
    assert.ok(toml.includes('omni-node.sh'), 'the wrapper (with its libp2p fix) still runs it');
  });

  const polkadotToml = () =>
    generateForkToml({
      repoDir: REPO,
      bundleDir: makeNetBundle('polkadot', {
        relay: { paraId: null, spec: 'polkadot', specId: 'polkadot' },
        'asset-hub': { paraId: 1000, spec: 'asset-hub', specId: 'asset-hub-polkadot' },
        people: { paraId: 1004, spec: 'people', specId: 'people-polkadot' },
        bulletin: { paraId: 1010, spec: 'bulletin', specId: 'bulletin-polkadot' },
      }),
    });

  it('tells the wrapper when a chain signs Aura with ed25519', () => {
    const toml = polkadotToml();
    assert.equal(
      toml.split('{ name = "PPN_COLLATOR_AURA", value = "ed25519" }').length - 1,
      1,
      'polkadot asset-hub declares aura: ed25519; people and bulletin do not'
    );
  });

  // Polkadot has no sudo, so a process whose only move is a root call cannot run there. The
  // ones that only need the chain to exist (dub, ipfs, eth-rpc, the product import) still do.
  it('leaves the sudo-dispatching services out of a fork without sudo', () => {
    const toml = polkadotToml();
    for (const name of ['increase-people-lite-attestation-allowance', 'grant-invites']) {
      assert.ok(!toml.includes(`name = "${name}"`), `${name} needs sudo`);
    }
    for (const name of ['eth-rpc', 'ipfs-daemon', 'dub-api', 'pin-design-families']) {
      assert.ok(toml.includes(`name = "${name}"`), `${name} should still run`);
    }
    // devnet has sudo, so there the grants run.
    assert.ok(devnetToml().includes('name = "grant-invites"'));
  });

  // A bite that authorized runtimes leaves the apply half to the spawn: the fork should come
  // up running the release under test, not merely permitted to. A bundle that seeded nothing
  // gets no such process.
  it('enacts the runtimes the bite authorized, and only then', () => {
    assert.ok(!polkadotToml().includes('name = "enact-upgrades"'), 'nothing seeded, nothing to enact');

    const dir = makeNetBundle('polkadot', {
      relay: { paraId: null, spec: 'polkadot', specId: 'polkadot' },
      'asset-hub': { paraId: 1000, spec: 'asset-hub', specId: 'asset-hub-polkadot' },
      people: { paraId: 1004, spec: 'people', specId: 'people-polkadot' },
      bulletin: { paraId: 1010, spec: 'bulletin', specId: 'bulletin-polkadot' },
    });
    const manifestPath = path.join(dir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    manifest.seededUpgrades = { people: { file: 'upgrades/people.wasm', codeHash: 'ab'.repeat(32), checkVersion: true } };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const toml = generateForkToml({ repoDir: REPO, bundleDir: dir });
    assert.ok(toml.includes('name = "enact-upgrades"'));
    assert.ok(toml.includes(`command = "${REPO}/scripts/enact-upgrades.sh"`));
  });

  it('says nothing about Aura for the sr25519 chains', () => {
    const toml = generateForkToml({
      repoDir: REPO,
      bundleDir: makeNetBundle('kusama', {
        relay: { paraId: null, spec: 'kusama', specId: 'kusama' },
        'asset-hub': { paraId: 1000, spec: 'asset-hub', specId: 'asset-hub-kusama' },
      }),
    });
    assert.ok(!toml.includes('PPN_COLLATOR_AURA'));
  });

  it('imports products only where the descriptor asks for them', () => {
    const pn = generateForkToml({ repoDir: REPO, bundleDir: makeBundle() });
    assert.ok(pn.includes('pin-bulletin-products'), 'previewnet declares pinProducts');

    const toml = generateForkToml({
      repoDir: REPO,
      bundleDir: makeNetBundle('paseo-next-v2', {
        relay: { paraId: null, spec: 'paseo', specId: 'paseo' },
        'asset-hub': { paraId: 1500, spec: 'asset-hub', specId: 'asset-hub' },
        people: { paraId: 1502, spec: 'people', specId: 'people' },
        bulletin: { paraId: 1501, spec: 'bulletin', specId: 'bulletin' },
      }),
    });
    assert.ok(
      !toml.includes('pin-bulletin-products'),
      'a bulletin chain is not on its own a reason to spend half an hour importing products'
    );
  });

  // Whether the content is wanted belongs to the run, not the network.
  it('lets a run ask for products the descriptor leaves off, and refuse ones it leaves on', () => {
    const paseo = () =>
      generateForkToml({
        repoDir: REPO,
        bundleDir: makeNetBundle('paseo-next-v2', {
          relay: { paraId: null, spec: 'paseo', specId: 'paseo' },
          'asset-hub': { paraId: 1500, spec: 'asset-hub', specId: 'asset-hub' },
          people: { paraId: 1502, spec: 'people', specId: 'people' },
          bulletin: { paraId: 1501, spec: 'bulletin', specId: 'bulletin' },
        }),
      });
    process.env.PRODUCT_SYNC = '1';
    try {
      assert.ok(paseo().includes('pin-bulletin-products'));
    } finally {
      delete process.env.PRODUCT_SYNC;
    }

    process.env.PRODUCT_SYNC = '0';
    try {
      assert.ok(!generateForkToml({ repoDir: REPO, bundleDir: makeBundle() }).includes('pin-bulletin-products'));
    } finally {
      delete process.env.PRODUCT_SYNC;
    }
  });

  it('runs only the services devnet parachains call for', () => {
    const toml = devnetToml();
    assert.ok(toml.includes('eth-rpc.sh'), 'asset-hub is present, eth-rpc should run');
    assert.ok(toml.includes('name = "dub-api"'), 'people is present, identity should run');
    assert.ok(!toml.includes('storage-provider-node'), 'devnet has no web3-storage');
  });

  it('drops people- and bulletin-bound services for a relay+asset-hub network', () => {
    const toml = generateForkToml({
      repoDir: REPO,
      bundleDir: makeNetBundle('kusama', {
        relay: { paraId: null, spec: 'kusama', specId: 'kusama' },
        'asset-hub': { paraId: 1000, spec: 'asset-hub', specId: 'asset-hub-kusama' },
      }),
    });
    assert.match(toml, /chain = "kusama"/);
    assert.ok(toml.includes('eth-rpc.sh'));
    for (const gone of ['dub-api', 'ipfs-daemon', 'pin-bulletin-products',
      'increase-people-lite-attestation-allowance', 'pin-design-families', 'storage-provider-node']) {
      assert.ok(!toml.includes(gone), `${gone} should not run without its parachain`);
    }
    assert.ok(toml.includes('patch-bootnodes.sh'), 'patch-bootnodes is unconditional');
  });

  it('validates a bundle against its own network, not previewnet', () => {
    assert.throws(
      () =>
        generateForkToml({
          repoDir: REPO,
          bundleDir: makeNetBundle('devnet', {
            relay: { paraId: null, spec: 'paseo', specId: 'paseo' },
            'asset-hub': { paraId: 1500, spec: 'asset-hub', specId: 'asset-hub' },
            people: { paraId: 1004, spec: 'people', specId: 'people' },
            bulletin: { paraId: 1010, spec: 'bulletin', specId: 'bulletin' },
          }),
        }),
      /para id mismatch for asset-hub — bundle says 1500, networks\/devnet\.json says 1000/
    );
  });
});

describe('generateForkToml — provenance', () => {
  it('records what was bitten, from where, and at which blocks', () => {
    const toml = generate();
    assert.match(toml, /bitten 2026-07-30T22:22:35\.661Z from https:\/\/previewnet\.substrate\.dev/);
    assert.match(toml, /Production node version at bite time: 1\.24\.0-2f2eeb2b81d/);
    assert.match(toml, new RegExp(`bitten at block 17434`));
  });

  it('produces no run of blank lines and ends with a newline', () => {
    const toml = generate();
    assert.ok(!/\n{3,}/.test(toml));
    assert.ok(toml.endsWith('\n'));
  });
});
