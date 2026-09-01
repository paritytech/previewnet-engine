// `ppn service dashboard` — the network's own status server.
//
// One zombienet custom_process, like eth-rpc: spawns with the network, dies with it, and
// renders what the network *is* from the same resolution the CLI runs on. Serves the UI,
// the contract (/api/network), the provenance stamps written at fetch/spawn time, health
// probes, log streams, and — locally — a path→port proxy so the laptop gets the same
// URL shapes the servers get from nginx. See docs/DASHBOARD.md.
//
// Never in the production data path: on servers nginx routes the chains directly and only
// `/` is proxied here, so this process crashing costs the dashboard, not the network.

import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { dashboardModel } from '@parity/ppn-network-config';
import type { ServiceContext } from './service-context.js';
import { PROVENANCE_FILE } from '../lib/provenance.js';

const LOG_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

interface HealthEntry {
  id: string;
  status: 'ok' | 'down';
  /** Chains: best block number. */
  block?: number;
  /**
   * Chains: the runtime the node is executing *now*. Deliberately not read from provenance —
   * that records the WASM `ppn fetch` downloaded, and a live upgrade (which this dashboard can
   * perform) moves specVersion without touching an artifact on disk. After one, the two
   * disagree, and the running one is the one an operator needs.
   */
  runtime?: { specName: string; specVersion: number; implVersion: number; transactionVersion: number };
  /** Chains: the collator/validator binary's own version, from system_version. */
  clientVersion?: string;
  error?: string;
  checkedAt: string;
}

/**
 * One JSON-RPC batch per chain per tick: head, runtime version, client version. A batch
 * rather than three requests because it is one round trip and one connection, and the probe
 * runs against every chain every five seconds.
 *
 * Responses are matched by id, not by position — the spec allows a server to answer a batch
 * in any order, and reading by index would silently attribute one method's result to another.
 */
