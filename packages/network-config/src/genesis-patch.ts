// Reading, patching and writing a chain spec.
//
// Two things here are easy to get wrong and expensive to notice:
//
// 1. Chain specs carry u128 genesis values above Number.MAX_SAFE_INTEGER (25-digit
//    balances on the web3-storage spec). A plain JSON round-trip loses precision and
//    re-emits values >= 1e21 in exponent notation, which the serde-based consumers
//    (zombie-cli, the nodes) reject as "invalid number". Every read below preserves the
//    original source text of unsafe numbers via JSON.rawJSON.
//
// 2. Re-serializing a large spec can alter formatting in ways downstream tools
//    (polkadot-omni-node build-spec) trip on, so a spec that needs no change is never
//    rewritten. `patchSpec` writes only when a mutator reports one.

import fs from 'node:fs';

// Same balance as the substrate dev accounts (1,000,000 PAS at 10 decimals).
const BALANCE = 10000000000000000;

// EVM-mapped SS58 addresses for dev accounts (pallet-revive convention). Computed from:
// DEV_PHRASE → sr25519 derive → keccak256(pubkey) → H160 → [h160 ++ 0xEE*12] → SS58.
// Applied to Asset Hub only; the other chains have no pallet-revive, so these would be
// inert pre-funded AccountId32s polluting their genesis state.
const EVM_DEV_ACCOUNTS = [
  '5FTZ6n1wY3GBqEZ2DWEdspbTarvRnp8DM8x2YXbWubu7JN98', // Alice   0x9621dde6…
  '5DZ4ZRZVipXuQ5BtamrqwymLZggk6J1iLW6LvGVGrJjVSyFj', // Bob     0x41dccbd4…
  '5HBDBSu2q6fbnDR6djKKJ2WbJQt3orNanKe8QEnou8FSYopF', // Charlie 0xe2235a2f…
  '5FrTVzyowexWhZ4hbomCbKvciky17fneKbY7Krt9yLNtJsLg', // Dave    0xa799a942…
  '5Cnxtrz86WmZfXByZTS4HrAAvU7SKbs3uDQgKdKeF2TPu8Tt', // Eve     0x203aedc6…
  '5CpqYNJLHzaYFttQtp3u3aUKM2dW5JXmJxTiuZvPMymbMzgX', // Ferdie  0x21a8aa80…
  '5Ha8yXQgvWcvpFya1BmjtJX386xUskafNTzU4Zmb6B3UwYd9', // Hardhat 0xf39Fd6e5…
];

// Well-known //Alice…//Ferdie SS58 accounts (+ stash variants) baked into the
// `development` / `local_testnet` runtime presets.
const DEV_SS58 = new Set([
  '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY',
  '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty',
  '5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y',
  '5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy',
  '5HGjWAeFDfFCWPsjFQdVV2Msvz2XtMktvgocEZcCj68kUMaw',
  '5CiPPseXPECbkjWCa6MnjNokrgYjMqmKndv2rSnekmSK2DjL',
  '5GNJqTPyNqANBkUVMN1LPPrxXnFouWXoe2wNSmmEoLctxiZY',
  '5HpG9w8EBLe5XCrbczpwq5TSXvedjrBGCwqxK1iQ7qUsSWFc',
  '5Ck5SLSHYac6WFt5UZRSsdJjwmpSZq85fd5TRNAdZQVzEAPT',
  '5HKPmK9GYtE1PSLsS1qiYU9xQ9Si1NcEhdeCq9sw5bqu4ns8',
  '5FCfAonRZgTFrTd9HREEyeJjDpT397KMzizE6T3DvebLFE7n',
  '5CRmqmsiNFExV6VbdmPJViVxrWmkaXXvBrSX8oqBT8R9vmWk',
]);

export const PROFILES = ['local', 'deployable'];

/** Read a chain spec without losing precision on u128 genesis values. */
export function readSpec(path: string): any {
  if (typeof (JSON as any).rawJSON !== 'function') {
    throw new Error('needs Node >= 21 (JSON.rawJSON) to preserve u128 genesis values');
  }
  // The three-argument reviver (with `context.source`) is Node >= 21; the lib types this
  // project builds against still declare the two-argument form, hence the cast.
  const reviver = (key: string, value: unknown, ctx: { source?: string }) =>
    typeof value === 'number' && !Number.isSafeInteger(value)
      ? (JSON as any).rawJSON(ctx.source)
      : value;
  return JSON.parse(fs.readFileSync(path, 'utf8'), reviver as (key: string, value: unknown) => unknown);
}

