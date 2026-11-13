// Tests for copyLocalBinary in packages/cli/src/commands/fetch.ts
// Run with: tsx --test tests/fetch-local.test.ts
//
// A `file:` pinned polkadot is a local build, and polkadot validates PVFs with the two workers
// built alongside it. Copying only polkadot left a node that spawns and then fails every
// candidate it is asked to validate.

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyLocalBinary } from '../src/commands/fetch.js';

let buildDir: string;
let nodeDest: string;

const writeBuild = (...names: string[]) => {
  for (const name of names) fs.writeFileSync(path.join(buildDir, name), `${name} build`);
};

beforeEach(() => {
  buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppn-build-'));
  nodeDest = fs.mkdtempSync(path.join(os.tmpdir(), 'ppn-bin-'));
});
afterEach(() => {
  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.rmSync(nodeDest, { recursive: true, force: true });
});

describe('copyLocalBinary', () => {
  it('copies a local polkadot together with the PVF workers from its build', () => {
    writeBuild('polkadot', 'polkadot-execute-worker', 'polkadot-prepare-worker');
    const copies = copyLocalBinary('polkadot', path.join(buildDir, 'polkadot'), nodeDest);

    assert.deepEqual(copies.map((copy) => copy.name), ['polkadot', 'polkadot-execute-worker', 'polkadot-prepare-worker']);
    for (const name of ['polkadot', 'polkadot-execute-worker', 'polkadot-prepare-worker']) {
      const dest = path.join(nodeDest, name);
      assert.equal(fs.readFileSync(dest, 'utf-8'), `${name} build`);
      assert.ok(fs.statSync(dest).mode & 0o100);
    }
  });

  it('fails, copying nothing, when a worker is missing next to polkadot', () => {
    writeBuild('polkadot', 'polkadot-execute-worker');
    assert.throws(
      () => copyLocalBinary('polkadot', path.join(buildDir, 'polkadot'), nodeDest),
      /no polkadot-prepare-worker next to it/
    );
    assert.deepEqual(fs.readdirSync(nodeDest), []);
  });

  it('copies any other binary alone', () => {
    writeBuild('polkadot-parachain');
    const copies = copyLocalBinary('polkadot-parachain', path.join(buildDir, 'polkadot-parachain'), nodeDest);
    assert.deepEqual(copies.map((copy) => copy.name), ['polkadot-parachain']);
    assert.deepEqual(fs.readdirSync(nodeDest), ['polkadot-parachain']);
  });
});
