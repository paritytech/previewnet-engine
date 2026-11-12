// The authority set a bite installs, and the storage values that install it.
//
// Doppelganger replaces the on-chain authority set while the warp-synced state is imported,
// so the forked network can be driven with keys we hold. Production's validators use
// generated keys, which is why a fork is undrivable without this.
//
// Everything in this file is pure — given a para id it produces the same bytes every time —
// so the encodings are unit-testable. relayOverrides()/paraOverrides() in ./overrides.ts
// additionally decode-verify each value against the live runtime before writing it.

import { Keyring } from '@polkadot/keyring';
import { cryptoWaitReady, decodeAddress } from '@polkadot/util-crypto';
import { blake2128Concat, compactLen, keyOf, twox64Concat, u128le, u32le, u64le } from './codec.js';
import { collatorNodeName, relayNodeName, type AuraScheme } from '@parity/ppn-network-config';

export const ALICE_SR = 'd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d';

export interface DevValidator {
  stash: string;
  babe: string;
  grandpa: string;
  beefy: string;
  paraValidator: string;
  paraAssignment: string;
  authorityDiscovery: string;
}

/** Relay RPC ports are `RELAY_BASE_PORT + i`, and the eleventh would land on People's. */
export const MAX_VALIDATORS = 10;

/**
 * The names the relay's dev keys derive from, in the order the authority set lists them.
 *
 * The first six are zombie-bite's get_validator_keys() order — ALICE, BOB, CHARLIE, DAVE,
 * FERDIE, EVE (note FERDIE before EVE) — because ActiveValidatorIndices and ValidatorGroups
 * index into the list positionally, and a bundle bitten with the old hard-coded keys had that
 * order. The names beyond them are whatever the fork TOML calls the extra nodes: zombienet
 * derives a non-well-known node's keys from `//<Name>`, exactly as done here.
 */
function validatorNames(count: number): string[] {
  const wellKnown = ['Alice', 'Bob', 'Charlie', 'Dave', 'Ferdie', 'Eve'];
  return Array.from({ length: count }, (_, i) => wellKnown[i] ?? relayNodeName(i));
}

/**
 * The dev keys for `count` relay validators, derived the way zombienet writes them into a
 * node's keystore: stash `//<Name>//stash`, BABE and the parachain keys sr25519 `//<Name>`,
 * GRANDPA the ed25519 key of that seed and BEEFY its ecdsa key. For the first six this is
 * byte-identical to the keys zombie-bite hard-codes in src/utils.rs (pinned by test), except
 * Charlie's and Dave's BEEFY keys, which zombie-bite has as bytes no seed derives to; the
 * keystore holds the derived ones, so those are what the session keys name here.
 */
export async function devValidators(count: number): Promise<DevValidator[]> {
  if (!Number.isInteger(count) || count < 1 || count > MAX_VALIDATORS) {
    throw new Error(`a fork runs 1..${MAX_VALIDATORS} relay validators, not ${count}`);
  }
  await cryptoWaitReady();
  const hex = (scheme: 'sr25519' | 'ed25519' | 'ecdsa', suri: string) =>
    Buffer.from(new Keyring({ type: scheme }).addFromUri(suri).publicKey).toString('hex');
  return validatorNames(count).map((name) => {
    const babe = hex('sr25519', `//${name}`);
    return {
      stash: hex('sr25519', `//${name}//stash`),
      babe,
      grandpa: hex('ed25519', `//${name}`),
      beefy: hex('ecdsa', `//${name}`),
      paraValidator: babe,
      paraAssignment: babe,
      authorityDiscovery: babe,
    };
  });
}

export const sessionKeys = (v: DevValidator): string =>
  v.grandpa + v.babe + v.paraValidator + v.paraAssignment + v.authorityDiscovery + v.beefy;

/**
 * Relay storage values that install the dev authority set.
 *
 * Deliberately NOT included, unlike zombie-bite's defaults. These are all relay pallets —
 * production's values are the ones we want, and each has teeth:
 *   Configuration::ActiveConfig  the relay's host configuration for every parachain. Its
 *                                scheduler_params holds numCores, of which the relay hands
 *                                Asset Hub three — that is what gives Asset Hub 2s blocks.
 *                                Its executor_params holds EnabledHostFunction(EccRfc163),
 *                                without which the relay's validators reject People's PVFs.
 *                                One key, two things depending on it.
 *   Hrmp::* / Dmp::*             keeps the four HRMP channels
 *   Paras::Parachains            keeps all four parachains registered
 */
