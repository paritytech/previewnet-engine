// Tests for packages/cli/src/commands/trinity-stack.ts
// Run with: tsx --test tests/trinity-stack.test.ts
//
// The writer runs against a fixture data directory and fake nodes, and what it writes is read
// back with @parity/trinity-stack, the reader hosts use: the descriptor must open with the
// pointer the dashboard shows, and each spec it names must match the bytes on disk. The
// generation and sequence rules are what tell readers to drop caches and refuse rollbacks.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDescriptorOnly, P2P_PORTS, PORTS, RELAY_BASE_PORT } from '@parity/ppn-network-config';
import { checkSpec, lightSpecGenesis, open } from '@parity/trinity-stack';
import { trinityStack, writeStack, type Settings } from '../src/commands/trinity-stack.js';
import type { ServiceContext } from '../src/commands/service-context.js';

const net = loadDescriptorOnly('previewnet');
const SPECS: Record<string, { port: number; p2p: number }> = {
  'paseo-local': { port: RELAY_BASE_PORT, p2p: P2P_PORTS.relay },
  'asset-hub-local': { port: PORTS['asset-hub'], p2p: P2P_PORTS['asset-hub'] },
  'individuality-local': { port: PORTS.people, p2p: P2P_PORTS.people },
  'bulletin-local': { port: PORTS.bulletin, p2p: P2P_PORTS.bulletin },
  'web3-storage-local': { port: PORTS['web3-storage'], p2p: P2P_PORTS['web3-storage'] },
};
const T0 = new Date('2026-10-21T00:00:00Z');
const later = (seconds: number) => () => new Date(T0.getTime() + seconds * 1000);

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
/** The same nodes, with one method failing. */
const failing = (failed: string): Settings['call'] => async (url, method, params) => {
  if (method === failed) throw new Error(`${failed} unavailable`);
  return fakeNodes(url, method, params);
};

let dataDir: string;
const settings = (extra: Partial<Settings> = {}): Settings => ({
  call: fakeNodes,
  now: () => T0,
  baseUrl: 'http://127.0.0.1:8090',
  dataDir,
  bootnodeHost: '127.0.0.1',
  ...extra,
});
const read = (file: string) => new Uint8Array(fs.readFileSync(path.join(dataDir, file)));
const readJson = (file: string) => JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf-8'));
const writeSpecs = (host: string) => {
  const hostPart = host === '127.0.0.1' ? '/ip4/127.0.0.1' : `/dns4/${host}`;
  for (const [name, { p2p }] of Object.entries(SPECS)) {
    const spec = { id: name, bootNodes: [`${hostPart}/tcp/${p2p}/ws/p2p/12D3KooWzombie`], genesis: { raw: { top: {} } } };
    fs.writeFileSync(path.join(dataDir, `${name}.json`), JSON.stringify(spec, null, 2));
  }
};
const stamp = (extra: Record<string, unknown> = {}) =>
  fs.writeFileSync(
    path.join(dataDir, 'spawn.json'),
    JSON.stringify({ spawnedAt: '2026-10-21T00:00:00.000Z', network: 'previewnet', mode: 'genesis', bite: null, profile: 'local', ...extra })
  );

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppn-stack-'));
  writeSpecs('127.0.0.1');
  stamp();
});

describe('writeStack — what it writes', () => {
  it('writes a descriptor the pointer opens, naming specs that match the files', async () => {
    const { written, complete } = await writeStack({ net }, settings());
    assert.equal(complete, true);
    const { descriptor } = open(read('trinity-stack.json'), written.pointer);
    assert.equal(written.pointer.url, 'http://127.0.0.1:8090/.well-known/trinity-stack.json');
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
    const relay = readJson('paseo-local.smol.json');
    assert.deepEqual(relay.bootNodes, [`/ip4/127.0.0.1/tcp/${P2P_PORTS.relay}/ws/p2p/12D3KooW${RELAY_BASE_PORT}`]);
    assert.deepEqual(relay.lightSyncState, { finalizedBlockHeader: '0x00' });
    assert.deepEqual(relay.genesis, { stateRootHash: stateRoot(RELAY_BASE_PORT) });
  });

  it('behind https, offers native light clients ws and browsers wss', async () => {
    writeSpecs('ppn.example');
    await writeStack({ net }, settings({ baseUrl: 'https://ppn.example', bootnodeHost: 'ppn.example' }));
    assert.deepEqual(readJson('asset-hub-local.smol.json').bootNodes, [
      `/dns4/ppn.example/tcp/${P2P_PORTS['asset-hub']}/ws/p2p/12D3KooW${PORTS['asset-hub']}`,
      `/dns4/ppn.example/tcp/31335/wss/p2p/12D3KooW${PORTS['asset-hub']}`,
    ]);
  });

  it('signs with the deployment key, and the pointer carries it', async () => {
    const { written } = await writeStack({ net }, settings({ secret: new Uint8Array(32).fill(7) }));
    assert.match(written.pointer.key ?? '', /^0x[0-9a-f]{64}$/);
    assert.ok(open(read('trinity-stack.json'), written.pointer).signed);
  });

  it('never signs a fork, whose machine may hold its source key', async () => {
    stamp({ mode: 'fork' });
    const { written } = await writeStack({ net }, settings({ secret: new Uint8Array(32).fill(7) }));
    assert.equal(written.pointer.key, undefined);
    assert.equal(open(read('trinity-stack.json'), written.pointer).signed, false);
  });

  const blocks = { relay: 100, '1500': 200, '1502': 300, '1501': 400, '1600': 500 };
  const hashes = Object.fromEntries(Object.keys(blocks).map((id, i) => [id, `0x${String(i + 1).repeat(64)}`]));
  const bite = (extra: Record<string, unknown> = {}) => ({
    at: '2026-10-20T12:00:00.000Z', source: 'https://previewnet.substrate.dev', blocks, ...extra,
  });

  it("describes a fork with the source's block each chain was bitten at", async () => {
    stamp({ mode: 'fork', bite: bite({ hashes }) });
    const { written } = await writeStack({ net }, settings());
    const { descriptor } = open(read('trinity-stack.json'), written.pointer);
    assert.equal(descriptor.id, 'previewnet-fork');
    assert.deepEqual(descriptor.fork, { of: net.stack!.pointer, at: Date.parse('2026-10-20T12:00:00Z') / 1000 });
    // The recorded source hashes, not the fork's own blocks, which the fake answers as 0xabab…
    assert.deepEqual(descriptor.chains.map((c) => c.forkedAt), [
      { number: 100, hash: hashes.relay },
      { number: 200, hash: hashes['1500'] },
      { number: 300, hash: hashes['1502'] },
      { number: 400, hash: hashes['1501'] },
      { number: 500, hash: hashes['1600'] },
    ]);
  });

  it("names a fork from a bundle that predates biteHashes, but claims no source block", async () => {
    stamp({ mode: 'fork', bite: bite() });
    const { written } = await writeStack({ net }, settings());
    const { descriptor } = open(read('trinity-stack.json'), written.pointer);
    assert.equal(descriptor.id, 'previewnet-fork');
    assert.equal(descriptor.fork, undefined);
    assert.ok(descriptor.chains.every((c) => c.forkedAt === undefined));
  });
});

