// Tests for packages/cli/src/fork/validators.ts and the verify() step of ./overrides.ts
// Run with: tsx --test packages/cli/tests/fork-validators.test.ts

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ALICE_SR,
  VALIDATORS,
  collatorKey,
  paraCandidates,
  paraInjects,
  relayCandidates,
  relayInjects,
  sessionKeys,
  authorizedUpgradeCandidate,
} from '../src/fork/validators.js';
import { verify, verifyInjects } from '../src/fork/overrides.js';
import { compactLen, keyOf, u32le } from '../src/fork/codec.js';
import { PARACHAINS } from '../src/fork/chains.js';

// Captured from the override files of a bite that produced a verified working fork, before
// this logic was ported from scripts/fork/*.mjs to TypeScript. Any change to an encoding
// here changes the authority set a fork boots with.
const GOLDEN = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, 'fixtures/overrides.golden.json'), 'utf-8')
) as Record<string, { overrides: Record<string, string>; injects: Record<string, string> }>;

describe('the dev authority set', () => {
  it('has six validators', () => {
    assert.equal(VALIDATORS.length, 6);
  });

  it('starts with Alice, whose babe key is also the sudo key', () => {
    assert.equal(VALIDATORS[0].babe, ALICE_SR);
    assert.equal(relayCandidates()[keyOf('Sudo', 'Key')], ALICE_SR);
  });

  // ActiveValidatorIndices and ValidatorGroups index into this list positionally, so the
  // order is get_validator_keys()' order — note FERDIE before EVE — not alphabetical.
  it('keeps zombie-bite key order, with Ferdie before Eve', () => {
    const ferdie = 'e659a7a1628cdd93febc04a4e0646ea20e9f5f0ce097d9a05290d4a9e054df4e';
    const eve = '1cbd2d43530a44705ad088af313e18f80b53ef16b36177cd4b77b846f2a5f07c';
    assert.equal(VALIDATORS[4].babe, eve, 'index 4 should be Eve');
    assert.equal(VALIDATORS[5].babe, ferdie, 'index 5 should be Ferdie');
  });

  it('has no duplicate keys', () => {
    for (const field of ['stash', 'babe', 'grandpa', 'beefy'] as const) {
      const values = VALIDATORS.map((v) => v[field]);
      assert.equal(new Set(values).size, 6, `duplicate ${field}`);
    }
  });

  it('composes session keys as grandpa+babe+paraValidator+paraAssignment+discovery+beefy', () => {
    const v = VALIDATORS[0];
    assert.equal(sessionKeys(v), v.grandpa + v.babe + v.babe + v.babe + v.babe + v.beefy);
    // 5 x 32-byte sr25519/ed25519 keys + 1 x 33-byte beefy key
    assert.equal(sessionKeys(v).length, (32 * 5 + 33) * 2);
  });
});

