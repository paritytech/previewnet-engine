// A deployment reshapes a network through PPN_NETWORK_OVERLAY instead of an engine release:
// RPC nodes in front of a chain that players hammer, and flags such as the connection limit.
// What matters is that every consumer of the network agrees on the result, so these check the
// generated zombienet config, the nginx routes and the dashboard together, and that a typo in
// the file fails loudly instead of deploying the descriptor's defaults.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-'));
const write = (name: string, body: unknown): string => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
};

// Set before anything loads the network: the genesis generator reads it once per process.
process.env.PPN_NETWORK_OVERLAY = write('people.json', {
  previewnet: {
    parachains: {
      people: {
        rpcNodes: 2,
        extraArgs: ['--rpc-max-connections=50', '-lsync=debug'],
        rpcNodeArgs: ['--rpc-max-connections=5000', '--rpc-message-buffer-capacity-per-connection=512'],
      },
    },
  },
  // Another network's section must not affect previewnet, nor fail on previewnet's chains.
  devnet: { relay: { extraArgs: ['--rpc-max-connections=7'] } },
});

const { generateToml, VALID_PARACHAINS, PORTS } = await import('../src/toml-generator.js');
const { loadNetwork, loadDescriptorOnly } = await import('../src/load.js');
const { applyOverlay } = await import('../src/overlay.js');
const { dashboardModel } = await import('../src/dashboard-model.js');
const { nginxRoutes } = await import('../src/nginx-routes.js');

/** name -> the TOML lines of that node's block. */
function nodeBlocks(toml: string): Map<string, string[]> {
  const blocks = new Map<string, string[]>();
  for (const block of toml.split(/^\[\[/m).slice(1)) {
    const name = /^name = "([^"]+)"/m.exec(block)?.[1];
    if (name) blocks.set(name, block.split('\n'));
  }
  return blocks;
}

const argsOf = (lines: string[]): string[] =>
  [...(lines.find((l) => l.startsWith('args = ')) ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]);

describe('network overlay: RPC nodes in front of People', () => {
  const nodes = nodeBlocks(generateToml([...VALID_PARACHAINS]));
  const collator = nodes.get('people-collator1')!;
  const rpc = [nodes.get('people-rpc1')!, nodes.get('people-rpc2')!];

  it('spawns full nodes on the ports after the collator, which keeps authoring', () => {
    for (const [i, block] of rpc.entries()) {
      assert.ok(block.includes('validator = false'));
      assert.ok(block.includes(`rpc_port = ${PORTS.people + i + 1}`));
      assert.ok(block.includes(`prometheus_port = ${PORTS.people + i + 1 + 10000}`));
      assert.ok(!argsOf(block).some((a) => a.startsWith('--force-authoring') || a.startsWith('--authoring')));
      assert.ok(argsOf(block).includes('--enable-statement-store'));
    }
    assert.ok(argsOf(collator).includes('--force-authoring'));
  });

  // A deployment has to be able to raise a limit the engine's table sets.
  it('gives the deployment the last word on a flag the engine also sets', () => {
    assert.ok(argsOf(collator).includes('--rpc-max-connections=50'));
    assert.ok(!argsOf(collator).includes('--rpc-max-connections=500'));
    assert.deepEqual(argsOf(collator).filter((a) => a.startsWith('-l')), ['-lsync=debug']);
    for (const block of rpc) {
      assert.ok(argsOf(block).includes('--rpc-max-connections=5000'));
      assert.ok(argsOf(block).includes('--rpc-message-buffer-capacity-per-connection=512'));
    }
  });

  it('routes the public People path across the RPC nodes and not the collator', () => {
    const model = dashboardModel(loadNetwork('previewnet'), 'https://example.test');
    const people = model.chains.find((c) => c.id === 'people')!;
    assert.deepEqual(people.upstreamPorts, [PORTS.people + 1, PORTS.people + 2]);
    assert.equal(people.port, PORTS.people + 1);

    const upstream = nginxRoutes(model).upstreams.split('\n\n').find((u) => u.startsWith('upstream people '))!;
    assert.match(upstream, /least_conn;/);
    assert.match(upstream, new RegExp(`server 127\\.0\\.0\\.1:${PORTS.people + 2};`));
    assert.doesNotMatch(upstream, new RegExp(`:${PORTS.people};`));
  });

  // A node listens on, and dials, every address it is given.
  it('adds a repeatable flag to the node\'s own instead of replacing them', async () => {
    const { overrideArgs } = await import('../src/args.js');
    assert.deepEqual(overrideArgs(['--listen-addr=/a', '--rpc-port=1'], ['--listen-addr=/b', '--rpc-port=2']), [
      '--listen-addr=/a',
      '--rpc-port=2',
      '--listen-addr=/b',
    ]);
  });

  it('applies each network its own section only', () => {
    const devnet = loadNetwork('devnet');
    assert.deepEqual(devnet.relay.extraArgs, ['--rpc-max-connections=7']);
    assert.ok(devnet.parachains.every((p) => p.rpcNodes === 0));
    assert.deepEqual(loadNetwork('previewnet').relay.extraArgs, []);
  });
});

describe('network overlay: a mistake fails instead of deploying defaults', () => {
  const net = loadDescriptorOnly('previewnet');
  const rejects = (body: unknown, message: RegExp) =>
    assert.throws(() => applyOverlay(net, write('bad.json', body)), message);

  it('rejects an unknown network', () => rejects({ previewnett: {} }, /unknown networks previewnett/));
  it('rejects a chain the network does not have', () =>
    rejects({ previewnet: { parachains: { coretime: {} } } }, /no parachains coretime/));
  it('rejects an unknown field', () =>
    rejects({ previewnet: { parachains: { people: { rpcNode: 2 } } } }, /unknown fields rpcNode/));
  it('rejects more RPC nodes than the port gap holds', () =>
    rejects({ previewnet: { parachains: { people: { rpcNodes: 10 } } } }, /rpcNodes must be an integer 0\.\.9/));
  it('rejects a fractional RPC node count', () =>
    rejects({ previewnet: { parachains: { people: { rpcNodes: 1.5 } } } }, /rpcNodes must be an integer/));
  it('rejects args that are not flags', () =>
    rejects({ previewnet: { relay: { extraArgs: ['rpc-max-connections=1'] } } }, /must be an array of "--flag" strings/));
  it('rejects a file that is not there', () =>
    assert.throws(() => applyOverlay(net, path.join(dir, 'missing.json')), /cannot read the network overlay/));
});
