// A server's nginx publishes the chains from localhost, so with safeRpc in the network overlay no
// node may listen on another interface or answer an unsafe method: anyone could otherwise insert
// keys, rotate them or write a collator's offchain storage, directly or through nginx's paths.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-rpc-'));
const write = (name: string, body: unknown): string => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
};

// Set before anything loads the network: the genesis generator reads it once per process.
process.env.PPN_NETWORK_OVERLAY = write('safe.json', { previewnet: { safeRpc: true, parachains: { people: { rpcNodes: 1 } } } });

const { generateToml, VALID_PARACHAINS } = await import('../src/toml-generator.js');
const { loadNetwork } = await import('../src/load.js');
const { applyOverlay } = await import('../src/overlay.js');
const { repoRoot } = await import('../src/repo-root.js');

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
  const toml = generateToml([...VALID_PARACHAINS]);
  const nodes = nodeBlocks(toml);

  it('binds no node RPC beyond localhost', () => {
    assert.ok(!toml.includes('--unsafe-rpc-external'));
  });

  it("runs every node through a launcher that serves safe methods only", () => {
    assert.match(toml, /^default_command = "\{\{SCRIPTS\}\}\/polkadot\.sh"$/m);
    assert.ok(nodes.has('people-rpc1'));
    for (const [name, block] of nodes) {
      assert.match(block, /\{ name = "PPN_RPC_METHODS", value = "safe" \}/, name);
    }
  });

  it('is off unless the overlay turns it on', () => {
    assert.equal(loadNetwork('devnet').safeRpc, false);
    assert.throws(() => applyOverlay(loadNetwork('previewnet'), write('bad.json', { previewnet: { safeRpc: 'yes' } })), /safeRpc must be true or false/);
  });
});

// zombienet hands every node `--rpc-methods unsafe`; the launchers replace it, and only when asked.
describe('node launchers', () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-rpc-bin-'));
  for (const binary of ['polkadot', 'polkadot-omni-node']) {
    fs.writeFileSync(path.join(bin, binary), '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
  }
  const run = (launcher: string, args: string[], methods?: string): string[] => {
    const env = { ...process.env, PPN_BIN_DIR: bin, ...(methods ? { PPN_RPC_METHODS: methods } : {}) };
    delete env.PPN_COLLATOR_AURA;
    const result = spawnSync('bash', [path.join(repoRoot(), 'scripts', launcher), ...args], { encoding: 'utf-8', env });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split('\n');
  };
  const methodsOf = (args: string[]) => args[args.indexOf('--rpc-methods') + 1];

  it('polkadot.sh serves the method set PPN_RPC_METHODS names', () => {
    assert.equal(methodsOf(run('polkadot.sh', ['--name', 'alice', '--rpc-methods', 'unsafe'], 'safe')), 'safe');
    assert.equal(methodsOf(run('polkadot.sh', ['--name', 'alice', '--rpc-methods', 'unsafe'])), 'unsafe');
  });

  it("omni-node.sh does the same, keeping the relay side's flags after --", () => {
    const args = run('omni-node.sh', ['--rpc-methods', 'unsafe', '--', '--chain', 'relay.json'], 'safe');
    assert.equal(methodsOf(args), 'safe');
    assert.deepEqual(args.slice(args.indexOf('--')), ['--', '--chain', 'relay.json', '--network-backend=libp2p', '--discover-local', '--allow-private-ip']);
  });
});
