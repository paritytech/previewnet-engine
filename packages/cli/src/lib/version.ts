// What this `ppn` is, and where it came from.
//
// Three shapes install it, and which one you are on is the half of a bug report the version
// number alone does not carry. A dist tarball has `.ppn-dist.json`: the release it was cut
// for, the commit behind it, when it was built. An npm install has the version CI stamped
// into package.json at publish. A checkout has neither — the version there is the placeholder
// the release rewrites, so the commit is the only honest answer.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { packageRoot, workspaceRoot } from '@parity/ppn-network-config';

/** How this copy got here. */
export type Install = 'dist' | 'npm' | 'checkout';

/** The subset of `ppn dist`'s manifest anything reads back. */
export interface DistManifest {
  version: string;
  builtAt?: string;
  repo?: string;
  commit?: string;
}

export interface VersionInfo {
  /** The published version. In a checkout it is the unreleased placeholder — read `commit`. */
  version: string;
  install: Install;
  /** The build's commit on a dist, HEAD in a checkout. An npm install carries none. */
  commit?: string;
  repo?: string;
  builtAt?: string;
  node: string;
  platform: string;
  packageRoot: string;
  workspace: string;
}

/**
 * The manifest `ppn dist` writes into a release tarball, or null when this is not one.
 *
 * Also the spawn stamp's source for the version a network was brought up on, so the two
 * cannot disagree about what a deployed tree is.
 */
export function distManifest(root: string): DistManifest | null {
  const file = path.join(root, '.ppn-dist.json');
  if (!fs.existsSync(file)) return null;
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return typeof m?.version === 'string' ? (m as DistManifest) : null;
  } catch {
    // A half-written manifest is not worth failing over: the caller falls back to package.json.
    return null;
  }
}

/**
 * The version `@parity/ppn` declares.
 *
 * Two layouts, because the package root is not always the package: installed, it *is*
 * @parity/ppn; in a checkout or an unpacked dist it is the private workspace root, with the
 * CLI one level in. Both are checked by name rather than by position, so neither a renamed
 * directory nor the private root's own version can be mistaken for a release.
 */
export function packageVersion(root: string): string {
  const candidates = [
    path.join(root, 'package.json'),
    path.join(root, 'packages', 'cli', 'package.json'),
  ];
  for (const file of candidates) {
    try {
      const pkg = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (pkg.name === '@parity/ppn' && typeof pkg.version === 'string') return pkg.version;
    } catch {
      // Absent or unreadable: try the other layout.
    }
  }
  return 'unknown';
}

/**
 * The bare string behind `ppn --version`.
 *
 * Registered on the program while it is being built, so it must not throw the way
 * `packageRoot()` does: a layout this cannot resolve is one where `ppn --help` still has to
 * work, which is the same reason the help's network list is deferred.
 */
export function shortVersion(): string {
  try {
    return packageVersion(packageRoot());
  } catch {
    return 'unknown';
  }
}

function head(cwd: string): string | undefined {
  try {
    const out = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

export function versionInfo(): VersionInfo {
  const root = packageRoot();
  // A dist first: it is the only shape that states its own provenance, and an unpacked
  // release inside a checkout is still a release.
  const dist = distManifest(root);
  const provenance: Pick<VersionInfo, 'install' | 'commit' | 'repo' | 'builtAt'> =
    dist ? { install: 'dist', commit: dist.commit, repo: dist.repo, builtAt: dist.builtAt }
    : fs.existsSync(path.join(root, '.git')) ? { install: 'checkout', commit: head(root) }
    : { install: 'npm' };

  return {
    version: packageVersion(root),
    ...provenance,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    packageRoot: root,
    workspace: workspaceRoot(),
  };
}

/** One line of identity, then what it is running on and against. */
export function formatVersion(info: VersionInfo): string {
  const qualifiers = [
    info.install,
    info.commit ? `commit ${info.commit}` : null,
    // The day is the useful part; the rest of an ISO timestamp is noise on one line.
    info.builtAt ? `built ${info.builtAt.slice(0, 10)}` : null,
  ].filter(Boolean);
  return [
    `ppn ${info.version} (${qualifiers.join(', ')})`,
    `node ${info.node} on ${info.platform}`,
    `package   ${info.packageRoot}`,
    `workspace ${info.workspace}`,
  ].join('\n');
}
