// Write the doppelganger storage-override files for a previewnet bite.
//
// The values themselves are built in ./validators.ts. What happens here is the part that
// needs a live chain: every value is decode-verified against the LIVE metadata of the chain
// being bitten before it is written. That is not belt-and-braces — it is what caught a
// `ParaScheduler::ValidatorGroups` missing its inner compact length, which decoded as
// `[[], …]` and would have silently mis-assigned cores.

import fs from 'node:fs';
import type { StorageIndex } from './rpc.js';
import { rpc, storageIndex } from './rpc.js';
import { hexToU8a, u8aToHex } from '@polkadot/util';
import { blake2128Concat, keyOf, twox64Concat } from './codec.js';
import {
  channelsTouching,
  coreDescriptorsValue,
  dmpWipes,
  FORK_VALIDATION_UPGRADE_COOLDOWN,
  FORK_VALIDATION_UPGRADE_DELAY,
  hrmpChannelKey,
  hrmpContentsWipes,
  hrmpParaKey,
  paraMessagingWipes,
  planCores,
  transactionStorageWipes,
  validatorGroups,
  type PlannedPara,
} from './shared-relay.js';
import {
  attestationAllowanceInjects,
  collatorKey,
  paraCandidates,
  bulletinAuthorizerInjects,
  dotnsDispatcherInject,
  evmDeployerEndowInjects,
  paraInjects,
  relayCandidates,
  relayInjects,
  sudoEndowInjects,
  authorizedUpgradeCandidate,
} from './validators.js';
import type { AuraScheme } from '@parity/ppn-network-config';

export interface OverrideFile {
  overrides: Record<string, string>;
  injects: Record<string, string>;
}

export interface VerifyResult {
  kept: Record<string, string>;
  /** Keys absent from this runtime, or maps rather than plain values. */
  skipped: string[];
  failures: string[];
}

/**
 * Keep only values that round-trip through their real on-chain type.
 *
 * A key the runtime does not have is skipped, not an error: the five chains do not all have
 * the same pallets. A key that exists but does not round-trip is always an error.
 */
export function verify(
  { reg, byKey }: Pick<StorageIndex, 'reg' | 'byKey'>,
  candidates: Record<string, string>
): VerifyResult {
  const kept: Record<string, string> = {};
  const skipped: string[] = [];
  const failures: string[] = [];

  for (const [key, value] of Object.entries(candidates)) {
    const info = byKey.get(key);
    if (!info) {
      skipped.push(`${key.slice(0, 12)}… (absent from this runtime)`);
      continue;
    }
    if (info.plain === null) {
      skipped.push(`${info.label} (map, not a plain value)`);
      continue;
    }
    try {
      const decoded = reg.createType(reg.createLookupType(info.plain), hexToU8a('0x' + value));
      if (scaleHex(decoded) !== value) throw new Error('round-trip mismatch');
      kept[key] = value;
    } catch (e) {
      failures.push(`${info.label}: ${(e as Error).message}`);
    }
  }
  return { kept, skipped, failures };
}

function report(label: string, result: VerifyResult, candidates: Record<string, string>): Record<string, string> {
  for (const s of result.skipped) console.log(`  skip  ${s}`);
  for (const k of Object.keys(result.kept)) console.log(`  ok    ${k.slice(0, 12)}…`);
  if (result.failures.length) {
    throw new Error(`${label} failed verification:\n    ${result.failures.join('\n    ')}`);
  }
  if (Object.keys(result.kept).length === 0) {
    throw new Error(`${label}: nothing verified out of ${Object.keys(candidates).length} candidates`);
  }
  return result.kept;
}

/**
 * Check every inject against the value type of the map it is written into.
 *
 * Injects are the one class of write a bite makes with nothing checking the shape: `verify()`
 * skips them, because a map has no single plain value to decode against. But the values are
 * hand-assembled — an AccountInfo built field by field, a DMQ head assumed to be one 32-byte
 * hash — and if the runtime disagrees about a width, the bite writes a malformed value, the
 * bundle carries it, and the fork fails later with nothing pointing back here.
 *
 * The key is `<map prefix><hashed key>`, so the entry is found by prefix: the prefix is the
 * first 64 hex characters (two twox128 hashes), exactly as `keyOf` produces it.
 */