export function writeSpec(path: string, spec: unknown): void {
  fs.writeFileSync(path, JSON.stringify(spec, null, 2) + '\n');
}

/** Enable the RFC-163 ECC host functions the People runtime needs during PVF validation. */
export function enableEccRfc163(spec: any): boolean {
  const params = spec.genesis?.runtimeGenesis?.patch?.configuration?.config;
  if (!params) throw new Error('no genesis.runtimeGenesis.patch.configuration.config');
  const existing = (params.executor_params ?? []).filter(
    (p: { EnabledHostFunction?: string }) => p.EnabledHostFunction !== 'EccRfc163'
  );
  params.executor_params = [...existing, { EnabledHostFunction: 'EccRfc163' }];
  return true;
}

/**
 * Point this network's product contexts at its own namespace.
 *
 * The suffix used to be a runtime constant — `paseo`, baked into the WASM — so a network
 * that wanted its own namespace had to rebuild the runtime. individuality-community#20
 * moved it into a pallet whose value genesis sets, and this writes ours over the `paseo`
 * the People and Asset Hub presets ship.
 *
 * Only those two runtimes carry the pallet. The relay, Bulletin and Web3 Storage emit no
 * such section, and neither does an individuality runtime built before that PR — injecting
 * a key their `RuntimeGenesisConfig` does not know would fail genesis validation outright,
 * so those are reported back as `absent` rather than patched.
 */
export function setNetworkSuffix(spec: any, suffix: string): 'set' | 'unchanged' | 'absent' {
  const patch = spec.genesis?.runtimeGenesis?.patch;
  if (!patch) throw new Error('no genesis.runtimeGenesis.patch');
  if (!patch.networkSuffix) return 'absent';

  const bytes = [...Buffer.from(suffix, 'utf8')];
  const current: unknown = patch.networkSuffix.networkSuffix;
  if (Array.isArray(current) && current.length === bytes.length && current.every((b, i) => b === bytes[i])) {
    return 'unchanged';
  }
  patch.networkSuffix.networkSuffix = bytes;
  return 'set';
}

/**
 * Create the People collections at genesis.
 *
 * Both people pallets create their collection in a migration, and a migration only runs on
 * a runtime upgrade — a chain starting from genesis never runs one, so the collections
 * never come into existence. Nothing fails loudly when they are missing: registrations are
 * accepted and then land nowhere, which is what `tests/09-dub-registration.zndsl` sees when
 * a username never reaches search.
 *
 * The preset emits both sections as `false`, and this flips them. A runtime built before
 * the flag existed emits neither, and creating one there is fatal rather than harmless —
 * `chain-spec-builder verify` rejects the whole spec with "unknown field `people`" — so
 * those are left alone. Returns the sections it changed.
 */
export function createPeopleCollections(spec: any): string[] {
  const patch = spec.genesis?.runtimeGenesis?.patch;
  if (!patch) throw new Error('no genesis.runtimeGenesis.patch');
  const changed: string[] = [];
  for (const section of ['people', 'peopleLite']) {
    if (!patch[section] || patch[section].createCollection === true) continue;
    patch[section].createCollection = true;
    changed.push(section);
  }
  return changed;
}

/** Put the pre-deployed DotNS contracts into Asset Hub's genesis. */
export function injectDotns(spec: any, dotnsGenesis: unknown, expectedTld?: string): boolean {
  const patch = spec.genesis?.runtimeGenesis?.patch;
  if (!patch) throw new Error('no genesis.runtimeGenesis.patch');
  const g = dotnsGenesis as { accounts?: unknown; tld?: string };
  if (!g || g.accounts === undefined) throw new Error('dotns genesis has no accounts');
  // dotns stamps the TLD into the artifact so a consumer can refuse a registry baked for a
  // different namespace — a rename cannot defeat it. Files predating the field pass.
  if (expectedTld && g.tld && g.tld !== expectedTld) {
    throw new Error(`dotns genesis is for TLD .${g.tld}, this network wants .${expectedTld}`);
  }
  // Only accounts: the artifact carries siblings (tld) that pallet-revive's GenesisConfig
  // does not know, and an unknown field fails chain-spec construction.
  patch.revive = { accounts: g.accounts };
  return true;
}

