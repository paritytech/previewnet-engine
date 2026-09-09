// Tests for packages/cli/src/fork/validators.ts and the verify() step of ./overrides.ts
// Run with: tsx --test packages/cli/tests/fork-validators.test.ts

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { u8aToHex } from '@polkadot/util';
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
  attestationAllowanceInjects,
  authorizedUpgradeCandidate,
  bulletinAuthorizerInjects,
  dotnsDispatcherInject,
  evmDeployerEndowInjects,
  sudoEndowInjects,
} from '../src/fork/validators.js';
import {
  assetHubAssetLocation,
  encodeMapEntry,
  seedAssetInjects,
  verify,
  verifyInjects,
} from '../src/fork/overrides.js';
import { blake2128Concat, compactLen, keyOf, u32le } from '../src/fork/codec.js';
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
    // The code compares SCALE bytes, so the stub takes a Uint8Array and returns `toU8a`.
    // It returns the bytes it was given, except for the candidate 'bad', which comes back
    // as something else so the round-trip check fails and the failure path can be tested.
    createType: (_type: string, raw: Uint8Array) => ({
      toU8a: () => (u8aToHex(raw).endsWith('bad') ? new Uint8Array([0xde, 0xad]) : raw),
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
    // The code compares SCALE bytes, so the stub takes a Uint8Array and returns `toU8a`.
    // It returns the bytes it was given, except for the candidate 'bad', which comes back
    // as something else so the round-trip check fails and the failure path can be tested.
    createType: (_type: string, raw: Uint8Array) => ({
      toU8a: () => (u8aToHex(raw).endsWith('bad') ? new Uint8Array([0xde, 0xad]) : raw),
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

// The dotNS dispatcher is the one inject written for a runtime the bite has not yet applied:
// DotnsGateway arrives with the authorized upgrade, so the chain being bitten has no such
// pallet. That is exactly why it cannot be guarded on `index.pallets.has` and why verifyInjects
// can only skip it.
describe('the dotNS dispatcher seed', () => {
  // Pinned, not recomputed: twox128('DotnsGateway') ++ twox128('DispatcherAddress'). The pallet
  // is named in the runtime's construct_runtime, so a rename moves the key and this catches it.
  const KEY = '57ca9018d648b40a8286a471e82c3808f31ce5ec278db3dff6304333f0019302';
  const ADDR = '0xCC932348606cc1f3318cADeC5A5Cd2CA447f8a4b';

  it('writes the address as a bare 20-byte value, lowercased', () => {
    assert.deepEqual(dotnsDispatcherInject(ADDR), {
      [KEY]: 'cc932348606cc1f3318cadec5a5cd2ca447f8a4b',
    });
  });

  it('agrees with keyOf, so the pinned key is the one the bite writes', () => {
    assert.equal(keyOf('DotnsGateway', 'DispatcherAddress'), KEY);
  });

  // OptionQuery stores Some as the bare value, so 20 bytes and no discriminant.
  it('writes 20 bytes, with no Option discriminant', () => {
    assert.equal(Object.values(dotnsDispatcherInject(ADDR))[0].length, 40);
  });

  it('takes the address with or without 0x', () => {
    assert.deepEqual(dotnsDispatcherInject(ADDR.slice(2)), dotnsDispatcherInject(ADDR));
  });

  for (const bad of ['0x1234', '', 'not-an-address', '0x' + 'gg'.repeat(20)]) {
    it(`refuses "${bad}" rather than writing a malformed value`, () => {
      assert.throws(() => dotnsDispatcherInject(bad), /20-byte hex address/);
    });
  }

  // The bite must not die on this inject. verifyInjects cannot type-check a pallet the live
  // runtime does not carry, so it must report it skipped — a failure would abort the bundle,
  // and `write` carries the whole inject set regardless of what was checked.
  it('is skipped, not failed, when the bitten runtime has no DotnsGateway', () => {
    const r = verifyInjects({ reg: {} as never, byKey: new Map() }, dotnsDispatcherInject(ADDR));
    assert.deepEqual(r.failures, []);
    assert.deepEqual(r.kept, {});
    assert.equal(r.skipped.length, 1);
    assert.match(r.skipped[0], /no such map in this runtime/);
  });
});

// A contract deployment on a fork is signed by an Ethereum wallet, which has no AccountId32 of
// its own. Fees come from revive's fallback account, so the bite endows it rather than leaving
// a transfer to be repeated by hand on every rebite.
describe('the evm deployer endowment', () => {
  const ANVIL0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  const ADMIN = '0x4A519C30DA0EC16AA9a73c26EA6CA6F701CcE099';
  const KEY = keyOf('System', 'Account');

  // frame/revive/src/address.rs: the address bytes, then twelve 0xEE.
  it('endows the revive fallback account, not the address', () => {
    const entry = Object.keys(evmDeployerEndowInjects(ANVIL0))[0];
    assert.equal(entry.slice(0, 64), KEY);
    // blake2_128concat appends the raw key after the 16-byte hash, so the account id is readable.
    assert.ok(entry.endsWith('f39fd6e51aad88f6f4ce6ab8827279cfffb92266' + 'ee'.repeat(12)));
  });

  it('writes a 32-byte account id', () => {
    const entry = Object.keys(evmDeployerEndowInjects(ANVIL0))[0];
    assert.equal((entry.length - 64 - 32) / 2, 32);
  });

  // Same shape as sudo's, so a change to AccountInfo breaks both together rather than silently
  // leaving one malformed.
  it('writes the same AccountInfo as the sudo endowment', () => {
    assert.equal(
      Object.values(evmDeployerEndowInjects(ANVIL0))[0],
      Object.values(sudoEndowInjects())[0]
    );
  });

  // dotns signs the CREATE3 factory from one key and the pipeline from another, so a fork that
  // reproduces another network's addresses and its proxy ownership has to fund both wallets.
  it('endows every wallet a chain names, keyed separately', () => {
    const two = evmDeployerEndowInjects([ANVIL0, ADMIN]);
    assert.equal(Object.keys(two).length, 2);
    assert.deepEqual(two, { ...evmDeployerEndowInjects(ANVIL0), ...evmDeployerEndowInjects(ADMIN) });
    assert.ok(Object.keys(two).some((k) => k.endsWith(ADMIN.slice(2).toLowerCase() + 'ee'.repeat(12))));
  });

  it('refuses a list holding a bad address, rather than endowing the good ones', () => {
    assert.throws(() => evmDeployerEndowInjects([ANVIL0, 'nope']), /20-byte hex address/);
  });

  it('takes the address with or without 0x, and refuses anything else', () => {
    assert.deepEqual(evmDeployerEndowInjects(ANVIL0.slice(2)), evmDeployerEndowInjects(ANVIL0));
    for (const bad of ['0x1234', '', 'nope']) {
      assert.throws(() => evmDeployerEndowInjects(bad), /20-byte hex address/);
    }
  });
});

// A bitten Bulletin has no authorizer at all: the runtime seeds one in its genesis preset and a
// fork has no genesis, while live Polkadot Bulletin's AllowedAuthorizers is empty because there
// authorizers arrive by governance. Without this every store fails BadSigner.
describe('the bulletin authorizer seed', () => {
  const ALICE = '0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d';

  it('writes into TransactionStorage::AllowedAuthorizers, blake2-128-concat keyed', () => {
    const entry = Object.keys(bulletinAuthorizerInjects(ALICE))[0];
    assert.equal(entry.slice(0, 64), keyOf('TransactionStorage', 'AllowedAuthorizers'));
    assert.ok(entry.endsWith(ALICE.slice(2)));
  });

  // AuthorizerBudget { quota: Some(Quota { transactions: u32, bytes: u64 }), valid_until: None,
  // feeless: bool } — the budget the bulletin runtime's own genesis preset writes.
  it('encodes the genesis presets budget: 100k transactions, 100 GiB, feeless, no expiry', () => {
    const v = Object.values(bulletinAuthorizerInjects(ALICE))[0];
    assert.equal(v, '01' + 'a0860100' + '0000000019000000' + '00' + '01');
    assert.equal(v.length / 2, 15);
  });

  it('refuses anything that is not a 32-byte account id', () => {
    for (const bad of ['0x1234', '', '0xd43593c7', 'nope']) {
      assert.throws(() => bulletinAuthorizerInjects(bad), /32-byte account id/);
    }
  });
});

// A Coinage instance wraps an asset, so the asset has to exist on the reserve chain and on every
// chain that holds it by location. Everything here goes through the chain's own metadata rather
// than hand-encoding, because an Assets::Asset key is a u32 on Asset Hub and a Location on People.
describe('the seeded asset', () => {
  // A registry stub: records what it was asked to encode, so the test can assert the shape passed
  // to the runtime's own types rather than a byte string this test would also have to invent.
  const seen: { type: string; value: unknown }[] = [];
  const reg = {
    createLookupType: (id: number) => `Type${id}`,
    createType: (type: string, value: unknown) => {
      seen.push({ type, value });
      return { toU8a: () => new Uint8Array([typeof value === 'number' ? 0xaa : 0xbb]) };
    },
  } as never;
  const index = (entries: [string, unknown][]) =>
    ({ reg, byKey: new Map(entries), pallets: new Set(['Assets']) }) as never;

  const ASSET = {
    id: 50000413,
    owner: '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
    minBalance: 1n,
    isSufficient: true,
    name: 'CASH',
    symbol: 'CASH',
    decimals: 6,
  };
  const withAssets = () =>
    index([
      [keyOf('Assets', 'Asset'), { label: 'Assets::Asset', plain: null, mapValue: 1, mapKey: 2, hashers: ['Blake2_128Concat'] }],
      [keyOf('Assets', 'Metadata'), { label: 'Assets::Metadata', plain: null, mapValue: 3, mapKey: 4, hashers: ['Blake2_128Concat'] }],
    ]);

  it('writes exactly the two entries force_create and force_set_metadata produce', () => {
    seen.length = 0;
    const out = seedAssetInjects(withAssets(), ASSET.id, ASSET);
    assert.equal(Object.keys(out).length, 2);
    for (const k of Object.keys(out)) {
      assert.ok(k.startsWith(keyOf('Assets', 'Asset')) || k.startsWith(keyOf('Assets', 'Metadata')));
    }
  });

  // do_force_create writes a fresh asset: owner/issuer/admin/freezer identical, everything
  // countable zero, status Live. Nothing here should invent balance state.
  it('registers an empty asset, with the owner in all four roles', () => {
    seen.length = 0;
    seedAssetInjects(withAssets(), ASSET.id, ASSET);
    const details = seen.find(x => x.type === 'Type1')!.value as Record<string, unknown>;
    for (const role of ['owner', 'issuer', 'admin', 'freezer']) {
      assert.equal(details[role], ASSET.owner, `${role} must be the seeded owner`);
    }
    for (const zero of ['supply', 'deposit', 'accounts', 'sufficients', 'approvals']) {
      assert.equal(details[zero], 0, `${zero} must start at zero`);
    }
    assert.equal(details.status, 'Live');
    assert.equal(details.minBalance, ASSET.minBalance);
  });

  it('keys the reserve chain by id and any other chain by location', () => {
    const loc = assetHubAssetLocation(1000, ASSET.id) as { interior: { X3: unknown[] } };
    assert.deepEqual(loc.interior.X3, [
      { Parachain: 1000 },
      { PalletInstance: 50 },
      { GeneralIndex: ASSET.id },
    ]);
  });

  it('refuses a map whose hasher would discard the key', () => {
    const bad = index([
      [keyOf('Assets', 'Asset'), { label: 'Assets::Asset', plain: null, mapValue: 1, mapKey: 2, hashers: ['Blake2_128'] }],
    ]);
    assert.throws(() => encodeMapEntry(bad, 'Assets', 'Asset', 1, {}), /not one key-preserving hasher/);
  });

  it('refuses a pallet or item this runtime does not have', () => {
    assert.throws(() => encodeMapEntry(index([]), 'Assets', 'Asset', 1, {}), /not in this runtime/);
  });

  it('refuses a plain value, which has no key to hash', () => {
    const plain = index([
      [keyOf('Assets', 'Asset'), { label: 'Assets::Asset', plain: 9, mapValue: null, mapKey: null, hashers: [] }],
    ]);
    assert.throws(() => encodeMapEntry(plain, 'Assets', 'Asset', 1, {}), /not a map here/);
  });

  // A double map holds two hashers and hashes the key tuple. Taking the first alone would write
  // a key nothing reads back, which is the failure this function exists to prevent.
  it('refuses a map with more than one key', () => {
    const double = index([
      [keyOf('Assets', 'Asset'), { label: 'Assets::Asset', plain: null, mapValue: 1, mapKey: 2, hashers: ['Blake2_128Concat', 'Twox64Concat'] }],
    ]);
    assert.throws(() => encodeMapEntry(double, 'Assets', 'Asset', 1, {}), /not one key-preserving hasher/);
  });

  // force_set_metadata writes the name, symbol and decimals a wallet shows. Nothing else asserts
  // them, so without this the whole metadata entry could be wrong with every other test green.
  it('writes the metadata force_set_metadata would', () => {
    seen.length = 0;
    seedAssetInjects(withAssets(), ASSET.id, ASSET);
    const meta = seen.find((x) => x.type === 'Type3')!.value as Record<string, unknown>;
    assert.equal(meta.name, ASSET.name);
    assert.equal(meta.symbol, ASSET.symbol);
    assert.equal(meta.decimals, ASSET.decimals);
    assert.equal(meta.deposit, 0);
    assert.equal(meta.isFrozen, false);
  });
});

// Two quotas share the `AttestationAllowance` name. `PeopleLite`'s counts how many people a
// verifier may attest, spent by `attest`; `DotnsGateway`'s how many names an attester may
// reserve, spent by `reserve_name`. The identity backend needs both, and on a fork neither can be
// granted after the spawn: `PeopleLite`'s manager is `EnsureRoot` and `DotnsGateway`'s is
// `RootOrWhitelist`.
describe('the attestation allowance seeds', () => {
  const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
  // What polkadot.json grants. Multi-byte, so the literal below catches a byte-order slip.
  const COUNT = 1000000;

  for (const pallet of ['PeopleLite', 'DotnsGateway'] as const) {
    it(`writes one ${pallet} entry keyed by the attester`, () => {
      const out = attestationAllowanceInjects(pallet, ALICE, COUNT);
      assert.deepEqual(out, {
        [keyOf(pallet, 'AttestationAllowance') + blake2128Concat(ALICE_SR)]: u32le(COUNT),
      });
    });
  }

  // Both pallets arrive with the runtime the bite authorizes, so they are absent from the
  // metadata of every chain this runs against. A key derived from that metadata would resolve
  // to nothing and write nothing, without reporting it, so the key depends on the pallet name
  // and the attester alone.
  it('needs no metadata, since neither pallet exists on the chain being bitten', () => {
    const out = attestationAllowanceInjects('DotnsGateway', ALICE, COUNT);
    assert.equal(Object.keys(out).length, 1);
    assert.equal(Object.keys(out)[0].slice(0, 64), keyOf('DotnsGateway', 'AttestationAllowance'));
  });

  // Both pallets hold it as a bare `u32` with `ValueQuery`, and both setters only
  // saturating-add, so the count is the whole state the call produces.
  it('encodes the count as a bare little-endian u32', () => {
    const [value] = Object.values(attestationAllowanceInjects('PeopleLite', ALICE, COUNT));
    assert.equal(value, u32le(COUNT));
    assert.equal(value, '40420f00');
  });

  it('accepts the raw account id as well as SS58', () => {
    assert.deepEqual(
      attestationAllowanceInjects('PeopleLite', '0x' + ALICE_SR, COUNT),
      attestationAllowanceInjects('PeopleLite', ALICE, COUNT)
    );
  });

  it('refuses a count that would grant nothing', () => {
    for (const bad of [0, -1, 1.5]) {
      assert.throws(() => attestationAllowanceInjects('PeopleLite', ALICE, bad), /positive integer/);
    }
  });

  it('refuses an attester that is not a 32-byte account', () => {
    // A 20-byte address decodes, so it reaches the length check. Garbage does not: decodeAddress
    // throws first, which is why that case cannot stand in for this one, and why the throw is
    // wrapped in a message that names the field.
    assert.throws(
      () => attestationAllowanceInjects('PeopleLite', '0x' + 'ab'.repeat(20), COUNT),
      /32-byte account, got 20 bytes/
    );
    assert.throws(
      () => attestationAllowanceInjects('PeopleLite', 'not-an-account', COUNT),
      /attester "not-an-account" is not an account: Decoding/
    );
  });
});