async function rpcBatch(port: number): Promise<Map<number, unknown>> {
  const calls = [
    { jsonrpc: '2.0', id: 1, method: 'chain_getHeader', params: [] },
    { jsonrpc: '2.0', id: 2, method: 'state_getRuntimeVersion', params: [] },
    { jsonrpc: '2.0', id: 3, method: 'system_version', params: [] },
  ];
  const res = await fetch(`http://127.0.0.1:${port}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(calls),
    signal: AbortSignal.timeout(3000),
  });
  const body = (await res.json()) as { id: number; result?: unknown }[] | { id: number; result?: unknown };
  const rows = Array.isArray(body) ? body : [body];
  return new Map(rows.filter((r) => r && r.result !== undefined).map((r) => [r.id, r.result]));
}

export async function dashboard(ctx: ServiceContext): Promise<void> {
  // Environment first: the test harness points fixtures at ephemeral ports, and a server
  // can repoint without editing ports.env — the same precedence loadContext gives BIN.
  const port = Number(process.env.DASHBOARD_PORT || ctx.ports.DASHBOARD_PORT || 8090);
  // Env first, then the ports file — the same precedence dataDir uses below, and for the
  // same reason: the dashboard runs as a zombienet custom process, which is handed no
  // environment. Setting PPN_PUBLIC_URL for the supervisor does not reach here, so a server
  // that only did that advertised ws://127.0.0.1:8090 for every chain — an address no
  // browser on the far side of a reverse proxy can use.
  const baseUrl =
    process.env.PPN_PUBLIC_URL || ctx.ports.PPN_PUBLIC_URL || `http://127.0.0.1:${port}`;
  const proxyEnabled = (process.env.DASHBOARD_PROXY ?? '1') !== '0';
  // Per-mode (data/ vs data-fork/), resolved by `ppn start` and carried through
  // ports.local.env because zombienet strips the environment of custom processes.
  const dataDir =
    process.env.DATA_DIR ||
    ctx.ports.PPN_DATA_DIR ||
    path.join(path.dirname(ctx.sharedBinDir), 'data');

  // Actions are sudo: a runtime upgrade is a root call. What may run one is decided by who
  // can reach this socket, not by a profile — PPN_PROFILE does not survive zombienet, which
  // strips the environment of custom processes, so reading it here resolves to the local
  // default on a deployed host and opens sudo to the network.
  //
  // Bound to loopback: open, because the only callers are on this machine. Bound anywhere
  // else: a bearer token the operator set, or the dashboard is read-only.
  const host = process.env.DASHBOARD_HOST || ctx.ports.DASHBOARD_HOST || '127.0.0.1';
  const loopbackOnly = host === '127.0.0.1' || host === '::1' || host === 'localhost';
  const actionsToken = process.env.DASHBOARD_ACTIONS_TOKEN || null;
  const actionsEnabled = loopbackOnly || actionsToken !== null;
  const authorized = (req: http.IncomingMessage): boolean => {
    if (!actionsEnabled) return false;
    if (!actionsToken) return loopbackOnly;
    return req.headers.authorization === `Bearer ${actionsToken}`;
  };

  // One action at a time: two concurrent sudo upgrades interleave nonces and both die.
  let running: { id: number; chain: string; lines: string[]; done: boolean; error?: string } | null = null;
  let nextActionId = 1;

  const model = dashboardModel(ctx.net, baseUrl);

  // Chain specs, for light clients (smoldot) — what the old landing page published. Which
  // basename exists depends on the mode (genesis writes <chainId>.json, a fork the source's
  // name), so the candidates are resolved against the data directory and a chain with no
  // spec on disk simply gets no link.
  // Names come from the descriptor where it knows them, but a fork's parachain specs land
  // under the *source's* chain id (asset-hub-paseo.json, not asset-hub.json), which no
  // descriptor field predicts. So the candidates are a hint and the disk is the authority:
  // any <name>.json in the data directory that is not a plain spec or zombienet's own file
  // is offered, matched to a chain by longest shared prefix.
  const specFile = (name: string) => path.join(dataDir, `${name}.json`);
  const onDisk = (() => {
    try {
      return fs.readdirSync(dataDir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.slice(0, -'.json'.length))
        .filter((n) => LOG_NAME.test(n) && !n.endsWith('-plain') && n !== 'zombie' && n !== 'spawn');
    } catch {
      return [];
    }
  })();
  const specFor = (c: { id: string; specCandidates?: string[] }): string | undefined => {
    for (const n of c.specCandidates ?? []) if (onDisk.includes(n)) return n;
    // A relay entry is relay-<validator>; its spec is the relay's, already in candidates.
    if (c.id.startsWith('relay-')) return undefined;
    // Otherwise take the on-disk name that contains the chain key (asset-hub-paseo for
    // asset-hub); the longest match wins so `people` cannot claim `paseo-people`'s file
    // ahead of a more specific candidate.
    const matches = onDisk.filter((n) => n === c.id || n.includes(c.id));
    return matches.sort((a, b) => b.length - a.length)[0];
  };
  for (const c of model.chains) {
    const found = specFor(c);
    if (found && fs.existsSync(specFile(found))) c.links.spec = `${baseUrl}/chainspecs/${found}.json`;
  }
  const routes = new Map<string, { port: number; ws: boolean; keepPrefix: boolean }>();
  for (const e of [...model.chains, ...model.services]) {
    routes.set(e.path, { port: e.port, ws: e.protocol === 'ws', keepPrefix: Boolean(e.keepPrefix) });
  }

  // ---- health: one probe loop, results cached; browsers read the cache ----
  const health = new Map<string, HealthEntry>();
  const probe = async () => {
    await Promise.all(
      [...model.chains, ...model.services].map(async (e) => {
        if (!e.health) return;
        const at = new Date().toISOString();
        try {
          if (e.health.kind === 'rpc') {
            // Substrate answers JSON-RPC over plain HTTP on the same port as WS.
            const got = await rpcBatch(e.port);
            const head = got.get(1) as { number: string } | undefined;
            // The head is what decides up-or-down; the other two are extra detail, and a
            // node that answers a header but not (say) system_version is still healthy.
            if (!head) throw new Error('no header');
            const rt = got.get(2) as
              | { specName: string; specVersion: number; implVersion: number; transactionVersion: number }
              | undefined;
            const client = got.get(3);
            health.set(e.id, {
              id: e.id,
              status: 'ok',
              block: parseInt(head.number, 16),
              runtime: rt && {
                specName: rt.specName,
                specVersion: rt.specVersion,
                implVersion: rt.implVersion,
                transactionVersion: rt.transactionVersion,
              },
              clientVersion: typeof client === 'string' ? client : undefined,
              checkedAt: at,
            });
          } else {
            const res = await fetch(`http://127.0.0.1:${e.port}${e.health.path}`, {
              signal: AbortSignal.timeout(3000),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            health.set(e.id, { id: e.id, status: 'ok', checkedAt: at });
          }
        } catch (err) {
          health.set(e.id, {
            id: e.id, status: 'down', error: (err as Error).message, checkedAt: at,
          });
        }
      })
    );
  };
  probe();
  const probeTimer = setInterval(probe, 5000);
  probeTimer.unref();

  // ---- logs: whitelist is what exists on disk as DATA_DIR/<name>/<name>.log ----
  // Names come from zombienet (alice-paseo-validator, eth-rpc, …) and differ between genesis
  // and fork spawns, so the truth is the disk, not a prediction. A name must match the
  // pattern AND the scan — no caller-supplied path ever reaches the filesystem.
  const logIds = (): string[] => {
    try {
      return fs.readdirSync(dataDir).filter(
        (n) => LOG_NAME.test(n) && fs.existsSync(path.join(dataDir, n, `${n}.log`))
      ).sort();
    } catch {
      return [];
    }
  };

  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify(body, null, 2));
  };

  const readJson = (file: string): unknown | null => {
    try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
  };

  const uiDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'web');
  const MIME: Record<string, string> = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png',
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', baseUrl);
    const p = url.pathname;

    // ---- API ----
    if (p === '/api/network') return json(res, 200, model);
    if (p === '/api/health') return json(res, 200, [...health.values()]);
    if (p === '/api/provenance') {
      return json(res, 200, {
        provenance: readJson(path.join(ctx.binDir, PROVENANCE_FILE)),
        spawn: readJson(path.join(dataDir, 'spawn.json')),
      });
    }
    if (p === '/api/addresses') {
      // The descriptor is the per-network address book (devnet pins its deployment there);
      // previewnet's addresses ship as a release artifact instead, built with its genesis.
      return json(res, 200, {
        dotns: ctx.net.dotns?.addresses ?? readJson(path.join(ctx.binDir, 'dotns-addresses.json')),
        dub: model.services.find((s) => s.id === 'dub')?.links ?? {},
      });
    }
    // The same files nginx publishes from ${DATA_DIR} on a server — served here so a laptop
    // (which has no nginx) offers the same light-client downloads. Whitelisted by name
    // against what the model resolved: no caller-supplied path reaches the filesystem.
    if (p.startsWith('/chainspecs/')) {
      const name = p.slice('/chainspecs/'.length).replace(/\.json$/, '');
      const allowed = model.chains.some((c) => c.links.spec?.endsWith(`/${name}.json`));
      if (!allowed || !LOG_NAME.test(name)) return json(res, 404, { error: 'no such chain spec' });
      res.writeHead(200, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'content-disposition': `attachment; filename="${name}.json"`,
      });
      fs.createReadStream(specFile(name)).pipe(res);
      return;
    }

    if (p === '/api/logs') {
      // Grouped for reading, not a-z: the chains you watch, the services that stay up, and
      // the one-off scripts that ran once at spawn. Chain log names come from zombienet
      // (alice-paseo-validator, asset-hub-collator1); a long-running service is anything on
      // the model's services list plus its workers; the rest ran and exited.
      const ids = logIds();
      // Genesis names: alice-paseo-validator, asset-hub-collator1. Fork names: the bare
      // well-known validators (alice…ferdie) and Collator-<paraId> (see docs/FORK.md).
      const WELL_KNOWN = new Set(['alice', 'bob', 'charlie', 'dave', 'eve', 'ferdie']);
      const chainish = (n: string) =>
        /-validator\d*$|-collator\d*$|^Collator-/.test(n) || WELL_KNOWN.has(n) || n === 'doppelganger';
      const serviceIds = new Set([
        ...model.services.map((s) => s.id),
        'dashboard', 'ipfs-swarm', 'dub-api', 'dub-postgres',
        'device-attestation-chain-writer', 'registration-queue', 'invite-tickets-pool',
      ]);
      return json(res, 200, {
        chains: ids.filter(chainish),
        services: ids.filter((n) => !chainish(n) && serviceIds.has(n)),
        scripts: ids.filter((n) => !chainish(n) && !serviceIds.has(n)),
      });
    }
    if (p.startsWith('/api/logs/')) {
      const name = p.slice('/api/logs/'.length);
      if (!LOG_NAME.test(name) || !logIds().includes(name)) return json(res, 404, { error: 'no such log' });
      return streamLog(res, path.join(dataDir, name, `${name}.log`));
    }

    // ---- actions (gated; see docs/DASHBOARD.md) ----
    if (p === '/api/actions') {
      return json(res, 200, {
        enabled: actionsEnabled,
        running: running && !running.done ? { id: running.id, chain: running.chain } : null,
      });
    }
    if (p === '/api/actions/upgrade' && req.method === 'POST') {
      if (!authorized(req)) return json(res, actionsEnabled ? 401 : 403, { error: 'actions are not enabled here' });
      if (running && !running.done) return json(res, 409, { error: `action ${running.id} still running` });
      const chain = url.searchParams.get('chain') || '';
      if (!/^[a-z0-9-]+$/.test(chain)) return json(res, 400, { error: 'bad chain' });
      const limit = 16 * 1024 * 1024;

      // A local path instead of an upload: the build artifact is usually already on this
      // machine (a runtime repo's target/), and round-tripping it through the browser is
      // pointless. Server-side file access is exactly what the actions gate guards — on the
      // local profile this is the user's own disk, on a server it needs the operator token.
      const wasmFrom = url.searchParams.get('path');
      if (wasmFrom) {
        const resolved = path.resolve(wasmFrom);
        if (!resolved.endsWith('.wasm')) return json(res, 400, { error: 'path must name a .wasm file' });
        let stat;
        try { stat = fs.statSync(resolved); } catch { return json(res, 404, { error: `no file at ${resolved}` }); }
        if (!stat.isFile() || stat.size === 0 || stat.size > limit) {
          return json(res, 400, { error: `not a usable runtime (size ${stat.size}, cap ${limit})` });
        }
        const action = { id: nextActionId++, chain, lines: [] as string[], done: false as boolean, error: undefined as string | undefined };
        running = action;
        json(res, 202, { id: action.id, events: `/api/actions/${action.id}/events` });
        (async () => {
          try {
            const { run: upgrade } = await import('./upgrade.js');
            const orig = console.log;
            console.log = (...a: unknown[]) => { action.lines.push(a.join(' ')); orig(...a); };
            action.lines.push(`using ${resolved} (${stat.size} bytes)`);
            try { await upgrade([chain, resolved], {}); } finally { console.log = orig; }
          } catch (err) {
            action.error = (err as Error).message;
            action.lines.push(`ERROR: ${action.error}`);
          } finally {
            action.done = true;
          }
        })();
        return;
      }

      // Body: the raw WASM. Same cap the spawner uses for runtime uploads.
      const parts: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > limit) { req.destroy(); return; }
        parts.push(c);
      });
      req.on('end', async () => {
        if (size === 0 || size > limit) return json(res, 400, { error: 'expected a WASM body up to 16 MB' });
        const wasmPath = path.join(fs.mkdtempSync(path.join(dataDir, '.upgrade-')), 'runtime.wasm');
        fs.writeFileSync(wasmPath, Buffer.concat(parts));
        const action = { id: nextActionId++, chain, lines: [] as string[], done: false as boolean, error: undefined as string | undefined };
        running = action;
        json(res, 202, { id: action.id, events: `/api/actions/${action.id}/events` });
        try {
          const { run: upgrade } = await import('./upgrade.js');
          const orig = console.log;
          console.log = (...a: unknown[]) => { action.lines.push(a.join(' ')); orig(...a); };
          try { await upgrade([chain, wasmPath], {}); } finally { console.log = orig; }
        } catch (err) {
          action.error = (err as Error).message;
          action.lines.push(`ERROR: ${action.error}`);
        } finally {
          action.done = true;
          fs.rmSync(path.dirname(wasmPath), { recursive: true, force: true });
        }
      });
      return;
    }
    {
      const m = p.match(/^\/api\/actions\/(\d+)\/events$/);
      if (m) {
        if (!running || running.id !== Number(m[1])) return json(res, 404, { error: 'no such action' });
        const action = running;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' });
        let sent = 0;
        const tick = setInterval(() => {
          while (sent < action.lines.length) res.write(`data: ${action.lines[sent++]}\n\n`);
          if (action.done) {
            res.write(`event: done\ndata: ${action.error ? 'error' : 'ok'}\n\n`);
            clearInterval(tick);
            res.end();
          }
        }, 300);
        res.on('close', () => clearInterval(tick));
        return;
      }
    }

    // ---- local proxy (HTTP side; WS upgrades handled below) ----
    if (proxyEnabled) {
      const route = matchRoute(routes, p);
      if (route) {
        // The upstream sees itself as 127.0.0.1:<port>; forwarding the browser's Host
        // (127.0.0.1:8090) trips substrate's RPC host whitelist and kubo's gateway check —
        // "Provided Host header is not whitelisted". Same rewrite nginx does per location.
        const upstream = http.request(
          { host: '127.0.0.1', port: route.target.port,
            path: route.target.keepPrefix ? route.matched + route.rest : (route.rest || '/'),
            method: req.method,
            headers: { ...req.headers, host: `127.0.0.1:${route.target.port}` } },
          (up) => { res.writeHead(up.statusCode || 502, up.headers); up.pipe(res); }
        );
        upstream.on('error', () => json(res, 502, { error: 'upstream unreachable' }));
        req.pipe(upstream);
        return;
      }
    }

    // ---- static UI ----
    const rel = p === '/' ? '/index.html' : p;
    const file = path.join(uiDir, path.normalize(rel).replace(/^([.][.][/\\])+/, ''));
    if (file.startsWith(uiDir) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
      return;
    }
    json(res, 404, { error: 'not found' });
  });

  // WebSocket proxying: a raw TCP splice after replaying the upgrade request. The dashboard
  // does not speak the WS protocol — it only moves bytes, which is all a proxy needs.
  server.on('upgrade', (req, socket, head) => {
    if (!proxyEnabled) return socket.destroy();
    const route = matchRoute(routes, new URL(req.url || '/', baseUrl).pathname);
    if (!route || !route.target.ws) return socket.destroy();
    const upstream = net.connect(route.target.port, '127.0.0.1', () => {
      const headers = Object.entries({ ...req.headers, host: `127.0.0.1:${route.target.port}` })
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
        .join('\r\n');
      upstream.write(`${req.method} ${route.target.keepPrefix ? route.matched + route.rest : (route.rest || '/')} HTTP/1.1\r\n${headers}\r\n\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  server.listen(port, host, () => {
    console.log(`dashboard: ${baseUrl} (bound ${host})`);
    console.log(`  api:    ${baseUrl}/api/network`);
    console.log(`  proxy:  ${proxyEnabled ? [...routes.keys()].join(' ') : 'off'}`);
    console.log(`  actions: ${actionsEnabled ? (actionsToken ? 'bearer token' : 'open on loopback') : 'off'}`);
  });

  // zombienet owns the lifecycle; hold the process open until it kills us.
  await new Promise(() => {});
}

/** Longest-prefix route match; returns the remainder to forward upstream. */
function matchRoute(
  routes: Map<string, { port: number; ws: boolean; keepPrefix: boolean }>,
  pathname: string
): { target: { port: number; ws: boolean; keepPrefix: boolean }; matched: string; rest: string } | null {
  let best: string | null = null;
  for (const key of routes.keys()) {
    if ((pathname === key || pathname.startsWith(key + '/')) && (!best || key.length > best.length)) {
      best = key;
    }
  }
  return best ? { target: routes.get(best)!, matched: best, rest: pathname.slice(best.length) } : null;
}

/** SSE-tail a log file: replay the last 64 KB, then follow appended bytes. */
function streamLog(res: http.ServerResponse, file: string): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'access-control-allow-origin': '*',
  });
  // Node services log with ANSI colour even into files; raw escapes render as `[2m` noise
  // in a browser. Severity is re-derived client-side from the words, so nothing is lost.
  const ANSI = /\x1b?\[[0-9;]*m/g;
  const send = (chunk: string) => {
    for (const line of chunk.split('\n')) {
      const clean = line.replace(ANSI, '');
      if (clean.length) res.write(`data: ${clean}\n\n`);
    }
  };

  let position = 0;
  try {
    const size = fs.statSync(file).size;
    position = Math.max(0, size - 64 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - position);
    fs.readSync(fd, buf, 0, buf.length, position);
    fs.closeSync(fd);
    position = size;
    send(buf.toString('utf-8'));
  } catch {
    /* file may rotate away mid-read; the watcher below recovers */
  }

  const poll = setInterval(() => {
    try {
      const size = fs.statSync(file).size;
      if (size < position) position = 0; // rotated
      if (size > position) {
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(size - position);
        fs.readSync(fd, buf, 0, buf.length, position);
        fs.closeSync(fd);
        position = size;
        send(buf.toString('utf-8'));
      }
    } catch {
      /* transient stat/read failure — retry next tick */
    }
  }, 1000);
  res.on('close', () => clearInterval(poll));
}
