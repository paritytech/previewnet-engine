// Reading config/*.env — shell files that Make, the scripts and this code all source.
//
// They stay shell-syntax because the Makefile and the zombienet wrappers `source` them
// directly; this reads the same files rather than keeping a second copy of their values.

import fs from 'node:fs';

/**
 * Parse a `KEY=value` shell file. Handles quoted values and `${VAR:-default}`, which
 * `config/versions.env` uses so the environment can override a pin.
 */
export function readEnvFile(path: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(path, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).replace(/^export\s+/, '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    // ${VAR:-default} and ${VAR}. An already-set environment variable wins, which is how
    // `PPN_TAG=v1 make fetch` overrides a pin.
    value = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, fallback) =>
      env[name] ?? fallback ?? ''
    );
    out[key] = value;
  }
  return out;
}
