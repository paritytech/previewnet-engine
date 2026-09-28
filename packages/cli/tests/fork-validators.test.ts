// Tests for packages/cli/src/fork/validators.ts and the verify() step of ./overrides.ts
// Run with: tsx --test packages/cli/tests/fork-validators.test.ts

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ALICE_SR,
  MAX_VALIDATORS,
  collatorKey,
  collatorKeys,
  devValidators,
  paraCandidates,
  paraInjects,
  relayCandidates,
  relayInjects,
  sessionKeys,
  authorizedUpgradeCandidate,
  type DevValidator,
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

// Well-known dev keys as zombie-bite src/utils.rs hard-codes them, in get_validator_keys()
// order. The keys used to be hard-coded from this list; now they are derived from the names,
// and the derivation must land on these exact bytes or every bundle's authority set silently
// changes. One deliberate difference: zombie-bite's BEEFY keys for Charlie and Dave
// (020e7446…, 0227e2b1…) derive from no seed at all, while zombienet writes the ecdsa key of
// `//Charlie` (0389…) and `//Dave` (03bc…) into the keystore — so those two are pinned to what
// the nodes actually hold.
const mk = (stash: string, babe: string, grandpa: string, beefy: string): DevValidator => ({
  stash, babe, grandpa, beefy,
  paraValidator: babe, paraAssignment: babe, authorityDiscovery: babe,
});
const ZOMBIE_BITE_KEYS: DevValidator[] = [
  mk('be5ddb1579b72e84524fc29e78609e3caf42e85aa118ebfe0b0ad404b5bdd25f', ALICE_SR, '88dc3417d5058ec4b4503e0c12ea1a0a89be200fe98922423d4334014fa6b0ee', '020a1091341fe5664bfa1782d5e04779689068c916b04cb365ec3153755684d9a1'),
  mk('fe65717dad0447d715f660a0a58411de509b42e6efb8375f562f58a554d5860e', '8eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48', 'd17c2d7823ebf260fd138f2d7e27d114c0145d968b5ff5006125f2414fadae69', '0390084fdbf27d2b79d26a4f13f0ccd982cb755a661969143c37cbc49ef5b91f27'),
  mk('1e07379407fecc4b89eb7dbd287c2c781cfb1907a96947a3eb18e4f8e7198625', '90b5ab205c6974c9ea841be688864633dc9ca8a357843eeacf2314649965fe22', '439660b36c6c03afafca027b910b4fecf99801834c62a5e6006f27d978de234f', '0389411795514af1627765eceffcbd002719f031604fadd7d188e2dc585b4e1afb'),
  mk('e860f1b1c7227f7c22602f53f15af80747814dffd839719731ee3bba6edc126c', '306721211d5404bd9da88e0204360a1a9ab8b87c66c1bc2fcdd37f3c2222cc20', '5e639b43e0052c47447dac87d6fd2b6ec50bdd4d0f614e4299c665249bbd09d9', '03bc9d0ca094bd5b8b3225d7651eac5d18c1c04bf8ae8f8b263eebca4e1410ed0c'),
  mk('101191192fc877c24d725b337120fa3edc63d227bbc92705db1e2cb65f56981a', '1cbd2d43530a44705ad088af313e18f80b53ef16b36177cd4b77b846f2a5f07c', '568cb4a574c6d178feb39c27dfc8b3f789e5f5423e19c71633c748b9acf086b5', '0291f1217d5a04cb83312ee3d88a6e6b33284e053e6ccfc3a90339a0299d12967c'),
  mk('8ac59e11963af19174d0b94d5d78041c233f55d2e19324665bafdfb62925af2d', 'e659a7a1628cdd93febc04a4e0646ea20e9f5f0ce097d9a05290d4a9e054df4e', '1dfe3e22cc0d45c70779c1095f7489a8ef3cf52d62fbd8c2fa38c9f1723502b5', '031d10105e323c4afce225208f71a6441ee327a65b9e646e772500c74d31f669aa'),
];

