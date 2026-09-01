// Tests for the pin-bulletin-products service.
//
// This used to drive scripts/pin-bulletin-products.sh with a stubbed `node` on PATH, which
// stopped being possible once the logic moved into the CLI — node is now the thing under
// test. The service takes the on-chain product scan as an injected dependency instead, and
// everything else here is real: a local HTTP server stands in for the source gateway and
// the fork's own gateway, and a stub `ipfs` binary records what was imported.
//
// The behaviour that matters is that this never blocks a spawn: every failure path has to
// return cleanly rather than throw.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { loadNetwork } from '@parity/ppn-network-config';
import { pinBulletinProducts, type ServiceContext } from '../src/commands/service.js';
import { loadNetwork } from '@parity/ppn-network-config';

const CID = (n: number) => `bafybeib${String(n).padStart(20, 'x')}`;

interface Harness {
  dir: string;
  bin: string;
  fork: string;
  imported: string[];
  gatewayHits: string[];
  ports: Record<string, string>;
}

let server: http.Server;
let port = 0;
let gatewayFails = false;
let carFails = false;
const gatewayHits: string[] = [];

before(async () => {
  server = http.createServer((req, res) => {
    gatewayHits.push(req.url ?? '');
    if (req.url?.includes('format=car')) {
      if (carFails) return res.writeHead(500).end();
      return res.writeHead(200).end('car-bytes');
    }
    if (req.url?.startsWith('/ipfs/')) {
      return gatewayFails ? res.writeHead(404).end() : res.writeHead(200).end('ok');
    }
    // The chain-reachability probe and the IPFS API probe.
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"jsonrpc":"2.0","id":1,"result":{}}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});

after(() => server.close());

/** A context whose every endpoint points at the local server, and a stub ipfs binary. */
function harness(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppn-pin-'));
  const bin = path.join(dir, 'bin');
  const fork = path.join(dir, 'fork-bundle');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(fork, { recursive: true });
  fs.writeFileSync(
    path.join(fork, 'manifest.json'),
    JSON.stringify({ source: `http://127.0.0.1:${port}`, network: 'previewnet', bittenAt: 'now' })
  );
  // Both sources agree, as they must in a real checkout: the descriptor states previewnet's
  // resolver and `ppn fetch` derives the same one, and the service refuses to import when they
  // differ. Reading it rather than repeating it keeps this fixture true if the address changes.
  fs.writeFileSync(
    path.join(bin, 'dotns-addresses.json'),
    JSON.stringify({ DotnsContentResolver: loadNetwork('previewnet').dotns!.resolver })
  );
  const imported = path.join(dir, 'imported.txt');
  fs.writeFileSync(
    path.join(bin, 'ipfs'),
    `#!/usr/bin/env bash\ncat > /dev/null\necho "import IPFS_PATH=\${IPFS_PATH:-UNSET}" >> ${imported}\nexit 0\n`
  );
  fs.chmodSync(path.join(bin, 'ipfs'), 0o755);

  const p = String(port);
  return {
    dir,
    bin,
    fork,
    gatewayHits,
    get imported() {
      return fs.existsSync(imported) ? fs.readFileSync(imported, 'utf-8').trim().split('\n') : [];
    },
    ports: {
      IPFS_API_PORT: p,
      IPFS_GATEWAY_PORT: p,
      ASSET_HUB_PORT: p,
      BULLETIN_PORT: p,
    },
  } as Harness;
}

function ctxFor(h: Harness): ServiceContext {
  return {
    net: loadNetwork('previewnet'),
    ports: h.ports,
    binDir: h.bin,
    sharedBinDir: h.bin,
    relayWs: `ws://127.0.0.1:${port}`,
    sudoUri: '//Alice',
  };
}

const scan = (cids: string[]) => async () => ({
  resolver: loadNetwork('previewnet').dotns!.resolver!,
  records: cids.length,
  bulletinEntries: cids.length,
  unmatched: 0,
  cids,
});

function capture(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(' '));
  return { lines, restore: () => void (console.log = original) };
}

async function run(h: Harness, deps: Parameters<typeof pinBulletinProducts>[1] = {}): Promise<string> {
  const cap = capture();
  try {
    await pinBulletinProducts(ctxFor(h), deps);
  } finally {
    cap.restore();
  }
  return cap.lines.join('\n');
}

