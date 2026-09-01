// Tests for the network-selection plumbing of `ppn start`.
// Run with: tsx --test packages/cli/tests/start-network.test.ts

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDirFor, binDirFor, forkDirFor, checkPorts } from '../src/commands/start.js';

// `ppn start <network>` must become $PPN_NETWORK before anything downstream runs: fetch,
// fork fetch-bundle and every service resolve the network from the environment, not from an
// argument. When the argument stayed local, `ppn start --fork devnet` fetched *previewnet's*
// artifacts into bin/devnet and downloaded previewnet's bundle under devnet's name — visibly
// ("Fetching previewnet ... into .../bin/devnet") and wrongly.
describe('start network selection', () => {
  it('suffixes every per-network path consistently', () => {
    assert.match(dataDirFor('devnet', true), /data-fork-devnet$/);
    assert.match(binDirFor('devnet'), /bin\/devnet$/);
    assert.match(forkDirFor('devnet'), /fork-bundle-devnet$/);
    // previewnet is the unsuffixed default everywhere.
    assert.match(dataDirFor('previewnet', false), /data$/);
    assert.match(binDirFor('previewnet'), /bin$/);
  });

  it('start() exports its network argument as PPN_NETWORK', async () => {
    const saved = process.env.PPN_NETWORK;
    delete process.env.PPN_NETWORK;
    try {
      const { start } = await import('../src/commands/start.js');
      // devnet is fork-only, and we pass no --fork: start() must throw — but only *after*
      // committing the network to the environment, which is the behaviour under test.
      await assert.rejects(() => start(['devnet'], {}), /fork-only/);
      assert.equal(process.env.PPN_NETWORK, 'devnet');
    } finally {
      if (saved === undefined) delete process.env.PPN_NETWORK;
      else process.env.PPN_NETWORK = saved;
    }
  });
});

// A port the config names but cannot bind is the failure that reaches the user as
// `panicked at crates/orchestrator/src/lib.rs:842: removal index (is 0) should be < len (is 0)`:
// zombienet drops the node into an error list nothing reads, then panics on the empty
// collator list minutes later. Refusing up front is the whole point, so the assertion is
// that the message names the port and the node.
describe('checkPorts', () => {
  const tomlNaming = (port: number) =>
    ['[[parachains.collators]]', 'name = "people-collator1"', `rpc_port = ${port}`, 'p2p_port = 39999'].join('\n');

  const write = (body: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppn-ports-'));
    const file = path.join(dir, 'net.toml');
    fs.writeFileSync(file, body);
    return file;
  };

  // Releasing a port and then asserting the check passes would race anything else on the
  // machine claiming it in between — the very failure this guard is about. So the freed
  // port is re-probed, and the assertion runs only once the precondition is known to hold.
  const stillFree = async (port: number) =>
    new Promise<boolean>((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen({ port, host: '0.0.0.0' }, () => s.close(() => resolve(true)));
    });

  it('passes when every port the config names is free', async () => {
    const probe = net.createServer();
    const port: number = await new Promise((r) => probe.listen(0, '0.0.0.0', () => r((probe.address() as net.AddressInfo).port)));
    await new Promise((r) => probe.close(r));
    if (!(await stillFree(port))) return; // someone took it; nothing to assert about
    await checkPorts(write(tomlNaming(port)));
  });

  it('refuses, naming the port, the node and the field', async () => {
    const held = net.createServer();
    const port: number = await new Promise((r) => held.listen(0, '0.0.0.0', () => r((held.address() as net.AddressInfo).port)));
    try {
      await assert.rejects(
        () => checkPorts(write(tomlNaming(port))),
        (err: Error) =>
          err.message.includes(String(port)) &&
          err.message.includes('people-collator1 rpc_port') &&
          err.message.includes('ppn kill')
      );
    } finally {
      await new Promise((r) => held.close(r));
    }
  });
});