const VALIDATORS = await devValidators(6);

describe('the dev authority set', () => {
  it('derives the six well-known keys byte-for-byte as zombie-bite hard-codes them', () => {
    assert.deepEqual(VALIDATORS, ZOMBIE_BITE_KEYS);
  });

  it('starts with Alice, whose babe key is also the sudo key', () => {
    assert.equal(VALIDATORS[0].babe, ALICE_SR);
    assert.equal(relayCandidates(VALIDATORS)[keyOf('Sudo', 'Key')], ALICE_SR);
  });

  // ActiveValidatorIndices and ValidatorGroups index into this list positionally, so the
  // order is get_validator_keys()' order — note FERDIE before EVE — not alphabetical.
  it('keeps zombie-bite key order, with Ferdie before Eve', () => {
    const ferdie = 'e659a7a1628cdd93febc04a4e0646ea20e9f5f0ce097d9a05290d4a9e054df4e';
    const eve = '1cbd2d43530a44705ad088af313e18f80b53ef16b36177cd4b77b846f2a5f07c';
    assert.equal(VALIDATORS[4].babe, eve, 'index 4 should be Eve');
    assert.equal(VALIDATORS[5].babe, ferdie, 'index 5 should be Ferdie');
  });

  // Past the well-known six, a validator is named for its position and zombienet derives its
  // keystore from that name — the keys here must be the same derivation, or the node holds
  // keys no authority entry mentions and never authors.
  it('extends past the well-known six with keys derived from the node names', async () => {
    const eight = await devValidators(8);
    assert.deepEqual(eight.slice(0, 6), ZOMBIE_BITE_KEYS, 'the first six do not move');
    const { Keyring } = await import('@polkadot/keyring');
    const hex = (k: Uint8Array) => Buffer.from(k).toString('hex');
    assert.equal(eight[6].babe, hex(new Keyring({ type: 'sr25519' }).addFromUri('//Validator-7').publicKey));
    assert.equal(eight[6].stash, hex(new Keyring({ type: 'sr25519' }).addFromUri('//Validator-7//stash').publicKey));
    assert.equal(eight[6].grandpa, hex(new Keyring({ type: 'ed25519' }).addFromUri('//Validator-7').publicKey));
    assert.equal(eight[6].beefy, hex(new Keyring({ type: 'ecdsa' }).addFromUri('//Validator-7').publicKey));
    assert.equal(eight[7].babe, hex(new Keyring({ type: 'sr25519' }).addFromUri('//Validator-8').publicKey));
  });

  it('has no duplicate keys, however many', async () => {
    const all = await devValidators(MAX_VALIDATORS);
    for (const field of ['stash', 'babe', 'grandpa', 'beefy'] as const) {
      const values = all.map((v) => v[field]);
      assert.equal(new Set(values).size, MAX_VALIDATORS, `duplicate ${field}`);
    }
  });

  // The eleventh relay RPC port is People's.
  it('refuses more validators than the relay has ports for', async () => {
    await assert.rejects(devValidators(MAX_VALIDATORS + 1), /at most|1\.\.10/);
    await assert.rejects(devValidators(0), /1\.\.10/);
  });

  it('composes session keys as grandpa+babe+paraValidator+paraAssignment+discovery+beefy', () => {
    const v = VALIDATORS[0];
    assert.equal(sessionKeys(v), v.grandpa + v.babe + v.babe + v.babe + v.babe + v.beefy);
    // 5 x 32-byte sr25519/ed25519 keys + 1 x 33-byte beefy key
    assert.equal(sessionKeys(v).length, (32 * 5 + 33) * 2);
  });
});

