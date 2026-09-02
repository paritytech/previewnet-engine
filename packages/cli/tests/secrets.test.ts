import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The case that matters and had no coverage: a zombienet custom process is handed no
// environment, so PPN_SECRETS_FILE has to be resolvable from config/ports.env. An
// environment-only lookup is empty on exactly the deployed servers that need the keys.
describe('secrets file resolution', () => {
  let tmp: string;
  let secrets: string;
  let saved: string | undefined;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ppn-secrets-test-'));
    secrets = path.join(tmp, 'secrets.env');
    fs.writeFileSync(secrets, 'PPN_PROFILE=deployable\nPPN_SUDO_SS58=5Test\n');
    saved = process.env.PPN_SECRETS_FILE;
  });

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (saved === undefined) delete process.env.PPN_SECRETS_FILE;
    else process.env.PPN_SECRETS_FILE = saved;
  });

  it('takes the environment when it carries the path', async () => {
    const { secretsFile } = await import('../src/lib/secrets.js');
    process.env.PPN_SECRETS_FILE = secrets;
    assert.equal(secretsFile(), secrets);
  });

  it('is null when nothing names a file, which is the local profile', async () => {
    const { secretsFile } = await import('../src/lib/secrets.js');
    delete process.env.PPN_SECRETS_FILE;
    // The repo's own config/ports.env ships PPN_SECRETS_FILE empty, so a checkout resolves
    // to nothing and stays local. If this ever fails, a deployment path was committed.
    assert.equal(secretsFile(), null);
  });

  // The regression this file exists for: with no environment at all, the path still has to
  // resolve, because that is every service zombienet spawns on a deployed server.
  it('finds it in ports.local.env when the environment is empty', async () => {
    const { secretsFile } = await import('../src/lib/secrets.js');
    const ws = path.join(tmp, 'ws');
    fs.mkdirSync(path.join(ws, 'config'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'networks'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'config', 'ports.local.env'), `PPN_SECRETS_FILE=${secrets}\n`);
    delete process.env.PPN_SECRETS_FILE;
    const savedHome = process.env.PPN_HOME;
    process.env.PPN_HOME = ws;
    try {
      assert.equal(secretsFile(), secrets);
    } finally {
      if (savedHome === undefined) delete process.env.PPN_HOME;
      else process.env.PPN_HOME = savedHome;
    }
  });

  it('refuses a path that is set but missing, rather than falling back to dev keys', async () => {
    const { secretsFile } = await import('../src/lib/secrets.js');
    process.env.PPN_SECRETS_FILE = path.join(tmp, 'not-there.env');
    assert.throws(() => secretsFile(), /does not exist/);
  });

  it('loads the file into the environment without overwriting what is set', async () => {
    const { loadSecrets } = await import('../src/lib/secrets.js');
    process.env.PPN_SECRETS_FILE = secrets;
    process.env.PPN_SUDO_SS58 = '5Existing';
    try {
      assert.equal(loadSecrets(), secrets);
      assert.equal(process.env.PPN_PROFILE, 'deployable');
      assert.equal(process.env.PPN_SUDO_SS58, '5Existing');
    } finally {
      delete process.env.PPN_PROFILE;
      delete process.env.PPN_SUDO_SS58;
    }
  });
});
