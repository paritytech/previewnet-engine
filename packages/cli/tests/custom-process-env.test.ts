// Tests that every custom process is told this run's workspace, network and data directory.
// Run with: tsx --test packages/cli/tests/custom-process-env.test.ts

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import toml from 'toml';
import { dubCustomProcesses } from '@parity/ppn-network-config';
import { customProcessEnv, spawnTomlFor, withCustomProcessEnv } from '../src/lib/spawn-env.js';

type Process = { name: string; command: string; args?: string[]; env?: { name: string; value: string }[] };
type Config = { custom_processes: Process[]; relaychain?: { nodes?: { name: string; env?: { name: string; value: string }[] }[] } };

const facts = customProcessEnv({ workspace: '/srv/ppn-home', network: 'paseo-next-v2', dataDir: '/srv/ppn-home/data-fork-paseo-next-v2' });
const envOf = (p: { env?: { name: string; value: string }[] }) => Object.fromEntries((p.env ?? []).map((e) => [e.name, e.value]));
const LOCAL_DEV = path.resolve(import.meta.dirname, '../../../zombienet-configs/local-dev.toml');

// zombie-cli (zombienet-sdk's native provider) starts every custom process with an empty
// environment plus TZ, LANG, PATH and the block's own `env`. PPN_HOME in zombie-cli's environment
// never reached them, so with PPN_HOME pointing anywhere but the checkout the launchers resolved
// another workspace (scripts/lib/workspace.sh) and read its ports.local.env, bin/ and data/.
describe('custom process environment', () => {
  it('names the workspace, the network and the data directory', () => {
    assert.deepEqual(facts, {
      PPN_HOME: '/srv/ppn-home',
      PPN_NETWORK: 'paseo-next-v2',
      PPN_DATA_DIR: '/srv/ppn-home/data-fork-paseo-next-v2',
    });
  });

  it('reaches every custom process of the genesis config, with or without an env of its own', () => {
    const before = toml.parse(fs.readFileSync(LOCAL_DEV, 'utf-8')) as Config;
    const after = toml.parse(withCustomProcessEnv(fs.readFileSync(LOCAL_DEV, 'utf-8'), facts)) as Config;
    assert.equal(after.custom_processes.length, before.custom_processes.length);
    assert.ok(before.custom_processes.some((p) => !p.env), 'the fixture has blocks without env');
    assert.ok(before.custom_processes.some((p) => p.env), 'and blocks with one');
    after.custom_processes.forEach((p, i) => {
      assert.deepEqual(envOf(p), { ...facts, ...envOf(before.custom_processes[i]) }, p.name);
      // Nothing else about the block moves.
      assert.equal(p.command, before.custom_processes[i].command);
      assert.deepEqual(p.args, before.custom_processes[i].args);
    });
    // Nodes keep exactly their own environment.
    assert.deepEqual(after.relaychain?.nodes, before.relaychain?.nodes);
  });

  it('reaches the identity backend\'s blocks and the TURN relay\'s, the last block in a fork config', () => {
    const fork = '[settings]\ntimeout = 1\n\n[relaychain]\nchain = "x"\n' +
      dubCustomProcesses({ postgres: 5433, people: 10010, assetHub: 10020, gateway: 8092 }, undefined, '/opt/ppn/scripts', true);
    const parsed = toml.parse(withCustomProcessEnv(fork, facts)) as Config;
    assert.deepEqual(parsed.custom_processes.map((p) => p.name), [
      'dub-postgres', 'dub-api', 'device-attestation-chain-writer', 'registration-queue', 'invite-tickets-pool', 'turn',
    ]);
    for (const p of parsed.custom_processes) assert.deepEqual({ ...envOf(p), ...facts }, envOf(p), p.name);
    assert.equal(envOf(parsed.custom_processes[1]).TURN_REALM, 'previewnet.local', 'dub-api keeps its own entries');
  });

  it('keeps an entry a block sets itself, and a single-line env', () => {
    const text = '[[custom_processes]]\nname = "a"\ncommand = "/a.sh"\nenv = [{ name = "PPN_NETWORK", value = "devnet" }]\n\n' +
      '[[custom_processes]]\nname = "b"\ncommand = "/b.sh"\nenv = []\n';
    const [a, b] = (toml.parse(withCustomProcessEnv(text, facts)) as Config).custom_processes;
    assert.deepEqual(envOf(a), { ...facts, PPN_NETWORK: 'devnet' });
    assert.deepEqual(envOf(b), facts);
  });

  it('is idempotent and leaves a config without custom processes as it was', () => {
    const once = withCustomProcessEnv(fs.readFileSync(LOCAL_DEV, 'utf-8'), facts);
    assert.equal(withCustomProcessEnv(once, facts), once);
    const nodesOnly = '[relaychain]\nchain = "x"\n\n[[relaychain.nodes]]\nname = "alice"\nenv = [{ name = "A", value = "1" }]\n';
    assert.equal(withCustomProcessEnv(nodesOnly, facts), nodesOnly);
  });

  it('writes the spawned config beside its source, so relative paths resolve the same', () => {
    assert.equal(spawnTomlFor('/opt/ppn/zombienet-configs/local-dev.toml'), '/opt/ppn/zombienet-configs/local-dev.spawn.toml');
    assert.equal(spawnTomlFor('/ppn/fork-bundle-devnet/fork.toml'), '/ppn/fork-bundle-devnet/fork.spawn.toml');
  });
});
