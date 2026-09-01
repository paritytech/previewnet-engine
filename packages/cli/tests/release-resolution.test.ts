// Tests for the `latest` fallback in packages/cli/src/lib/github.ts
// Run with: tsx --test tests/release-resolution.test.ts
//
// A repo that publishes only prereleases 404s on /releases/latest for ever, so `latest` falls
// back to the release list. "Newest in the list" is not enough to pick correctly:
// individuality-community publishes a nightly and a rolling `e2e-zombienet-snapshot` whose
// created_at match to the second, and only the nightly carries runtime WASM. Whichever the tie
// ordered first decided whether `ppn fetch` worked, and the tie moves whenever the rolling tag
// is republished — so this is a coin toss, not a preference.
//
// The fix is to prefer the newest release that carries the assets the caller came for. These
// tests pin that, and pin the fallbacks around it: no names given, or nothing carrying them.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// Stand in for api.github.com. fetchRelease builds absolute URLs, so the test overrides
// globalThis.fetch and rewrites the host rather than trying to reconfigure the module.
let server: http.Server;
let base: string;
let realFetch: typeof fetch;

/** The shape that broke: two releases tied on creation, one of them without the WASM. */
const RELEASES = [
  { tag_name: 'e2e-zombienet-snapshot', assets: [{ name: 'people-collator.tgz' }, { name: 'SHA256SUMS' }] },
  { tag_name: 'nightly-2026-08-26', assets: [{ name: 'next_people_paseo_runtime.compact.compressed.wasm' }] },
  { tag_name: 'nightly-2026-08-25', assets: [{ name: 'next_people_paseo_runtime.compact.compressed.wasm' }] },
];

let served = RELEASES;

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    // Only prereleases exist, so GitHub answers 404 here — the trigger for the fallback.
    if (url.pathname.endsWith('/releases/latest')) return json(404, { message: 'Not Found' });
    if (url.pathname.endsWith('/releases')) {
      return json(200, served.map((r) => ({
        ...r,
        assets: r.assets.map((a) => ({ ...a, url: `${base}/asset/${a.name}`, size: 1 })),
      })));
    }
    const m = /\/releases\/tags\/(.+)$/.exec(url.pathname);
    if (m) {
      const found = served.find((r) => r.tag_name === decodeURIComponent(m[1]));
      return found ? json(200, found) : json(404, { message: 'Not Found' });
    }
    json(404, { message: 'Not Found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return realFetch(u.replace('https://api.github.com', base), init);
  }) as typeof fetch;
});

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((r) => server.close(() => r()));
});

const WASM = 'next_people_paseo_runtime.compact.compressed.wasm';

describe('fetchRelease, `latest` against a prerelease-only repo', () => {
  it('skips the newest release when it does not carry the asked-for asset', async () => {
    const { fetchRelease } = await import('../src/lib/github.js');
    const rel = await fetchRelease('org/individuality-community', 'latest', 'tok', [WASM]);
    // The list's first entry is the snapshot, which has no WASM. Naming the asset is what
    // makes this deterministic rather than a tie-break.
    assert.equal(rel.tag, 'nightly-2026-08-26');
    assert.ok(rel.assets.some((a) => a.name === WASM));
  });

  it('is unaffected by the order the tie happens to come back in', async () => {
    const { fetchRelease } = await import('../src/lib/github.js');
    // Exactly the same set, snapshot-first vs nightly-first. Before this fix, these two
    // orderings gave different answers — one of them a fetch that reported the runtime missing.
    const reversed = [RELEASES[1], RELEASES[0], RELEASES[2]];
    for (const order of [RELEASES, reversed]) {
      served = order;
      const rel = await fetchRelease('org/individuality-community', 'latest', 'tok', [WASM]);
      assert.equal(rel.tag, 'nightly-2026-08-26', `order starting ${order[0].tag_name}`);
    }
    served = RELEASES;
  });

  it('requires every named asset, not just one of them', async () => {
    const { fetchRelease } = await import('../src/lib/github.js');
    // A release carrying one of two wanted runtimes is not the release we mean.
    const rel = await fetchRelease('org/individuality-community', 'latest', 'tok', [
      WASM,
      'next_asset_hub_paseo_runtime.compact.compressed.wasm',
    ]);
    // Nothing served carries both, so it falls back to the plain newest rather than guessing.
    assert.equal(rel.tag, 'e2e-zombienet-snapshot');
  });

  it('falls back to the newest when the caller names no assets', async () => {
    const { fetchRelease } = await import('../src/lib/github.js');
    // The old behaviour, kept for every caller that has nothing to say about assets.
    const rel = await fetchRelease('org/individuality-community', 'latest', 'tok');
    assert.equal(rel.tag, 'e2e-zombienet-snapshot');
  });
});
