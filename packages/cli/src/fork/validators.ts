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
import type { AuraScheme } from '@parity/ppn-network-config';

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

const mk = (stash: string, babe: string, grandpa: string, beefy: string): DevValidator => ({
  stash, babe, grandpa, beefy,
  paraValidator: babe, paraAssignment: babe, authorityDiscovery: babe,
});

/**
 * Well-known dev keys, verbatim from zombie-bite src/utils.rs.
 *
 * Order matters: it must match get_validator_keys() — ALICE, BOB, CHARLIE, DAVE, FERDIE,
 * EVE (note FERDIE before EVE) — because ActiveValidatorIndices and ValidatorGroups index
 * into it positionally.
 */
export const VALIDATORS: DevValidator[] = [
  mk('be5ddb1579b72e84524fc29e78609e3caf42e85aa118ebfe0b0ad404b5bdd25f', ALICE_SR, '88dc3417d5058ec4b4503e0c12ea1a0a89be200fe98922423d4334014fa6b0ee', '020a1091341fe5664bfa1782d5e04779689068c916b04cb365ec3153755684d9a1'),
  mk('fe65717dad0447d715f660a0a58411de509b42e6efb8375f562f58a554d5860e', '8eaf04151687736326c9fea17e25fc5287613693c912909cb226aa4794f26a48', 'd17c2d7823ebf260fd138f2d7e27d114c0145d968b5ff5006125f2414fadae69', '0390084fdbf27d2b79d26a4f13f0ccd982cb755a661969143c37cbc49ef5b91f27'),
  mk('1e07379407fecc4b89eb7dbd287c2c781cfb1907a96947a3eb18e4f8e7198625', '90b5ab205c6974c9ea841be688864633dc9ca8a357843eeacf2314649965fe22', '439660b36c6c03afafca027b910b4fecf99801834c62a5e6006f27d978de234f', '020e7446f3910e15fed2b2db1e71a01c57f3dd85cc2e65f30680220e09f8bbbc79'),
  mk('e860f1b1c7227f7c22602f53f15af80747814dffd839719731ee3bba6edc126c', '306721211d5404bd9da88e0204360a1a9ab8b87c66c1bc2fcdd37f3c2222cc20', '5e639b43e0052c47447dac87d6fd2b6ec50bdd4d0f614e4299c665249bbd09d9', '0227e2b139697b04eb01f4eef7e8f3724431b795c45ce6ef7b8e23a4e93f4abd26'),
  mk('101191192fc877c24d725b337120fa3edc63d227bbc92705db1e2cb65f56981a', '1cbd2d43530a44705ad088af313e18f80b53ef16b36177cd4b77b846f2a5f07c', '568cb4a574c6d178feb39c27dfc8b3f789e5f5423e19c71633c748b9acf086b5', '0291f1217d5a04cb83312ee3d88a6e6b33284e053e6ccfc3a90339a0299d12967c'),
  mk('8ac59e11963af19174d0b94d5d78041c233f55d2e19324665bafdfb62925af2d', 'e659a7a1628cdd93febc04a4e0646ea20e9f5f0ce097d9a05290d4a9e054df4e', '1dfe3e22cc0d45c70779c1095f7489a8ef3cf52d62fbd8c2fa38c9f1723502b5', '031d10105e323c4afce225208f71a6441ee327a65b9e646e772500c74d31f669aa'),
];

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
export function relayCandidates(): Record<string, string> {
  const len = compactLen(VALIDATORS.length);
  const each = (f: (v: DevValidator) => string) => VALIDATORS.map(f).join('');

  return {
    [keyOf('Session', 'Validators')]: len + each((v) => v.stash),
    [keyOf('Session', 'QueuedKeys')]: len + each((v) => v.stash + sessionKeys(v)),
    [keyOf('Babe', 'Authorities')]: len + each((v) => v.babe + '0100000000000000'),
    [keyOf('Babe', 'NextAuthorities')]: len + each((v) => v.babe + '0100000000000000'),
    [keyOf('Grandpa', 'Authorities')]: len + each((v) => v.grandpa + '0100000000000000'),
    [keyOf('Staking', 'Invulnerables')]: len + each((v) => v.stash),
    [keyOf('ParasShared', 'ActiveValidatorIndices')]: len + VALIDATORS.map((_, i) => u32le(i)).join(''),
    [keyOf('ParasShared', 'ActiveValidatorKeys')]: len + each((v) => v.paraValidator),
    [keyOf('AuthorityDiscovery', 'Keys')]: len + each((v) => v.authorityDiscovery),
    [keyOf('AuthorityDiscovery', 'NextKeys')]: len + each((v) => v.authorityDiscovery),
    [keyOf('Sudo', 'Key')]: ALICE_SR,
    // Each group carries its own compact length. Verified against production, whose real
    // value is `18` + 6x(`04` + u32) = [[0],[1],[2],[3],[4],[5]].
    [keyOf('ParaScheduler', 'ValidatorGroups')]:
      len + VALIDATORS.map((_, i) => compactLen(1) + u32le(i)).join(''),
    // previewnet's relay runs the paseo runtime, which has no `:UsePreviousValidators:`
    // hook, so doppelganger's inject for it is inert. Without ForceNone the first session
    // rotation re-elects production's validators — whose Session::NextKeys doppelganger has
    // just wiped — leaving Babe::NextAuthorities empty and halting authoring after one epoch.
    [keyOf('Staking', 'ForceEra')]: '02', // Forcing::ForceNone
  };
}

