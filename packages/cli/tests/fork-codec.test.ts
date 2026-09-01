// Tests for packages/cli/src/fork/codec.ts and packages/cli/src/fork/chains.ts
// Run with: tsx --test packages/cli/tests/fork-codec.test.ts

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  compactLen,
  encodeHeadData,
  keyOf,
  parasHeadKey,
  twox64Concat,
  u32le,
} from '../src/fork/codec.js';
import { CHAINS, PARACHAINS } from '../src/fork/chains.js';
import { VALID_PARACHAINS, paraIds } from '@parity/ppn-network-config';

describe('keyOf', () => {
  // Known twox128 prefixes — these are the storage keys the whole bite depends on, so they
  // are pinned rather than recomputed by the test.
  it('derives well-known storage prefixes', () => {
    assert.equal(keyOf('System', 'Account'), '26aa394eea5630e07c48ae0c9558cef7b99d880ec681799c0cf30e8886371da9');
    assert.equal(keyOf('Paras', 'Heads'), 'cd710b30bd2eab0352ddcc26417aa1941b3c252fcb29d88eff4f3de5de4476c3');
  });

  it('is 64 hex chars with no 0x prefix', () => {
    const k = keyOf('Session', 'Validators');
    assert.equal(k.length, 64);
    assert.match(k, /^[0-9a-f]+$/);
  });
});

describe('u32le', () => {
  it('encodes little-endian', () => {
    assert.equal(u32le(0), '00000000');
    assert.equal(u32le(1), '01000000');
    assert.equal(u32le(1500), 'dc050000');
    assert.equal(u32le(1600), '40060000');
  });
});

describe('parasHeadKey', () => {
  it('is the Paras::Heads prefix, then twox64(paraId), then the para id', () => {
    const key = parasHeadKey(1502);
    assert.ok(key.startsWith(keyOf('Paras', 'Heads')), 'wrong storage prefix');
    assert.ok(key.endsWith(u32le(1502)), 'para id not appended in the clear');
    assert.equal(key.length, 64 + 16 + 8);
  });

  it('differs per para', () => {
    const keys = [1500, 1501, 1502, 1600].map(parasHeadKey);
    assert.equal(new Set(keys).size, 4);
  });
});

describe('twox64Concat', () => {
  it('prefixes the hash and keeps the encoded key', () => {
    const encoded = 'aa'.repeat(32);
    const k = twox64Concat(encoded);
    assert.ok(k.endsWith(encoded));
    assert.equal(k.length, 16 + encoded.length);
  });
});

describe('compactLen', () => {
  it('encodes the single-byte mode', () => {
    assert.equal(compactLen(0), '00');
    assert.equal(compactLen(1), '04');
    assert.equal(compactLen(6), '18'); // six validators
    assert.equal(compactLen(63), 'fc');
  });

  // Silently mis-encoding a longer sequence is exactly the class of bug that produced a
  // ValidatorGroups value decoding as [[], …].
  it('refuses anything it cannot encode in one byte', () => {
    assert.throws(() => compactLen(64), /only supports n < 64/);
    assert.throws(() => compactLen(-1), /non-negative integer/);
    assert.throws(() => compactLen(1.5), /non-negative integer/);
  });
});

describe('encodeHeadData', () => {
  it('uses one-byte compact below 64 bytes', () => {
    assert.equal(encodeHeadData('0x' + 'ab'.repeat(4)), '10abababab');
    assert.equal(encodeHeadData('ab'.repeat(4)), '10abababab', '0x prefix is optional');
  });

  it('uses two-byte compact from 64 bytes', () => {
    const out = encodeHeadData('cd'.repeat(64));
    assert.equal(out.slice(0, 4), '0101'); // (64 << 2) | 1 = 257 -> 0x01 0x01
    assert.equal(out.length, 4 + 128);
  });

  it('uses four-byte compact from 16384 bytes', () => {
    const out = encodeHeadData('ef'.repeat(16384));
    assert.equal(out.length, 8 + 32768);
    assert.equal(out.slice(0, 8), '02000100');
  });

  it('round-trips the payload', () => {
    const body = 'deadbeef'.repeat(10);
    assert.ok(encodeHeadData('0x' + body).endsWith(body));
  });
});

describe('CHAINS', () => {
  it('lists the relay plus every parachain PPN knows', () => {
    assert.equal(CHAINS.length, 5);
    assert.equal(PARACHAINS.length, 4);
    assert.ok(!PARACHAINS.some((c) => c.paraId === null));
  });

  // If these drift, a bundle manifest can no longer be read against VALID_PARACHAINS and
  // fork.toml generation fails with a "parachain set mismatch".
  it('keys parachains exactly as packages/cli/src/types.ts does', () => {
    assert.deepEqual(PARACHAINS.map((c) => c.key).sort(), [...VALID_PARACHAINS].sort());
  });

  // Para ids are derived from paraIds() now, so asserting they match it would be
  // tautological. Pin the documented values instead — that catches a typo in ports.env.
  it('carries the documented para ids', () => {
    assert.deepEqual(Object.fromEntries(PARACHAINS.map((c) => [c.key, c.paraId])), {
      'asset-hub': 1500,
      bulletin: 1501,
      people: 1502,
      'web3-storage': 1600,
    });
    assert.equal(paraIds()['asset-hub'], 1500, 'ports.env and the docs disagree');
  });

  // People is the one chain whose bundle spec name differs from its key.
  it('records the bundle spec name for each chain', () => {
    assert.equal(CHAINS.find((c) => c.key === 'people')?.spec, 'individuality');
    assert.equal(CHAINS.find((c) => c.key === 'relay')?.spec, 'paseo');
  });
});