describe('pin-bulletin-products — when it should do nothing', () => {
  it('returns cleanly outside a fork', async () => {
    const h = harness();
    fs.rmSync(path.join(h.fork, 'manifest.json'));
    process.env.FORK_DIR = h.fork;
    const out = await run(h);
    assert.match(out, /not a fork, nothing to do/);
    fs.rmSync(h.dir, { recursive: true });
  });

  it('honours PRODUCT_SYNC=0', async () => {
    const h = harness();
    process.env.FORK_DIR = h.fork;
    process.env.PRODUCT_SYNC = '0';
    const out = await run(h);
    delete process.env.PRODUCT_SYNC;
    assert.match(out, /PRODUCT_SYNC=0, skipping/);
    fs.rmSync(h.dir, { recursive: true });
  });

  // Never block a spawn: a source that cannot be resolved is a skip, not a failure.
  it('skips, rather than throwing, when nothing can be resolved', async () => {
    const h = harness();
    process.env.FORK_DIR = h.fork;
    const out = await run(h, {
      scanProducts: async () => {
        throw new Error('chain unreachable');
      },
    });
    assert.match(out, /could not resolve products, skipping/);
    fs.rmSync(h.dir, { recursive: true });
  });

  // A live contract with no records is nearly always a stale address, and saying
  // "0 products" alone reads as "this network has none", which is a different thing.
  it('says so when the network has no registered products', async () => {
    const h = harness();
    process.env.FORK_DIR = h.fork;
    const out = await run(h, { scanProducts: scan([]) });
    assert.match(out, /no registered products/);
    fs.rmSync(h.dir, { recursive: true });
  });

  // And still ends with the summary line, because a reader waiting for it cannot otherwise
  // tell "finished, nothing to do" from "died before reporting". A previewnet redeployed an
  // hour earlier genuinely has no products, and returning silently failed the fork-e2e leg
  // with "product import never reported".
  it('reports 0/0 served when there is nothing to import', async () => {
    const h = harness();
    process.env.FORK_DIR = h.fork;
    const out = await run(h, { scanProducts: scan([]) });
    assert.match(out, /imported 0, failed 0 — 0\/0 served locally/);
    assert.match(out, /\d+\/\d+ served/, 'CI waits on this shape; see zombienet-tests.yml');
    fs.rmSync(h.dir, { recursive: true });
  });
});

