// The shared-relay overrides, which exist because a fork of somebody else's relay inherits a
// core layout and a messaging state that are both wrong for six dev validators.
//
// Encodings are pinned here rather than eyeballed: the same class of value (ValidatorGroups)
// once shipped with a missing compact length and decoded as `[[], …]`, which mis-assigned every
// core silently. The live-metadata decode check in overrides.ts is the other half of that.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compactLen, keyOf, u32le } from '../src/fork/codec.js';
import {
  coresFor,
  coreDescriptorsValue,
  DMP_HEAD_EMPTY,
  HRMP_INGRESS_EMPTY,
  messagingWipes,
  paraMessagingWipes,
  planCores,
  transactionStorageWipes,
  FORK_RETENTION_PERIOD,
  validatorGroups,
  FULL_CORE,
} from '../src/fork/shared-relay.js';

const PNV2 = [
  { key: 'asset-hub', paraId: 1500 },
  { key: 'people', paraId: 1502 },
  { key: 'bulletin', paraId: 1501 },
];

describe('planCores', () => {
  it('keeps Asset Hub on three cores, everything else on one', () => {
    assert.equal(coresFor('asset-hub'), 3);
    assert.equal(coresFor('people'), 1);
    assert.equal(coresFor('bulletin'), 1);
  });

  // Upward from zero is the whole point: those are the cores the runtime staffs first.
  it('lays the parachains out from core 0 with no gaps', () => {
    assert.deepEqual(planCores(PNV2), [
      { core: 0, paraId: 1500 },
      { core: 1, paraId: 1500 },
      { core: 2, paraId: 1500 },
      { core: 3, paraId: 1502 },
      { core: 4, paraId: 1501 },
    ]);
  });

  // 5 cores + 1 = 6 validators, which is exactly the number of dev keys a fork runs. If this
  // ever exceeds them, groups start coming out empty again and blocks stop being backed.
  it('plans no more cores than six validators can staff', () => {
    assert.ok(planCores(PNV2).length < 6, 'a fork has six dev validators');
  });
});

describe('validatorGroups', () => {
  // 6 validators over 5 cores: the sixth has to go somewhere, and it goes to group 0 rather
  // than leaving a group empty.
  it('gives every core at least one validator', () => {
    const value = validatorGroups(5, 6);
    assert.equal(
      value,
      compactLen(5) +
        (compactLen(2) + u32le(0) + u32le(5)) +
        (compactLen(1) + u32le(1)) +
        (compactLen(1) + u32le(2)) +
        (compactLen(1) + u32le(3)) +
        (compactLen(1) + u32le(4))
    );
  });

  it('carries a compact length per group, not just for the outer list', () => {
    // The bug this pins: outer length only, which decodes as five empty groups.
    const value = validatorGroups(2, 2);
    assert.equal(value, compactLen(2) + compactLen(1) + u32le(0) + compactLen(1) + u32le(1));
    assert.notEqual(value, compactLen(2) + u32le(0) + u32le(1));
  });

  // Parsed, not substring-searched: `compactLen(0)` is '00', which appears inside every u32le,
  // so looking for it finds a false empty group in a perfectly good value.
  const parseGroups = (hex: string): number[][] => {
    let at = 0;
    const byte = () => parseInt(hex.slice(at, (at += 2)), 16) >> 2; // single-byte compact
    const count = byte();
    return Array.from({ length: count }, () => {
      const len = byte();
      return Array.from({ length: len }, () => {
        const v = parseInt(hex.slice(at, at + 8).match(/../g)!.reverse().join(''), 16);
        at += 8;
        return v;
      });
    });
  };

  it('never leaves a group empty, whatever the ratio', () => {
    for (const cores of [1, 2, 3, 5, 6]) {
      const groups = parseGroups(validatorGroups(cores, 6));
      assert.equal(groups.length, cores, `${cores} groups`);
      for (const [i, g] of groups.entries()) {
        assert.ok(g.length >= 1, `core ${i} of ${cores} has no validator`);
      }
      assert.deepEqual(groups.flat().sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
    }
  });
});

describe('paraMessagingWipes', () => {
  // The pairing that matters: zeroing only the relay's copy turns the mismatch around rather
  // than resolving it — the parachain's stale head on one side, a zero hash on the other.
  it('zeroes the parachain half of the DMP head', () => {
    assert.deepEqual(paraMessagingWipes(), {
      [keyOf('ParachainSystem', 'LastDmqMqcHead')]: DMP_HEAD_EMPTY,
    });
  });
});

describe('messagingWipes', () => {
  it('empties both HRMP ingress and the DMP head for each parachain', () => {
    const wipes = messagingWipes([1500, 1501]);
    assert.equal(Object.keys(wipes).length, 4);
    for (const id of [1500, 1501]) {
      const hrmp = Object.entries(wipes).find(
        ([k]) => k.startsWith(keyOf('Hrmp', 'HrmpIngressChannelsIndex')) && k.includes(u32le(id))
      );
      const dmp = Object.entries(wipes).find(
        ([k]) => k.startsWith(keyOf('Dmp', 'DownwardMessageQueueHeads')) && k.includes(u32le(id))
      );
      assert.equal(hrmp?.[1], HRMP_INGRESS_EMPTY, `hrmp ${id}`);
      assert.equal(dmp?.[1], DMP_HEAD_EMPTY, `dmp ${id}`);
    }
  });

  it('writes a 32-byte zero hash for the DMP head', () => {
    assert.equal(DMP_HEAD_EMPTY.length, 64);
    assert.equal(BigInt('0x' + DMP_HEAD_EMPTY), 0n);
  });
});

describe('coreDescriptorsValue', () => {
  // Keyed by core index, because the storage value is a BTreeMap. Encoding it as a list of
  // pairs fails inside an Option — the next entry's core index gets read as the previous
  // entry's `queue` — which is exactly how this was wrong the first time.
  it('gives each core one full-ratio task, keyed by core', () => {
    assert.deepEqual(coreDescriptorsValue([{ core: 0, paraId: 1500 }]), {
      0: {
        queue: null,
        currentWork: {
          assignments: [[{ Task: 1500 }, { ratio: FULL_CORE, remaining: FULL_CORE }]],
          endHint: null,
          pos: 0,
          step: FULL_CORE,
        },
      },
    });
  });

  it('describes every planned core', () => {
    const value = coreDescriptorsValue(planCores(PNV2));
    assert.deepEqual(Object.keys(value), ['0', '1', '2', '3', '4']);
    assert.deepEqual(
      Object.values(value).map((d: any) => d.currentWork.assignments[0][0].Task),
      [1500, 1500, 1500, 1502, 1501]
    );
  });
});

describe('transactionStorageWipes', () => {
  // Bulletin on Paseo is at ~1.49M blocks with a 201,600-block retention period, so it wants a
  // proof for a block whose data a bite does not carry — and pallet-transaction-storage asserts on
  // that in on_finalize, so the chain builds no block at all.
  it('pushes the retention period past any plausible chain height', () => {
    assert.deepEqual(transactionStorageWipes(), {
      [keyOf('TransactionStorage', 'RetentionPeriod')]: u32le(FORK_RETENTION_PERIOD),
    });
    assert.ok(FORK_RETENTION_PERIOD > 10_000_000, 'must exceed any chain we fork');
    // and stay well inside u32, because the pallet also schedules cleanup at now + period
    assert.ok(FORK_RETENTION_PERIOD < 2_000_000_000, 'must not risk overflowing u32');
  });
});
