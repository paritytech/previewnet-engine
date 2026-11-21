// A server's nginx publishes the chains from localhost, so with safeRpc in the network overlay no
// node may listen on another interface or answer an unsafe method: anyone could otherwise insert
// keys, rotate them or write a collator's offchain storage, directly or through nginx's paths.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ForkManifest } from '../src/fork-toml.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-rpc-'));
const write = (name: string, body: unknown): string => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
};

// Set before anything loads the network: the genesis generator reads it once per process.
process.env.PPN_NETWORK_OVERLAY = write('safe.json', { previewnet: { safeRpc: true, parachains: { people: { rpcNodes: 1 } } } });

const { generateToml, VALID_PARACHAINS, paraIds } = await import('../src/toml-generator.js');
const { generateForkToml } = await import('../src/fork-toml.js');
const { loadDescriptor } = await import('../src/networks.js');
const { applyOverlay } = await import('../src/overlay.js');
const { repoRoot } = await import('../src/repo-root.js');

/** Writes a previewnet fork bundle with what the generator reads: a manifest and the specs' ids. */
function makeBundle(): string {
  const bundle = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-rpc-bundle-'));
  fs.mkdirSync(path.join(bundle, 'specs'));
  const specs = { relay: 'paseo', 'asset-hub': 'asset-hub', people: 'individuality', bulletin: 'bulletin', 'web3-storage': 'web3-storage' };
  const chains = Object.fromEntries(
    Object.entries(specs).map(([key, spec]) => {
      fs.writeFileSync(path.join(bundle, 'specs', `${spec}.json`), JSON.stringify({ id: key === 'relay' ? 'paseo-local' : `${key}-local` }));
      const paraId = key === 'relay' ? null : paraIds()[key as keyof ReturnType<typeof paraIds>];
      return [key, { paraId, spec, specName: spec, specVersion: 1, headAtStart: 1, genesis: '0x00' }];
    })
  ) as ForkManifest['chains'];
  const manifest: ForkManifest = { bittenAt: '2026-01-01T00:00:00.000Z', source: 'wss://previewnet.substrate.dev', nodeVersion: '1.25.3', epochDuration: 10, chains, biteBlocks: {} };
  fs.writeFileSync(path.join(bundle, 'manifest.json'), JSON.stringify(manifest));
  return bundle;
}

/** name -> that node's TOML block. */
function nodeBlocks(toml: string): Map<string, string> {
  const blocks = new Map<string, string>();
  for (const block of toml.split(/^\[\[/m).slice(1)) {
    const name = /^name = "([^"]+)"/m.exec(block)?.[1];
    if (name && /^(relaychain\.nodes|parachains\.collators)\]/.test(block)) blocks.set(name, block);
  }
  return blocks;
}

describe('safeRpc in the network overlay', () => {
  for (const [mode, toml] of [
    ['genesis', generateToml([...VALID_PARACHAINS])],
    ['fork', generateForkToml({ repoDir: '/repo', bundleDir: makeBundle() })],
  ]) {
    it(`runs every ${mode} node, RPC nodes included, through a launcher that applies it`, () => {
      assert.match(toml, /^default_command = "[^"]*\/polkadot\.sh"$/m);
      const nodes = nodeBlocks(toml);
      assert.ok(nodes.has('people-rpc1'));
      for (const [name, block] of nodes) {
        assert.match(block, /\{ name = "PPN_SAFE_RPC", value = "1" \}/, name);
      }
    });
  }

  it('rejects an overlay that contradicts it', () => {
    const overlay = (section: unknown) => () => applyOverlay(loadDescriptor('previewnet'), write('bad.json', { previewnet: section }));
    assert.throws(overlay({ safeRpc: 'yes' }), /safeRpc must be true or false/);
    assert.throws(overlay({ safeRpc: true, parachains: { people: { rpcNodeArgs: ['--rpc-external'] } } }), /--rpc-external cannot be set/);
  });
});

describe('node launchers under PPN_SAFE_RPC=1', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-rpc-bin-'));
  for (const binary of ['polkadot', 'polkadot-omni-node']) {
    fs.writeFileSync(path.join(bin, binary), '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  }
  const run = (launcher: string, args: string[], safeRpc = true): string[] => {
    const env = { ...process.env, PPN_BIN_DIR: bin, ...(safeRpc ? { PPN_SAFE_RPC: '1' } : {}) };
    delete env.PPN_COLLATOR_AURA;
    const result = spawnSync('bash', [path.join(repoRoot(), 'scripts', launcher), ...args], { encoding: 'utf-8', env });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split('\n');
  };
  // What zombienet and the engine pass a node.
  const nodeArgs = ['--name', 'alice', '--rpc-cors', 'all', '--rpc-methods', 'unsafe', '--unsafe-rpc-external', '--prometheus-external'];

  it('serve safe methods on localhost, RPC and Prometheus alike', () => {
    assert.deepEqual(run('polkadot.sh', nodeArgs), ['--name', 'alice', '--rpc-cors', 'all', '--rpc-methods', 'safe']);
  });

  it('pass the arguments through without it', () => {
    assert.deepEqual(run('polkadot.sh', nodeArgs, false), nodeArgs);
  });

  it("set safe methods when zombienet doesn't pass --rpc-methods", () => {
    assert.deepEqual(run('polkadot.sh', ['--name', 'alice']), ['--name', 'alice', '--rpc-methods', 'safe']);
    assert.deepEqual(run('omni-node.sh', ['--name', 'collator', '--', '--chain', 'relay.json']).slice(0, 5), [
      '--name',
      'collator',
      '--rpc-methods',
      'safe',
      '--',
    ]);
  });

  it("cover the collator's relay-chain node after -- as well", () => {
    assert.deepEqual(run('omni-node.sh', [...nodeArgs, '--', '--chain', 'relay.json', '--prometheus-external']), [
      '--name',
      'alice',
      '--rpc-cors',
      'all',
      '--rpc-methods',
      'safe',
      '--',
      '--chain',
      'relay.json',
      '--rpc-methods',
      'safe',
      '--network-backend=libp2p',
      '--discover-local',
      '--allow-private-ip',
    ]);
  });
});
