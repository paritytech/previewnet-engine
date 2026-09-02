// Tests for packages/cli/src/lib/spawn-stamp.ts
// Run with: tsx --test tests/spawn-stamp.test.ts
//
// One writer, two callers: `ppn start` and `ppn stamp-spawn` (which is how a server gets the
// stamp, since a deployment spawns zombienet directly). The point of sharing it is that a field
// cannot reach one path and silently miss the other — so what is asserted here is the shape
// every caller produces, and that a half-written bundle cannot take a spawn down with it.

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeSpawnStamp, SPAWN_FILE } from '../src/lib/spawn-stamp.js';

let root: string;
const read = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, SPAWN_FILE), 'utf-8'));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ppn-spawn-'));
  delete process.env.PPN_PROFILE;
});
after(() => {
  delete process.env.PPN_PROFILE;
});

describe('writeSpawnStamp', () => {
  it('records a genesis spawn, defaulting the profile to local', () => {
    const data = path.join(root, 'data');
    const stamp = writeSpawnStamp(data, { network: 'previewnet', mode: 'genesis', repoRoot: root });

    assert.equal(stamp.network, 'previewnet');
    assert.equal(stamp.mode, 'genesis');
    assert.equal(stamp.bite, null);
    assert.equal(stamp.profile, 'local');
    // A checkout has no packed release to name, and must not invent one.
    assert.equal(stamp.ppnVersion, undefined);
    assert.ok(!Number.isNaN(Date.parse(stamp.spawnedAt)), 'spawnedAt is not a date');
    // What is returned is what is on disk — the dashboard reads the file, not the return.
    assert.deepEqual(read(data), stamp);
  });

  // The directory is created rather than required: on a server the stamp is written just
  // before the service starts, which may be the first thing to touch a wiped DATA_DIR.
  it('creates the data directory when it does not exist yet', () => {
    const data = path.join(root, 'nested', 'data');
    writeSpawnStamp(data, { network: 'previewnet', mode: 'genesis', repoRoot: root });
    assert.ok(fs.existsSync(path.join(data, SPAWN_FILE)));
  });

  it('names the release when one is installed, and carries the deployable profile', () => {
    process.env.PPN_PROFILE = 'deployable';
    fs.writeFileSync(path.join(root, '.ppn-dist.json'), JSON.stringify({ version: 'v-2026-08-26' }));
    const stamp = writeSpawnStamp(path.join(root, 'data'), {
      network: 'previewnet', mode: 'genesis', repoRoot: root,
    });
    assert.equal(stamp.ppnVersion, 'v-2026-08-26');
    assert.equal(stamp.profile, 'deployable');
  });

  it('carries the bite through for a fork', () => {
    const manifest = path.join(root, 'manifest.json');
    fs.writeFileSync(manifest, JSON.stringify({
      bittenAt: '2026-08-20T10:00:00Z',
      source: 'https://previewnet.substrate.dev/relay/alice',
      biteBlocks: { relay: 100, 'asset-hub': 200 },
    }));
    const stamp = writeSpawnStamp(path.join(root, 'data'), {
      network: 'paseo-next-v2', mode: 'fork', forkManifest: manifest, repoRoot: root,
    });
    assert.equal(stamp.mode, 'fork');
    assert.deepEqual(stamp.bite, {
      at: '2026-08-20T10:00:00Z',
      source: 'https://previewnet.substrate.dev/relay/alice',
      blocks: { relay: 100, 'asset-hub': 200 },
    });
  });

  // A stamp is a nice-to-have; a spawn is not. An interrupted bite leaves a truncated
  // manifest on disk (see usableBundle in commands/start.ts), and reading it must not be what
  // stops the network coming up — the mode still says `fork`, the detail is simply absent.
  it('still stamps a fork whose manifest is missing or unreadable', () => {
    const truncated = path.join(root, 'half.json');
    fs.writeFileSync(truncated, '{"bittenAt": "2026-08-2');

    for (const manifest of [truncated, path.join(root, 'absent.json'), null]) {
      const data = fs.mkdtempSync(path.join(root, 'd-'));
      const stamp = writeSpawnStamp(data, {
        network: 'devnet', mode: 'fork', forkManifest: manifest, repoRoot: root,
      });
      assert.equal(stamp.mode, 'fork', `manifest ${manifest}: mode lost`);
      assert.equal(stamp.bite, null, `manifest ${manifest}: invented a bite`);
    }
  });
});