describe('relay overrides', () => {
  const candidates = relayCandidates();

  it('matches the values a verified bite produced', () => {
    for (const [key, value] of Object.entries(GOLDEN.relay.overrides)) {
      assert.equal(candidates[key], value, `override ${key} changed`);
    }
    for (const [key, value] of Object.entries(GOLDEN.relay.injects)) {
      assert.equal(relayInjects()[key], value, `inject ${key} changed`);
    }
  });

  // The bug this guards: without the inner compact length each group encoded as empty, the
  // value decoded as [[], …], and cores would have been silently mis-assigned.
  it('gives every validator group its own compact length', () => {
    const expected = compactLen(6) + [0, 1, 2, 3, 4, 5].map((i) => compactLen(1) + u32le(i)).join('');
    assert.equal(candidates[keyOf('ParaScheduler', 'ValidatorGroups')], expected);
  });

  it('prefixes every list with a compact length of six', () => {
    for (const item of ['Validators', 'QueuedKeys'] as const) {
      assert.ok(candidates[keyOf('Session', item)].startsWith(compactLen(6)), `Session::${item}`);
    }
    assert.ok(candidates[keyOf('Babe', 'Authorities')].startsWith(compactLen(6)));
    assert.ok(candidates[keyOf('Grandpa', 'Authorities')].startsWith(compactLen(6)));
  });

  it('numbers the active validator indices 0..5', () => {
    assert.equal(
      candidates[keyOf('ParasShared', 'ActiveValidatorIndices')],
      compactLen(6) + [0, 1, 2, 3, 4, 5].map(u32le).join('')
    );
  });

  // Without ForceNone the first session rotation re-elects production's validators, whose
  // NextKeys doppelganger just wiped, and authoring stops after one epoch.
  it('forces staking to ForceNone', () => {
    assert.equal(candidates[keyOf('Staking', 'ForceEra')], '02');
  });

  // All relay pallets, and production's values are the ones we want: overriding them costs
  // the cores Asset Hub's 2s blocks depend on, the ECC host function People's PVFs need, the
  // HRMP channels and the para registrations.
  it("leaves the relay's host configuration, HRMP/DMP and para registrations alone", () => {
    for (const [pallet, item] of [
      ['Configuration', 'ActiveConfig'],
      ['Hrmp', 'HrmpChannels'],
      ['Dmp', 'DownwardMessageQueues'],
      ['Paras', 'Parachains'],
    ]) {
      assert.equal(candidates[keyOf(pallet, item)], undefined, `${pallet}::${item} must not be overridden`);
    }
  });

  it('injects session keys for all six validators plus the UsePreviousValidators flag', () => {
    const injects = relayInjects();
    assert.equal(injects['c57d82d01f0fc18afc048ca20ac460dd'], '01');
    assert.equal(Object.keys(injects).length, 7);
  });
});

describe('para overrides', () => {
  it('derives the collator key from //Collator-<paraId>, deterministically', async () => {
    const a = await collatorKey(1502);
    const b = await collatorKey(1502);
    assert.equal(a, b);
    assert.equal(a.length, 64);
    assert.notEqual(a, await collatorKey(1500), 'para id must change the key');
  });

  it('matches the values a verified bite produced, for every parachain', async () => {
    for (const { paraId } of PARACHAINS) {
      const collator = await collatorKey(paraId);
      const candidates = paraCandidates(collator);
      const injects = paraInjects(collator);
      for (const [key, value] of Object.entries(GOLDEN[paraId].overrides)) {
        assert.equal(candidates[key], value, `para ${paraId} override ${key} changed`);
      }
      for (const [key, value] of Object.entries(GOLDEN[paraId].injects)) {
        assert.equal(injects[key], value, `para ${paraId} inject ${key} changed`);
      }
    }
  });

  it('installs exactly one collator as the authority', async () => {
    const collator = await collatorKey(1500);
    const candidates = paraCandidates(collator);
    assert.equal(candidates[keyOf('CollatorSelection', 'DesiredCandidates')], '01000000');
    for (const [pallet, item] of [['Aura', 'Authorities'], ['AuraExt', 'Authorities'], ['Session', 'Validators']]) {
      assert.equal(candidates[keyOf(pallet, item)], compactLen(1) + collator, `${pallet}::${item}`);
    }
  });

  // Zeroing it, as zombie-bite does, desyncs the parachain from the relay's preserved Dmp.
  it('leaves ParachainSystem::LastDmqMqcHead alone', async () => {
    const candidates = paraCandidates(await collatorKey(1500));
    assert.equal(candidates[keyOf('ParachainSystem', 'LastDmqMqcHead')], undefined);
  });
});

