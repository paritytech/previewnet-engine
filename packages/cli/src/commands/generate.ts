// `ppn generate` — build the genesis chain specs.
//
// Only a genesis network has these (previewnet; see networks/README.md). Every value —
// para ids, chain ids, display names, presets, output filenames, which runtime each chain
// builds from — comes from the descriptor, the same file `ppn fetch` reads to download
// those runtimes, so the two cannot disagree.
//
// Usage: ppn generate [binDir]        (default: ./bin)
//
// Environment:
//   PPN_PROFILE      local (default) | deployable — see docs/PROFILES.md
//   PPN_SUDO_URI     deployable: the sudo signing key
//   PPN_SUDO_SS58    deployable: the same key's address, cross-checked below
//   PPN_FAUCET_SS58  deployable: pre-funded faucet account

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadCurrentNetwork, networkChains, repoRoot,
  workspaceRoot} from '@parity/ppn-network-config';
import { patchSpec, applyProfile, enableEccRfc163, injectDotns, readSpec,
  setNetworkSuffix, createPeopleCollections } from '@parity/ppn-network-config';

// Roots come from repoRoot()/workspaceRoot(), never from counting directory levels.
const REPO = repoRoot();
/** Mutable state — binaries, chain data, bundles — lives in the workspace, not the package. */
const WS = workspaceRoot();
const SECRETS_FILE = '/etc/ppn/secrets.env';

/**
 * Deployable-profile secrets. server/redeploy.sh exports them before calling us; a direct
 * `make generate` does not, so read the file when it is there.
 */
function loadSecrets() {
  if (!fs.existsSync(SECRETS_FILE)) return;
  for (const line of fs.readFileSync(SECRETS_FILE, 'utf8').split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, '');
    process.env[m[1]] ??= value;
  }
  console.log(`Loaded ${SECRETS_FILE} (PPN_PROFILE=${process.env.PPN_PROFILE ?? 'unset'})`);
}

/**
 * Confirm PPN_SUDO_URI and PPN_SUDO_SS58 are the same keypair before any spec is built.
 * A mismatch silently bricks sudo at runtime — every sudo call returns BadOrigin, with a
 * misleading error — so it is much better to fail here.
 */
