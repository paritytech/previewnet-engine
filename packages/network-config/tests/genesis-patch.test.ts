// Tests for lib/genesis-patch.mjs — run with: node --test lib/
//
// These were shell steps in .github/workflows/zombienet-tests.yml, each writing a
// synthetic spec to /tmp, running the patcher and asserting with jq. They are the same
// cases, now runnable locally in under a second.

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyProfile, patchSpec, readSpec, enableEccRfc163, injectDotns,
  setNetworkSuffix, createPeopleCollections } from '../src/genesis-patch.js';

const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
const BOB = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';
const HARDHAT = '5Ha8yXQgvWcvpFya1BmjtJX386xUskafNTzU4Zmb6B3UwYd9';
const SUDO = '5C4hrfjw9DjXZTzV3MwzrrAr9P1MJhSrvWGWqi1eSuyUpnhM';
const FAUCET = '5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy';

const ENV_KEYS = ['PPN_SUDO_SS58', 'PPN_FAUCET_SS58', 'PPN_ALLOWANCE_SS58'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function spec({ balances = [[ALICE, 1000]], extra = {} } = {}) {
  return {
    genesis: {
      runtimeGenesis: {
        patch: {
          configuration: { config: { executor_params: [] } },
          balances: { balances },
          sudo: { key: ALICE },
          ...extra,
        },
      },
    },
  };
}
const balancesOf = (s) => s.genesis.runtimeGenesis.patch.balances.balances;
const addrs = (s) => balancesOf(s).map(([a]) => a);

describe('local profile', () => {
  it('funds the seven EVM dev accounts on Asset Hub', () => {
    const s = spec();
    assert.equal(applyProfile(s, { profile: 'local', fundEvmDev: true }), true);
    assert.equal(balancesOf(s).length, 8, '1 existing + 7 EVM');
    assert.ok(addrs(s).includes(HARDHAT), 'Hardhat deployer must be funded');
  });

  it('leaves sudo.key alone', () => {
    const s = spec();
    applyProfile(s, { profile: 'local', fundEvmDev: true });
    assert.equal(s.genesis.runtimeGenesis.patch.sudo.key, ALICE);
  });

  // Every other chain: re-serializing a large spec can alter formatting in ways
  // polkadot-omni-node build-spec trips on, so an unchanged spec is never rewritten.
  it('reports no change without the Asset Hub flag, so the file is not rewritten', () => {
    const s = spec();
    assert.equal(applyProfile(s, { profile: 'local' }), false);
    assert.equal(balancesOf(s).length, 1);
  });

  it('is idempotent', () => {
    const s = spec();
    applyProfile(s, { profile: 'local', fundEvmDev: true });
    assert.equal(applyProfile(s, { profile: 'local', fundEvmDev: true }), false);
    assert.equal(balancesOf(s).length, 8);
  });
});

describe('deployable profile', () => {
  it('strips dev accounts, funds sudo + faucet, sets sudo.key', () => {
    process.env.PPN_SUDO_SS58 = SUDO;
    process.env.PPN_FAUCET_SS58 = FAUCET;
    delete process.env.PPN_ALLOWANCE_SS58;
    const s = spec({ balances: [[ALICE, 1000], [BOB, 1000]] });
    assert.equal(applyProfile(s, { profile: 'deployable' }), true);
    assert.deepEqual(addrs(s), [SUDO, FAUCET]);
    assert.equal(s.genesis.runtimeGenesis.patch.sudo.key, SUDO);
  });

  it('funds the attestation allowance account when one is configured', () => {
    process.env.PPN_SUDO_SS58 = SUDO;
    process.env.PPN_FAUCET_SS58 = FAUCET;
    process.env.PPN_ALLOWANCE_SS58 = '5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y';
    const s = spec();
    applyProfile(s, { profile: 'deployable' });
    const entry = balancesOf(s).find(([a]) => a === process.env.PPN_ALLOWANCE_SS58);
    assert.ok(entry && entry[1] > 0, 'allowance account must be funded');
  });

  // A storage provider has to cover its stake at genesis, so its account survives the
  // strip even when it is a well-known dev one. Without this the genesis build panics.
  it('keeps a storage provider even when it is a dev account', () => {
    process.env.PPN_SUDO_SS58 = SUDO;
    process.env.PPN_FAUCET_SS58 = FAUCET;
    const s = spec({
      balances: [[ALICE, 1000], [BOB, 1000]],
      extra: { storageProvider: { providers: [{ account: ALICE }] } },
    });
    applyProfile(s, { profile: 'deployable' });
    assert.ok(addrs(s).includes(ALICE), 'provider account was stripped');
    assert.ok(!addrs(s).includes(BOB), 'non-provider dev account should be stripped');
  });

  // A chain with no sudo pallet (the relay) must not gain one: injecting a sudo section
  // fails runtime genesis validation.
  it('does not invent a sudo section', () => {
    process.env.PPN_SUDO_SS58 = SUDO;
    process.env.PPN_FAUCET_SS58 = FAUCET;
    const s = spec();
    delete s.genesis.runtimeGenesis.patch.sudo;
    applyProfile(s, { profile: 'deployable' });
    assert.equal(s.genesis.runtimeGenesis.patch.sudo, undefined);
  });

  it('hard-fails on missing env vars', () => {
    delete process.env.PPN_SUDO_SS58;
    delete process.env.PPN_FAUCET_SS58;
    assert.throws(() => applyProfile(spec(), { profile: 'deployable' }), /requires PPN_SUDO_SS58/);
  });
});

describe('unknown profile', () => {
  it('is rejected', () => {
    assert.throws(() => applyProfile(spec(), { profile: 'staging' }), /unknown profile "staging"/);
  });
});

describe('u128 genesis values', () => {
  // A plain JSON round-trip loses precision above Number.MAX_SAFE_INTEGER and re-emits
  // values >= 1e21 in exponent notation, which the nodes reject as "invalid number".
  it('survives read → patch → write', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppn-genesis-'));
    const file = path.join(dir, 'spec.json');
    // 25 digits, as on the web3-storage spec. Written as raw JSON text, on a field the
    // patcher does not touch, so this measures the round-trip and nothing else.
    const big = '10000000000000000000000000';
    fs.writeFileSync(
      file,
      `{"genesis":{"runtimeGenesis":{"patch":{
        "balances":{"balances":[["${ALICE}",1000]]},
        "sudo":{"key":"${ALICE}"},
        "storageProvider":{"providers":[{"account":"${BOB}","stake":${big}}]}
      }}}}`
    );
    process.env.PPN_SUDO_SS58 = SUDO;
    process.env.PPN_FAUCET_SS58 = FAUCET;
    patchSpec(file, [(s) => applyProfile(s, { profile: 'deployable' })]);

    const text = fs.readFileSync(file, 'utf8');
    const exponent = text.match(/\d+e\+?\d+/i);
    assert.ok(text.includes(big), `25-digit value corrupted: ${exponent ?? '(value missing)'}`);
    assert.equal(exponent, null, 'no value may be written in exponent notation');
    fs.rmSync(dir, { recursive: true });
  });
});

