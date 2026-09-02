import fs from 'node:fs';
import path from 'node:path';
import { readEnvFile, repoRoot, workspaceRoot } from '@parity/ppn-network-config';

/**
 * Where the operator keeps deployment secrets, named by PPN_SECRETS_FILE.
 *
 * The engine ships no default path on purpose. A default is a guess about somebody else's
 * host, and a wrong guess is indistinguishable from "there are no secrets" — which resolves
 * to the local profile and the well-known dev keys, so a deployed server runs Alice as sudo
 * and nothing says so.
 *
 * Read from the environment *or* from config/ports.env, because zombienet hands custom
 * processes no environment at all: every service that needs the deployable keys runs as one,
 * so an environment-only lookup is unset exactly where it matters most. ports.env is the
 * channel those facts already travel on, and a deployment patches it per deploy.
 *
 * Unset means local. Set-but-missing is fatal: that is a deployment that believes it
 * configured secrets, and it is the case a silent fallback gets wrong.
 */
export function secretsFile(): string | null {
  const file = process.env.PPN_SECRETS_FILE || fromPorts();
  if (!file) return null;
  if (!fs.existsSync(file)) {
    throw new Error(
      `PPN_SECRETS_FILE points at ${file}, which does not exist.\n` +
        '       Unset it for a local run. A missing secrets file is not read as "no secrets",\n' +
        '       because that would start a deployment on the dev keys without saying so.'
    );
  }
  return file;
}

/** ports.local.env wins over ports.env, the same precedence every other fact uses. */
function fromPorts(): string | undefined {
  for (const p of [
    path.join(workspaceRoot(), 'config', 'ports.local.env'),
    path.join(repoRoot(), 'config', 'ports.env'),
  ]) {
    if (!fs.existsSync(p)) continue;
    const v = readEnvFile(p).PPN_SECRETS_FILE;
    if (v) return v;
  }
  return undefined;
}

/** secretsFile(), merged into process.env without overwriting what is already set. */
export function loadSecrets(): string | null {
  const file = secretsFile();
  if (!file) return null;
  for (const [k, v] of Object.entries(readEnvFile(file))) process.env[k] ??= v;
  return file;
}
