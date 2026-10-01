// Tests for packages/cli/src/fork/topology.ts — what `--cores`/`--collators` settle into.
// Run with: tsx --test packages/cli/tests/fork-topology.test.ts

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadNetwork } from '@parity/ppn-network-config';
import { resolveTopology, sameTopology, topologyFlags } from '../src/fork/topology.js';

const previewnet = loadNetwork('previewnet');

describe('resolveTopology', () => {
  it('is nothing when nothing was asked for', () => {
    assert.equal(resolveTopology({}, previewnet), undefined);
    assert.equal(resolveTopology({ cores: [], collators: [] }, previewnet), undefined);
  });

  // previewnet: Asset Hub 3 + People 3 + Bulletin 1 + Web3 Storage 1 = 8 cores, and every
  // core needs a validator group of its own or nothing backs the blocks on it.
  it('grows the validator set to one per core', () => {
    assert.deepEqual(resolveTopology({ cores: ['people=3'], collators: ['people=5'] }, previewnet), {
      validators: 8,
      cores: { people: 3 },
      collators: { people: 5 },
    });
  });

  it('keeps the descriptor validators when the cores fit inside them', () => {
    assert.equal(resolveTopology({ collators: ['people=5'] }, previewnet)?.validators, previewnet.relay.validators);
  });

  it('refuses a chain the network does not run, a bad count, and a malformed spec', () => {
    assert.throws(() => resolveTopology({ cores: ['kitchen-sink=3'] }, previewnet), /does not run/);
    assert.throws(() => resolveTopology({ cores: ['people=0'] }, previewnet), /at least 1/);
    assert.throws(() => resolveTopology({ collators: ['people=two'] }, previewnet), /at least 1/);
    assert.throws(() => resolveTopology({ cores: ['people'] }, previewnet), /<chain>=<count>/);
  });

  // The eleventh relay RPC port is People's.
  it('refuses more cores than the relay has validator ports for', () => {
    assert.throws(() => resolveTopology({ cores: ['people=6'] }, previewnet), /at most 10/);
  });
});

describe('sameTopology', () => {
  const t = { validators: 8, cores: { people: 3 }, collators: { people: 5 } };

  it('treats two default bites as the same', () => {
    assert.ok(sameTopology(undefined, undefined));
  });

  it('tells a default bundle from an asked-for one, either way round', () => {
    assert.ok(!sameTopology(t, undefined));
    assert.ok(!sameTopology(undefined, t));
  });

  it('compares what was asked for, not key order', () => {
    assert.ok(sameTopology(t, { validators: 8, collators: { people: 5 }, cores: { people: 3 } }));
    assert.ok(!sameTopology(t, { ...t, collators: { people: 4 } }));
  });
});

describe('topologyFlags', () => {
  it('spells the flags that would ask for it again', () => {
    assert.equal(
      topologyFlags({ validators: 8, cores: { people: 3 }, collators: { people: 5 } }),
      '--cores people=3 --collators people=5'
    );
  });
});
