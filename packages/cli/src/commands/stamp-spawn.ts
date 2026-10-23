// `ppn stamp-spawn` — write the spawn stamp for a network this process is not spawning.
//
// A stopgap, and worth naming as one. `ppn start` writes data/spawn.json as part of bringing a
// network up, but a server does not run `ppn start`: a deployment spawns zombie-cli directly,
// for historical reasons (the unit predates the CLI's start verb). So the stamp — spawn time,
// profile, mode, PPN version — was simply missing on every deployment, and the dashboard had
// nothing to show for it.
//
// This exists so the deploy overlay can write the same stamp, through the same writer, until
// `ppn start` grows a server mode that the unit can use directly. When it does, this command
// goes with the duplication it papers over. See docs/DASHBOARD.md.

import fs from 'node:fs';
import path from 'node:path';
import { currentNetworkName, readEnvFile, repoRoot, workspaceRoot } from '@parity/ppn-network-config';
import { writeSpawnStamp } from '../lib/spawn-stamp.js';

export interface StampSpawnOptions {
  /** Fork mode. Servers spawn genesis today, so the default is genesis. */
  fork?: boolean;
  /** The fork bundle's manifest.json, whose bite this records. Implies fork mode. */
  forkManifest?: string;
  /** Override the data directory; otherwise resolved the way the dashboard resolves it. */
  dataDir?: string;
}

export async function stampSpawn(args: string[], opts: StampSpawnOptions = {}): Promise<void> {
  const network = args[0] || currentNetworkName();
  const WS = workspaceRoot();
  const REPO = repoRoot();

  // The same precedence the dashboard uses to find the directory it reads the stamp back
  // from, so the two cannot disagree about where it lives: DATA_DIR from the environment
  // (what the supervisor sets), then PPN_DATA_DIR out of the ports files (what the deploy overlay
  // patches), then the workspace default.
  const ports = readEnvFile(path.join(REPO, 'config', 'ports.env'));
  const localOverride = path.join(WS, 'config', 'ports.local.env');
  if (fs.existsSync(localOverride)) {
    for (const [k, v] of Object.entries(readEnvFile(localOverride))) if (v) ports[k] = v;
  }

  const dataDir =
    opts.dataDir || process.env.DATA_DIR || ports.PPN_DATA_DIR || path.join(WS, 'data');

  const stamp = writeSpawnStamp(dataDir, {
    network,
    mode: opts.fork || opts.forkManifest ? 'fork' : 'genesis',
    // Where the bundle lives is the deployment's choice (a spawner VM fetches it to
    // /opt/ppn/fork-bundle), so it names the manifest. Without one, a fork carries the mode
    // but no bite detail.
    forkManifest: opts.forkManifest ?? null,
    repoRoot: REPO,
  });

  console.log(
    `stamped ${path.join(dataDir, 'spawn.json')}: ${stamp.network} ${stamp.mode}` +
      `, profile ${stamp.profile}${stamp.ppnVersion ? `, ppn ${stamp.ppnVersion}` : ''}`
  );
}