describe('writeStack — generation and sequence', () => {
  it('keeps the generation when the network resumes, though the spawn is stamped again', async () => {
    const first = await writeStack({ net }, settings());
    stamp({ spawnedAt: '2026-10-22T00:00:00.000Z' });
    const second = await writeStack({ net }, settings({ now: later(86400) }));
    assert.equal(second.written.generation, first.written.generation);
  });

  it('mints a new generation when the data directory is wiped', async () => {
    const first = await writeStack({ net }, settings());
    fs.rmSync(path.join(dataDir, 'trinity-stack.state.json'));
    stamp({ spawnedAt: '2026-10-22T00:00:00.000Z' });
    const second = await writeStack({ net }, settings({ now: later(86400) }));
    assert.notEqual(second.written.generation, first.written.generation);
    assert.equal(second.written.generation, '2026-10-22T00:00:00.000Z');
  });

  it('keeps the sequence and the bytes when nothing changed, however much later', async () => {
    const first = await writeStack({ net }, settings());
    const bytes = read('trinity-stack.json');
    const second = await writeStack({ net }, settings({ now: later(1000) }));
    assert.deepEqual(second.written.state, first.written.state);
    assert.deepEqual(read('trinity-stack.json'), bytes);
  });

  it('raises the sequence when the content changes', async () => {
    const first = await writeStack({ net }, settings());
    const second = await writeStack({ net }, settings({ now: later(1000), faucet: 'https://faucet.example' }));
    assert.equal(second.written.state.sequence, first.written.state.sequence + 1000);
  });
});

describe('writeStack — what it refuses or defers', () => {
  it('refuses a light spec that does not imply the chain genesis', async () => {
    const wrongRoot: Settings['call'] = async (url, method, params) =>
      method === 'chain_getHeader' ? ({ stateRoot: stateRoot(1) } as never) : fakeNodes(url, method, params);
    await assert.rejects(writeStack({ net }, settings({ call: wrongRoot })), /light spec implies genesis/);
  });

  it('publishes without the relay light spec until the relay has finalized a block', async () => {
    const { written, complete } = await writeStack({ net }, settings({ call: failing('sync_state_genSyncSpec') }));
    assert.equal(complete, false);
    const relay = open(read('trinity-stack.json'), written.pointer).descriptor.chains[0];
    assert.equal(relay.lightSpec, undefined);
    assert.ok(relay.fullSpec);
  });

  it('publishes without eth-rpc until it answers', async () => {
    const { written, complete } = await writeStack({ net }, settings({ call: failing('eth_chainId') }));
    assert.equal(complete, false);
    const { descriptor } = open(read('trinity-stack.json'), written.pointer);
    assert.equal(descriptor.services.find((s) => s.kind === 'eth-rpc'), undefined);
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

  it('writes nothing for an ephemeral run, whose data directory is an earlier run', async () => {
    const ctx: ServiceContext = {
      net,
      ports: { PPN_EPHEMERAL: '1' },
      binDir: dataDir,
      sharedBinDir: dataDir,
      relayWs: 'ws://127.0.0.1:1',
      sudoUri: '//Alice',
      dataDir,
      baseUrl: 'http://127.0.0.1:8090',
    };
    await trinityStack(ctx);
    assert.equal(fs.existsSync(path.join(dataDir, 'trinity-stack.json')), false);
  });
});