export function relayCandidates(validators: DevValidator[]): Record<string, string> {
  const len = compactLen(validators.length);
  const each = (f: (v: DevValidator) => string) => validators.map(f).join('');

  return {
    [keyOf('Session', 'Validators')]: len + each((v) => v.stash),
    [keyOf('Session', 'QueuedKeys')]: len + each((v) => v.stash + sessionKeys(v)),
    [keyOf('Babe', 'Authorities')]: len + each((v) => v.babe + '0100000000000000'),
    [keyOf('Babe', 'NextAuthorities')]: len + each((v) => v.babe + '0100000000000000'),
    [keyOf('Grandpa', 'Authorities')]: len + each((v) => v.grandpa + '0100000000000000'),
    [keyOf('Staking', 'Invulnerables')]: len + each((v) => v.stash),
    [keyOf('ParasShared', 'ActiveValidatorIndices')]: len + validators.map((_, i) => u32le(i)).join(''),
    [keyOf('ParasShared', 'ActiveValidatorKeys')]: len + each((v) => v.paraValidator),
    [keyOf('AuthorityDiscovery', 'Keys')]: len + each((v) => v.authorityDiscovery),
    [keyOf('AuthorityDiscovery', 'NextKeys')]: len + each((v) => v.authorityDiscovery),
    [keyOf('Sudo', 'Key')]: ALICE_SR,
    // Each group carries its own compact length. Verified against production, whose real
    // value is `18` + 6x(`04` + u32) = [[0],[1],[2],[3],[4],[5]].
    [keyOf('ParaScheduler', 'ValidatorGroups')]:
      len + validators.map((_, i) => compactLen(1) + u32le(i)).join(''),
    // Without this the relay takes the validator set Asset Hub elects. None of those accounts
    // holds session keys on a fork, so `pallet_session` queues an empty set and announces the
    // next BABE epoch with no authorities: nobody can claim a slot, no block enacts the next
    // rotation, and the chain stops at the session boundary. `Buffered` makes `new_session()`
    // return `None`, so `pallet_session` keeps the ones in `VALIDATORS`.
    [keyOf('StakingAhClient', 'Mode')]: '01', // OperatingMode::Buffered
    // `Buffered` above handles the validator set. This is for `ElectionProviderMultiPhase`,
    // which runs on the relay whatever mode `StakingAhClient` is in.
    [keyOf('Staking', 'ForceEra')]: '02', // Forcing::ForceNone
  };
}

/** Session::NextKeys is a map, so our validators' entries are injects, not overrides. */
export function relayInjects(validators: DevValidator[]): Record<string, string> {
  // twox128(":UsePreviousValidators:")
  const injects: Record<string, string> = { c57d82d01f0fc18afc048ca20ac460dd: '01' };
  const nextKeys = keyOf('Session', 'NextKeys');
  for (const v of validators) {
    injects[nextKeys + twox64Concat(v.stash)] = sessionKeys(v);
  }
  return injects;
}

/**
 * Endow the fork's sudo (//Alice) by writing its System::Account entry at import.
 *
 * Shared-relay networks only: their chains are live public networks where no dev
 * account holds funds, so sudo's first transaction (a runtime upgrade's fees) is
 * unpayable — observed live on paseo-next-v2's people chain. Injecting the entry is
 * safe: verified byte-for-byte on-chain and A/B'd against clean bites on previewnet.
 * Networks with their own relay are left alone — their genesis endows the dev
 * accounts, and overwriting a live account would reset its nonce and consumers.
 */
export function sudoEndowInjects(): Record<string, string> {
  // //Alice, sr25519 public key.
  const alice = 'd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d';
  return endowInjects(alice);
}

/** Write one `System::Account` entry with a spendable balance and nothing else set. */
function endowInjects(accountId: string): Record<string, string> {
  const info =
    '00000000' + // nonce
    '00000000' + // consumers
    '01000000' + // providers: the balance provides for the account
    '00000000' + // sufficients
    u128le(10n ** 17n) + // free: 10M units at 10 decimals — clears any fee on these chains
    u128le(0n) + // reserved
    u128le(0n) + // frozen
    u128le(1n << 127n); // flags: the new-logic marker every current account carries
  return { [keyOf('System', 'Account') + blake2128Concat(accountId)]: info };
}

