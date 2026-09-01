// Two roots, because PPN is two things.
//
// **The package** is what ships: compiled code, the launchers zombienet execs by path, and the
// neutral defaults (config/ports.env, the zombienet config templates). Read-only.
//
// **The workspace** is what a run owns: the network descriptors it may run, the downloaded
// binaries, chain state, fork bundles, generated config. Writable, and per-user.
//
// They were the same directory for as long as PPN could only be a git checkout, which is why
// `repoRoot()` conflated them. Splitting them is what lets the tool run from node_modules —
// and it puts the descriptors on the workspace side, so a published package carries no
// deployment detail (endpoints, hostnames) at all.
//
// In a checkout both resolve to the repo root, so nothing changes for anyone working in one.
//
// Never count `..` from import.meta.dirname to find either. That count differs between src/
// under tsx and dist/ after a build, and again between packages nested at different depths;
// this session shipped two bugs that way — a fork config pointing at `packages/bin/polkadot`,
// and a `generate` writing to `packages/bin/`, invisible locally because make passes the path.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Ships inside the package, so its presence identifies the package root. Just ports.env: it is
 * this library's own default and travels with it, while the shell launchers travel with the
 * CLI. Requiring both would make the library unable to find its own configuration when
 * installed on its own.
 */
const PACKAGE_MARKERS = [path.join('config', 'ports.env')];

/** Identifies a workspace: the networks a run is allowed to spawn. */
const WORKSPACE_MARKER = 'networks';

function searchUp(from: string, has: (dir: string) => boolean): string | null {
  let dir = path.resolve(from);
  for (let i = 0; i < 8; i++) {
    if (has(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const isPackageRoot = (dir: string) =>
  PACKAGE_MARKERS.every((m) => fs.existsSync(path.join(dir, m)));

/**
 * Where the shipped, read-only half lives.
 *
 * Searched from several starting points, because this module and the data are not always in
 * the same package. In a checkout they are: walking up from here finds the repo root. Once
 * published they are not — the launchers and the defaults ship in @parity/ppn, while this code
 * ships in @parity/ppn-network-config, so walking up from here only ever reaches
 * node_modules. The entry point is the reliable anchor: it lives inside the package that
 * carries the data.
 */
export function packageRoot(from?: string): string {
  const candidates = [
    from,
    process.env.PPN_PACKAGE_ROOT,
    import.meta.dirname,
    // The running CLI, which is inside the package that ships scripts/ and config/.
    process.argv[1] ? path.dirname(process.argv[1]) : undefined,
    process.cwd(),
  ].filter((c): c is string => Boolean(c));

  for (const start of candidates) {
    const found = searchUp(start, isPackageRoot);
    if (found) return found;
  }
  throw new Error(
    'PPN package root not found — no directory above ' +
      candidates.join(', ') +
      ` holds ${PACKAGE_MARKERS.join(' + ')}.\n` +
      '       Set PPN_PACKAGE_ROOT if the package layout is unusual.'
  );
}

/**
 * The per-user home an install falls back to, for a `ppn` that is on the PATH rather than in a
 * checkout. Honours XDG when it is set, since that is where a Linux user expects a tool's data.
 */
export function defaultHome(): string {
  const xdg = process.env.XDG_DATA_HOME;
  return xdg ? path.join(xdg, 'ppn') : path.join(os.homedir(), '.ppn');
}

/**
 * Where this run's state and network definitions live:
 *
 *   1. `$PPN_HOME`, when set — the explicit answer, and the one CI and the servers use.
 *   2. the nearest directory above the working directory that has `networks/` — which makes a
 *      git checkout behave exactly as it always has.
 *   3. the per-user home (`~/.ppn`, or $XDG_DATA_HOME/ppn) — where an installed `ppn` keeps
 *      everything it owns, so one copy of the ~540 MB of binaries serves every network the
 *      user runs, and nothing is written into node_modules or into whatever directory the
 *      command happened to be typed in.
 *
 * A checkout reached through the entry point (rather than the cwd) still counts as a
 * workspace — zombienet's custom processes run from the spawn's temp directory, not the repo.
 * An installed package never does: anything under node_modules is read-only by nature and
 * replaced wholesale by the next install. Descriptors are read from it (`networksDirs`);
 * state is never written to it.
 */
export function workspaceRoot(cwd: string = process.cwd()): string {
  const home = process.env.PPN_HOME;
  if (home) return path.resolve(home);
  const found = searchUp(cwd, (dir) => fs.existsSync(path.join(dir, WORKSPACE_MARKER)));
  if (found) return found;
  // A checkout is a workspace even when the working directory is elsewhere — zombienet gives
  // its custom processes a cwd in the spawn's temp tree, and before this fallback existed they
  // found the repo through the entry point. An *installed* package is not: it lives under
  // node_modules, is replaced wholesale by the next `npm install -g`, and must never absorb
  // 540 MB of binaries and a chain database. The path says which of the two this is.
  const pkg = packageRoot();
  if (!pkg.split(path.sep).includes('node_modules') && fs.existsSync(path.join(pkg, WORKSPACE_MARKER))) {
    return pkg;
  }
  return defaultHome();
}

/**
 * The repo root, for code that predates the split. Same as the package root: in a checkout
 * that is also the workspace. New code should say which half it means.
 */
export function repoRoot(from?: string): string {
  return packageRoot(from);
}

/** Where the descriptor for `name` lives: the workspace first, then whatever shipped. */
export function networksDirs(): string[] {
  const dirs = [path.join(workspaceRoot(), 'networks'), path.join(packageRoot(), 'networks')];
  return [...new Set(dirs)].filter((d) => fs.existsSync(d));
}
