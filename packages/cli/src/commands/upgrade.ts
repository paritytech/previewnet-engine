// `ppn upgrade` — change the runtime of a chain that is already running.
//
// The on-chain path (authorize_upgrade → apply_authorized_upgrade), not the genesis-time
// WASM substitution: that one cannot touch a fork, because forked state belongs to the
// runtimes the source network is running. See docs/RUNTIME-UPGRADE.md.
//
// The logic lives in ../upgrade/ and is unit-tested; this reads the arguments and the blob.

import fs from 'node:fs';
import { runtimeUpgrade } from '../upgrade/upgrade.js';
import { ensureFunds } from '../upgrade/fund.js';
import { alreadyInstalled } from '../upgrade/upgrade.js';
import { localWsUrl, UPGRADE_CHAINS } from '../upgrade/chains.js';
import { resolveSudoUri } from '../upgrade/sudo.js';
import { signerFromUri } from '../upgrade/signer.js';
import { wsProvider } from '../upgrade/provider-node.js';
import { secretsFile } from '../lib/secrets.js';


export interface UpgradeOptions {
  /** WS endpoint; defaults to the chain's local port from config/ports.env. */
  ws?: string;
  /** Apply a blob whose spec_version is not bumped — production's own runtime on a fork. */
  allowSameSpec?: boolean;
  /** Skip the sudo top-up (already funded, or funding is not wanted). */
  skipFunding?: boolean;
}

export function upgradeChains(): string[] {
  return UPGRADE_CHAINS;
}

export async function run(args: string[], opts: UpgradeOptions = {}): Promise<void> {
  const [chain, wasmPath] = args;
  if (!chain) throw new Error(`missing chain (one of: ${UPGRADE_CHAINS.join(', ')})`);
  if (!wasmPath) throw new Error('missing path to the runtime blob');

  const wsUrl = opts.ws || localWsUrl(chain);
  let wasm: Buffer;
  try {
    wasm = fs.readFileSync(wasmPath);
  } catch (err) {
    throw new Error(`cannot read ${wasmPath}: ${err instanceof Error ? err.message : err}`);
  }

  // The same secrets channel the services use: zombie-cli does not forward env vars to
  // custom processes, so the deployable profile's key is read from the file.
  const secretsPath = secretsFile();
  const secretsText = secretsPath ? fs.readFileSync(secretsPath, 'utf8') : null;
  const sudoUri = resolveSudoUri(process.env.PPN_SUDO_URI, secretsText);

  // On a fork of production the relay's sudo account sits at the existential deposit —
  // sudo by key override, unable to pay by state, so a sudo call dies in the tx pool with
  // Invalid::Payment. Top it up from a well-known dev account first; on a genesis network
  // or the deployable profile the account is already funded and this is a no-op.
  //
  // A byte-identical blob is checked BEFORE funding: the upgrade submits nothing for
  // it, so it needs no fees — and the top-up transfer is itself a transaction that
  // can fail or hang, which a no-op should never risk.
  const noOp = await alreadyInstalled(wsUrl, new Uint8Array(wasm));
  if (noOp) {
    console.log('the chain already runs exactly this code — skipping the sudo top-up');
  }
  if (!opts.skipFunding && !noOp) {
    await ensureFunds({
      provider: wsProvider(wsUrl),
      wsUrl,
      sudo: signerFromUri(sudoUri),
      log: console.log,
    });
  }

  const result = await runtimeUpgrade({
    provider: wsProvider(wsUrl),
    wsUrl,
    wasm: new Uint8Array(wasm),
    signer: signerFromUri(sudoUri).signer,
    allowSameSpec: Boolean(opts.allowSameSpec),
    log: console.log,
  });
  console.log(
    `OK ${chain}: ${result.specName} ${result.fromSpecVersion} -> ${result.toSpecVersion} (${result.strategy})`
  );
}

/**
 * Make a zombie-cli network readable by the zombienet test runner: it expects a few
 * top-level keys the spawner does not write. Used by scripts/run-tests.sh.
 */
export function zombieCompat(zombiePath?: string): void {
  if (!zombiePath) throw new Error('missing the path to zombie.json');
  const network = JSON.parse(fs.readFileSync(zombiePath, 'utf-8'));

  network.client = { providerName: 'native', configPath: '' };
  network.namespace = network.ns;
  network.tmpDir = network.local_base_dir;
  network.companions = [];
  network.nodesByName = {};

  for (const node of network.relay.nodes) {
    network.nodesByName[node.name] = {
      name: node.name,
      wsUri: node.ws_uri,
      prometheusUri: node.prometheus_uri,
    };
  }
  for (const [id, para] of Object.entries(network.parachains) as [string, any][]) {
    for (const node of para[0].collators) {
      network.nodesByName[node.name] = {
        name: node.name,
        wsUri: node.ws_uri,
        prometheusUri: node.prometheus_uri,
        parachainId: id,
        parachainSpecPath: para.chain_spec_path,
      };
    }
  }
  fs.writeFileSync(zombiePath, JSON.stringify(network, null, 4));
}