// verify() is what stands between a wrong encoding and a silently broken fork, so its own
// behaviour is pinned here with a stand-in registry.
describe('verify', () => {
  const PLAIN = 1;
  const registry = {
    createLookupType: (id: number) => `Type${id}`,
    createType: (_type: string, hex: string) => ({
      toHex: () => (hex === '0xbad' ? '0xdifferent' : hex),
    }),
  } as never;

  const index = (entries: [string, { label: string; plain: number | null }][]) => ({
    reg: registry,
    byKey: new Map(entries),
  });

  it('keeps values that round-trip', () => {
    const r = verify(index([['k1', { label: 'Pallet::Item', plain: PLAIN }]]), { k1: 'aabb' });
    assert.deepEqual(r.kept, { k1: 'aabb' });
    assert.deepEqual(r.failures, []);
  });

  it('skips keys the runtime does not have, rather than failing', () => {
    const r = verify(index([]), { missing: 'aabb' });
    assert.deepEqual(r.kept, {});
    assert.deepEqual(r.failures, []);
    assert.equal(r.skipped.length, 1);
  });

  it('skips maps, which have no single plain value', () => {
    const r = verify(index([['k1', { label: 'Pallet::Map', plain: null }]]), { k1: 'aabb' });
    assert.deepEqual(r.kept, {});
    assert.match(r.skipped[0], /map, not a plain value/);
  });

  it('fails a value that does not round-trip', () => {
    const r = verify(index([['k1', { label: 'Pallet::Item', plain: PLAIN }]]), { k1: 'bad' });
    assert.deepEqual(r.kept, {});
    assert.equal(r.failures.length, 1);
    assert.match(r.failures[0], /Pallet::Item: round-trip mismatch/);
  });
});

// Injects were the one class of write a bite made with nothing checking the shape: verify()
// skips maps, and every inject is a map entry. The values are hand-assembled, so a runtime that
// disagrees about a field width used to be written straight into the bundle.
describe('verifyInjects', () => {
  const MAPVAL = 7;
  const registry = {
    createLookupType: (id: number) => `Type${id}`,
    createType: (_type: string, hex: string) => ({
      toHex: () => (hex === '0xbad' ? '0xdifferent' : hex),
    }),
  } as never;

  // An inject's key is the map prefix — twox128(pallet) ++ twox128(item), 64 hex chars, as
  // keyOf() builds it and as the storage index is keyed — followed by the hashed key.
  const PREFIX = keyOf('System', 'Account');
  const index = (entries: [string, { label: string; mapValue: number | null }][]) => ({
    reg: registry,
    byKey: new Map(entries),
  });

  it('checks an inject against the value type of the map it writes into', () => {
    assert.equal(PREFIX.length, 64);
    const r = verifyInjects(
      index([[PREFIX, { label: 'System::Account', mapValue: MAPVAL }]]) as never,
      { [PREFIX + 'deadbeef']: 'aabb' }
    );
    assert.deepEqual(r.kept, { [PREFIX + 'deadbeef']: 'aabb' });
    assert.deepEqual(r.failures, []);
  });

  // The lookup once took the first 32 hex chars — the pallet hash alone — which matches no
  // index entry, so every inject was reported "no such map" and written unchecked.
  it('looks the map up by its full two-hash prefix, not the pallet hash alone', () => {
    const r = verifyInjects(
      index([[PREFIX.slice(0, 32), { label: 'System', mapValue: MAPVAL }]]) as never,
      { [PREFIX + 'deadbeef']: 'aabb' }
    );
    assert.deepEqual(r.kept, {});
    assert.equal(r.skipped.length, 1);
  });

  // The seeded upgrade authorization is a plain value the live chain does not have, so it has
  // to travel as an inject (doppelganger overrides only keys already present) — and it is
  // checked against the plain type, not skipped as "not a map".
  it('checks a plain-value inject against its own type', () => {
    const AUTH = keyOf('System', 'AuthorizedUpgrade');
    const r = verifyInjects(
      index([[AUTH, { label: 'System::AuthorizedUpgrade', plain: 3, mapValue: null } as never]]) as never,
      { [AUTH]: 'ab'.repeat(32) + '01' }
    );
    assert.deepEqual(Object.keys(r.kept), [AUTH]);
    assert.deepEqual(r.failures, []);
  });

  it('fails an inject the runtime decodes to something else', () => {
    const r = verifyInjects(
      index([[PREFIX, { label: 'Dmp::DownwardMessageQueueHeads', mapValue: MAPVAL }]]) as never,
      { [PREFIX + 'deadbeef']: 'bad' }
    );
    assert.deepEqual(r.kept, {});
    assert.equal(r.failures.length, 1);
    assert.match(r.failures[0], /Dmp::DownwardMessageQueueHeads/);
  });

  it('skips a map this runtime does not have, rather than failing', () => {
    const r = verifyInjects(index([]) as never, { [PREFIX + 'deadbeef']: 'aabb' });
    assert.deepEqual(r.kept, {});
    assert.deepEqual(r.failures, []);
    assert.equal(r.skipped.length, 1);
  });
});

