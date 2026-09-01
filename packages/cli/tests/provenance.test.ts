// Tests for packages/cli/src/lib/provenance.ts
// Run with: tsx --test tests/provenance.test.ts
//
// The stamp is history: what a pin resolved to when the fetch ran, and what actually landed.
// It must record only artifacts that exist (a failed download has no provenance), keep the
// pinned/resolved pair distinct (that pair is the whole point for `latest` pins), and hash
// the real bytes so "is staging running the same binary" is answerable.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeProvenance, readProvenance, reusable, PROVENANCE_FILE } from '../src/lib/provenance.js';

let dir: string;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppn-prov-'));
  // A "binary" that answers --version, as the real ones do.
  fs.writeFileSync(path.join(dir, 'polkadot'), '#!/bin/sh\necho "polkadot 9.9.9-testbuild"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'runtime.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d]));
  // The shared toolchain: one that answers --version, one that refuses (as some do).
  fs.writeFileSync(path.join(dir, 'dub'), '#!/bin/sh\necho "dub 0.3.1"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'zombie-cli'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const read = () => JSON.parse(fs.readFileSync(path.join(dir, PROVENANCE_FILE), 'utf-8'));

describe('writeProvenance', () => {
  it('records pinned vs resolved, hash, and the probed version', () => {
    writeProvenance(dir, 'previewnet', [
      { kind: 'binary', name: 'polkadot', repo: 'org/sdk', pinned: 'latest',
        resolved: 'weekly-w34', file: path.join(dir, 'polkadot') },
      { kind: 'runtime', name: 'runtime.wasm', repo: 'org/runtimes', pinned: 'v1.0.0',
        resolved: 'v1.0.0', file: path.join(dir, 'runtime.wasm') },
    ]);
    const p = read();
    assert.equal(p.network, 'previewnet');
    assert.ok(p.fetchedAt);

    const bin = p.binaries[0];
    assert.equal(bin.pinned, 'latest');
    assert.equal(bin.resolved, 'weekly-w34');
    assert.equal(bin.version, 'polkadot 9.9.9-testbuild');
    const expected = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(dir, 'polkadot'))).digest('hex');
    assert.equal(bin.sha256, expected);

    // Runtimes are not executables: hashed, never probed.
    assert.equal(p.runtimes[0].version, undefined);
    assert.equal(p.runtimes[0].sha256.length, 64);
  });

  // The toolchain is pinned in config/versions.env, not in a descriptor, and it used to be
  // stamped nowhere — so "which DUB is staging running?" had no answer. It is a third group
  // rather than more binaries: these are shared across networks, and mixing them in with a
  // network's own polkadot build muddies both.
  it('records the shared toolchain as its own group, probed like a binary', () => {
    writeProvenance(dir, 'previewnet', [
      { kind: 'binary', name: 'polkadot', repo: 'org/sdk', pinned: 'latest',
        resolved: 'weekly-w34', file: path.join(dir, 'polkadot') },
      { kind: 'toolchain', name: 'dub', repo: 'org/device-uniqueness-backend', pinned: 'v0.3.1',
        resolved: 'v0.3.1', file: path.join(dir, 'dub') },
      { kind: 'toolchain', name: 'zombie-cli', repo: 'org/zombienet', pinned: 'v1.3.133',
        resolved: 'v1.3.133', file: path.join(dir, 'zombie-cli') },
    ]);
    const p = read();
    // Toolchain entries do not leak into the network's own binaries, and vice versa.
    assert.deepEqual(p.binaries.map((b: { name: string }) => b.name), ['polkadot']);
    assert.deepEqual(p.toolchain.map((t: { name: string }) => t.name), ['dub', 'zombie-cli']);

    const dub = p.toolchain[0];
    assert.equal(dub.version, 'dub 0.3.1');
    assert.equal(dub.repo, 'org/device-uniqueness-backend');
    assert.equal(dub.sha256.length, 64);
    // A --version that exits non-zero is recorded as no version, not as a failed stamp: the
    // hash and the resolved tag still answer "which build is this".
    assert.equal(p.toolchain[1].version, undefined);
    assert.equal(p.toolchain[1].resolved, 'v1.3.133');
  });

  it('drops artifacts whose download failed, rather than inventing history', () => {
    writeProvenance(dir, 'previewnet', [
      { kind: 'binary', name: 'ghost', repo: 'org/sdk', pinned: 'latest',
        resolved: 'weekly-w34', file: path.join(dir, 'does-not-exist') },
      { kind: 'binary', name: 'polkadot', repo: 'org/sdk', pinned: 'latest',
        resolved: 'weekly-w34', file: path.join(dir, 'polkadot') },
    ]);
    const p = read();
    assert.deepEqual(p.binaries.map((b: { name: string }) => b.name), ['polkadot']);
  });
});