export function verifyInjects(
  { reg, byKey }: Pick<StorageIndex, 'reg' | 'byKey'>,
  injects: Record<string, string>
): VerifyResult {
  const kept: Record<string, string> = {};
  const skipped: string[] = [];
  const failures: string[] = [];

  for (const [key, value] of Object.entries(injects)) {
    const info = byKey.get(key.slice(0, 64));
    if (!info) {
      skipped.push(`${key.slice(0, 12)}… (no such map in this runtime)`);
      continue;
    }
    // A plain value can be an inject too — one the live chain does not have, such as the
    // seeded upgrade authorization — and is then checked against its own type.
    const type = key.length === 64 ? info.plain : info.mapValue;
    if (type === null) {
      skipped.push(`${info.label} (${key.length === 64 ? 'a map, written without a key' : 'not a map here'})`);
      continue;
    }
    try {
      const decoded = reg.createType(reg.createLookupType(type), hexToU8a('0x' + value));
      if (scaleHex(decoded) !== value) throw new Error('round-trip mismatch');
      kept[key] = value;
    } catch (e) {
      failures.push(`${info.label}: ${(e as Error).message}`);
    }
  }
  return { kept, skipped, failures };
}

function write(outFile: string, file: OverrideFile, index?: StorageIndex): void {
  const { overrides, injects } = file;
  // Injects go through the same round-trip as overrides, against the map's value type. Checked
  // here rather than at each call site so no future caller can add a map write that nothing
  // decodes. A failure is fatal for the same reason a bad override is: the alternative is a
  // bundle that looks fine and produces a chain that will not run.
  if (index) {
    const result = verifyInjects(index, injects);
    for (const s of result.skipped) console.log(`  skipped inject ${s}`);
    if (result.failures.length) {
      throw new Error(
        `${outFile.split('/').pop()}: ${result.failures.length} inject(s) do not match this ` +
          `runtime's storage:\n       ${result.failures.join('\n       ')}`
      );
    }
  }
  fs.writeFileSync(outFile, JSON.stringify(file, null, 2) + '\n');
  console.log(
    `  -> ${outFile.split('/').pop()} (${Object.keys(overrides).length} overrides, ` +
      `${Object.keys(injects).length} injects)\n`
  );
}

/**
 * SCALE bytes of a codec, as hex without the 0x.
 *
 * polkadot-js overrides `toHex` on its integer types to emit big-endian, so it does not give
 * SCALE bytes. Decoding has the same trap, since a multi-byte integer read from a hex string
 * comes back byte-reversed. Every encode goes through this function, including the struct ones
 * `toHex` would get right.
 */
export function scaleHex(codec: { toU8a(): Uint8Array }): string {
  return u8aToHex(codec.toU8a()).slice(2);
}

/**
 * Encode a value through the chain's own metadata.
 *
 * For anything whose shape is more than a list of integers. `verify()` decodes every override
 * afterwards, so a value built this way is checked both ways by construction.
 */
function encode(index: StorageIndex, pallet: string, item: string, value: unknown): string {
  const entry = index.byKey.get(keyOf(pallet, item));
  if (!entry?.plain) throw new Error(`${pallet}::${item} is not a plain storage value here`);
  const type = index.reg.createLookupType(entry.plain);
  return scaleHex(index.reg.createType(type, value));
}

/**
 * Build one map entry, hashed key and encoded value, through the chain's own metadata.
 *
 * `encode()` handles only plain values. A map entry needs three things the metadata owns:
 * the key type (an `Assets::Asset` id is a `u32` on Asset Hub and a `Location` on People), the
 * hasher, and the value type. Getting any of them from a hand-written assumption is how a bite
 * writes a value the runtime cannot read back.
 *
 * Only single-key maps whose hasher keeps the key: `Blake2_128Concat`, `Twox64Concat` and
 * `Identity`. Anything else either discards the key or hashes a tuple of them, and every map a
 * bite writes into is reversible by design.
 */