// Kusama and Polkadot have no Sudo pallet, so `authorize_upgrade` — a root call — can never be
// made on a fork of them. The authorization is written into state during the bite instead, and
// `apply_authorized_upgrade` (unsigned by design) finishes the job after the fork spawns.
//
// The encoding is `CodeUpgradeAuthorization { code_hash: H256, check_version: bool }`, which
// verify() checks against the runtime's own type at bite time. These cover the shape, and the
// arguments it refuses before verify() ever sees them.
describe('authorizedUpgradeCandidate', () => {
  const HASH = 'ab'.repeat(32);
  const KEY = keyOf('System', 'AuthorizedUpgrade');

  it('encodes the hash followed by the check_version flag', () => {
    assert.deepEqual(authorizedUpgradeCandidate(HASH, true), { [KEY]: HASH + '01' });
    assert.deepEqual(authorizedUpgradeCandidate(HASH, false), { [KEY]: HASH + '00' });
  });

  it('accepts a 0x-prefixed hash, since that is how every tool prints one', () => {
    assert.deepEqual(authorizedUpgradeCandidate('0x' + HASH, true), { [KEY]: HASH + '01' });
  });

  it('refuses anything that is not a 32-byte hash', () => {
    // A truncated or mistyped hash still decodes as *some* authorization, and the fork would
    // then reject the real blob for not matching it — a failure with nothing pointing here.
    assert.throws(() => authorizedUpgradeCandidate('abc', true), /32 bytes of hex/);
    assert.throws(() => authorizedUpgradeCandidate('zz'.repeat(32), true), /32 bytes of hex/);
    assert.throws(() => authorizedUpgradeCandidate(HASH + 'ab', true), /32 bytes of hex/);
  });

  it('writes one plain storage value, not a map entry', () => {
    // System::AuthorizedUpgrade is a StorageValue: the key is the bare twox128 pair with no
    // hashed suffix, and a map-shaped key here would be written where nothing reads it.
    const [key] = Object.keys(authorizedUpgradeCandidate(HASH, true));
    assert.equal(key.length, 64, 'key is twox128(pallet) ++ twox128(item) and nothing else');
  });
});

describe('collator key curve', () => {
  it('defaults to sr25519, the curve every chain but one uses', async () => {
    assert.equal(
      await collatorKey(1501),
      '98313b04a2915e6dc2b9e15eab29a6a9c663755ae771edd09ed494adfa21cd22'
    );
  });

  // The key `polkadot-omni-node key insert --key-type aura --scheme ed25519 --suri //Collator-1000`
  // writes into the keystore. The override has to name the same one or the collator, holding a key
  // no authority entry mentions, silently never authors — how a forked Polkadot Asset Hub spawned
  // and then sat at its bite block for 15 minutes.
  it('derives the ed25519 key Polkadot Asset Hub authors with', async () => {
    assert.equal(
      await collatorKey(1000, 'ed25519'),
      '822b93fc8f9f9c96e34872d87d52c39507c1cf727c7aef4eec74675e4045df40'
    );
  });

  it('is a different key on each curve, from the one seed', async () => {
    assert.notEqual(await collatorKey(1000), await collatorKey(1000, 'ed25519'));
  });
});
