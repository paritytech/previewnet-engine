// Stamping what a spawn actually was.
//
// The sibling of lib/provenance.ts, split by lifetime: provenance records what `ppn fetch`
// downloaded and lives in bin/, this records how one network was brought up and lives beside
// the chain state it describes. Both exist because they are historical facts, not lookups —
// `mode` and `bite` cannot be re-derived once a bundle moves on, so they are written at the
// moment they are true.
//
// One writer, called by every path that spawns. There used to be exactly one such path
// (`ppn start`), so this logic sat inside it — and a server, which spawns zombie-cli straight
// spawning zombie-cli itself, wrote no stamp at all. Its dashboard then had no spawn time, no profile
// and no PPN version to show. Adding a second caller to the same writer is the point: a field
// added here cannot reach one path and silently miss the other.

import fs from 'node:fs';
import path from 'node:path';

export const SPAWN_FILE = 'spawn.json';

export interface Bite {
  at: string;
  source: string;
  blocks: Record<string, number>;
}

export interface SpawnStamp {
  spawnedAt: string;
  network: string;
  mode: 'genesis' | 'fork';
  /** Fork mode only: which live network this continues from, and at which blocks. */
  bite: Bite | null;
  profile: string;
  /** Absent in a checkout, which has no packed release to name. */
  ppnVersion?: string;
}

export interface StampSpawnInput {
  network: string;
  mode: 'genesis' | 'fork';
  /**
   * The fork bundle's manifest, when this is a fork. Passed in rather than resolved here:
   * where a bundle lives is `ppn start`'s decision, and this module stays free of it.
   */
  forkManifest?: string | null;
  /** Repo/release root, for the packed version. A checkout simply has no manifest there. */
  repoRoot: string;
}

/** The bite fields a manifest contributes, or null when there is no usable manifest. */
function biteFrom(manifest: string | null | undefined): Bite | null {
  if (!manifest || !fs.existsSync(manifest)) return null;
  try {
    const m = JSON.parse(fs.readFileSync(manifest, 'utf-8'));
    return { at: m.bittenAt, source: m.source, blocks: m.biteBlocks };
  } catch {
    // A half-written manifest is not worth failing a spawn over; the mode still says `fork`.
    return null;
  }
}

function packedVersion(repoRoot: string): string | undefined {
  const dist = path.join(repoRoot, '.ppn-dist.json');
  if (!fs.existsSync(dist)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(dist, 'utf-8')).version;
  } catch {
    return undefined;
  }
}

/**
 * Write `<dataDir>/spawn.json` and return what was written.
 *
 * The directory is created if absent: on a server the stamp is written just before the
 * service starts, which may be the first thing to touch a freshly wiped DATA_DIR.
 */
export function writeSpawnStamp(dataDir: string, input: StampSpawnInput): SpawnStamp {
  const version = packedVersion(input.repoRoot);
  const stamp: SpawnStamp = {
    spawnedAt: new Date().toISOString(),
    network: input.network,
    mode: input.mode,
    bite: input.mode === 'fork' ? biteFrom(input.forkManifest) : null,
    profile: process.env.PPN_PROFILE || 'local',
    // Set only when there is one: an own `ppnVersion: undefined` would survive in the
    // returned object but not in the JSON, so the return would not equal what was written.
    ...(version ? { ppnVersion: version } : {}),
  };
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, SPAWN_FILE), JSON.stringify(stamp, null, 2) + '\n');
  return stamp;
}

/** The stamp of the last spawn on `dataDir`, or null when there is none worth trusting. */
export function readSpawnStamp(dataDir: string): SpawnStamp | null {
  const file = path.join(dataDir, SPAWN_FILE);
  if (!fs.existsSync(file)) return null;
  try {
    const stamp = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return stamp && typeof stamp === 'object' && typeof stamp.mode === 'string' ? (stamp as SpawnStamp) : null;
  } catch {
    return null;
  }
}
