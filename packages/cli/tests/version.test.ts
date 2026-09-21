// What `ppn version` reports, per install shape.
//
// The shapes are the point: the same code answers differently from a checkout, an npm
// install and an unpacked dist, and only the last two carry a version worth quoting. Each
// case here is a directory laid out the way that shape really is, so a change to the layout
// (a renamed manifest, a moved package.json) fails here rather than on someone's box.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { distManifest, packageVersion, formatVersion, type VersionInfo } from '../src/lib/version.js';

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ppn-version-'));
}

function write(file: string, body: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
}

describe('distManifest', () => {
  it('reads the manifest a dist tarball carries', () => {
    const root = tmpdir();
    write(path.join(root, '.ppn-dist.json'), {
      version: 'v1.2.3',
      commit: 'abc1234',
      repo: 'paritytech/previewnet-engine',
      builtAt: '2026-09-18T10:00:00.000Z',
    });
    assert.equal(distManifest(root)?.version, 'v1.2.3');
    assert.equal(distManifest(root)?.commit, 'abc1234');
  });

  it('is null where there is no manifest', () => {
    assert.equal(distManifest(tmpdir()), null);
  });

  it('is null rather than a throw on a half-written manifest', () => {
    const root = tmpdir();
    write(path.join(root, '.ppn-dist.json'), '{"version": "v1.2.3"');
    assert.equal(distManifest(root), null);
  });

  it('is null when the manifest names no version', () => {
    const root = tmpdir();
    write(path.join(root, '.ppn-dist.json'), { builtAt: '2026-09-18T10:00:00.000Z' });
    assert.equal(distManifest(root), null);
  });
});

describe('packageVersion', () => {
  it('reads an installed package, whose root is @parity/ppn itself', () => {
    const root = tmpdir();
    write(path.join(root, 'package.json'), { name: '@parity/ppn', version: '1.2.3' });
    assert.equal(packageVersion(root), '1.2.3');
  });

  it('reaches into packages/cli in a checkout, past the private workspace root', () => {
    const root = tmpdir();
    // The root package.json is `ppn`, private, and carries a version of its own — which is
    // exactly the one that must not be reported.
    write(path.join(root, 'package.json'), { name: 'ppn', version: '9.9.9', private: true });
    write(path.join(root, 'packages', 'cli', 'package.json'), { name: '@parity/ppn', version: '1.2.3' });
    assert.equal(packageVersion(root), '1.2.3');
  });

  it('is unknown rather than a guess when no @parity/ppn is there', () => {
    const root = tmpdir();
    write(path.join(root, 'package.json'), { name: 'something-else', version: '9.9.9' });
    assert.equal(packageVersion(root), 'unknown');
  });
});

describe('formatVersion', () => {
  const base: VersionInfo = {
    version: '1.2.3',
    install: 'npm',
    node: 'v24.0.0',
    platform: 'linux x64',
    packageRoot: '/usr/lib/node_modules/@parity/ppn',
    workspace: '/home/u/.ppn',
  };

  it('states the install shape on the identity line', () => {
    assert.match(formatVersion(base).split('\n')[0], /^ppn 1\.2\.3 \(npm\)$/);
  });

  it('carries the commit and the build day of a dist', () => {
    const line = formatVersion({
      ...base,
      install: 'dist',
      commit: 'abc1234',
      builtAt: '2026-09-18T10:00:00.000Z',
    }).split('\n')[0];
    assert.equal(line, 'ppn 1.2.3 (dist, commit abc1234, built 2026-09-18)');
  });

  it('names the commit in a checkout, where the version is a placeholder', () => {
    const line = formatVersion({ ...base, install: 'checkout', commit: '7907a3b' }).split('\n')[0];
    assert.equal(line, 'ppn 1.2.3 (checkout, commit 7907a3b)');
  });

  it('reports both roots, which is what tells one install apart from another', () => {
    const out = formatVersion(base);
    assert.match(out, /package {3}\/usr\/lib\/node_modules\/@parity\/ppn/);
    assert.match(out, /workspace \/home\/u\/\.ppn/);
  });
});
