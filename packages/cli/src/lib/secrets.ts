import fs from 'node:fs';
import { readEnvFile } from '@parity/ppn-network-config';

/**
 * Deployment secrets, from the file named by PPN_SECRETS_FILE.
 *
 * The engine ships no default path on purpose. A default is a guess about somebody else's
 * host, and a wrong guess is indistinguishable from "there are no secrets" — which resolves
 * to the local profile and the well-known dev keys, so a deployed server runs Alice as sudo
 * and nothing says so.
 *
 * Unset means local. Set-but-missing is fatal: that is a deployment that believes it
 * configured secrets, and it is exactly the case a silent fallback gets wrong.
 */
export function secretsFile(): string | null {
  const file = process.env.PPN_SECRETS_FILE;
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

/** secretsFile(), merged into process.env without overwriting what is already set. */
export function loadSecrets(): string | null {
  const file = secretsFile();
  if (!file) return null;
  for (const [k, v] of Object.entries(readEnvFile(file))) process.env[k] ??= v;
  return file;
}
