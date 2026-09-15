import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compressor } from '../src/commands/bite.js';

// Which compressor tar is handed decides whether a bite packs in seconds or minutes, and a
// wrong flag is not a slow pack but a failed one: on BSD tar `-I` is a synonym for `-T`, its
// files-from flag, so the short form reads "pigz" as a file to list and dies on "Couldn't open
// pigz" even with pigz on PATH. Each case points PATH at a directory that has a pigz or has
// none, since that is the only thing the choice turns on.
describe('the tar compressor choice', () => {
  // PATH is replaced, never prepended: with a prepend, a pigz already installed would satisfy
  // the positive case whether or not the shim works.
  const withPath = <T>(dir: string, fn: () => T): T => {
    const prev = process.env.PATH;
    process.env.PATH = dir;
    try {
      return fn();
    } finally {
      process.env.PATH = prev;
    }
  };

  const shimDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppn-pigz-'));
    fs.writeFileSync(path.join(dir, 'pigz'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    return dir;
  };

  // A real directory that simply has no pigz, rather than a path that does not exist.
  const emptyDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'ppn-nopigz-'));

  // Pinned whole rather than as "contains pigz": GNU's `-I` would satisfy a looser assertion
  // and break on a Mac, so the spelling is the thing under test. The name is pinned with it,
  // because that is what the packing log reports.
  it('uses pigz through the spelling both tars accept', () => {
    assert.deepEqual(withPath(shimDir(), compressor), {
      name: 'pigz',
      flags: ['--use-compress-program', 'pigz'],
    });
  });

  it('falls back to -z when pigz is not installed', () => {
    assert.deepEqual(withPath(emptyDir(), compressor), { name: 'gzip', flags: ['-z'] });
  });
});