/**
 * The account `pallet-revive` spends from when an Ethereum wallet signs.
 *
 * An secp256k1 wallet has no AccountId32 of its own, so revive derives a fallback: the twenty
 * address bytes followed by twelve `0xEE` (`to_fallback_account_id` in `frame/revive/address.rs`,
 * which also recognises the suffix on the way back). Fees and deposits for anything that wallet
 * signs come out of that account.
 *
 * Endowing it at import is what lets a contract deployment run on a fork of a chain where no key
 * we hold has funds. A signed transfer after the spawn would also work where the bite endows
 * Alice, which it does on a shared relay, but that is a manual step to repeat on every rebite
 * and here it costs one entry.
 *
 * A chain may name more than one wallet. dotns signs the CREATE3 factory from a single-purpose
 * key and the deploy pipeline from another, which becomes the proxy owner, so a fork that
 * reproduces another network's addresses and its ownership has to fund both.
 */
export function evmDeployerEndowInjects(addresses: string | string[]): Record<string, string> {
  const injects: Record<string, string> = {};
  for (const address of Array.isArray(addresses) ? addresses : [addresses]) {
    const hex = address.replace(/^0x/, '').toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(hex)) {
      throw new Error(`evm deployer must be a 20-byte hex address, got "${address}"`);
    }
    Object.assign(injects, endowInjects(hex + 'ee'.repeat(12)));
  }
  return injects;
}

/**
 * Let one account authorize Bulletin storage, written at import.
 *
 * `TransactionStorage::authorize_account` takes `Authorizer`, which is Root, a sibling parachain
 * in `AllowedParachainIds`, or an account in `AllowedAuthorizers`. On a fork of a chain without
 * Sudo the first is unreachable and the other two are empty: live Polkadot Bulletin has no
 * entry in either, because on a production chain authorizers arrive by governance. So nothing
 * can store anything, and `bulletinAutoAuthorize` fails `BadSigner`.
 *
 * previewnet does not hit this: the bulletin runtime's own genesis preset seeds
 * `Sr25519Keyring::Eve` with 100_000 transactions and 100 GiB. A fork has no genesis, so the
 * same entry is written here instead, with the budget copied from that preset rather than
 * invented. `valid_until: None` and `feeless: true` are what `BuildGenesisConfig` sets.
 *
 * This writes the map entry alone. Both paths that create one in the pallet pair the insert
 * with `inc_authorizer_providers`, which keeps a `feeless` authorizer with no balance from
 * being reaped between dispatches. So pass an account that holds a balance, which provides
 * for itself. The reference cannot be supplied later either: both paths guard the increment
 * on the entry being new, so adding the authorizer again through the pallet is a no-op.
 *
 * Unlike the other injects this one is type-checkable: `TransactionStorage` exists on the chain
 * being bitten, so `verifyInjects` decodes it against real metadata.
 */
export function bulletinAuthorizerInjects(accountId: string): Record<string, string> {
  const id = accountId.replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(id)) {
    throw new Error(`bulletin authorizer must be a 32-byte account id, got "${accountId}"`);
  }
  const budget =
    '01' + // quota: Some
    u32le(100_000) + // transactions
    u64le(100n * 1024n * 1024n * 1024n) + // bytes: 100 GiB
    '00' + // valid_until: None
    '01'; // feeless
  return { [keyOf('TransactionStorage', 'AllowedAuthorizers') + blake2128Concat(id)]: budget };
}