/** Session::NextKeys is a map, so our validators' entries are injects, not overrides. */
export function relayInjects(): Record<string, string> {
  // twox128(":UsePreviousValidators:")
  const injects: Record<string, string> = { c57d82d01f0fc18afc048ca20ac460dd: '01' };
  const nextKeys = keyOf('Session', 'NextKeys');
  for (const v of VALIDATORS) {
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
    u128le(10n ** 16n) + // free: 1M units at 10 decimals — clears any fee on these chains
    u128le(0n) + // reserved
    u128le(0n) + // frozen
    u128le(1n << 127n); // flags: the new-logic marker every current account carries
  return { [keyOf('System', 'Account') + blake2128Concat(alice)]: info };
}

/**
 * The collator key for a parachain.
 *
 * zombie-bite derives it from the seed "//Collator-<paraId>" and names the collator
 * Collator-<paraId>; zombienet derives non-well-known node keys the same way, so the two
 * agree. Verified byte-identical against a real `bite -r paseo` run.
 *
 * The curve is the chain's, not ours: see auraScheme(). The same seed on the other curve
 * is a different key, and zombienet already writes it — under `gran`, not `aura`.
 */
export async function collatorKey(paraId: number, scheme: AuraScheme = 'sr25519'): Promise<string> {
  await cryptoWaitReady();
  const pair = new Keyring({ type: scheme }).addFromUri(`//Collator-${paraId}`);
  return Buffer.from(pair.publicKey).toString('hex');
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

export function paraCandidates(collator: string): Record<string, string> {
  const one = compactLen(1);
  return {
    [keyOf('CollatorSelection', 'DesiredCandidates')]: '01000000',
    [keyOf('CollatorSelection', 'Invulnerables')]: one + collator,
    [keyOf('AuraExt', 'Authorities')]: one + collator,
    [keyOf('Aura', 'Authorities')]: one + collator,
    [keyOf('Session', 'Validators')]: one + collator,
    [keyOf('Session', 'QueuedKeys')]: one + collator + collator,
    [keyOf('Sudo', 'Key')]: ALICE_SR,
    // ParachainSystem::LastDmqMqcHead is left alone: zeroing it (as zombie-bite does)
    // desyncs the parachain from the relay's preserved Dmp state.
  };
}

export function paraInjects(collator: string): Record<string, string> {
  return {
    [keyOf('Session', 'NextKeys') + twox64Concat(collator)]: collator,
    // Session::KeyOwner(("aura", collatorKey))
    ['cec5070d609dd3497f72bde07fc96ba0726380404683fc89e8233450c8aa1950eab3d4a1675d3d746175726180' +
      collator]: collator,
  };
}
