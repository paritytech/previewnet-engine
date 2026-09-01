// `ppn dist` — package a deployable build.
//
// Why this exists: the server used to get its code with `git reset --hard origin/main`
// while taking its *artifacts* from a pinned release tag. So a deploy could pair release
// v20260812's binaries with whatever had landed on main since — two different versions of
// the same system, with nothing recording the combination. Rollback meant reverting commits.
//
// A dist tarball is the code for one release, built and pinned. Deploying is unpack +
// symlink; rolling back is repointing the symlink at the previous release.
//
// What goes in: the compiled packages, the entry point, the shell launchers zombienet
// needs, and the configuration. What stays out: `bin/` (the server runs `ppn fetch`, which
// pins its own artifacts per network), `node_modules` (installed from the committed
// lockfile, which is in here), `.git`, the tests, and the deployment side — `server/` is
// uploaded by deploy.yml straight from its checkout as a versionless overlay next to
// releases/, so the release is the engine only.

import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from '@parity/ppn-network-config';
import { execFileSync } from 'node:child_process';

const REPO = repoRoot();

/** Everything a server needs to run a network, relative to the repo root. */
const CONTENTS = [
  // The entry point and the compiled code behind it.
  'bin/ppn.mjs',
  'packages/network-config/dist',
  'packages/network-config/package.json',
  'packages/cli/dist',
  'packages/cli/package.json',
  // The launchers zombienet's custom_processes must exec, plus the shell that stayed shell.
  'scripts',
  // Configuration and the network definitions.
  'networks',
  'config',
  'zombienet-configs',
  // The verbs the server calls.
  'Makefile',
  // A prod install needs all three; the lockfile is what makes it reproducible.
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  // The dashboard UI, built by dashboard-ui into the CLI package. The dashboard resolves it
  // relative to its own compiled code (dist/commands/../../web), so a release without it
  // serves the API and answers `{"error":"not found"}` at / — which is what staging did.
  'packages/cli/web',
];

export interface DistOptions {
  /** Version stamped into the manifest. CI passes the release tag. */
  version?: string;
  /** Where to write the tarball. */
  out?: string;
}

export async function run(_args: string[], opts: DistOptions = {}): Promise<void> {
  const version = opts.version ?? 'dev';
  const outFile = path.resolve(opts.out ?? path.join(REPO, `ppn-dist-${version}.tar.gz`));

  const missing = CONTENTS.filter((p) => !fs.existsSync(path.join(REPO, p)));
  if (missing.length) {
    throw new Error(
      `not built — missing ${missing.join(', ')}\n` +
        '       Run `make build` first (the dist carries compiled output, not sources).'
    );
  }

  // A manifest so a deployed tree can say what it is. Without this, "which version is on
  // the box?" is answered by guessing from file dates.
  const manifest = {
    version,
    builtAt: new Date().toISOString(),
    repo: gitRepo(),
    commit: gitCommit(),
    node: process.version,
    contents: CONTENTS,
  };
  const manifestPath = path.join(REPO, '.ppn-dist.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  try {
    // --exclude keeps test files and stray node_modules out even when a listed directory
    // contains them; scripts/ has picked up a node_modules before now.
    execFileSync(
      'tar',
      [
        '-czf', outFile,
        '-C', REPO,
        '--exclude=node_modules',
        '--exclude=*.test.*',
        '--exclude=.DS_Store',
        '.ppn-dist.json',
        ...CONTENTS,
      ],
      { stdio: 'inherit' }
    );
  } finally {
    fs.rmSync(manifestPath, { force: true });
  }

  const mb = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1);
  console.log(`\n${path.basename(outFile)} (${mb} MB) — version ${version}, commit ${manifest.commit}`);
  console.log('  unpack it, `pnpm install --prod --frozen-lockfile`, then the deploy overlay runs server/redeploy.sh');
}

/**
 * "owner/name", so the manifest's commit resolves in the right repository. The tarball no
 * longer carries the deployment side, so whoever debugs a server sees this manifest in a tree
 * with no other hint of where the code lives — and a bare hash would be looked up in whatever
 * repo the reader had in mind.
 */
function gitRepo(): string {
  try {
    const url = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd: REPO,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
    // https://github.com/owner/name(.git), git@github.com:owner/name(.git),
    // ssh://git@github.com/owner/name(.git) — all reduce to owner/name.
    const m = url.match(/^(?:https?:\/\/[^/]+\/|(?:ssh:\/\/)?[^/@]+@[^/:]+(?::\d+)?[:/])(.+?)(?:\.git)?\/?$/);
    return m ? m[1] : url || 'unknown';
  } catch {
    return 'unknown';
  }
}

function gitCommit(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: REPO,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}
