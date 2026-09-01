// Stamping what a fetch actually downloaded.
//
// "Which binaries is this network running?" is a historical fact, not a lookup: a descriptor
// pinned to `latest` resolves somewhere else next week, so answering from the descriptor at
// query time silently rewrites history. `ppn fetch` therefore records, next to the binaries
// themselves, what each pin resolved to and what landed on disk — and the dashboard reads the
// stamp, never re-resolves.
//
// It covers everything the network runs, not only the chains: the shared toolchain (the
// device-uniqueness backend, zombienet, kubo, postgres) is pinned in config/versions.env
// rather than in a descriptor, and used to be stamped nowhere at all — so "which DUB is
// staging running?" had no answer short of ssh and `--version`.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export interface ProvenanceArtifact {
  name: string;
  repo: string;
  /** The descriptor's tag, `latest` included. */
  pinned: string;
  /** What the pin meant when the fetch ran. */
  resolved: string;
  sha256: string;
  /** Executables only: what the artifact says with --version. */
  version?: string;
}

export interface Provenance {
  fetchedAt: string;
  network: string;
  platform: string;
  /** Node binaries, from the descriptor's per-network pins. */
  binaries: ProvenanceArtifact[];
  runtimes: ProvenanceArtifact[];
  /**
   * Everything else a network runs that is not a chain: the device-uniqueness backend,
   * zombienet, kubo, postgres. Pinned in config/versions.env rather than the descriptor,
   * because they have no per-network dimension — but "which DUB is this?" is still a
   * question about the running network, and until this existed nothing on the box answered it.
   */
  toolchain: ProvenanceArtifact[];
}

export const PROVENANCE_FILE = 'provenance.json';

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** `--version`'s first line, or undefined for anything that does not answer. */
function probeVersion(file: string): string | undefined {
  const r = spawnSync(file, ['--version'], { encoding: 'utf-8', timeout: 10_000 });
  const line = (r.stdout || '').split('\n')[0].trim();
  return r.status === 0 && line ? line : undefined;
}

export interface StampInput {
  kind: 'binary' | 'runtime' | 'toolchain';
  name: string;
  repo: string;
  pinned: string;
  resolved: string;
  /** Where the artifact landed. Skipped (with a note) if the download failed. */
  file: string;
  /**
   * A hash already known to be this file's, from `reusable()` deciding the download could be
   * skipped. Hashing 3.7 GB is not free, and without this a skipped artifact would be hashed
   * twice per fetch: once to prove it was current, once to stamp it.
   */
  sha256?: string;
}

/**
 * Write bin/provenance.json. Artifacts whose file is absent are dropped rather than guessed
 * at — a failed download has no provenance, and the fetch already reported it loudly.
 */
/** The stamp a previous fetch left in this directory, or null if there is none to read. */
export function readProvenance(binDir: string): Provenance | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(binDir, PROVENANCE_FILE), 'utf-8')) as Provenance;
  } catch {
    return null;
  }
}

/**
 * Whether a file on disk is already the artifact a fetch is about to download — and if so, its
 * hash, so the caller can stamp it without hashing again.
 *
 * The previous stamp is the cache index. It is the right one because it records what a pin
 * *resolved to*, not what it said: a `latest` pin that has moved since the last fetch resolves
 * to a different tag, so the recorded tag no longer matches and the artifact is re-downloaded.
 * Nothing else in the workspace knows that — the file on disk looks identical either way.
 *
 * Three ways this correctly declines to skip:
 *   - no previous stamp, or the artifact is not in it   -> never fetched here
 *   - the resolved tag differs                          -> the pin moved
 *   - the file is missing, or hashes differently        -> deleted, truncated, or edited
 *
 * Names are unique across the three groups in practice (polkadot, asset_hub.wasm, dub), so the
 * lookup is by name alone; a collision would only ever cause an unnecessary download.
 */
export function reusable(
  prev: Provenance | null,
  name: string,
  resolved: string,
  file: string
): string | null {
  if (!prev) return null;
  const known = [...(prev.binaries ?? []), ...(prev.runtimes ?? []), ...(prev.toolchain ?? [])]
    .find((a) => a.name === name);
  if (!known || known.resolved !== resolved) return null;
  if (!fs.existsSync(file)) return null;
  const actual = sha256(file);
  return actual === known.sha256 ? actual : null;
}

export function writeProvenance(binDir: string, network: string, inputs: StampInput[]): void {
  const entry = (i: StampInput): ProvenanceArtifact | null => {
    if (!fs.existsSync(i.file)) return null;
    const base: ProvenanceArtifact = {
      name: i.name,
      repo: i.repo,
      pinned: i.pinned,
      resolved: i.resolved,
      sha256: i.sha256 ?? sha256(i.file),
    };
    // Runtimes are WASM and answer nothing; the two executable kinds are asked.
    if (i.kind !== 'runtime') {
      const v = probeVersion(i.file);
      if (v) base.version = v;
    }
    return base;
  };

  const provenance: Provenance = {
    fetchedAt: new Date().toISOString(),
    network,
    platform: `${process.platform}-${process.arch}`,
    binaries: inputs.filter((i) => i.kind === 'binary').map(entry).filter((e): e is ProvenanceArtifact => e !== null),
    runtimes: inputs.filter((i) => i.kind === 'runtime').map(entry).filter((e): e is ProvenanceArtifact => e !== null),
    toolchain: inputs.filter((i) => i.kind === 'toolchain').map(entry).filter((e): e is ProvenanceArtifact => e !== null),
  };
  fs.writeFileSync(
    path.join(binDir, PROVENANCE_FILE),
    JSON.stringify(provenance, null, 2) + '\n'
  );
}
