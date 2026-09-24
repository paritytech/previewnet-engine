import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** The processone tap: eturnal.net publishes no macOS binary. */
export const ETURNAL_BREW_INSTALL =
  'brew tap processone/eturnal https://github.com/processone/eturnal && brew install processone/eturnal/eturnal';

/** Where `ppn fetch` unpacks the Linux release: a whole prefix tree, bundled ERTS included. */
export function eturnalDist(sharedBinDir: string): string {
  return path.join(sharedBinDir, 'eturnal');
}

/**
 * eturnalctl for this OS: the fetched tree on Linux, the Homebrew install on macOS. Null when
 * it is not there; callers say how to get it.
 */
export function eturnalCtl(sharedBinDir: string): string | null {
  if (process.platform === 'darwin') {
    // Not `brew --prefix`: zombienet starts custom processes without HOME, and brew refuses
    // to run without it.
    const prefixes = [process.env.HOMEBREW_PREFIX, '/opt/homebrew', '/usr/local'].filter(Boolean) as string[];
    const ctl = prefixes.map((p) => path.join(p, 'opt', 'eturnal', 'bin', 'eturnalctl')).find((c) => fs.existsSync(c));
    return ctl ?? null;
  }
  const ctl = path.join(eturnalDist(sharedBinDir), 'bin', 'eturnalctl');
  return fs.existsSync(ctl) ? ctl : null;
}

/** The installed Homebrew version, e.g. "1.12.3", or null. */
export function brewEturnalVersion(): string | null {
  try {
    const out = execFileSync('brew', ['list', '--versions', 'eturnal'], { encoding: 'utf-8' }).trim();
    return out.split(/\s+/)[1] ?? null;
  } catch {
    return null;
  }
}