/**
 * Point `DotnsGateway` at the contract it dispatches into, written at import.
 *
 * `set_dispatcher_address` takes `RootOrWhitelist`, and a fork of a chain without Sudo reaches
 * neither arm: Root has no dispatcher, and the whitelisted caller needs a referendum to
 * whitelist the call. Until it is set, `reserve_name` and `register_name` fail
 * `DispatcherAddressNotSet`, the two calls that reach the contract. The bite is the only
 * origin-free moment, exactly as it is for the seeded upgrade authorization.
 *
 * Two things here differ from every other inject, and both follow from the pallet arriving with
 * the runtime the bite authorizes rather than being on the chain being bitten. `verifyInjects`
 * cannot type-check the value, because the live metadata has no `DotnsGateway`, and reports it
 * skipped; the value is a bare H160, so nothing a type check would catch is lost. And the guard
 * is the descriptor rather than `index.pallets.has('DotnsGateway')`, which would be false at
 * bite time for the same reason and would silently write nothing at all.
 *
 * `DispatcherAddress` is `OptionQuery`, whose `Some` is stored as the bare value: 20 bytes, no
 * discriminant.
 */
export function dotnsDispatcherInject(address: string): Record<string, string> {
  const hex = address.replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hex)) {
    throw new Error(`dotns dispatcher must be a 20-byte hex address, got "${address}"`);
  }
  return { [keyOf('DotnsGateway', 'DispatcherAddress')]: hex };
}

/**
 * Grant an attestation allowance, as `increase_attestation_allowance` would have.
 *
 * Two quotas share the name. `PeopleLite`'s is how many people a verifier may attest, spent by
 * `attest`; `DotnsGateway`'s is how many names an attester may reserve, spent by `reserve_name`.
 * Without the first nobody becomes a lite person, without the second nobody who did can take a
 * username, and the backend needs both.
 *
 * `PeopleLite`'s manager is `EnsureRoot` and `DotnsGateway`'s is `RootOrWhitelist`, so on a fork
 * of a chain whose Root is a referendum neither can be granted after the spawn.
 *
 * The key is hand-built for the same reason `dotnsDispatcherInject` hand-builds its own: both
 * pallets arrive with the runtime the bite authorizes, so neither is in the metadata of the
 * chain being bitten. Deriving the key from that metadata yields nothing at all, silently, on
 * exactly the chains this is meant for.
 *
 * Both pallets store it as `StorageMap<_, Blake2_128Concat, AccountId, u32, ValueQuery>`, and
 * both `increase_attestation_allowance` implementations only saturating-add, so the count is
 * the whole state.
 */
export function attestationAllowanceInjects(
  pallet: 'PeopleLite' | 'DotnsGateway',
  attester: string,
  count: number
): Record<string, string> {
  // One descriptor object feeds both calls, so neither message names the pallet: the count and
  // the attester are the same on each, and naming one would imply a figure that is per-pallet.
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`attestation allowance must be a positive integer, got ${count}`);
  }
  let id: string;
  try {
    id = Buffer.from(decodeAddress(attester)).toString('hex');
  } catch (cause) {
    // decodeAddress reports the encoding it failed to read, which says nothing about where the
    // value came from. This is the only place that knows it is an attester.
    throw new Error(`attester "${attester}" is not an account: ${(cause as Error).message}`);
  }
  if (id.length !== 64) {
    throw new Error(`attester must be a 32-byte account, got ${id.length / 2} bytes`);
  }
  return { [keyOf(pallet, 'AttestationAllowance') + blake2128Concat(id)]: u32le(count) };
}

/**
 * The onboarding size of one `Members` collection.
 *
 * `OnboardingSize` is `StorageMap<_, Identity, Identifier, u32, ValueQuery>` and
 * `set_onboarding_size` only inserts, so the size is the whole state the call writes. The
 * `Identity` hasher leaves the key as the identifier's own bytes.
 *
 * The collection has to exist on the chain being bitten. `create_collection` writes this entry
 * too, so a collection the runtime upgrade creates gets the runtime's size, not this one.
 */
export function onboardingSizeInject(collection: string, size: number): Record<string, string> {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`onboarding size must be a positive integer, got ${size}`);
  }
  // `Identifier` is `[u8; 32]`, and the runtime spells each one as a byte-string literal padded
  // to that length. A name of any other length names no collection the runtime knows.
  const id = Buffer.from(collection, 'utf8');
  if (id.length !== 32) {
    throw new Error(`collection "${collection}" must be 32 bytes, got ${id.length}`);
  }
  return { [keyOf('Members', 'OnboardingSize') + id.toString('hex')]: u32le(size) };
}

