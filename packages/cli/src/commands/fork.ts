// `ppn fork <command>` — the bite/fork tooling.
//
// All the logic lives in TypeScript under ./../fork/ and is unit-tested; this
// file only parses arguments and prints. The descriptor queries a bite also needs
// (chains, spec-sources, network fields) are in bin/ppn.mjs instead, because those
// need no compiled code and `make bite` should not have to build first to read them.
//
//   ppn fork manifest <baseUrl> <outFile>
//   ppn fork overrides <outDir> <baseUrl>
//   ppn fork head-env <workDir>
//   ppn fork toml <bundleDir> <outFile>
//   ppn fork products <assetHubRpc> <bulletinRpc> <resolverAddr>
//   ppn fork wait <bundleDir> [timeoutSeconds]    block until all chains finalize
//   ppn fork verify <bundleDir> [sampleSeconds]   is the fork working?
//
// Environment: ENABLE_HOP  toml: --enable-hop on the bulletin collator (default true)

import fs from 'node:fs';
import path from 'node:path';
import { PARACHAINS, CHAINS, NETWORK, endpointOf } from '../fork/chains.js';
import { PORTS, RELAY_BASE_PORT, repoRoot,
  workspaceRoot} from '@parity/ppn-network-config';
import { writeManifest, headEnvLines } from '../fork/manifest.js';
import { relayOverrides, paraOverrides } from '../fork/overrides.js';
import { generateForkToml, type ForkManifest } from '@parity/ppn-network-config';
import { scanProducts } from '../fork/products.js';
import {
  targetsFromManifest,
  waitForChains,
  checkChains,
  checkDistinctChains,
  checkDiverged,
} from '../fork/verify.js';

// Roots come from repoRoot()/workspaceRoot(), never from counting directory levels.
const REPO = repoRoot();
/** Mutable state — binaries, chain data, bundles — lives in the workspace, not the package. */
const WS = workspaceRoot();

const usage = (msg: string): never => {
  console.error(`${msg}\n\nsee the header of lib/commands/fork.mjs for usage`);
  process.exit(1);
};
const need = <T>(value: T | undefined, what: string): T => value ?? usage(`missing ${what}`);

const readManifest = (bundleDir?: string): ForkManifest =>
  JSON.parse(fs.readFileSync(`${need(bundleDir, 'bundleDir')}/manifest.json`, 'utf8'));