describe('per-chain genesis edits', () => {
  it('enables EccRfc163 exactly once, however often it runs', () => {
    const s = spec();
    enableEccRfc163(s);
    enableEccRfc163(s);
    const params = s.genesis.runtimeGenesis.patch.configuration.config.executor_params;
    assert.deepEqual(params, [{ EnabledHostFunction: 'EccRfc163' }]);
  });

  it('puts only the accounts under revive, dropping artifact metadata like tld', () => {
    const s = spec();
    // dotns release artifacts carry a `tld` sibling; pallet-revive's GenesisConfig does
    // not know it, and an unknown field fails chain-spec construction.
    injectDotns(s, { tld: 'test', accounts: [{ address: '0xabc' }] });
    assert.deepEqual(s.genesis.runtimeGenesis.patch.revive, { accounts: [{ address: '0xabc' }] });
  });

  it('refuses a genesis stamped for a different TLD', () => {
    assert.throws(
      () => injectDotns(spec(), { tld: 'dot', accounts: [] }, 'test'),
      /for TLD \.dot, this network wants \.test/
    );
  });

  it('accepts a pre-tld artifact when a TLD is expected', () => {
    const s = spec();
    injectDotns(s, { accounts: [] }, 'test');
    assert.deepEqual(s.genesis.runtimeGenesis.patch.revive, { accounts: [] });
  });

  it('refuses a spec with no genesis patch rather than writing a broken one', () => {
    assert.throws(() => enableEccRfc163({}), /configuration\.config/);
    assert.throws(() => injectDotns({}, { accounts: [] }), /runtimeGenesis\.patch/);
  });

  it('refuses a file with no accounts — the wrong artifact entirely', () => {
    assert.throws(() => injectDotns(spec(), {}), /no accounts/);
  });
});