export function encodeMapEntry(
  index: StorageIndex,
  pallet: string,
  item: string,
  key: unknown,
  value: unknown
): [string, string] {
  const prefix = keyOf(pallet, item);
  const entry = index.byKey.get(prefix);
  if (!entry) throw new Error(`${pallet}::${item} is not in this runtime`);
  if (entry.mapValue === null || entry.mapKey === null) {
    throw new Error(`${pallet}::${item} is not a map here`);
  }
  const encKey = scaleHex(index.reg.createType(index.reg.createLookupType(entry.mapKey), key));
  // A double map holds two hashers and hashes the key tuple, so taking the first alone would
  // write a key nothing reads back. Joining leaves no single hasher name to match, so it is
  // refused instead.
  const hasher = entry.hashers.join(',');
  const hashed =
    hasher === 'Blake2_128Concat'
      ? blake2128Concat(encKey)
      : hasher === 'Twox64Concat'
        ? twox64Concat(encKey)
        : hasher === 'Identity'
          ? encKey
          : (() => {
              throw new Error(
                `${pallet}::${item} is hashed with ${hasher}, which is not one key-preserving hasher`
              );
            })();
  const encValue = scaleHex(index.reg.createType(index.reg.createLookupType(entry.mapValue), value));
  return [prefix + hashed, encValue];
}

/** The asset a fork seeds, so a Coinage instance has one to wrap as coins. */
export interface SeededAsset {
  /** Asset id on its reserve chain; the same asset is keyed by `Location` on People. */
  id: number;
  /** Account that owns, issues, admins and freezes it: one we hold, so minting works after. */
  owner: string;
  minBalance: bigint;
  isSufficient: boolean;
  name: string;
  symbol: string;
  decimals: number;
}

/**
 * How a sibling names an Asset Hub asset: the reserve chain, its `Assets` pallet, the id.
 *
 * Matches `people_foreign_location` in individuality-community's initial-setup, so a seeded
 * registration is keyed exactly as the scripts and the runtime expect. Pallet index 50 is
 * `Assets` on Asset Hub.
 */
export function assetHubAssetLocation(assetHubParaId: number, assetId: number): unknown {
  return {
    parents: 1,
    interior: {
      X3: [{ Parachain: assetHubParaId }, { PalletInstance: 50 }, { GeneralIndex: assetId }],
    },
  };
}

/**
 * Register an asset, as `Assets.force_create` and `force_set_metadata` would have.
 *
 * People is what forces this. `CreateOrigin` for its by-`Location` instance is `EnsureNever`, so
 * no signed origin can register the foreign representation whatever deposit it offers, and
 * `force_create` takes `ForceOrigin`, which is Root, unreachable on a fork of a chain whose Root
 * is a 28-day referendum. Asset Hub would take a signed `create` against a deposit; seeding it
 * too keeps one mechanism and costs no post-spawn step.
 *
 * Everything a fresh asset holds is zero. `do_force_create` sets supply, deposit, accounts,
 * sufficients and approvals to zero and status to `Live`, with owner, issuer, admin and freezer
 * all the same account. So there is no balance state to keep consistent here: minting, the
 * conversion pool and the Coinage instance are ordinary signed calls that run afterwards and
 * compute their own state.
 *
 * `assetKey` is the id on its reserve chain and the `Location` on any other, which is why this
 * takes the key as an opaque value and lets the metadata encode it.
 */
export function seedAssetInjects(
  index: StorageIndex,
  assetKey: unknown,
  asset: SeededAsset
): Record<string, string> {
  const [detailsKey, details] = encodeMapEntry(index, 'Assets', 'Asset', assetKey, {
    owner: asset.owner,
    issuer: asset.owner,
    admin: asset.owner,
    freezer: asset.owner,
    supply: 0,
    deposit: 0,
    minBalance: asset.minBalance,
    isSufficient: asset.isSufficient,
    accounts: 0,
    sufficients: 0,
    approvals: 0,
    status: 'Live',
  });
  const [metaKey, meta] = encodeMapEntry(index, 'Assets', 'Metadata', assetKey, {
    deposit: 0,
    name: asset.name,
    symbol: asset.symbol,
    decimals: asset.decimals,
    isFrozen: false,
  });
  return { [detailsKey]: details, [metaKey]: meta };
}

