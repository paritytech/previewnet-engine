// Tests for packages/cli/src/commands/trinity-stack.ts
// Run with: tsx --test tests/trinity-stack.test.ts
//
// The writer runs against a fixture data directory and fake nodes, and what it writes is read
// back with @parity/trinity-stack, the reader hosts use: the descriptor must open with the
// pointer the dashboard shows, and each spec it names must match the bytes on disk.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDescriptorOnly, P2P_PORTS, PORTS, RELAY_BASE_PORT } from '@parity/ppn-network-config';
import { checkSpec, lightSpecGenesis, open } from '@parity/trinity-stack';
import { writeStack, type Settings } from '../src/commands/trinity-stack.js';

const net = loadDescriptorOnly('previewnet');
const SPECS: Record<string, { port: number; p2p: number }> = {
  'paseo-local': { port: RELAY_BASE_PORT, p2p: P2P_PORTS.relay },
  'asset-hub-local': { port: PORTS['asset-hub'], p2p: P2P_PORTS['asset-hub'] },
  'individuality-local': { port: PORTS.people, p2p: P2P_PORTS.people },
  'bulletin-local': { port: PORTS.bulletin, p2p: P2P_PORTS.bulletin },
  'web3-storage-local': { port: PORTS['web3-storage'], p2p: P2P_PORTS['web3-storage'] },
};

const stateRoot = (port: number) => `0x${port.toString(16).padStart(64, '0')}`;
const genesisOf = (port: number) =>
  lightSpecGenesis(new TextEncoder().encode(JSON.stringify({ genesis: { stateRootHash: stateRoot(port) } })));

/** A node per chain port, answering what the writer asks. */
const fakeNodes: Settings['call'] = async <T,>(url: string, method: string, params: unknown[] = []) => {
  const port = Number(new URL(url).port);
  const answers: Record<string, unknown> = {
    chain_getBlockHash: params[0] === 0 ? genesisOf(port) : `0x${'ab'.repeat(32)}`,
    chain_getHeader: { stateRoot: stateRoot(port) },
    system_localPeerId: `12D3KooW${port}`,
    sync_state_genSyncSpec: { lightSyncState: { finalizedBlockHeader: '0x00' } },
    eth_chainId: '0x190f1b41',
  };
  if (!(method in answers)) throw new Error(`unexpected ${method}`);
  return answers[method] as T;
};

let dataDir: string;
const settings = (extra: Partial<Settings> = {}): Settings => ({
  call: fakeNodes,
  baseUrl: 'http://127.0.0.1:8090',
  dataDir,
  bootnodeHost: '127.0.0.1',
  ...extra,
});
const read = (file: string) => new Uint8Array(fs.readFileSync(path.join(dataDir, file)));

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppn-stack-'));
  for (const [name, { p2p }] of Object.entries(SPECS)) {
    const spec = { id: name, bootNodes: [`/ip4/127.0.0.1/tcp/${p2p}/ws/p2p/12D3KooWzombie`], genesis: { raw: { top: {} } } };
    fs.writeFileSync(path.join(dataDir, `${name}.json`), JSON.stringify(spec, null, 2));
  }
  fs.writeFileSync(
    path.join(dataDir, 'spawn.json'),
    JSON.stringify({ spawnedAt: '2026-10-21T00:00:00.000Z', network: 'previewnet', mode: 'genesis', bite: null, profile: 'local' })
  );
});