/**
 * Apply the profile's account rules. Returns false when there is nothing to do, so the
 * caller can leave the file untouched.
 *
 *   local       fund the EVM-mapped dev accounts (Asset Hub only, via fundEvmDev).
 *               Substrate dev accounts are already funded by the runtime preset.
 *   deployable  strip the well-known dev accounts, fund sudo + faucet (+ attester when
 *               configured), and set sudo.key. Missing env vars are a hard failure.
 */
export function applyProfile(
  spec: any,
  { profile, fundEvmDev = false, log = () => {} }: { profile: string; fundEvmDev?: boolean; log?: (msg: string) => void }
): boolean {
  if (!PROFILES.includes(profile)) {
    throw new Error(`unknown profile "${profile}" (expected ${PROFILES.join(' or ')})`);
  }
  // In local profile the only possible change is funding EVM dev accounts.
  if (profile === 'local' && !fundEvmDev) return false;

  const patch = spec.genesis?.runtimeGenesis?.patch;
  if (!patch) throw new Error('no genesis.runtimeGenesis.patch');

  if (profile === 'local') {
    const balances = patch.balances?.balances;
    if (!balances) return false;
    const existing = new Set(balances.map(([addr]: [string, unknown]) => addr));
    const added = EVM_DEV_ACCOUNTS.filter((a) => !existing.has(a));
    for (const addr of added) balances.push([addr, BALANCE]);
    if (added.length) log(`  [local] Funded ${added.length} EVM dev account(s)`);
    return added.length > 0;
  }

  const sudo = process.env.PPN_SUDO_SS58;
  const faucet = process.env.PPN_FAUCET_SS58;
  if (!sudo || !faucet) {
    throw new Error('deployable profile requires PPN_SUDO_SS58 and PPN_FAUCET_SS58');
  }

  // A storage provider must be able to cover its stake at genesis, so its account
  // survives the dev-account strip even when it is a well-known one.
  const protectedAddrs = new Set<string>(
    (patch.storageProvider?.providers ?? []).map((p: { account: string }) => p.account)
  );

  patch.balances ??= {};
  if (!Array.isArray(patch.balances.balances)) patch.balances.balances = [];
  const before = patch.balances.balances.length;
  patch.balances.balances = patch.balances.balances.filter(
    ([addr]: [string, unknown]) => !DEV_SS58.has(addr) || protectedAddrs.has(addr)
  );
  const removed = before - patch.balances.balances.length;
  const kept = [...protectedAddrs].filter((a) => DEV_SS58.has(a)).length;

  // The attestation-allowance recipient is funded too when configured: it is the account
  // the identity backend signs PeopleLite.attest with, so it pays those fees. Unfunded,
  // registrations are accepted and then never land. Optional — a deployment without the
  // identity backend needs no such account.
  const allowance = process.env.PPN_ALLOWANCE_SS58;
  for (const addr of [sudo, faucet, ...(allowance ? [allowance] : [])]) {
    if (!patch.balances.balances.some(([a]: [string, unknown]) => a === addr)) {
      patch.balances.balances.push([addr, BALANCE]);
    }
  }
  log(
    `  [deployable] Removed ${removed} dev account(s)` +
      (kept > 0 ? ` (kept ${kept} storage provider(s))` : '') +
      `; funded sudo + faucet${allowance ? ' + attester' : ''}`
  );

  // Only override sudo.key when the preset emits a sudo section — injecting one on a
  // chain with no sudo pallet (the paseo-local relay) fails runtime genesis validation.
  if (patch.sudo) {
    patch.sudo.key = sudo;
    log(`  [deployable] Set sudo key to ${sudo}`);
  } else {
    log('  [deployable] No sudo section in preset — skipping sudo key override');
  }
  return true;
}

/** Read a spec, run the mutators, and write it back only if one of them changed it. */
export function patchSpec(path: string, mutators: ((spec: any) => boolean)[]): boolean {
  const spec = readSpec(path);
  let changed = false;
  for (const mutate of mutators) changed = mutate(spec) || changed;
  if (changed) writeSpec(path, spec);
  return changed;
}