/** The HostConfiguration fields a shared-relay bite changes, and what they were. */
interface HostConfigPatch {
  value: string;
  before: { numCores: number; validationUpgradeDelay: number; validationUpgradeCooldown: number };
}

/**
 * Change three numbers in production's own HostConfiguration: `scheduler_params.num_cores`,
 * `validation_upgrade_delay` and `validation_upgrade_cooldown`.
 *
 * Rebuilt from the decoded value's own fields — Codec instances, not JSON. Going through
 * `toJSON()` and back produces bytes that mean the same thing but are not the ones the chain
 * wrote, and `verify()` rightly refuses them: it requires a value to survive decode → encode
 * unchanged. Passing the untouched fields through as codecs keeps them byte-for-byte, so the
 * only bytes that move are the ones for the numbers being changed.
 *
 * That matters beyond tidiness. This struct also carries `executor_params`, whose
 * `EnabledHostFunction(EccRfc163)` the relay's validators need to accept People's PVFs, plus
 * the async-backing values production tuned. Replacing the whole value would cost all of it to
 * fix three numbers, which is why the bite leaves this key alone on previewnet entirely.
 */
function patchHostConfig(
  index: StorageIndex,
  liveHex: string,
  want: { numCores: number; validationUpgradeDelay: number; validationUpgradeCooldown: number }
): HostConfigPatch {
  const entry = index.byKey.get(keyOf('Configuration', 'ActiveConfig'));
  if (!entry?.plain) throw new Error('Configuration::ActiveConfig is not a plain value here');
  const type = index.reg.createLookupType(entry.plain);

  const decoded = index.reg.createType(type, hexToU8a(liveHex)) as any;
  const fields = Object.fromEntries([...decoded.entries()]);
  const params = fields.schedulerParams;
  if (!params?.entries) {
    throw new Error('HostConfiguration has no schedulerParams — this relay runtime is not what the bite expects');
  }
  const paramFields = Object.fromEntries([...params.entries()]);
  const num = (v: unknown, name: string): number => {
    const n = Number(v?.toString());
    if (!Number.isFinite(n)) throw new Error(`HostConfiguration has no ${name} — this relay runtime is not what the bite expects`);
    return n;
  };
  const before = {
    numCores: num(paramFields.numCores, 'schedulerParams.numCores'),
    validationUpgradeDelay: num(fields.validationUpgradeDelay, 'validationUpgradeDelay'),
    validationUpgradeCooldown: num(fields.validationUpgradeCooldown, 'validationUpgradeCooldown'),
  };

  const u32 = (n: number) => index.reg.createType('u32', n);
  const patchedParams = new (params.constructor as any)(index.reg, { ...paramFields, numCores: u32(want.numCores) });
  const value = scaleHex(
    index.reg.createType(type, {
      ...fields,
      schedulerParams: patchedParams,
      validationUpgradeDelay: u32(want.validationUpgradeDelay),
      validationUpgradeCooldown: u32(want.validationUpgradeCooldown),
    })
  );

  // Guards, because this rebuilds a struct whose layout is the runtime's, not ours: the result
  // must differ from production only inside those three u32s, and must read back as asked.
  const bytes = (hex: string) => hex.match(/../g) ?? [];
  const changed = bytes(value).filter((b, i) => b !== bytes(liveHex.slice(2))[i]).length;
  if (changed === 0 || changed > 12) {
    throw new Error(`patching HostConfiguration changed ${changed} bytes; expected 1-12`);
  }
  const back = index.reg.createType(type, hexToU8a('0x' + value)).toJSON() as any;
  const got = {
    numCores: back.schedulerParams?.numCores,
    validationUpgradeDelay: back.validationUpgradeDelay,
    validationUpgradeCooldown: back.validationUpgradeCooldown,
  };
  for (const k of Object.keys(want) as (keyof typeof want)[]) {
    if (got[k] !== want[k]) throw new Error(`${k} read back as ${got[k]}, not ${want[k]}`);
  }
  return { value, before };
}

/**
 * The extra overrides a shared relay needs: our parachains registered alone, laid out on cores
 * from 0 with validator groups to match, `num_cores` cut to fit, and the inherited messaging
 * state cleared. See ./shared-relay.ts for why each one is here.
 */