describe('relay overrides', () => {
  const candidates = relayCandidates(VALIDATORS);

  it('matches the values a verified bite produced', () => {
    for (const [key, value] of Object.entries(GOLDEN.relay.overrides)) {
      assert.equal(candidates[key], value, `override ${key} changed`);
    }
    for (const [key, value] of Object.entries(GOLDEN.relay.injects)) {
      assert.equal(relayInjects(VALIDATORS)[key], value, `inject ${key} changed`);
    }
  });

  it('lists every validator it is given, in order', async () => {
    const eight = await devValidators(8);
    const c = relayCandidates(eight);
    assert.equal(
      c[keyOf('ParasShared', 'ActiveValidatorIndices')],
      compactLen(8) + [0, 1, 2, 3, 4, 5, 6, 7].map(u32le).join('')
    );
    assert.equal(c[keyOf('Session', 'Validators')], compactLen(8) + eight.map((v) => v.stash).join(''));
    assert.equal(Object.keys(relayInjects(eight)).length, 9);
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

  it('puts the Asset Hub staking client in Buffered', () => {
    assert.equal(candidates[keyOf('StakingAhClient', 'Mode')], '01');
  });

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
    const injects = relayInjects(VALIDATORS);
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
      const candidates = paraCandidates([collator]);
      const injects = paraInjects([collator]);
      for (const [key, value] of Object.entries(GOLDEN[paraId].overrides)) {
        assert.equal(candidates[key], value, `para ${paraId} override ${key} changed`);
      }
      for (const [key, value] of Object.entries(GOLDEN[paraId].injects)) {
        assert.equal(injects[key], value, `para ${paraId} inject ${key} changed`);
      }
    }
  });

  it('installs exactly one collator as the authority by default', async () => {
    const collator = await collatorKey(1500);
    const candidates = paraCandidates([collator]);
    assert.equal(candidates[keyOf('CollatorSelection', 'DesiredCandidates')], '01000000');
    for (const [pallet, item] of [['Aura', 'Authorities'], ['AuraExt', 'Authorities'], ['Session', 'Validators']]) {
      assert.equal(candidates[keyOf(pallet, item)], compactLen(1) + collator, `${pallet}::${item}`);
    }
  });

  // The first key is the one every existing bundle was bitten with; the rest follow the node
  // names the fork TOML gives the extra collators, which is where zombienet derives them from.
  it('derives further collator keys from Collator-<paraId>-<n>, keeping the first', async () => {
    const five = await collatorKeys(1502, 5);
    assert.equal(five.length, 5);
    assert.equal(five[0], await collatorKey(1502));
    assert.equal(new Set(five).size, 5, 'duplicate collator keys');
    const { Keyring } = await import('@polkadot/keyring');
    assert.equal(
      five[1],
      Buffer.from(new Keyring({ type: 'sr25519' }).addFromUri('//Collator-1502-2').publicKey).toString('hex')
    );
    await assert.rejects(collatorKeys(1502, 0), /at least one collator/);
  });

  it('installs every collator it is given as an authority', async () => {
    const five = await collatorKeys(1502, 5);
    const candidates = paraCandidates(five);
    assert.equal(candidates[keyOf('CollatorSelection', 'DesiredCandidates')], u32le(5));
    for (const [pallet, item] of [['Aura', 'Authorities'], ['AuraExt', 'Authorities'], ['Session', 'Validators'], ['CollatorSelection', 'Invulnerables']]) {
      assert.equal(candidates[keyOf(pallet, item)], compactLen(5) + five.join(''), `${pallet}::${item}`);
    }
    assert.equal(candidates[keyOf('Session', 'QueuedKeys')], compactLen(5) + five.map((c) => c + c).join(''));
    // One NextKeys entry and one KeyOwner entry per collator.
    assert.equal(Object.keys(paraInjects(five)).length, 10);
  });

  // Zeroing it, as zombie-bite does, desyncs the parachain from the relay's preserved Dmp.
  it('leaves ParachainSystem::LastDmqMqcHead alone', async () => {
    const candidates = paraCandidates([await collatorKey(1500)]);
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
