// Unpacking the archives some upstreams ship instead of bare binaries.
//
// `tar` and `unzip` are called as child processes rather than pulled in as libraries:
// they are already required on every machine that runs PPN, and a tarball is exactly the
// kind of thing where the system tool is more trustworthy than a dependency.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

export function extractTarGz(
  archive: string,
  dest: string,
  opts: { strip?: number; only?: string } = {}
): void {
  fs.mkdirSync(dest, { recursive: true });
  const args = ['-xzf', archive, '-C', dest];
  if (opts.strip !== undefined) args.push(`--strip-components=${opts.strip}`);
  if (opts.only) args.push(opts.only);
  execFileSync('tar', args, { stdio: 'inherit' });
}

export function extractZip(archive: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  execFileSync('unzip', ['-oq', archive, '-d', dest], { stdio: 'inherit' });
}

/** First file with this name anywhere under dir — tarballs nest under a versioned path. */
export function findFile(dir: string, name: string): string | undefined {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name === name) return path.join(entry.parentPath ?? dir, entry.name);
  }
  return undefined;
}

export function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppn-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