async function sharedRelayCandidates(
  index: StorageIndex,
  relayUrl: string,
  paras: PlannedPara[],
  validators: number
): Promise<{ overrides: Record<string, string>; injects: Record<string, string> }> {
  const plan = planCores(paras);
  const paraIds = paras.map((p) => p.paraId);

  // Read production's own HostConfiguration and change exactly one field in it.
  const liveConfig = await rpc<`0x${string}` | null>(relayUrl, 'state_getStorage', [
    '0x' + keyOf('Configuration', 'ActiveConfig'),
  ]);
  if (!liveConfig) throw new Error('the relay has no Configuration::ActiveConfig to patch');
  const want = {
    numCores: plan.length,
    validationUpgradeDelay: FORK_VALIDATION_UPGRADE_DELAY,
    validationUpgradeCooldown: FORK_VALIDATION_UPGRADE_COOLDOWN,
  };
  const config = patchHostConfig(index, liveConfig, want);

  console.log(
    `  shared relay: ${paraIds.join(', ')} on cores 0-${plan.length - 1}, ` +
      `num_cores ${config.before.numCores} -> ${want.numCores}, ` +
      `validation_upgrade_delay ${config.before.validationUpgradeDelay} -> ${want.validationUpgradeDelay}, ` +
      `cooldown ${config.before.validationUpgradeCooldown} -> ${want.validationUpgradeCooldown}`
  );

  return {
    overrides: {
      [keyOf('ParaScheduler', 'ValidatorGroups')]: validatorGroups(plan.length, validators),
      [keyOf('ParaScheduler', 'CoreDescriptors')]: encode(
        index,
        'ParaScheduler',
        'CoreDescriptors',
        coreDescriptorsValue(plan)
      ),
      [keyOf('Configuration', 'ActiveConfig')]: config.value,
    },
    // Storage map entries, so injects.
    injects: { ...dmpWipes(paraIds), ...(await hrmpResets(index, relayUrl, paraIds)) },
  };
}

/**
 * Reset every HRMP channel touching one of our parachains, keeping it open.
 *
 * The channel set comes from the relay's own indexes at bite time, so nothing here restates
 * which channels a network has. Each `HrmpChannels` entry is rebuilt from its live value with
 * `mqc_head` cleared and the counters zeroed, and everything else — capacities, deposits —
 * byte-for-byte as production has it; the pending contents and the recipient's digests are
 * emptied to match. The parachain half is paraMessagingWipes().
 *
 * The hashers are checked against the metadata because the keys are assembled by hand: an
 * inject on a mis-hashed key is a write nothing reads, and the fork would fail later with
 * `HRMP head mismatch` pointing nowhere near here.
 */
async function hrmpResets(index: StorageIndex, relayUrl: string, paraIds: number[]): Promise<Record<string, string>> {
  if (!index.pallets.has('Hrmp')) return {};
  for (const item of ['HrmpChannels', 'HrmpChannelContents', 'HrmpChannelDigests', 'HrmpIngressChannelsIndex', 'HrmpEgressChannelsIndex']) {
    const entry = index.byKey.get(keyOf('Hrmp', item));
    if (!entry) throw new Error(`this relay runtime has no Hrmp::${item}`);
    if (entry.hashers.join(',') !== 'Twox64Concat') {
      throw new Error(`Hrmp::${item} is hashed with ${entry.hashers.join(',')}, not Twox64Concat as the reset assumes`);
    }
  }

  const read = (key: string) => rpc<`0x${string}` | null>(relayUrl, 'state_getStorage', ['0x' + key]);
  const paraList = (hex: `0x${string}` | null): number[] =>
    hex ? (index.reg.createType('Vec<u32>', hexToU8a(hex)).toJSON() as number[]) : [];

  const ingress = new Map<number, number[]>();
  const egress = new Map<number, number[]>();
  for (const id of paraIds) {
    ingress.set(id, paraList(await read(hrmpParaKey('HrmpIngressChannelsIndex', id))));
    egress.set(id, paraList(await read(hrmpParaKey('HrmpEgressChannelsIndex', id))));
  }
  const channels = channelsTouching(paraIds, ingress, egress);
  if (channels.length === 0) {
    console.log('  hrmp: no channels touch our parachains — nothing to reset');
    return {};
  }

  const injects: Record<string, string> = hrmpContentsWipes(channels, paraIds);
  for (const ch of channels) {
    const live = await read(hrmpChannelKey('HrmpChannels', ch));
    if (!live) throw new Error(`the relay indexes channel ${ch.sender} -> ${ch.recipient} but has no HrmpChannels entry for it`);
    injects[hrmpChannelKey('HrmpChannels', ch)] = resetHrmpChannel(index, live);
  }
  const ours = channels.filter((c) => paraIds.includes(c.sender) && paraIds.includes(c.recipient));
  console.log(
    `  hrmp: ${channels.length} channel(s) reset, ${ours.length} between our parachains ` +
      `(${ours.map((c) => `${c.sender}->${c.recipient}`).join(', ') || 'none'})`
  );
  return injects;
}

