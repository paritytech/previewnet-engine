import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';

import {
  ALICE_SS58,
  BOB_SS58,
  dubCustomProcesses,
  dubDatabaseUrl,
  dubServices,
  peopleRpcUrl,
} from '../src/dub.js';

const PORTS = { postgres: 5433, people: 10010, assetHub: 10020, gateway: 8092 };

describe('dubDatabaseUrl', () => {
  it('points at the local cluster on the configured port', () => {
    assert.equal(
      dubDatabaseUrl('identity', 5433),
      'postgres://identity@127.0.0.1:5433/identity'
    );
  });

  it('gives each service its own namespaced database', () => {
    // v0.2.0 split a bare DATABASE_URL into namespaced keys, because eight call sites had been
    // reading it while naming four different Postgres instances. v0.3.0 renamed the first of
    // them and deleted the dim-tickets one, and reads neither old name any more: an
    // environment offering only those now fails at boot instead of warning.
    const svc = dubServices(PORTS)[0];
    assert.match(svc.env.DEVICE_ATTESTATION_DATABASE_URL, /\/identity$/);
    assert.match(svc.env.INDEXER_DATABASE_URL, /\/username_indexer$/);
    assert.match(svc.env.INVITE_TICKETS_DATABASE_URL, /\/invite_tickets$/);
    assert.equal(new Set(Object.values({
      a: svc.env.DEVICE_ATTESTATION_DATABASE_URL, b: svc.env.INDEXER_DATABASE_URL,
      c: svc.env.INVITE_TICKETS_DATABASE_URL,
    })).size, 3, 'two services would share a database');
    for (const dropped of ['DATABASE_URL', 'IDENTITY_DATABASE_URL', 'DIM_TICKETS_DATABASE_URL']) {
      assert.ok(!(dropped in svc.env), `${dropped} is not read upstream any more`);
    }
  });
});

describe('peopleRpcUrl', () => {
  it('is loopback', () => {
    assert.equal(peopleRpcUrl(10010), 'ws://127.0.0.1:10010');
  });
});

