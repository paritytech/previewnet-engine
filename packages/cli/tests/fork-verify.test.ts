// Tests for packages/cli/src/fork/verify.ts
// Run with: tsx --test packages/cli/tests/fork-verify.test.ts
//
// Driven against a real HTTP JSON-RPC server rather than a stubbed `rpc`, because the thing
// most worth pinning down here is what happens when a chain does *not* answer — and a
// hand-stubbed rejection is not the same failure a socket refusing a connection produces.
//
// The case that motivated the file: a CI run reported four collators as `best=0 finalized=0`
// with no explanation while every one of them was producing blocks. They had simply not
// finished restoring their DB snapshots when sampling began, and the missing-baseline branch
// zeroed the row and said nothing. A verifier that indicts healthy chains is worse than none.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { checkChains, waitForChains, type ChainTarget } from '../src/fork/verify.js';

/** A chain that answers `chain_getHeader` from a height we control, or refuses to answer. */
class FakeChain {
  private server: http.Server;
  best = 100;
  finalized = 90;
  /** When false every request 500s, standing in for a node that is not up yet. */
  up = true;
  url = '';

  constructor() {
    this.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (!this.up) {
          res.writeHead(500).end('not up');
          return;
        }
        const { method, params } = JSON.parse(body);
        // chain_getHeader with no params is the best header; with a hash it is that block's.
        const n =
          method === 'chain_getHeader'
            ? (params?.length ? this.finalized : this.best)
            : null;
        const result =
          method === 'chain_getFinalizedHead' ? '0xfinalized' : n === null ? null : { number: '0x' + n.toString(16) };
        res.writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
      });
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async stop(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

const target = (key: string, chain: FakeChain, biteBlock = 50): ChainTarget => ({
  key,
  url: chain.url,
  biteBlock,
});

const noSleep = async () => {};

describe('checkChains', () => {
  const relay = new FakeChain();
  const para = new FakeChain();
  before(async () => {
    await relay.start();
    await para.start();
  });
  after(async () => {
    await relay.stop();
    await para.stop();
  });

  it('passes a chain that is producing and finalizing above its bite block', async () => {
    relay.up = true;
    relay.best = 100;
    relay.finalized = 90;
    const [r] = await checkChains([target('relay', relay)], 0, async () => {
      relay.best = 110;
      relay.finalized = 99;
    });
    assert.deepEqual(r.problems, []);
    assert.equal(r.ok, true);
    assert.equal(r.best, 110);
    assert.equal(r.produced, 10);
  });

  it('flags a chain that is producing but never finalizing', async () => {
    relay.up = true;
    relay.best = 100;
    relay.finalized = 90;
    const [r] = await checkChains([target('relay', relay)], 0, async () => {
      relay.best = 110; // finality stays put — the dispute-lifetime signature
    });
    assert.equal(r.ok, false);
    assert.match(r.problems.join(';'), /not finalizing/);
  });

  it('flags a chain that restarted below its bite block', async () => {
    relay.up = true;
    relay.best = 3;
    relay.finalized = 1;
    const [r] = await checkChains([target('relay', relay, 50)], 0, async () => {
      relay.best = 5;
      relay.finalized = 2;
    });
    assert.equal(r.ok, false);
    assert.match(r.problems.join(';'), /below the bite block/);
  });

  // The regression this file exists for.
  it('explains a chain that came up mid-sample instead of reporting it as zeroed', async () => {
    para.up = false; // not yet restored when the baseline is taken
    para.best = 294128;
    para.finalized = 294119;
    const [r] = await checkChains([target('para', para, 1000)], 0, async () => {
      para.up = true; // finished restoring, and was producing all along
    });
    assert.equal(r.ok, false, 'production genuinely could not be measured');
    assert.equal(r.best, 294128, 'the height it actually reported must survive');
    assert.equal(r.finalized, 294119);
    assert.match(r.problems.join(';'), /unreachable when sampling started/);
    // Must not accuse it of the things it was not doing.
    assert.doesNotMatch(r.problems.join(';'), /below the bite block|not producing|not finalizing/);
  });

  it('reports a chain that is down for the whole sample as unreachable', async () => {
    para.up = false;
    const [r] = await checkChains([target('para', para)], 0, noSleep);
    assert.equal(r.ok, false);
    assert.equal(r.best, 0);
    assert.match(r.problems.join(';'), /unreachable/);
  });
});

describe('waitForChains', () => {
  const relay = new FakeChain();
  const para = new FakeChain();
  before(async () => {
    await relay.start();
    await para.start();
  });
  after(async () => {
    await relay.stop();
    await para.stop();
  });

  it('returns as soon as every chain answers', async () => {
    relay.up = true;
    para.up = true;
    const r = await waitForChains([target('relay', relay), target('para', para)], 60_000, {
      pollMs: 0,
      sleep: noSleep,
    });
    assert.deepEqual(r, { ok: true, waitedMs: r.waitedMs, missing: [] });
  });

  // The relay is up long before the collators have restored their snapshots; that gap is
  // exactly what this function exists to absorb.
  it('keeps waiting while a slow collator restores, then succeeds', async () => {
    relay.up = true;
    para.up = false;
    let polls = 0;
    const r = await waitForChains([target('relay', relay), target('para', para)], 60_000, {
      pollMs: 0,
      sleep: async () => {
        if (++polls === 3) para.up = true;
      },
    });
    assert.equal(r.ok, true);
    assert.equal(polls, 3, 'should have kept polling until the collator answered');
  });

  it('times out naming only the chains still missing', async () => {
    relay.up = true;
    para.up = false;
    let clock = 0;
    const r = await waitForChains([target('relay', relay), target('para', para)], 30_000, {
      pollMs: 0,
      sleep: async () => {
        clock += 10_000;
      },
      now: () => clock,
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing, ['para'], 'the healthy relay must not be blamed');
  });

  // A fork's parachains produce from the first second but finalize nothing until the relay
  // finalizes a block carrying their candidates. Treating "answers" as ready is what made a
  // 30s sample report four healthy collators as `not finalizing`.
  it('keeps waiting for a chain that produces but has not finalized yet', async () => {
    relay.up = true;
    para.up = true;
    para.finalized = 90;
    let polls = 0;
    const r = await waitForChains([target('para', para)], 60_000, {
      requireFinality: true,
      pollMs: 0,
      sleep: async () => {
        if (++polls === 4) para.finalized = 95; // relay finality reaches the para at last
      },
    });
    assert.equal(r.ok, true);
    assert.equal(polls, 4, 'returned before finality actually moved');
  });

  it('times out on a chain that produces but never finalizes', async () => {
    relay.up = true;
    para.up = true;
    para.finalized = 90;
    let clock = 0;
    const r = await waitForChains([target('para', para)], 30_000, {
      requireFinality: true,
      pollMs: 0,
      sleep: async () => {
        para.best += 10; // producing all the while, which is the bug's signature
        clock += 10_000;
      },
      now: () => clock,
    });
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing, ['para']);
  });
});