export async function run(args: string[]): Promise<void> {
  const [command, ...rest] = args;

  // Ports come from the same table the fork TOML is generated from, so a chain can never
  // be probed on a port nothing was told to listen on.
  const bundleTargets = (manifest: ForkManifest) =>
    targetsFromManifest(manifest, (k: string) =>
      k === 'relay' ? RELAY_BASE_PORT : PORTS[k as keyof typeof PORTS]
    );

  switch (command) {
    case 'manifest': {
      const [baseUrl, outFile] = rest;
      return writeManifest(need(baseUrl, 'baseUrl'), need(outFile, 'outFile'), new Date().toISOString());
    }

    case 'overrides': {
      const [outDir, baseUrl] = rest;
      need(outDir, 'outDir');
      need(baseUrl, 'baseUrl');
      // Runtimes `ppn bite --upgrade` staged, keyed by chain. Passed as JSON rather than
      // read off disk so this subcommand stays a pure function of its arguments.
      const flag = rest.indexOf('--upgrades');
      const seeded: Record<string, { codeHash: string; checkVersion: boolean }> =
        flag === -1 ? {} : JSON.parse(need(rest[flag + 1], '--upgrades'));
      fs.mkdirSync(outDir, { recursive: true });
      const relay = CHAINS.find((c) => c.key === 'relay')!;
      // A shared relay carries parachains this network does not run, and its inherited core
      // layout and messaging state are then wrong for us — see fork/shared-relay.ts.
      const shared = NETWORK.bite.sharedRelay
        ? {
            paras: PARACHAINS.map((p) => ({ key: p.key, paraId: p.paraId })),
            validators: NETWORK.relay.validators,
          }
        : undefined;
      await relayOverrides(
        endpointOf(relay, NETWORK, baseUrl),
        `${outDir}/rc_overrides.json`,
        shared,
        seeded.relay
      );
      for (const p of PARACHAINS) {
        await paraOverrides(
          p.paraId,
          endpointOf(p, NETWORK, baseUrl),
          `${outDir}/${p.paraId}_overrides.json`,
          NETWORK.bite.sharedRelay,
          seeded[p.key],
          p.aura
        );
      }
      return;
    }

    case 'head-env': {
      return console.log(headEnvLines(need(rest[0], 'workDir')).join('\n'));
    }

    case 'toml': {
      const [bundleDir, outFile] = rest;
      need(bundleDir, 'bundleDir');
      need(outFile, 'outFile');
      // Binaries follow the bundle's network, not the environment: previewnet's live in
      // bin/, every other network's in bin/<network>.
      const bundleNet = readManifest(bundleDir).network || 'previewnet';
      const toml = generateForkToml({
        repoDir: WS,
        // The launchers ship in the package; the workspace has no scripts/ unless it *is* a
        // checkout. In a checkout REPO === WS, so this changes nothing there.
        scriptsDir: path.join(REPO, 'scripts'),
        bundleDir: path.resolve(bundleDir),
        enableHop: (process.env.ENABLE_HOP || 'true').toLowerCase() !== 'false',
        binDir: bundleNet === 'previewnet' ? undefined : path.join(WS, 'bin', bundleNet),
      });
      fs.writeFileSync(outFile, toml);
      const rpcPorts = [...toml.matchAll(/^rpc_port = (\d+)$/gm)].map((m) => m[1]);
      const processes = [...toml.matchAll(/^\[\[custom_processes\]\]\nname = "([^"]+)"/gm)].map((m) => m[1]);
      console.log(`wrote ${outFile}`);
      console.log(`  nodes: ${rpcPorts.length} on ports ${rpcPorts.join(', ')}`);
      console.log(`  custom_processes: ${processes.join(', ')}`);
      return;
    }

    // Print the CIDs a forked network needs in order to serve its DotNS products.
    // Resolved from the fork's own state, so it works with no access to the source.
    case 'products': {
      const [assetHubRpc, bulletinRpc, resolverAddr] = rest;
      const r = await scanProducts(
        need(assetHubRpc, 'assetHubRpc'),
        need(bulletinRpc, 'bulletinRpc'),
        need(resolverAddr, 'resolverAddr')
      );
      if (r.resolver.toLowerCase() !== resolverAddr.toLowerCase()) {
        console.error(`  ${resolverAddr} held nothing; using ${r.resolver} found on chain`);
      }
      console.error(
        `  ${r.records} contenthash records, ${r.bulletinEntries} bulletin entries -> ` +
          `${r.cids.length} products (${r.unmatched} records no longer retained)`
      );
      // A live contract with no records is nearly always a stale address: each release
      // redeploys DotNS, and the previous resolver stays on chain holding nothing.
      if (r.records === 0) {
        console.error('  No contenthash records on any contract — this network has no registered products.');
      }
      if (r.cids.length) console.log(r.cids.join('\n'));
      return;
    }

    // Block until every chain in the bundle is producing *and* finalizing. Collators
    // restore their DB snapshots long after the relay, and parachain finality only starts
    // once the relay finalizes a block carrying their candidates.
    case 'wait': {
      const [bundleDir, timeoutSeconds] = rest;
      const targets = bundleTargets(readManifest(bundleDir));
      const timeoutMs = Number(timeoutSeconds || 600) * 1000;
      console.log(`waiting up to ${timeoutMs / 1000}s for ${targets.length} chains to finalize`);
      const r = await waitForChains(targets, timeoutMs, { requireFinality: true });
      const secs = Math.round(r.waitedMs / 1000);
      if (!r.ok) {
        console.error(`not finalizing after ${secs}s: ${r.missing.join(', ')}`);
        process.exit(1);
      }
      return console.log(`all ${targets.length} chains producing and finalizing after ${secs}s`);
    }

    // Assert a running fork is actually working: every chain continuing from its bite
    // block, producing and finalizing, on its own chain, and diverged from its source.
    case 'verify': {
      const [bundleDir, sampleSeconds] = rest;
      const manifest = readManifest(bundleDir);
      const targets = bundleTargets(manifest);
      const waitMs = Number(sampleSeconds || 30) * 1000;

      console.log(`checking ${targets.length} chains over ${waitMs / 1000}s`);
      const results = await checkChains(targets, waitMs);
      for (const r of results) {
        console.log(
          `  ${r.ok ? 'ok  ' : 'FAIL'} ${r.key.padEnd(13)} best=${r.best} finalized=${r.finalized} ` +
            `(+${r.produced} blocks)${r.problems.length ? '  ' + r.problems.join('; ') : ''}`
        );
      }

      const distinct = await checkDistinctChains(targets);
      console.log(
        `  ${distinct.ok ? 'ok  ' : 'FAIL'} chains are distinct` +
          (distinct.problems.length ? '  ' + distinct.problems.join('; ') : '')
      );

      const relay = targets.find((t) => t.key === 'relay')!;
      // Manifests record each chain's resolved endpoint; older bundles predate that.
      const sourceRelay = manifest.chains.relay.endpoint || `${manifest.source}/relay/alice`;
      const diverged = await checkDiverged(relay.url, sourceRelay, relay.biteBlock);
      console.log(`  ${diverged.ok ? 'ok  ' : 'FAIL'} diverged from source — ${diverged.detail}`);

      const failed = results.filter((r) => !r.ok).length + (distinct.ok ? 0 : 1) + (diverged.ok ? 0 : 1);
      if (failed) {
        console.error(`\n${failed} check(s) failed`);
        process.exit(1);
      }
      return console.log('\nfork is healthy');
    }

    default:
      usage(`fork: unknown command "${command ?? ''}"`);
  }
}
