import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkSecrets, requiredSecrets, secretSections } from '../src/lib/secrets-example.js';

const local = { PPN_PROFILE: 'local', JWT_ED25519_SECRET: '0x11', TURN_SECRET: 'dA==' };
const deployable = {
  ...local,
  PPN_PROFILE: 'deployable',
  PPN_SUDO_URI: '0x22',
  PPN_SUDO_SS58: '5a',
  PPN_FAUCET_SS58: '5b',
  PPN_DUB_ATTESTER_URI: '0x33',
  PPN_ALLOWANCE_SS58: '5c',
};
const without = (o: Record<string, string>, key: string) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));

describe('config/secrets.env.example', () => {
  it('puts every key in a section', () => {
    const s = secretSections();
    assert.ok(s.always.includes('JWT_ED25519_SECRET'));
    assert.ok(s.deployable.includes('PPN_SUDO_URI'));
    assert.ok(s.optional.includes('APNS_KEY_ID'));
  });

  it('requires the deployable keys only under deployable', () => {
    assert.deepEqual(requiredSecrets('local'), ['PPN_PROFILE', 'JWT_ED25519_SECRET', 'TURN_SECRET']);
    assert.ok(requiredSecrets('deployable').includes('PPN_FAUCET_SS58'));
  });
});

describe('ppn secrets check', () => {
  it('accepts a complete file under either profile, with optional keys or without', () => {
    assert.deepEqual(checkSecrets(local), []);
    assert.deepEqual(checkSecrets(deployable), []);
    assert.deepEqual(checkSecrets({ ...local, APNS_KEY_ID: 'K' }), []);
  });

  it('names a missing or empty key', () => {
    assert.deepEqual(checkSecrets(without(deployable, 'JWT_ED25519_SECRET')), ['JWT_ED25519_SECRET: missing']);
    assert.deepEqual(checkSecrets({ ...local, TURN_SECRET: '' }), ['TURN_SECRET: missing']);
  });

  it('rejects a key the example does not list', () => {
    assert.deepEqual(checkSecrets({ ...local, TURN_SECERT: 'x' }), ['TURN_SECERT: not in config/secrets.env.example']);
  });

  it('rejects a deployable key in a local file', () => {
    assert.deepEqual(checkSecrets({ ...local, PPN_SUDO_URI: '0x22' }), ['PPN_SUDO_URI: deployable only, and this file is local']);
  });

  it('needs a profile to know what to require', () => {
    assert.match(checkSecrets(without(local, 'PPN_PROFILE'))[0], /PPN_PROFILE: must be local or deployable/);
  });
});