/**
 * A live `HrmpChannel` with `mqc_head` cleared and `msg_count`/`total_size` zeroed. Rebuilt
 * from the decoded value's own codec fields for the same reason patchNumCores() is: the
 * untouched fields — capacities, deposits — must come out byte-for-byte as they went in.
 */
function resetHrmpChannel(index: StorageIndex, liveHex: string): string {
  const entry = index.byKey.get(keyOf('Hrmp', 'HrmpChannels'));
  if (!entry?.mapValue) throw new Error('Hrmp::HrmpChannels is not a map here');
  const type = index.reg.createLookupType(entry.mapValue);
  const decoded = index.reg.createType(type, hexToU8a(liveHex)) as any;
  const fields = Object.fromEntries([...decoded.entries()]);
  for (const f of ['mqcHead', 'msgCount', 'totalSize']) {
    if (!(f in fields)) throw new Error(`HrmpChannel has no ${f} field — this relay runtime is not what the reset expects`);
  }
  return scaleHex(
    index.reg.createType(type, {
      ...fields,
      mqcHead: index.reg.createType('Option<H256>', null),
      msgCount: index.reg.createType('u32', 0),
      totalSize: index.reg.createType('u32', 0),
    })
  );
}

/** A runtime to authorize at import, for a fork that has no sudo to authorize one later. */
export interface SeededUpgrade {
  /** blake2-256 of the wasm, as the runtime stores it. */
  codeHash: string;
  /** false applies a blob whose spec_version is not bumped. */
  checkVersion: boolean;
}

export async function relayOverrides(
  relayUrl: string,
  outFile: string,
  shared?: { paras: PlannedPara[]; validators: number },
  upgrade?: SeededUpgrade
): Promise<void> {
  const index = await storageIndex(relayUrl);
  console.log('relay:');

  // Order matters: the shared-relay values replace the ones relayCandidates() sets for a relay
  // that is ours (ValidatorGroups above all), so they come second.
  const extra = shared
    ? await sharedRelayCandidates(index, relayUrl, shared.paras, shared.validators)
    : { overrides: {}, injects: {} };
  const candidates = { ...relayCandidates(), ...extra.overrides };

  const overrides = report('relay overrides', verify(index, candidates), candidates);
  write(outFile, {
    overrides,
    // On a shared relay the dev accounts hold nothing — endow sudo at import so its
    // first transaction (a runtime upgrade's fees) is payable.
    injects: {
      ...relayInjects(),
      ...(shared ? sudoEndowInjects() : {}),
      ...extra.injects,
      ...seededUpgradeInject(index, upgrade),
    },
  }, index);
}

/**
 * The seeded authorization is an inject, never an override.
 *
 * doppelganger overrides a key only if the state being imported already has it, and writes
 * injects unconditionally at the end of the import. `System::AuthorizedUpgrade` is empty on
 * every live chain — nobody leaves an authorization lying around — so as an override it was
 * verified, written to the file, and never applied: the fork came up with no authorization and
 * the apply failed `NothingAuthorized`, having paid its fee. Verified here against the plain
 * value's type, exactly as an override would be, before it goes into the injects.
 */