// The skip decision. It exists because a fetch used to re-download every artifact every
// time — 3.7 GB for previewnet, on a laptop and on every deploy, almost always to write back
// bytes that were already there.
//
// The previous stamp is the cache index, and the reason it is the *right* index is the
// resolved tag: a `latest` pin that moved resolves elsewhere, and nothing else on disk can
// tell you that — the file looks identical either way. So the cases below are the contract.
describe('reusable', () => {
  const bin = () => path.join(dir, 'polkadot');
  const stamp = (resolved: string) => {
    writeProvenance(dir, 'previewnet', [
      { kind: 'binary', name: 'polkadot', repo: 'org/sdk', pinned: 'latest', resolved, file: bin() },
    ]);
    return readProvenance(dir)!;
  };

  it('reuses a file whose resolved tag and bytes both still match', () => {
    const prev = stamp('weekly-w34');
    const hash = reusable(prev, 'polkadot', 'weekly-w34', bin());
    assert.ok(hash, 'an unchanged artifact was not reused');
    // The hash comes back so the caller can stamp without hashing the file a second time.
    assert.equal(hash, prev.binaries[0].sha256);
  });

  it('re-downloads when a moving pin has resolved somewhere new', () => {
    const prev = stamp('weekly-w34');
    // Same file on disk, same `latest` pin — only the resolution moved. This is the case the
    // whole design turns on: a size or mtime check would wrongly skip here.
    assert.equal(reusable(prev, 'polkadot', 'weekly-w35', bin()), null);
  });

  it('re-downloads when the file was edited, truncated or deleted', () => {
    const prev = stamp('weekly-w34');
    fs.writeFileSync(bin(), '#!/bin/sh\necho tampered\n');
    assert.equal(reusable(prev, 'polkadot', 'weekly-w34', bin()), null);
    fs.rmSync(bin());
    assert.equal(reusable(prev, 'polkadot', 'weekly-w34', bin()), null);
    // Put it back for any later test in this file.
    fs.writeFileSync(bin(), '#!/bin/sh\necho "polkadot 9.9.9-testbuild"\n', { mode: 0o755 });
  });

  it('re-downloads what no previous stamp mentions, and never guesses without one', () => {
    const prev = stamp('weekly-w34');
    assert.equal(reusable(prev, 'never-fetched', 'weekly-w34', bin()), null);
    // No stamp at all — a fresh bin/, or `--force`, which passes null deliberately.
    assert.equal(reusable(null, 'polkadot', 'weekly-w34', bin()), null);
  });

  it('finds an artifact in any of the three groups', () => {
    // Toolchain and runtime entries have to be reusable too, or dub/kubo/postgres re-download
    // on every fetch — and postgres alone is an archive worth hundreds of MB.
    fs.writeFileSync(path.join(dir, 'dub'), 'dub-bytes');
    writeProvenance(dir, 'previewnet', [
      { kind: 'toolchain', name: 'dub', repo: 'org/dub', pinned: 'v0.3.0', resolved: 'v0.3.0',
        file: path.join(dir, 'dub') },
      { kind: 'runtime', name: 'runtime.wasm', repo: 'org/rt', pinned: 'v1', resolved: 'v1',
        file: path.join(dir, 'runtime.wasm') },
    ]);
    const prev = readProvenance(dir)!;
    assert.ok(reusable(prev, 'dub', 'v0.3.0', path.join(dir, 'dub')), 'toolchain not reusable');
    assert.ok(reusable(prev, 'runtime.wasm', 'v1', path.join(dir, 'runtime.wasm')), 'runtime not reusable');
  });
});

describe('readProvenance', () => {
  it('returns null rather than throwing when there is no stamp to read', () => {
    assert.equal(readProvenance(path.join(dir, 'nope')), null);
  });
});