describe('writeStack', () => {
  it('writes a descriptor the pointer opens, naming specs that match the files', async () => {
    const { written, complete } = await writeStack({ net }, settings());
    assert.equal(complete, true);
    const { descriptor } = open(read('trinity-stack.json'), written.pointer);
    assert.equal(written.pointer.url, 'http://127.0.0.1:8090/.well-known/trinity-stack.json');
    assert.equal(descriptor.generation, '2026-10-21T00:00:00.000Z');
    assert.equal(descriptor.chains.length, 5);
    for (const chain of descriptor.chains) {
      const name = path.basename(new URL(chain.fullSpec!.url).pathname, '.json');
      checkSpec(chain.fullSpec!, read(`${name}.json`));
      checkSpec(chain.lightSpec!, read(`${name}.smol.json`));
      assert.equal(lightSpecGenesis(read(`${name}.smol.json`)), chain.genesisHash);
    }
  });

  it('points light clients at the nodes it runs, and gives the relay a checkpoint', async () => {
    await writeStack({ net }, settings());
    const relay = JSON.parse(fs.readFileSync(path.join(dataDir, 'paseo-local.smol.json'), 'utf-8'));
    assert.deepEqual(relay.bootNodes, [`/ip4/127.0.0.1/tcp/${P2P_PORTS.relay}/ws/p2p/12D3KooW${RELAY_BASE_PORT}`]);
    assert.deepEqual(relay.lightSyncState, { finalizedBlockHeader: '0x00' });
    assert.deepEqual(relay.genesis, { stateRootHash: stateRoot(RELAY_BASE_PORT) });
  });

  it('keeps the sequence and the bytes when nothing changed', async () => {
    const first = await writeStack({ net }, settings());
    const bytes = read('trinity-stack.json');
    const second = await writeStack({ net }, settings());
    assert.deepEqual(second.written.state, first.written.state);
    assert.deepEqual(read('trinity-stack.json'), bytes);
  });

  it('signs with the deployment key, and the pointer carries it', async () => {
    const { written } = await writeStack({ net }, settings({ secret: new Uint8Array(32).fill(7) }));
    assert.match(written.pointer.key ?? '', /^0x[0-9a-f]{64}$/);
    assert.ok(open(read('trinity-stack.json'), written.pointer).signed);
  });

  it('publishes without the relay light spec until the relay has finalized a block', async () => {
    const unfinalized: Settings['call'] = async (url, method, params) => {
      if (method === 'sync_state_genSyncSpec') throw new Error('Failed to load the block weight');
      return fakeNodes(url, method, params);
    };
    const { written, complete } = await writeStack({ net }, settings({ call: unfinalized }));
    assert.equal(complete, false);
    const relay = open(read('trinity-stack.json'), written.pointer).descriptor.chains[0];
    assert.equal(relay.lightSpec, undefined);
    assert.ok(relay.fullSpec);
  });

  it('describes a fork with the block each chain was bitten at', async () => {
    const blocks = { relay: 100, '1500': 200, '1502': 300, '1501': 400, '1600': 500 };
    fs.writeFileSync(
      path.join(dataDir, 'spawn.json'),
      JSON.stringify({
        spawnedAt: '2026-10-21T00:00:00.000Z', network: 'previewnet', mode: 'fork', profile: 'local',
        bite: { at: '2026-10-20T12:00:00.000Z', source: 'https://previewnet.substrate.dev', blocks },
      })
    );
    const { written } = await writeStack({ net }, settings());
    const { descriptor } = open(read('trinity-stack.json'), written.pointer);
    assert.equal(descriptor.id, 'previewnet-fork');
    assert.deepEqual(descriptor.fork, { of: net.stack!.pointer, at: Date.parse('2026-10-20T12:00:00Z') / 1000 });
    assert.deepEqual(descriptor.chains.map((c) => c.forkedAt?.number), [100, 200, 300, 400, 500]);
  });

  it("refuses a spec that still names the source network's nodes", async () => {
    const file = path.join(dataDir, 'asset-hub-local.json');
    const spec = JSON.parse(fs.readFileSync(file, 'utf-8'));
    spec.bootNodes.push('/dns/asset-hub-paseo.example/tcp/30333/p2p/12D3KooWsource');
    fs.writeFileSync(file, JSON.stringify(spec));
    await assert.rejects(writeStack({ net }, settings()), /names nodes this network does not run/);
    assert.equal(fs.existsSync(path.join(dataDir, 'trinity-stack.json')), false);
  });

  it('waits for patch-bootnodes on a server', async () => {
    await assert.rejects(
      writeStack({ net }, settings({ baseUrl: 'https://ppn.example', bootnodeHost: 'ppn.example' })),
      /not patched to ppn\.example yet/
    );
  });
});
