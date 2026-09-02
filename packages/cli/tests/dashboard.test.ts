// Tests for packages/cli/src/commands/dashboard.ts
// Run with: tsx --test tests/dashboard.test.ts
//
// The sidecar is exercised as a black box on an ephemeral port against a fixture workspace:
// the contract answers, the stamps are passed through verbatim, the log whitelist rejects
// anything not on disk (traversal included), and the SSE stream replays what the file holds.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..', '..', '..');
const PORT = 18091;
const BASE = `http://127.0.0.1:${PORT}`;

let tmp: string;
let child: ChildProcess;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ppn-dash-'));
  // A workspace: descriptors so loadNetwork resolves, a bin with a provenance stamp,
  // a data dir with one log.
  fs.cpSync(path.join(REPO, 'networks'), path.join(tmp, 'networks'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'bin', 'provenance.json'),
    JSON.stringify({
      fetchedAt: '2026-08-21T00:00:00Z', network: 'previewnet', platform: 'test',
      binaries: [{ name: 'polkadot', repo: 'org/sdk', pinned: 'latest', resolved: 'w34', sha256: 'ab'.repeat(32) }],
      runtimes: [],
    })
  );
  fs.mkdirSync(path.join(tmp, 'data', 'eth-rpc'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'data', 'eth-rpc', 'eth-rpc.log'), 'line one\nline two\n');
  fs.writeFileSync(
    path.join(tmp, 'data', 'spawn.json'),
    JSON.stringify({ spawnedAt: '2026-08-21T00:00:01Z', network: 'previewnet', mode: 'genesis', bite: null, profile: 'local' })
  );

  child = spawn(process.execPath, [path.join(REPO, 'bin', 'ppn.mjs'), 'service', 'dashboard'], {
    env: {
      ...process.env,
      PPN_HOME: tmp,
      BIN: path.join(tmp, 'bin'),
      DATA_DIR: path.join(tmp, 'data'),
      DASHBOARD_PORT: String(PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Up when the port answers.
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`${BASE}/api/network`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('dashboard did not come up');
});

after(() => {
  child.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const get = async (p: string) => {
  const res = await fetch(`${BASE}${p}`);
  return { status: res.status, body: res.status === 200 ? await res.json() : null };
};

describe('dashboard actions gate', () => {
  // Who may run a sudo action is decided by who can reach the socket. Bound to loopback it
  // is open (only this machine can call it); bound wider it refuses without a token — 403,
  // not 401, because no credential exists that would have worked. With a token, only the
  // exact bearer passes.
  it('is open when bound to loopback', async () => {
    const { body } = await get('/api/actions');
    assert.equal(body.enabled, true);
  });

  it('refuses a bad chain name before reading a body', async () => {
    const res = await fetch(`${BASE}/api/actions/upgrade?chain=../etc`, { method: 'POST', body: 'x' });
    assert.equal(res.status, 400);
  });

  it('is closed when bound beyond loopback with no token', async () => {
    const PORT2 = PORT + 1;
    const child2 = spawn(process.execPath, [path.join(REPO, 'bin', 'ppn.mjs'), 'service', 'dashboard'], {
      env: { ...process.env, PPN_HOME: tmp, BIN: path.join(tmp, 'bin'), DATA_DIR: path.join(tmp, 'data'),
             DASHBOARD_PORT: String(PORT2), DASHBOARD_HOST: '0.0.0.0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      for (let i = 0; i < 50; i++) {
        try { await fetch(`http://127.0.0.1:${PORT2}/api/network`); break; }
        catch { await new Promise((r) => setTimeout(r, 100)); }
      }
      const state = await (await fetch(`http://127.0.0.1:${PORT2}/api/actions`)).json();
      assert.equal(state.enabled, false);
      const res = await fetch(`http://127.0.0.1:${PORT2}/api/actions/upgrade?chain=asset-hub`, {
        method: 'POST', body: Buffer.from([0, 0x61, 0x73, 0x6d]),
      });
      assert.equal(res.status, 403);
    } finally {
      child2.kill();
    }
  });

  it('with a token set, only the exact bearer passes the gate', async () => {
    const PORT3 = PORT + 2;
    const child3 = spawn(process.execPath, [path.join(REPO, 'bin', 'ppn.mjs'), 'service', 'dashboard'], {
      env: { ...process.env, PPN_HOME: tmp, BIN: path.join(tmp, 'bin'), DATA_DIR: path.join(tmp, 'data'),
             DASHBOARD_PORT: String(PORT3), DASHBOARD_HOST: '0.0.0.0', DASHBOARD_ACTIONS_TOKEN: 's3cret' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      for (let i = 0; i < 50; i++) {
        try { await fetch(`http://127.0.0.1:${PORT3}/api/network`); break; }
        catch { await new Promise((r) => setTimeout(r, 100)); }
      }
      const wrong = await fetch(`http://127.0.0.1:${PORT3}/api/actions/upgrade?chain=asset-hub`, {
        method: 'POST', headers: { authorization: 'Bearer nope' }, body: 'x',
      });
      assert.equal(wrong.status, 401);
      // The right bearer passes the gate; the 400 is the next check (chain body), which is
      // fine — the assertion here is authentication, not a live upgrade.
      const right = await fetch(`http://127.0.0.1:${PORT3}/api/actions/upgrade?chain=bad/chain`, {
        method: 'POST', headers: { authorization: 'Bearer s3cret' }, body: 'x',
      });
      assert.equal(right.status, 400);
    } finally {
      child3.kill();
    }
  });
});

describe('dashboard API', () => {
  it('serves the contract', async () => {
    const { body } = await get('/api/network');
    assert.equal(body.schemaVersion, 1);
    assert.equal(body.network.name, 'previewnet');
    assert.ok(body.chains.length >= 10);
    assert.ok(body.chains.every((c: { url: string }) => c.url.startsWith('ws://')));
  });

  it('passes the stamps through verbatim', async () => {
    const { body } = await get('/api/provenance');
    assert.equal(body.provenance.binaries[0].pinned, 'latest');
    assert.equal(body.provenance.binaries[0].resolved, 'w34');
    assert.equal(body.spawn.mode, 'genesis');
  });

  it('lists only logs that exist on disk, grouped for reading', async () => {
    const { body } = await get('/api/logs');
    // eth-rpc is a long-running service; the fixture has no chain or script logs.
    assert.deepEqual(body, { chains: [], services: ['eth-rpc'], scripts: [] });
  });

  it('rejects unknown log ids and traversal attempts', async () => {
    assert.equal((await get('/api/logs/nope')).status, 404);
    assert.equal((await get('/api/logs/..%2F..%2Fetc%2Fpasswd')).status, 404);
    assert.equal((await get('/api/logs/eth-rpc%2F..%2F..')).status, 404);
  });

  it('streams a log over SSE, replaying existing content', async () => {
    const res = await fetch(`${BASE}/api/logs/eth-rpc`);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    assert.match(text, /data: line one/);
    assert.match(text, /data: line two/);
    await reader.cancel();
  });

  // The probe asks each chain three things in one JSON-RPC batch, and the answers are matched
  // by id rather than by position. A stub node stands in for a collator: it answers the batch
  // in reverse, so a regression that read results by index would hand the client version to
  // the runtime field and this would catch it.
  //
  // It has to bind the port the model expects for relay-alice, so it is skipped rather than
  // failed when a real network (or another run) already holds it.
  it('reports the running runtime and node version, matched by id', async () => {
    const ports = fs.readFileSync(path.join(REPO, 'config', 'ports.env'), 'utf-8');
    const alicePort = Number(/^RELAY_ALICE_PORT=(\d+)/m.exec(ports)?.[1]);
    assert.ok(alicePort, 'RELAY_ALICE_PORT is not in config/ports.env');

    // A real network on this machine owns that port, and then the stub cannot be the thing the
    // dashboard probes. Detected by connecting rather than by a failed bind: a listener on
    // 0.0.0.0 does not always make a 127.0.0.1 bind fail, and the test would then pass its
    // bind and still be probing the real node.
    const occupied = await new Promise<boolean>((resolve) => {
      const probe = net.connect(alicePort, '127.0.0.1');
      probe.once('connect', () => { probe.destroy(); resolve(true); });
      probe.once('error', () => resolve(false));
      probe.setTimeout(1000, () => { probe.destroy(); resolve(false); });
    });
    if (occupied) {
      console.log(`# skipped: a network is already running on port ${alicePort}`);
      return;
    }

    const stub = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const calls = JSON.parse(body) as { id: number; method: string }[];
        assert.ok(Array.isArray(calls), 'the probe must send one batch, not three requests');
        const answer = (id: number) => {
          const method = calls.find((c) => c.id === id)!.method;
          if (method === 'chain_getHeader') return { jsonrpc: '2.0', id, result: { number: '0x2a' } };
          if (method === 'state_getRuntimeVersion')
            return { jsonrpc: '2.0', id, result: {
              specName: 'paseo', specVersion: 1004000, implVersion: 0, transactionVersion: 26 } };
          return { jsonrpc: '2.0', id, result: '1.19.2-deadbeef' };
        };
        // Reversed on purpose: the JSON-RPC spec lets a server answer a batch in any order.
        const out = calls.map((c) => answer(c.id)).reverse();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      });
    });

    const bound = await new Promise<boolean>((resolve) => {
      stub.once('error', () => resolve(false));
      stub.listen(alicePort, '127.0.0.1', () => resolve(true));
    });
    if (!bound) {
      console.log(`# skipped: port ${alicePort} is already in use`);
      return;
    }

    try {
      // The probe loop runs every 5s; wait for the tick that sees the stub. The wait is for
      // the stub's *own* spec version, not merely for some runtime to appear: the dashboard
      // probes once at startup, so a value cached before the stub existed would otherwise
      // satisfy the loop and be asserted against the stub's fixture.
      let entry: { runtime?: { specName: string; specVersion: number }; clientVersion?: string } | undefined;
      for (let i = 0; i < 70; i++) {
        await new Promise((r) => setTimeout(r, 200));
        const { body } = await get('/api/health');
        entry = (body as { id: string }[]).find((e) => e.id === 'relay-alice') as typeof entry;
        if (entry?.runtime?.specVersion === 1004000) break;
      }
      assert.ok(entry?.runtime, 'no runtime version reported for relay-alice');
      assert.equal(entry.runtime.specName, 'paseo');
      assert.equal(entry.runtime.specVersion, 1004000);
      assert.equal(entry.clientVersion, '1.19.2-deadbeef');
    } finally {
      stub.close();
    }
  });

  it('reports health for every probed endpoint', async () => {
    // The prober runs on startup; give it a beat.
    await new Promise((r) => setTimeout(r, 500));
    const { body } = await get('/api/health');
    assert.ok(body.length > 0);
    // The fixture probes the well-known local ports, and a developer (or a shared runner)
    // may have a real network up on them — so the assertion is the *shape*, not "all down":
    // every probed endpoint reports a status and a timestamp, whichever way the probe went.
    for (const e of body as { id: string; status: string; checkedAt: string }[]) {
      assert.ok(['ok', 'down'].includes(e.status), `${e.id}: unexpected status ${e.status}`);
      assert.ok(e.checkedAt, `${e.id}: no checkedAt`);
    }
  });
});
