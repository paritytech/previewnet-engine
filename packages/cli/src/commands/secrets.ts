// `ppn secrets check`: a secrets file against config/secrets.env.example. `ppn start` runs the
// same check, so a deployment can run it before stopping anything.

import { readEnvFile } from '@parity/ppn-network-config';
import { checkSecrets } from '../lib/secrets-example.js';
import { secretsFile } from '../lib/secrets.js';

/** Throws, naming every problem, when the secrets file does not match the example. */
export function assertSecrets(file: string): void {
  const problems = checkSecrets(readEnvFile(file, {}));
  if (problems.length > 0) {
    throw new Error(`${file} does not match config/secrets.env.example:\n` + problems.map((p) => `         ${p}`).join('\n'));
  }
}

export function check(fileArg: string | undefined): void {
  const file = fileArg ?? secretsFile();
  if (!file) throw new Error('no secrets file: pass one, or name it with PPN_SECRETS_FILE');
  assertSecrets(file);
  console.log(`✓ ${file}`);
}
