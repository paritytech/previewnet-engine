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
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { blake2128Concat, compactLen, keyOf, twox64Concat, u128le, u32le } from './codec.js';
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
  const info =
    '00000000' + // nonce
    '00000000' + // consumers
    '01000000' + // providers: the balance provides for the account
    '00000000' + // sufficients
    u128le(10n ** 17n) + // free: 10M units at 10 decimals — clears any fee on these chains
    u128le(0n) + // reserved
    u128le(0n) + // frozen
    u128le(1n << 127n); // flags: the new-logic marker every current account carries
  return { [keyOf('System', 'Account') + blake2128Concat(alice)]: info };
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