function checkDeployableSudo() {
  const uri = process.env.PPN_SUDO_URI;
  const ss58 = process.env.PPN_SUDO_SS58;
  if (!uri || !ss58) throw new Error('deployable profile requires PPN_SUDO_URI and PPN_SUDO_SS58');

  const dot = (args: string[]) => execFileSync('dot', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
  try {
    dot(['--version']);
  } catch {
    throw new Error('deployable profile requires the `dot` CLI (make ensure-dot-cli)');
  }
  const account = '_ppn_sudo_check';
  const remove = () => {
    try { dot(['account', 'remove', account]); } catch { /* not present */ }
  };
  remove();
  dot(['account', 'add', account, '--env', 'PPN_SUDO_URI']);
  let derived;
  try {
    derived = JSON.parse(dot(['account', 'inspect', account, '--json'])).ss58;
  } finally {
    remove();
  }
  if (derived !== ss58) {
    throw new Error(
      `PPN_SUDO_URI derives to ${derived} but PPN_SUDO_SS58 is ${ss58}\n` +
        '       The chain spec sudo.key and the operational signing key must match.'
    );
  }
  console.log('Verified PPN_SUDO_URI derives to PPN_SUDO_SS58');
}

export interface GenerateOptions {
  /** Do nothing when every spec this would build is already there. */
  ifNeeded?: boolean;
  /** Delete the specs this builds, and stop. */
  clean?: boolean;
}

export async function run(args: string[], opts: GenerateOptions = {}): Promise<void> {
  const binDir = path.resolve(args[0] || path.join(WS, 'bin'));
  const netForFiles = loadCurrentNetwork();
  const specFiles = netForFiles.genesis
    ? networkChains(netForFiles).map((c) => c.genesisSpec!.file)
    : [];

  if (opts.clean) {
    for (const f of specFiles) fs.rmSync(path.join(binDir, f), { force: true });
    console.log(`removed ${specFiles.length} chain spec(s) from ${binDir}`);
    return;
  }
  if (opts.ifNeeded && specFiles.length > 0 && specFiles.every((f) => fs.existsSync(path.join(binDir, f)))) {
    console.log(`✓ chain specs present in ${binDir}`);
    return;
  }

  loadSecrets();
  const profile = process.env.PPN_PROFILE || 'local';
  if (profile === 'deployable') checkDeployableSudo();

  const net = loadCurrentNetwork();
  if (!net.genesis) {
    throw new Error(`${net.name} is fork-only — it has no genesis to build (see networks/README.md)`);
  }
  const { chainType, properties } = net.genesisConfig!;
  const relayChainId = net.relay.genesisSpec!.chainId;

  const builder = path.join(binDir, 'chain-spec-builder');
  if (!fs.existsSync(builder)) {
    throw new Error(`no chain-spec-builder in ${binDir} — run \`make fetch\` first`);
  }

  console.log(`Generating chain specs (profile: ${profile}, network: ${net.name})...`);
  const log = (msg: string) => console.log(msg);

  // Which chains actually took the network suffix — only the runtimes carrying the pallet
  // can, and a network that names one and finds none has runtime pins older than it.
  const networkSuffix = net.genesisConfig!.networkSuffix;
  const suffixed: string[] = [];

  for (const chain of networkChains(net)) {
    const { chainId, name, preset, file } = chain.genesisSpec!;
    const isRelay = chain.key === 'relay';

    console.log(
      isRelay ? `Relay Chain (${chainId}):` : `${name} (parachain ${chain.paraId}):`
    );

    // The relay has no built-in preset for this chain id, so its spec is built from the
    // runtime WASM like every parachain's — the only difference is that it takes no
    // para id and is not told which relay it belongs to.
    execFileSync(
      builder,
      [
        'create',
        ...(isRelay ? [] : ['-p', String(chain.paraId), '-c', relayChainId]),
        '-i', chainId,
        '-n', name,
        '-t', chainType,
        '--properties', properties,
        '-r', chain.runtime!.file,
        'named-preset', preset,
      ],
      { cwd: binDir, stdio: 'inherit' }
    );
    fs.renameSync(path.join(binDir, 'chain_spec.json'), path.join(binDir, file));

    // Per-chain genesis edits, then the profile's account rules. One read-modify-write:
    // a spec that needs no change is left byte-for-byte as chain-spec-builder wrote it.
    const specPath = path.join(binDir, file);
    const mutators: ((spec: any) => boolean)[] = [];

    if (isRelay) {
      // The People runtime uses RFC-163 ECC host calls during PVF validation when the ZK
      // chunk payloads are decoded. Without this the relay's validators reject those
      // candidates for missing ext_host_calls_* functions.
      mutators.push(enableEccRfc163);
    }

    let fundEvmDev = false;
    if (chain.key === 'asset-hub') {
      // Only Asset Hub runs pallet-revive, so only it gets the EVM-mapped dev accounts
      // and the pre-deployed DotNS contracts.
      fundEvmDev = true;
      // The descriptor's networkSuffix doubles as the DotNS TLD (one knob, no drift):
      // it names the fetched asset, and injectDotns asserts the artifact's own stamp
      // against it, so a registry baked for a different namespace cannot land here.
      if (networkSuffix) {
        const dotnsPath = path.join(binDir, `dotns-genesis-${networkSuffix}.json`);
        if (!fs.existsSync(dotnsPath)) {
          // A namespaced genesis network without its registry is a broken product, not a
          // reduced one — 05-dotns-contracts and the gateway would fail hours later.
          throw new Error(`${path.basename(dotnsPath)} is missing from ${binDir} — run: make fetch`);
        }
        const dotns: any = readSpec(dotnsPath);
        mutators.push((spec: any) => {
          injectDotns(spec, dotns, networkSuffix);
          console.log(`  Injected ${Object.keys(dotns.accounts ?? {}).length} DotNS contracts into Asset Hub genesis`);
          return true;
        });
      } else {
        console.log('  Note: no networkSuffix in the descriptor — no namespace, skipping DotNS');
      }
    }

    if (chain.key === 'people') {
      mutators.push((spec: any) => {
        const created = createPeopleCollections(spec);
        console.log(
          created.length > 0
            ? `  Created the People collections at genesis (${created.join(', ')})`
            : '  Note: this People runtime has no collection flag in genesis — skipping\n' +
                '  (a runtime older than the flag; re-run `ppn fetch` if registrations do not land)'
        );
        return created.length > 0;
      });
    }

    if (networkSuffix) {
      mutators.push((spec: any) => {
        const outcome = setNetworkSuffix(spec, networkSuffix);
        if (outcome !== 'absent') {
          suffixed.push(chain.key);
          console.log(`  Set network suffix to "${networkSuffix}"`);
        }
        return outcome === 'set';
      });
    }

    mutators.push((spec: any) => applyProfile(spec, { profile, fundEvmDev, log }));
    patchSpec(specPath, mutators);
    console.log(`  Done: ${file}`);
  }

  if (networkSuffix && suffixed.length === 0) {
    console.log(
      `\nWarning: ${net.name} asks for network suffix "${networkSuffix}", but no runtime it\n` +
        '         builds from carries the pallet that holds it — those specs keep the suffix\n' +
        "         their preset ships. Re-run `ppn fetch` for runtimes new enough to take it."
    );
  }

  console.log(`\nGenerated chain specs in ${binDir}`);
}