function seededUpgradeInject(index: StorageIndex, upgrade?: SeededUpgrade): Record<string, string> {
  if (!upgrade) return {};
  const candidate = authorizedUpgradeCandidate(upgrade.codeHash, upgrade.checkVersion);
  return report('seeded upgrade authorization', verify(index, candidate), candidate);
}

export async function paraOverrides(
  paraId: number,
  paraUrl: string,
  outFile: string,
  sharedRelay = false,
  upgrade?: SeededUpgrade,
  scheme: AuraScheme = 'sr25519',
  dotns?: { dispatcher?: string; deployer?: string | string[] },
  bulletinAuthorizer?: string,
  seedAsset?: { asset: SeededAsset; assetHubParaId: number; isReserve: boolean },
  attestation?: { attester: string; count: number; pallet: 'PeopleLite' | 'DotnsGateway' }
): Promise<void> {
  const index = await storageIndex(paraUrl);
  const collator = await collatorKey(paraId, scheme);
  // On a shared relay the inherited messaging state is reset on both sides at once — see
  // ./shared-relay.ts. On our own relay it is preserved on both sides, which is what keeps
  // previewnet's HRMP channels and its XCM tests working.
  // The transaction-storage wipe applies on EVERY bite of a chain with that pallet, not
  // just shared relays: no bite carries the stored data blocks, so once the source chain
  // has an active proof schedule (previewnet's bulletin since v0.0.24), the fork's next
  // proof check panics "Storage proof must be checked once in the block" and the chain
  // wedges one block in — reproduced on the published previewnet bundle 2026-08-19.
  const candidates = {
    ...paraCandidates(collator),
    ...(sharedRelay ? paraMessagingWipes() : {}),
    ...(index.pallets.has('TransactionStorage') ? transactionStorageWipes() : {}),
  };

  console.log(`para ${paraId} (collator //Collator-${paraId} ${scheme} = ${collator.slice(0, 16)}…):`);
  const overrides = report(`para ${paraId} overrides`, verify(index, candidates), candidates);

  // A parachain without a Session pallet manages authorities through Aura alone.
  const injects = {
    ...(index.pallets.has('Session') ? paraInjects(collator) : {}),
    // Parachains of a shared relay are live public chains: no dev account holds
    // funds there, so sudo is endowed at import (see sudoEndowInjects).
    ...(sharedRelay ? sudoEndowInjects() : {}),
    // Written for the runtime this bite authorizes, not the one being bitten: DotnsGateway
    // arrives with the upgrade, so the live metadata cannot type-check this and the guard is
    // the descriptor. See dotnsDispatcherInject.
    ...(dotns?.dispatcher ? dotnsDispatcherInject(dotns.dispatcher) : {}),
    // The contracts the dispatcher points at are deployed after the spawn, by wallets whose
    // revive accounts hold nothing on the chain being bitten. Endow them here so no funding
    // step has to be repeated by hand on every rebite.
    ...(dotns?.deployer ? evmDeployerEndowInjects(dotns.deployer) : {}),
    // A bitten Bulletin has no authorizer: the runtime seeds one at genesis and a fork has none.
    ...(bulletinAuthorizer && index.pallets.has('TransactionStorage')
      ? bulletinAuthorizerInjects(bulletinAuthorizer)
      : {}),
    // Registered on both the reserve chain and any chain that holds it by location: Coinage
    // needs the asset on People, and People's by-`Location` CreateOrigin is EnsureNever, so no
    // signed origin could ever register it. See seedAssetInjects.
    ...(seedAsset && index.pallets.has('Assets')
      ? seedAssetInjects(
          index,
          seedAsset.isReserve
            ? seedAsset.asset.id
            : assetHubAssetLocation(seedAsset.assetHubParaId, seedAsset.asset.id),
          seedAsset.asset
        )
      : {}),
    // Neither pallet is in the metadata of the chain being bitten, so the guard is the
    // descriptor rather than `index.pallets.has`. See attestationAllowanceInjects.
    ...(attestation
      ? attestationAllowanceInjects(attestation.pallet, attestation.attester, attestation.count)
      : {}),
    ...seededUpgradeInject(index, upgrade),
  };
  write(outFile, { overrides, injects }, index);
}
