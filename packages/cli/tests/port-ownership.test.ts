// Tests that `ppn start` and `ppn kill` leave alone what this workspace did not start.
// Run with: tsx --test packages/cli/tests/port-ownership.test.ts

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { loadNetwork } from '@parity/ppn-network-config';
import { refuseOccupiedPorts, servicePorts, sweepPatterns } from '../src/commands/start.js';

const REQUIRE_FREE = path.resolve(import.meta.dirname, '../../../scripts/require-free-ports.sh');

// A service port used to be "freed" with `lsof -ti :port | kill -9`. That matched whatever held
// the port — another checkout's network, a developer's own Postgres or IPFS daemon — and, since
// `-i :port` matches either end of a connection, every client talking to that port elsewhere: a
// browser on some host's :8080, a wallet on a remote :8545. It now refuses instead.
describe('occupied service ports', () => {
  const ports = [
    { key: 'IPFS_API_PORT', port: '5001' },
    { key: 'DUB_POSTGRES_PORT', port: '5433' },
  ];

  it('starts when nothing listens', () => {
    assert.doesNotThrow(() => refuseOccupiedPorts(ports, () => []));
  });

  it('refuses a held port, naming the port, its key and the holder, and stops nothing', () => {
    const asked: string[] = [];
    const holders = (port: string) => {
      asked.push(port);
      return port === '5433' ? ['postgres(4242)'] : [];
    };
    assert.throws(
      () => refuseOccupiedPorts(ports, holders),
      (err: Error) =>
        /1 service port\(s\)/.test(err.message) &&
        /5433 \(DUB_POSTGRES_PORT\) — postgres\(4242\)/.test(err.message) &&
        /nothing was stopped/.test(err.message) &&
        !/5001/.test(err.message)
    );
    // Every port is looked at, so one error lists them all.
    assert.deepEqual(asked, ['5001', '5433']);
  });

  it('checks the TURN relay\'s ports only for a network that runs the relay', () => {
    const values = { DASHBOARD_PORT: '8090', TURN_PORT: '3478', TURN_PROXY_PORT: '3479' };
    const previewnet = loadNetwork('previewnet');
    const keys = (def: typeof previewnet) => servicePorts(def, values).map((p) => p.key);
    assert.deepEqual(keys(previewnet), ['DASHBOARD_PORT', 'TURN_PORT', 'TURN_PROXY_PORT']);
    const noRelay = { ...previewnet, services: { ...previewnet.services, turn: false } } as typeof previewnet;
    assert.deepEqual(keys(noRelay), ['DASHBOARD_PORT']);
  });
});

// `ppn kill` used to `killall -9 polkadot` (and every other node binary by name) and pkill any
// `postgres-dist/bin/postgres`: every network on the machine, whoever started it. Its patterns
// are now anchored to this workspace's bin/ and this package's own launchers.
describe('ppn kill sweep patterns', () => {
  const sweep = sweepPatterns('/home/dev/.ppn', '/opt/ppn');
  const matches = (pattern: string, args: string) => new RegExp(pattern).test(args);

  it('matches this workspace\'s nodes and service binaries, wherever bin/ keeps them', () => {
    for (const args of [
      '/home/dev/.ppn/bin/zombie-cli spawn -p native local-dev.toml',
      '/home/dev/.ppn/bin/polkadot --chain relay.json',
      '/home/dev/.ppn/bin/paseo-next-v2/polkadot-omni-node --collator',
      '/home/dev/.ppn/bin/devnet/dg/doppelganger --chain x',
      '/home/dev/.ppn/bin/polkadot-execute-worker',
      '/home/dev/.ppn/bin/ipfs daemon --enable-gc',
      '/home/dev/.ppn/bin/paseo-next-v2/eth-rpc --node-rpc-url ws://127.0.0.1:10020',
      '/home/dev/.ppn/bin/dub all-in-one',
    ]) {
      assert.ok(matches(sweep.binaries, args), args);
    }
  });

  it('matches nothing another workspace or the system runs', () => {
    for (const args of [
      '/home/other/.ppn/bin/polkadot --chain relay.json',
      '/home/dev/xppn/bin/polkadot --chain relay.json', // the dot in .ppn is escaped
      '/usr/local/bin/polkadot --dev',
      '/home/dev/.ppn-2/bin/ipfs daemon',
      'polkadot --dev',
      '/home/dev/.ppn/bin/polkadot-unrelated',
    ]) {
      assert.ok(!matches(sweep.binaries, args), args);
    }
  });

  it('matches this package\'s launchers and services, from a checkout or from npm', () => {
    assert.ok(matches(sweep.launchers, '/bin/bash /opt/ppn/scripts/dub/service.sh --role=all-in-one'));
    assert.ok(matches(sweep.launchers, 'bash /opt/ppn/scripts/ipfs-daemon.sh'));
    assert.ok(!matches(sweep.launchers, 'bash /opt/other/scripts/ipfs-daemon.sh'));
    assert.ok(matches(sweep.services, 'node /opt/ppn/bin/ppn.mjs service turn'));
    assert.ok(matches(sweep.services, 'node /opt/ppn/dist/bin.js service dashboard'));
    assert.ok(!matches(sweep.services, 'node /opt/other/bin/ppn.mjs service turn'));
    assert.ok(!matches(sweep.services, 'node /opt/ppn/bin/ppn.mjs start'));
  });

  it('matches only this workspace\'s Postgres', () => {
    assert.ok(matches(sweep.postgres, '/home/dev/.ppn/bin/postgres-dist/bin/postgres -D /data/identity-pgdata'));
    assert.ok(!matches(sweep.postgres, '/home/other/.ppn/bin/postgres-dist/bin/postgres -D /x'));
    assert.ok(!matches(sweep.postgres, '/opt/homebrew/opt/postgresql@16/bin/postgres -D /usr/local/var/postgres'));
  });
});

describe('require-free-ports.sh', () => {
  it('passes when nothing is given or the port is free', () => {
    assert.equal(spawnSync('bash', [REQUIRE_FREE], { encoding: 'utf-8' }).status, 0);
    assert.equal(spawnSync('bash', [REQUIRE_FREE, ''], { encoding: 'utf-8' }).status, 0);
  });

  it('refuses a port something listens on, names the holder and leaves it running', async () => {
    const held = net.createServer();
    const port: number = await new Promise((r) =>
      held.listen(0, '127.0.0.1', () => r((held.address() as net.AddressInfo).port))
    );
    try {
      const r = spawnSync('bash', [REQUIRE_FREE, String(port)], { encoding: 'utf-8' });
      assert.equal(r.status, 1);
      assert.match(r.stderr, new RegExp(`port ${port} is in use by node\\(${process.pid}\\)`));
      assert.match(r.stderr, /nothing was stopped/);
      assert.ok(held.listening, 'the holder is still listening');
    } finally {
      await new Promise((r) => held.close(r));
    }
  });
});