/**
 * The collator keys for a parachain, one per collator node.
 *
 * zombie-bite derives the first from the seed "//Collator-<paraId>" and names the collator
 * Collator-<paraId>; zombienet derives non-well-known node keys the same way, so the two
 * agree. Verified byte-identical against a real `bite -r paseo` run. Further collators follow
 * the node names collatorNodeName() gives them, for the same reason.
 *
 * The curve is the chain's, not ours: see auraScheme(). The same seed on the other curve
 * is a different key, and zombienet already writes it — under `gran`, not `aura`.
 */
export async function collatorKeys(
  paraId: number,
  count: number,
  scheme: AuraScheme = 'sr25519'
): Promise<string[]> {
  if (!Number.isInteger(count) || count < 1) throw new Error(`a parachain runs at least one collator, not ${count}`);
  await cryptoWaitReady();
  const keyring = new Keyring({ type: scheme });
  return Array.from({ length: count }, (_, i) =>
    Buffer.from(keyring.addFromUri(`//${collatorNodeName(paraId, i)}`).publicKey).toString('hex')
  );
}

/** The one collator every bite before collator counts installed. */
export async function collatorKey(paraId: number, scheme: AuraScheme = 'sr25519'): Promise<string> {
  return (await collatorKeys(paraId, 1, scheme))[0];
}

/**
 * Authorize a runtime upgrade in storage, so a fork with no sudo can still enact one.
 *
 * `authorize_upgrade` is a root call, and Kusama and Polkadot have no Sudo pallet — there is
 * no origin on a fork that can make it. Writing the authorization at import instead leaves the
 * chain in the state that call would have produced, and `apply_authorized_upgrade` is callable
 * unsigned by anyone, so the second half needs no privilege either.
 *
 * This is the state the real upgrade path passes through, not a shortcut around it: the blob
 * is still hashed, still checked against this authorization, and on a parachain still goes
 * through the relay's PVF pre-check and go-ahead. What it skips is only the governance
 * dispatch that would have authorized it.
 *
 * `checkVersion` false is what applying a runtime whose spec_version is not bumped needs —
 * an e2e run replaying production's own runtime against a fork of production's state.
 *
 * Mirrors zombie-bite's `--rc-upgrade`/`--para-upgrade` (paritytech/zombie-bite#127), which is
 * where this belongs once PPN calls zombie-bite instead of driving doppelganger itself.
 */
export function authorizedUpgradeCandidate(codeHash: string, checkVersion: boolean): Record<string, string> {
  // Case-insensitive, then lowercased: `0xAB…` is the same hash, and every tool that prints
  // one has its own opinion about case. Rejecting it here would fail *after* the bite ran.
  const hash = codeHash.replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`code hash must be 32 bytes of hex, got "${codeHash}"`);
  return { [keyOf('System', 'AuthorizedUpgrade')]: hash + (checkVersion ? '01' : '00') };
}

/**
 * Parachain storage values that install the collators as its authority set. One key serves as
 * both the account and the Aura key: the seed is the same and the account is the sr25519 public
 * key, which is what CollatorSelection and Session hold.
 */
export function paraCandidates(collators: string[]): Record<string, string> {
  const len = compactLen(collators.length);
  const all = collators.join('');
  return {
    [keyOf('CollatorSelection', 'DesiredCandidates')]: u32le(collators.length),
    [keyOf('CollatorSelection', 'Invulnerables')]: len + all,
    [keyOf('AuraExt', 'Authorities')]: len + all,
    [keyOf('Aura', 'Authorities')]: len + all,
    [keyOf('Session', 'Validators')]: len + all,
    [keyOf('Session', 'QueuedKeys')]: len + collators.map((c) => c + c).join(''),
    [keyOf('Sudo', 'Key')]: ALICE_SR,
    // ParachainSystem::LastDmqMqcHead is left alone: zeroing it (as zombie-bite does)
    // desyncs the parachain from the relay's preserved Dmp state.
  };
}

export function paraInjects(collators: string[]): Record<string, string> {
  const injects: Record<string, string> = {};
  for (const collator of collators) {
    injects[keyOf('Session', 'NextKeys') + twox64Concat(collator)] = collator;
    // Session::KeyOwner(("aura", collatorKey))
    injects[
      'cec5070d609dd3497f72bde07fc96ba0726380404683fc89e8233450c8aa1950eab3d4a1675d3d746175726180' +
        collator
    ] = collator;
  }
  return injects;
}