describe('dubServices', () => {
  it('runs all-in-one plus the three workers', () => {
    assert.deepEqual(
      dubServices(PORTS).map((s) => s.role),
      [
        // Every HTTP surface in one process…
        'all-in-one',
        // …and the single-instance workers, which are never merged: each owns a Postgres
        // lease and a nonce lane. Four until v0.3.0 deleted dim-tickets-writer; a role the
        // binary does not know fails its role gate, so this list cannot drift silently.
        'device-attestation-chain-writer',
        'registration-queue',
        'invite-tickets-pool',
      ]
    );
  });

  // The reason this file exists. device-attestation-api and its chain writer do not
  // fail when PEOPLE_RPC_URL is unset; they default to the public Paseo
  // endpoint, which would point a signing writer at a public network. An
  // omission here is silent at runtime, so it has to be caught in a test.
  it('gives every service an explicit local PEOPLE_RPC_URL', () => {
    for (const svc of dubServices(PORTS)) {
      assert.equal(svc.env.PEOPLE_RPC_URL, 'ws://127.0.0.1:10010', `${svc.name} PEOPLE_RPC_URL`);
    }
  });

  it('never emits a non-loopback endpoint', () => {
    for (const svc of dubServices(PORTS)) {
      for (const [key, value] of Object.entries(svc.env)) {
        assert.ok(
          !/polkadot\.io|wss:\/\//.test(value),
          `${svc.name} ${key} must not reference a public endpoint: ${value}`
        );
      }
    }
  });

  it('serves the whole API on one port, off the IPFS gateway port', () => {
    const byName = Object.fromEntries(dubServices(PORTS).map((s) => [s.name, s]));
    // all-in-one carries every HTTP surface, so there is one address to bind and it is the
    // origin clients already used when a hand-written gateway sat in front.
    assert.equal(byName['dub-api'].role, 'all-in-one');
    assert.equal(byName['dub-api'].env.BIND_ADDR, '127.0.0.1:8092');
    const bound = dubServices(PORTS).filter((s) => s.env.BIND_ADDR);
    assert.equal(bound.length, 1, 'only all-in-one listens');
    // Upstream defaults both to 8080, which is IPFS_GATEWAY_PORT.
    for (const svc of dubServices(PORTS)) {
      assert.notEqual(svc.env.BIND_ADDR, '127.0.0.1:8080');
    }
  });

  it('disables metrics so the five processes do not fight over 9090', () => {
    for (const svc of dubServices(PORTS)) {
      assert.equal(svc.env.METRICS_ENABLED, 'false', `${svc.name} METRICS_ENABLED`);
    }
  });

  it('defaults the attester to the account PPN grants allowance to', () => {
    for (const svc of dubServices(PORTS)) {
      if ('ATTESTER_ACCOUNT' in svc.env) {
        assert.equal(svc.env.ATTESTER_ACCOUNT, ALICE_SS58);
      }
    }
  });

  it('applies a deployable-profile attester override', () => {
    const custom = '5FLSigC9HGRKVhB9FiEo4Y3koPsNmBmLJbpXg2mp1hXcS59Y'; // Charlie
    const writer = dubServices(PORTS, custom).find(
      (s) => s.name === 'device-attestation-chain-writer'
    )!;
    assert.equal(writer.env.ATTESTER_ACCOUNT, custom);
  });

  // The invariant that took a full network run to find. invite-tickets-pool submits a batch
  // every ~30s; sharing an account with the chain writer puts both in one nonce lane and
  // the writer loses every race, so a username the API accepted with a 202 never lands. There
  // is nothing in the logs that says so — it reads as the writer being broken.
  it('signs ticket batches as a different account than it attests with', () => {
    let checked = 0;
    for (const svc of dubServices(PORTS)) {
      if (!('INVITER_ADDRESS' in svc.env)) continue;
      checked++;
      assert.equal(svc.env.INVITER_ADDRESS, BOB_SS58, `${svc.name} inviter`);
      assert.notEqual(
        svc.env.INVITER_ADDRESS,
        svc.env.ATTESTER_ACCOUNT,
        `${svc.name} shares one nonce lane between the chain writer and the ticket writers`
      );
    }
    // Or the loop above passes by checking nothing, which is how the variable would go
    // missing without anyone noticing — and a missing INVITER_ADDRESS is a boot failure.
    assert.ok(checked > 0, 'no service declares INVITER_ADDRESS');
  });

  // The other half of that pairing lives in a shell script, so nothing but a test spanning
  // both can hold them together. If they drift, the ticket services wrap every batch in
  // Proxy.proxy(real = INVITER_ADDRESS) for a proxy People Chain has no registration for.
  it('keeps INVITER_ADDRESS in step with the SURI service.sh signs with', () => {
    const script = fs.readFileSync(
      path.join(import.meta.dirname, '..', '..', '..', 'scripts', 'dub', 'service.sh'),
      'utf-8'
    );
    const suri = script.match(/^export INVITER_SIGNER_SURI="\$\{PPN_INVITER_SURI:-(.+?)\}"/m)?.[1];
    assert.equal(suri, '//Bob', 'service.sh signs ticket batches with an unexpected key');
    const inviter = dubServices(PORTS)[0].env.INVITER_ADDRESS;
    assert.equal(inviter, BOB_SS58, 'the TOML names an account that is not //Bob');
  });

  // Private keys must not reach the generated TOML: the deployable profile
  // keeps them at runtime only (docs/PROFILES.md). service.sh injects these.
  it('emits no secret material', () => {
    for (const svc of dubServices(PORTS)) {
      assert.ok(!('CHAIN_WRITER_SIGNER_SURI' in svc.env), `${svc.name} leaks signer SURI`);
      assert.ok(!('JWT_ED25519_SECRET' in svc.env), `${svc.name} leaks JWT secret`);
      for (const value of Object.values(svc.env)) {
        assert.ok(!value.startsWith('//'), `${svc.name} embeds a SURI: ${value}`);
      }
    }
  });
});

describe('dubCustomProcesses', () => {
  const toml = dubCustomProcesses(PORTS);

  it('starts Postgres alongside the services', () => {
    assert.match(toml, /name = "dub-postgres"/);
    assert.match(toml, /command = "\{\{SCRIPTS\}\}\/dub\/postgres\.sh"/);
  });

  it('routes every service through the supervising wrapper', () => {
    const commands = [...toml.matchAll(/command = "([^"]+)"/g)].map((m) => m[1]);
    const services = commands.filter((c) => c.endsWith('service.sh'));
    assert.equal(services.length, 4);
  });

  // zombienet validates custom_process args as CLI arguments: a bare positional
  // is rejected at spawn with "doesn't match Arg::Option, Arg::Flag or Arg::Array".
  it('passes args in flag form, never bare positionals', () => {
    assert.match(toml, /args = \["--role=all-in-one", "--wait-for=127\.0\.0\.1:5433"\]/);
    for (const [, list] of toml.matchAll(/args = \[([^\]]*)\]/g)) {
      for (const arg of list.split(',')) {
        const value = arg.trim().replace(/^"|"$/g, '');
        if (!value) continue;
        assert.ok(value.startsWith('--'), `bare positional arg would be rejected: ${value}`);
      }
    }
  });

  it('emits env as zombienet name/value tables', () => {
    assert.match(toml, /\{ name = "DEVICE_ATTESTATION_DATABASE_URL", value = "[^"]+" \}/);
  });

  // The gateway process is gone: all-in-one carries the route table upstream compiles in, so
  // PPN no longer mirrors their Caddyfile by hand — which is what scripts/dub/routes.mjs
  // was, along with a standing risk of drifting from it.
  it('runs no hand-written gateway', () => {
    assert.ok(!toml.includes('identity-gateway'), 'the gateway process should be gone');
    assert.ok(!toml.includes('gateway.mjs'), 'nothing should exec the deleted gateway');
    assert.match(toml, /name = "dub-api"/);
  });
});
