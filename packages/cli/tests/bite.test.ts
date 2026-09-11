import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  compressor,
  SYNC_SOURCE_PREFIX,
  syncSourceArgs,
  syncSourceWarnings,
} from '../src/commands/bite.js';

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

const SOURCE_ADDR = '/ip4/127.0.0.1/tcp/30333/p2p/12D3KooWQyc7p4d2mFxNyqz8Pd5rHTxbYHXhKV8vFQzZDkLu3Jm1';

// `syncSourceWarnings` reads every variable carrying the sync-source prefix, so these tests clear
// the whole prefix, not only the keys they set: one already exported in the shell would land in
// the result and fail the assertion. `undefined` unsets, which is distinct from ''.
const withEnv = <T>(vars: Record<string, string | undefined>, fn: () => T): T => {
  const existing = Object.keys(process.env).filter((key) => key.startsWith(SYNC_SOURCE_PREFIX));
  const touched = [...new Set([...existing, ...Object.keys(vars)])];
  const prev = new Map(touched.map((key) => [key, process.env[key]]));
  for (const key of existing) delete process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of prev) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

// `--reserved-only` means a wrong or stale pin does not slow a bite down, it stops it, and the
// variable is per para id, so a source belonging to another chain must not pin this one.
describe('the parachain state sync source', () => {
  // Pinned whole: `--reserved-nodes` alone leaves the node as one more peer in the pool.
  it('pins the source and refuses every other peer', () => {
    assert.deepEqual(
      withEnv({ PPN_BITE_SYNC_SOURCE_1000: SOURCE_ADDR }, () => syncSourceArgs('1000')),
      ['--reserved-nodes', SOURCE_ADDR, '--reserved-only']
    );
  });

  it('adds no arguments when no source is set', () => {
    assert.deepEqual(withEnv({ PPN_BITE_SYNC_SOURCE_1000: undefined }, () => syncSourceArgs('1000')), []);
  });

  // Right variable, wrong chain.
  it('ignores a source set for a different para', () => {
    assert.deepEqual(withEnv({ PPN_BITE_SYNC_SOURCE_1000: SOURCE_ADDR }, () => syncSourceArgs('1004')), []);
  });
});

// A para id this network does not have, and an empty value, look the same from the operator's
// side: the variable is set and the bite syncs from public peers regardless, so each has to
// name its own reason.
describe('sync sources that will do nothing', () => {
  it('names a para id this network does not have', () => {
    assert.deepEqual(
      withEnv({ PPN_BITE_SYNC_SOURCE_1001: SOURCE_ADDR }, () => syncSourceWarnings(['1000', '1004'])),
      ['PPN_BITE_SYNC_SOURCE_1001 names no parachain in this network']
    );
  });

  // This network has that para id, so only the empty value makes the variable inert.
  it('is set to an empty value', () => {
    assert.deepEqual(
      withEnv({ PPN_BITE_SYNC_SOURCE_1000: '' }, () => syncSourceWarnings(['1000', '1004'])),
      ['PPN_BITE_SYNC_SOURCE_1000 is set but empty']
    );
  });

  it('stays quiet when a source names a parachain and has a value', () => {
    assert.deepEqual(
      withEnv({ PPN_BITE_SYNC_SOURCE_1000: SOURCE_ADDR }, () => syncSourceWarnings(['1000', '1004'])),
      []
    );
  });

  it('ignores variables that are not sync sources', () => {
    assert.deepEqual(withEnv({ PPN_BITE_LOG_DIR: '/tmp/logs' }, () => syncSourceWarnings(['1000'])), []);
  });
});