describe('pin-bulletin-products — importing', () => {
  it('imports every product and reports progress past 25', async () => {
    const h = harness();
    process.env.FORK_DIR = h.fork;
    gatewayHits.length = 0;
    const cids = Array.from({ length: 30 }, (_, i) => CID(i));
    const out = await run(h, { scanProducts: scan(cids) });
    assert.match(out, /30 products to import/);
    assert.match(out, /imported 25\/30/, 'progress line never fired');
    assert.match(out, /imported 30, failed 0/);
    assert.equal(h.imported.length, 30, 'the ipfs stub should have been called once per product');
    fs.rmSync(h.dir, { recursive: true });
  });

  // Importing is not the same as serving: a pin can succeed while the gateway cannot
  // return the content, which is the failure this check exists to catch.
  it('verifies against the local gateway after importing', async () => {
    const h = harness();
    process.env.FORK_DIR = h.fork;
    const out = await run(h, { scanProducts: scan([CID(1), CID(2), CID(3), CID(4)]) });
    assert.match(out, /4\/4 served locally/);
    fs.rmSync(h.dir, { recursive: true });
  });

  it('reports a gateway that cannot serve what was just pinned', async () => {
    const h = harness();
    process.env.FORK_DIR = h.fork;
    gatewayFails = true;
    const out = await run(h, { scanProducts: scan([CID(1), CID(2)]) });
    gatewayFails = false;
    assert.match(out, /0\/2 served locally/);
    fs.rmSync(h.dir, { recursive: true });
  });

  // Regression: kubo resolves its repo through IPFS_PATH and falls back to $HOME/.ipfs.
  // zombienet starts custom processes without HOME, so when the port from shell to
  // TypeScript dropped the `export IPFS_PATH` the real network imported 0 of 116 products
  // every run — and still printed "116/116 served locally", because ipfs-swarm lets the
  // gateway fetch from the source network on demand. Nothing looked wrong.
  it('gives kubo an IPFS_PATH, which it cannot derive without $HOME', async () => {
    const h = harness();
    process.env.FORK_DIR = h.fork;
    await run(h, { scanProducts: scan([CID(1), CID(2)]) });
    const seen = h.imported.map((line) => line.replace('import IPFS_PATH=', ''));
    assert.equal(seen.length, 2);
    for (const value of seen) {
      assert.notEqual(value, 'UNSET', 'ipfs was spawned without IPFS_PATH');
      assert.equal(value, path.join(h.bin, '.ipfs'));
    }
    fs.rmSync(h.dir, { recursive: true });
  });

  // The same bug was undiagnosable because stderr was discarded: kubo exits before reading
  // the CAR off stdin, so Node reports only EPIPE. Keep the reason.
  it('reports why an import failed instead of just counting it', async () => {
    const h = harness();
    process.env.FORK_DIR = h.fork;
    fs.writeFileSync(
      path.join(h.bin, 'ipfs'),
      "#!/usr/bin/env bash\necho 'Error: $HOME is not defined' >&2\nexit 1\n"
    );
    fs.chmodSync(path.join(h.bin, 'ipfs'), 0o755);
    const out = await run(h, { scanProducts: scan([CID(1), CID(2)]) });
    assert.match(out, /imported 0, failed 2/);
    assert.match(out, /first failure: .*\$HOME is not defined/);
    fs.rmSync(h.dir, { recursive: true });
  });

  it('counts a failed download as failed, without throwing', async () => {
    const h = harness();
    process.env.FORK_DIR = h.fork;
    carFails = true;
    const out = await run(h, { scanProducts: scan([CID(1), CID(2)]) });
    carFails = false;
    assert.match(out, /imported 0, failed 2/);
    fs.rmSync(h.dir, { recursive: true });
  });

  // A truncated CAR is the real-world failure this retries for: `?format=car` is chunked with
  // no Content-Length, so a gateway abandoning a traversal mid-DAG produces a clean HTTP 200
  // carrying an incomplete CAR, and only kubo notices ("unexpected EOF"). A live fork-e2e run
  // hit it on 1 of 604 products and the block involved fetched fine moments later.
  it('retries a failed import once, and counts the product as imported', async () => {
    const h = harness();
    process.env.FORK_DIR = h.fork;
    const flag = path.join(h.dir, 'first-attempt-done');
    // Fails the first time it is called, succeeds afterwards.
    fs.writeFileSync(
      path.join(h.bin, 'ipfs'),
      '#!/usr/bin/env bash\ncat > /dev/null\n' +
        `if [ ! -f ${flag} ]; then touch ${flag}; ` +
        'echo \'Error: import failed after block "bafkreiaaa": unexpected EOF\' >&2; exit 1; fi\nexit 0\n'
    );
    fs.chmodSync(path.join(h.bin, 'ipfs'), 0o755);
    const out = await run(h, { scanProducts: scan([CID(1)]) });
    assert.match(out, /imported 1, failed 0/, 'the retry did not rescue the product');
    assert.match(out, /imported on retry: .*first attempt: .*unexpected EOF/);
    assert.match(out, /1 product\(s\) imported only on the second attempt/);
    fs.rmSync(h.dir, { recursive: true });
  });

  it('re-fetches the CAR on retry rather than re-importing the same bytes', async () => {
    const h = harness();
    process.env.FORK_DIR = h.fork;
    const flag = path.join(h.dir, 'first-attempt-done');
    fs.writeFileSync(
      path.join(h.bin, 'ipfs'),
      '#!/usr/bin/env bash\ncat > /dev/null\n' +
        `if [ ! -f ${flag} ]; then touch ${flag}; echo 'Error: unexpected EOF' >&2; exit 1; fi\nexit 0\n`
    );
    fs.chmodSync(path.join(h.bin, 'ipfs'), 0o755);
    gatewayHits.length = 0;
    await run(h, { scanProducts: scan([CID(1)]) });
    // Two CAR requests for one product. Retrying the import alone would be useless: the bytes
    // are what is truncated, so a retry has to go back to the gateway.
    const cars = gatewayHits.filter((u) => u.includes('format=car'));
    assert.equal(cars.length, 2, `expected 2 CAR fetches, saw ${cars.length}`);
    fs.rmSync(h.dir, { recursive: true });
  });

  it('gives up after one retry, and still does not throw', async () => {
    const h = harness();
    process.env.FORK_DIR = h.fork;
    gatewayHits.length = 0;
    carFails = true;
    const out = await run(h, { scanProducts: scan([CID(1)]) });
    carFails = false;
    assert.match(out, /imported 0, failed 1/);
    // Two attempts, not an unbounded loop — 604 products must not become 604 retries for ever.
    assert.equal(gatewayHits.filter((u) => u.includes('format=car')).length, 2);
    fs.rmSync(h.dir, { recursive: true });
  });

  it('honours PRODUCT_SYNC_LIMIT', async () => {
    const h = harness();
    process.env.FORK_DIR = h.fork;
    process.env.PRODUCT_SYNC_LIMIT = '2';
    const out = await run(h, { scanProducts: scan([CID(1), CID(2), CID(3)]) });
    delete process.env.PRODUCT_SYNC_LIMIT;
    assert.match(out, /2 products to import/);
    fs.rmSync(h.dir, { recursive: true });
  });
});
