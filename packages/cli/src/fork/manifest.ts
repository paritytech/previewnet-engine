export type { ForkManifest, ForkManifestChain } from '@parity/ppn-network-config';
// Record what a bite is being taken from.
//
// The daily release is built from polkadot-sdk master while production runs an older
// release, so a bundle has to record what production actually was — otherwise a restore can
// silently land on incompatible binaries.

import fs from 'node:fs';
import { CHAINS, PARACHAINS, NETWORK, endpointOf } from './chains.js';
import type { ForkManifest, ForkManifestChain } from '@parity/ppn-network-config';
import { parasHeadKey, encodeHeadData } from './codec.js';
import { constantOf, rpc, storageIndex } from './rpc.js';

interface RuntimeVersion {
  specName: string;
  specVersion: number;
}

export async function buildManifest(baseUrl: string, now: string): Promise<ForkManifest> {
  const chains: ForkManifest['chains'] = {};

  for (const c of CHAINS) {
    const url = endpointOf(c, NETWORK, baseUrl);
    const [version, header, genesis] = await Promise.all([
      rpc<RuntimeVersion>(url, 'state_getRuntimeVersion'),
      rpc<{ number: string }>(url, 'chain_getHeader'),
      rpc<string>(url, 'chain_getBlockHash', [0]),
    ]);
    chains[c.key] = {
      paraId: c.paraId,
      spec: c.spec,
      endpoint: url,
      specName: version.specName,
      specVersion: version.specVersion,
      headAtStart: parseInt(header.number, 16),
      genesis,
    };
  }

  const relayUrl = endpointOf(CHAINS.find((c) => c.key === 'relay')!, NETWORK, baseUrl);
  const nodeVersion = await rpc<string>(relayUrl, 'system_version');

  // Captured rather than assumed: zombie-bite hardcodes 600 for Paseo, but PPN builds its
  // relay with --features fast-runtime, making it 10. Doppelganger feeds this into its
  // GenesisSlot recomputation, so a wrong value breaks the fork's epochs.
  const epochDuration = constantOf(await storageIndex(relayUrl), 'Babe', 'EpochDuration');
  if (!epochDuration) throw new Error('could not read Babe::EpochDuration from the relay');

  return {
    bittenAt: now,
    source: baseUrl,
    network: NETWORK.name,
    chains,
    nodeVersion,
    epochDuration: Number(epochDuration),
    // Filled in by bite.sh once each chain has actually been bitten.
    biteBlocks: {},
  };
}

export async function writeManifest(baseUrl: string, outFile: string, now: string): Promise<void> {
  const manifest = await buildManifest(baseUrl, now);
  fs.writeFileSync(outFile, JSON.stringify(manifest, null, 2) + '\n');

  console.log(`  production node version: ${manifest.nodeVersion}`);
  console.log(`  relay Babe::EpochDuration: ${manifest.epochDuration}`);
  for (const c of CHAINS) {
    const m = manifest.chains[c.key];
    console.log(`  ${c.key.padEnd(13)} ${m.specName}/${m.specVersion} at #${m.headAtStart}`);
  }
}

/**
 * The environment variables that inject parachain heads into the relay bite.
 *
 * After each parachain is bitten it records the header it stopped at. Doppelganger scans its
 * environment for names containing the Paras::Heads storage prefix and overrides those
 * entries during the relay's state import — which is how the relay is made to agree with
 * wherever the parachains actually landed, rather than the other way round.
 */
export function headEnvLines(workDir: string): string[] {
  return PARACHAINS.map(({ paraId }) => {
    const headFile = `${workDir}/${paraId}/head.txt`;
    if (!fs.existsSync(headFile)) throw new Error(`missing head for para ${paraId}: ${headFile}`);
    const head = fs.readFileSync(headFile, 'utf-8').trim();
    if (!head) throw new Error(`empty head for para ${paraId}`);
    return `ZOMBIE_${parasHeadKey(paraId)}=${encodeHeadData(head)}`;
  });
}