describe('createPeopleCollections', () => {
  const sections = (s) => s.genesis.runtimeGenesis.patch;

  it('flips both flags the preset ships as false', () => {
    const s = spec({ extra: { people: { createCollection: false }, peopleLite: { createCollection: false } } });
    assert.deepEqual(createPeopleCollections(s), ['people', 'peopleLite']);
    assert.equal(sections(s).people.createCollection, true);
    assert.equal(sections(s).peopleLite.createCollection, true);
  });

  it('keeps the other fields a preset ships alongside the flag', () => {
    const s = spec({ extra: { peopleLite: { subscriptionWhitelist: ['1500'], createCollection: false } } });
    createPeopleCollections(s);
    assert.deepEqual(sections(s).peopleLite, { subscriptionWhitelist: ['1500'], createCollection: true });
  });

  it('leaves a runtime older than the flag alone', () => {
    // Creating the section there is fatal, not harmless: the runtime's RuntimeGenesisConfig
    // has no such field and chain-spec-builder rejects the whole spec.
    const s = spec();
    assert.deepEqual(createPeopleCollections(s), []);
    assert.equal('people' in sections(s), false);
    assert.equal('peopleLite' in sections(s), false);
  });

  it('reports nothing to do when the flags are already set', () => {
    const s = spec({ extra: { people: { createCollection: true }, peopleLite: { createCollection: true } } });
    assert.deepEqual(createPeopleCollections(s), []);
  });

  it('refuses a spec with no genesis patch', () => {
    assert.throws(() => createPeopleCollections({}), /runtimeGenesis\.patch/);
  });
});

describe('setNetworkSuffix', () => {
  const bytesOf = (s) => s.genesis.runtimeGenesis.patch.networkSuffix.networkSuffix;
  const withPallet = () => spec({ extra: { networkSuffix: { networkSuffix: [...Buffer.from('paseo')] } } });

  it('writes the suffix as the bytes the BoundedVec expects', () => {
    const s = withPallet();
    assert.equal(setNetworkSuffix(s, 'test'), 'set');
    assert.deepEqual(bytesOf(s), [116, 101, 115, 116]);
  });

  it('reports no change when the preset already ships the suffix we want', () => {
    const s = withPallet();
    assert.equal(setNetworkSuffix(s, 'paseo'), 'unchanged');
    assert.deepEqual(bytesOf(s), [...Buffer.from('paseo')]);
  });

  it('leaves a runtime without the pallet alone', () => {
    // Injecting a key the RuntimeGenesisConfig does not know fails genesis validation, so
    // the relay, Bulletin, Web3 Storage and any pre-#20 runtime must come back untouched.
    const s = spec();
    assert.equal(setNetworkSuffix(s, 'test'), 'absent');
    assert.equal('networkSuffix' in s.genesis.runtimeGenesis.patch, false);
  });

  it('refuses a spec with no genesis patch', () => {
    assert.throws(() => setNetworkSuffix({}, 'test'), /runtimeGenesis\.patch/);
  });
});

describe('patchSpec', () => {
  it('writes only when a mutator reports a change', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppn-genesis-'));
    const file = path.join(dir, 'spec.json');
    const original = JSON.stringify(spec(), null, 4); // deliberately not our output format
    fs.writeFileSync(file, original);

    assert.equal(patchSpec(file, [() => false]), false);
    assert.equal(fs.readFileSync(file, 'utf8'), original, 'untouched spec must stay byte-identical');

    assert.equal(patchSpec(file, [(s) => ((s.marker = 1), true)]), true);
    assert.equal(readSpec(file).marker, 1);
    fs.rmSync(dir, { recursive: true });
  });
});
