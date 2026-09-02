// `ppn bite` — capture a live network into a fork bundle.
//
// Produces a self-contained bundle that `make start FORK=1` can spawn: the live network's
// state, resumed under keys we control, continuing from the bite block rather than
// restarting at genesis. See docs/FORK.md.
//
// Order matters, and it is the order zombie-bite uses:
//   1. parachains are bitten first, in parallel, each recording the head it stopped at
//   2. the relay is bitten with those heads injected over Paras::Heads, so the relay is
//      made to agree with wherever the parachains actually landed
//
// Only this needs the doppelganger binaries; spawning the result uses the regular
// polkadot / polkadot-omni-node, which is why `ppn fork fetch-bundle` needs none of them.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import {
  asHttp,
  loadCurrentNetwork,
  networkChains,
  specSourceUrl,
  asWs,
  readEnvFile,
  type NetworkDef,
  type NetworkChain,
  repoRoot,
  workspaceRoot,
} from '@parity/ppn-network-config';
import { blake2AsHex } from '@polkadot/util-crypto';
import { githubToken, downloadUrl } from '../lib/github.js';
import { extractTarGz, extractZip, withTempDir } from '../lib/archive.js';
import { forkBundleName, forkBundleAsset } from '../lib/fork-bundle-name.js';

const REPO = repoRoot();
/** Mutable state — binaries, chain data, bundles — lives in the workspace, not the package. */
const WS = workspaceRoot();

// Master gates DISPUTE_CANDIDATE_LIFETIME_AFTER_FINALIZATION on this, defaulting to 10. A
// warp-synced database has no ancestry before the bite block, so the dispute scrape fails,
// DetermineUndisputedChain errors, and relay chain-selection pins the finality target to
// the bite block forever. Nothing else sets it.
//
// ZOMBIE_WARP_SKIP_PROOF asks for state without a range proof, which is the only way a chain
// whose staking lives on Asset Hub can be bitten at all. Since Kusama's staking migration,
// `Staking::ErasValidatorPrefs` is a huge flat map, and the responder bounds the *values* it
// collects (2 MiB) rather than the proof it builds: one chunk came back as a 15.6 MiB proof
// carrying 311,819 keys, the next could not be served, the cursor stopped advancing, and the
// node re-requested the identical range until every peer banned it for repeating
// (`SAME_REQUEST` is `Rep::new(i32::MIN)`). Sync froze at 37% with nothing logged. Measured
// on one binary with only this variable changed: 37% / 172 MiB against 90% / 290 MiB.
//
// Safe here in a way it would not be for a normal node: a bite forks state rather than
// adopting it — the authority set is rewritten, sudo becomes //Alice, and the chain is driven
// by dev keys — so verifying a proof of state we are about to overwrite buys little. Needs a
// doppelganger built with the flag (paritytech/polkadot-sdk `polkadot.rs`, warp's state
// handoff); older builds ignore the variable and bite as before.
const BITE_ENV = {
  ZOMBIE_DISPUTE_CANDIDATE_LIFETIME_AFTER_FINALIZATION: '1',
  ZOMBIE_WARP_SKIP_PROOF: '1',
};

const COMMON_ARGS = ['--no-hardware-benchmarks', '--state-pruning', '256', '--database', 'rocksdb'];

/**
 * Where a bite's node logs go. Beside the bundle, never inside it: the bundle is tarred whole
 * and published, and `work/` (which used to hold these) is deleted once the snapshots are
 * packed. Overridable so CI can keep one directory per retry attempt.
 */
function biteLogDir(out: string): string {
  return process.env.PPN_BITE_LOG_DIR || `${out}-logs`;
}

/**
 * Run one bite node, streaming its output straight to a file.
 *
 * Streamed rather than buffered because of how this fails in practice: a bite that hangs is
 * killed from outside — a CI timeout, someone's Ctrl-C — and a buffered `execFile` hands its
 * output to the caller only on exit, so exactly the run you most need to explain leaves
 * nothing behind. One release run sat in a hung bite for six hours and produced no log at all.
 *
 * Resolves whatever the exit code is: doppelganger deliberately ends an essential task to stop
 * the node once it has captured the state, so a non-zero exit is the normal path. Success is
 * judged by the info file the node writes, as before.
 */
function runBiteNode(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  logFile: string,
  label = path.basename(logFile, '.log')
): Promise<void> {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = fs.openSync(logFile, 'a');
  fs.writeSync(fd, `=== ${cmd} ${args.join(' ')}\n`);
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ['ignore', fd, fd] });
    const heartbeat = startHeartbeat(logFile, label);
    const done = () => {
      clearInterval(heartbeat);
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
      resolve();
    };
    child.on('close', done);
    child.on('error', (err) => {
      fs.appendFileSync(logFile, `\nspawn failed: ${err.message}\n`);
      done();
    });
  });
}

/**
 * Say where a bite has got to, every minute, and say when it stops getting anywhere.
 *
 * A bite writes everything to its own log and nothing to the terminal, so while it runs the
 * only visible difference between "syncing a large chain" and "stuck" is how long you are
 * willing to wait. A Kusama bite sat at 37% of Asset Hub's state for half an hour with peers
 * at zero and looked exactly like one making progress; the same thing in CI is an hour of
 * blank output before a timeout kills the job.
 *
 * So: the newest progress line, and how long since it last changed. The stall is the signal —
 * a percentage that has not moved in minutes is the part worth acting on.
 */
function startHeartbeat(logFile: string, label: string): NodeJS.Timeout {
  const started = Date.now();
  let lastSeen = '';
  let lastChanged = Date.now();
  const mins = (ms: number) => `${Math.round(ms / 60000)}m`;

  const timer = setInterval(() => {
    // Progress markers, whichever phase the node is in: state sync while importing state,
    // block import after it, and the idle line every substrate node emits regardless.
    const [newest = ''] = logTail(logFile, 1, /State sync|Warp sync|Syncing|Importing|Idle/);
    // Drop the log's own timestamp: it changes on every line and would make a stalled node
    // look like a moving one.
    const state = newest.replace(/\s+/g, ' ').replace(/^\S+ \S+ /, '').trim().slice(0, 100);
    if (state && state !== lastSeen) {
      lastSeen = state;
      lastChanged = Date.now();
    }
    const stalled = Date.now() - lastChanged;
    const suffix = stalled > 150_000 ? `  — unchanged for ${mins(stalled)}` : '';
    console.log(`  [${mins(Date.now() - started)}] ${label}: ${state || 'no progress yet'}${suffix}`);
  }, 60_000);

  timer.unref?.();
  return timer;
}

/** Last lines of a bite log, for an error message that says why rather than just "failed". */
function logTail(logFile: string, lines: number, filter?: RegExp): string[] {
  if (!fs.existsSync(logFile)) return [`(no log at ${logFile})`];
  const all = fs.readFileSync(logFile, 'utf-8').split('\n').filter(Boolean);
  const picked = filter ? all.filter((l) => filter.test(l)) : all;
  return (picked.length ? picked : all).slice(-lines);
}

export interface BiteOptions {
  /** Override the network's own bite.source, to bite another instance of it. */
  source?: string;
  /** `<chain key>=<path to wasm>`, authorized at import. See stageUpgrades. */
  upgrades?: string[];
  /** false authorizes a runtime whose spec_version is not bumped. Default true. */
  upgradeCheckVersion?: boolean;
}

/**
 * Stage the runtimes to authorize at import.
 *
 * A fork of Kusama or Polkadot has no sudo, so `authorize_upgrade` — a root call — can never
 * be made on it. The authorization is written into state during the bite instead, and the blob
 * travels in the bundle so the apply half (callable unsigned) can be submitted after the fork
 * spawns. See fork/validators.ts authorizedUpgradeCandidate.
 */
function stageUpgrades(
  specs: string[] | undefined,
  chains: NetworkChain[],
  out: string,
  checkVersion: boolean
): Record<string, { file: string; codeHash: string; checkVersion: boolean }> {
  const staged: Record<string, { file: string; codeHash: string; checkVersion: boolean }> = {};
  if (!specs?.length) return staged;

  const known = new Set(chains.map((c) => c.key));
  fs.mkdirSync(path.join(out, 'upgrades'), { recursive: true });

  for (const spec of specs) {
    const at = spec.indexOf('=');
    if (at < 1) throw new Error(`--upgrade wants <chain>=<wasm>, got "${spec}"`);
    const key = spec.slice(0, at);
    const src = spec.slice(at + 1);
    if (!known.has(key as never)) {
      throw new Error(`--upgrade names "${key}", which this network does not run (${[...known].join(', ')})`);
    }
    if (!fs.existsSync(src)) throw new Error(`--upgrade ${key}: no runtime at ${src}`);

    const code = fs.readFileSync(src);
    const dest = path.join('upgrades', `${key}.wasm`);
    fs.writeFileSync(path.join(out, dest), code);
    // blake2-256, the hash the runtime stores and checks the applied blob against.
    const codeHash = blake2AsHex(code, 256).slice(2);
    staged[key] = { file: dest, codeHash, checkVersion };
    console.log(`  authorize ${key}: ${path.basename(src)} → ${codeHash.slice(0, 16)}… (checkVersion=${checkVersion})`);
  }
  return staged;
}

/**
 * The doppelganger build that can execute this network's runtimes. Pinned per network
 * because too old a build panics during the state import rather than failing cleanly.
 *
 * They go in bin/<network>/dg rather than beside the node binaries on purpose: the release
 * ships its own polkadot-{execute,prepare}-worker built from the doppelganger branch, and
 * those must be the ones the bite node finds — not PPN's, which track a different
 * polkadot-sdk revision.
 */
export async function ensureDoppelganger(net: NetworkDef, binDir: string): Promise<string> {
  const dg = net.bite.doppelganger;
  if (!dg) throw new Error(`${net.name} declares no bite.doppelganger — it cannot be bitten`);

  const dir = path.join(binDir, 'dg');
  const binaries = ['doppelganger', 'doppelganger-parachain', 'polkadot-execute-worker', 'polkadot-prepare-worker'];
  if (binaries.every((b) => fs.existsSync(path.join(dir, b)))) {
    console.log(`✓ doppelganger ${dg.tag} present in ${dir}`);
    return dir;
  }

  // Asset naming follows doppelganger-wrapper's own release workflow, which differs from
  // the polkadot-sdk convention.
  const suffix = process.platform === 'darwin' ? '-macos-arm64' : '';
  fs.mkdirSync(dir, { recursive: true });
  console.log(`Fetching doppelganger ${dg.tag} from ${dg.repo}`);
  for (const bin of binaries) {
    const url = `https://github.com/${dg.repo}/releases/download/${dg.tag}/${bin}${suffix}`;
    const dest = path.join(dir, bin);
    if (!(await downloadUrl(url, dest))) {
      throw new Error(
        `doppelganger asset ${bin}${suffix} not found at ${url}\n` +
          `       Check that networks/${net.name}.json's bite.doppelganger pin is a build ` +
          'that can execute this network\'s runtimes.'
      );
    }
    fs.chmodSync(dest, 0o755);
    console.log(`  ✓ ${bin}`);
  }
  // macOS quarantines downloaded binaries; clear it so they can execute.
  if (process.platform === 'darwin') {
    try {
      execFileSync('xattr', ['-d', 'com.apple.quarantine', ...binaries.map((b) => path.join(dir, b))], {
        stdio: 'ignore',
      });
    } catch {
      /* nothing quarantined */
    }
  }
  return dir;
}

/** The source relay's current block, or null when it cannot be reached. */
async function relayHead(httpUrl: string): Promise<number | null> {
  try {
    const res = await fetch(httpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chain_getHeader', params: [] }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json()) as { result?: { number?: string } };
    return json.result?.number ? parseInt(json.result.number, 16) : null;
  } catch {
    return null;
  }
}

/** Bytes as a human-readable size, for progress lines that would otherwise be unreadable. */
function humanSize(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** Total size of a directory tree, so a copy or a pack can say what it is working through. */
function dirSize(dir: string): number {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    try {
      total += fs.statSync(path.join(e.parentPath ?? dir, e.name)).size;
    } catch {
      /* vanished mid-walk */
    }
  }
  return total;
}

/**
 * Pack a node database the way zombie-bite's generate_snap() does: data/ containing chains/.
 *
 * Reports as it goes. A snapshot of a public chain runs to gigabytes — devnet's was 4.9 GB —
 * and copying then compressing that took many silent minutes, which is indistinguishable from
 * a hang right at the end of an already long bite.
 */
function packSnapshot(dbDir: string, dest: string, label: string): void {
  // A staging directory rather than a tar flag, because the flag that rewrites the prefix
  // in place differs between GNU (--transform) and BSD (-s) tar.
  const stage = path.join(dbDir, '.stage');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(path.join(stage, 'data'), { recursive: true });

  const source = path.join(dbDir, 'chains');
  const raw = dirSize(source);
  console.log(`  ${label}: copying ${humanSize(raw)}…`);
  fs.cpSync(source, path.join(stage, 'data', 'chains'), { recursive: true });

  console.log(`  ${label}: compressing…`);
  const started = Date.now();
  // Watch the tarball grow: `tar` says nothing, and compressing gigabytes is where a bite
  // looks most like it has died.
  const ticker = setInterval(() => {
    const so_far = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    const mins = Math.round((Date.now() - started) / 60000);
    console.log(`  ${label}: ${humanSize(so_far)} written after ${mins}m`);
  }, 60_000);
  ticker.unref?.();
  try {
    execFileSync('tar', ['-czf', dest, '-C', stage, 'data'], { stdio: 'inherit' });
  } finally {
    clearInterval(ticker);
  }

  const packed = fs.statSync(dest).size;
  console.log(`  ${label}: ${humanSize(packed)} packed from ${humanSize(raw)}`);
  fs.rmSync(stage, { recursive: true, force: true });
}

/** Fetch a chain spec, then keep two copies — see the comment at the call site. */
async function collectSpec(
  chain: NetworkChain,
  net: NetworkDef,
  out: string,
  baseUrl: string,
  dgDir: string
): Promise<void> {
  const src = specSourceUrl(net, chain, baseUrl);
  const workSpec = path.join(out, 'work', 'specs', `${chain.spec}.json`);
  fs.mkdirSync(path.dirname(workSpec), { recursive: true });

  if (src.startsWith('builtin:')) {
    // Public chains carry their spec inside the node binary — but each kind carries only its
    // own, so a parachain's spec has to be built by the parachain binary. Asking the relay
    // binary for `asset-hub-kusama` fails with "Unknown chain", which is a confusing way to
    // learn that the wrong executable was picked.
    const builder = chain.paraId === null ? 'doppelganger' : 'doppelganger-parachain';
    // `export-chain-spec --output` writes the file itself. `build-spec --raw` printed to
    // stdout, which meant buffering a raw system-chain spec — hundreds of MB — through a
    // pipe with a hand-picked maxBuffer, and guessing that ceiling wrong is a truncated
    // spec rather than an error.
    execFileSync(
      path.join(dgDir, builder),
      ['export-chain-spec', '--chain', src.slice('builtin:'.length), '--raw', '--output', workSpec],
      { stdio: 'inherit' }
    );
  } else if (src.endsWith('.zip')) {
    // A full raw system-chain spec runs to hundreds of MB (Paseo Asset Hub: 279 MB, 57 MB
    // zipped), so the sources that publish one publish it zipped. The zip must contain
    // exactly one .json — anything else is ambiguous and refused.
    const archive = workSpec + '.zip';
    if (!(await downloadUrl(src, archive))) {
      throw new Error(`could not fetch the ${chain.spec} chain spec archive from ${src}`);
    }
    withTempDir((tmp) => {
      extractZip(archive, tmp);
      const jsons = fs.readdirSync(tmp, { recursive: true, encoding: 'utf-8' })
        .filter((f) => f.endsWith('.json'));
      if (jsons.length !== 1) {
        throw new Error(`${src} holds ${jsons.length} .json files — expected exactly one chain spec`);
      }
      fs.copyFileSync(path.join(tmp, jsons[0]), workSpec);
    });
    fs.rmSync(archive, { force: true });
  } else if (!(await downloadUrl(src, workSpec))) {
    throw new Error(`could not fetch the ${chain.spec} chain spec from ${src}`);
  }

  // Two copies, and only one of them ships. The as-fetched spec keeps the source's
  // bootNodes, which the bite needs in order to warp-sync. What goes in the bundle has
  // them stripped, because a forked node that keeps them rejoins the source network and
  // follows its longer chain — which looks like success on every metric while not being a
  // fork at all.
  const spec = JSON.parse(fs.readFileSync(workSpec, 'utf-8'));
  const bootNodes = spec.bootNodes?.length ?? 0;
  spec.bootNodes = [];
  const shipped = path.join(out, 'specs', `${chain.spec}.json`);
  fs.writeFileSync(shipped, JSON.stringify(spec));
  const kb = Math.round(fs.statSync(shipped).size / 1024);
  console.log(`  ${chain.spec}.json (${kb}K, ${bootNodes} bootNodes stripped)`);
}

export async function run(args: string[], opts: BiteOptions = {}): Promise<void> {
  const net = loadCurrentNetwork();

  // A descriptor still carrying _todo stubs describes a network nobody has confirmed the
  // sources for. Refusing is the rule, and it belongs here with the data it judges.
  if (net.todos.length) {
    throw new Error(
      `networks/${net.name}.json still carries stubs:\n` +
        net.todos.map((t) => `         • ${t}`).join('\n') +
        `\n       Fill them in (and drop the _todo notes) before biting ${net.name}.`
    );
  }

  const out = path.resolve(args[0] || path.join(WS, forkBundleName(net.name)));
  const binDir = path.join(WS, 'bin', net.name === 'previewnet' ? '' : net.name);
  const baseUrl = opts.source ?? net.bite.source;
  const chains = networkChains(net);
  const relay = chains.find((c) => c.key === 'relay')!;
  const parachains = chains.filter((c) => c.paraId !== null);
  const relayRpc = asWs(
    /^(wss?|https?):\/\//.test(relay.rpc) ? relay.rpc : `${baseUrl}/${relay.rpc}`
  );

  // Refuse a source that is unreachable or has almost no state worth forking — the check
  // CI used to do in a separate step, which meant it only ran in CI.
  const head = await relayHead(asHttp(relayRpc));
  if (head === null) throw new Error(`${baseUrl} is unreachable — nothing to bite`);
  if (head < 100) {
    throw new Error(`${net.name}'s relay is at #${head} — too fresh to be worth biting`);
  }
  console.log(`Biting ${net.name} from ${baseUrl} (relay head #${head})`);

  const dgDir = await ensureDoppelganger(net, binDir);
  // bin/dg first so the bite node finds the doppelganger release's own PVF workers rather
  // than PPN's, which track a different polkadot-sdk revision.
  const env = { ...process.env, ...BITE_ENV, PATH: `${dgDir}:${binDir}:${process.env.PATH}` };

  fs.rmSync(out, { recursive: true, force: true });
  for (const d of ['specs', 'overrides', 'snapshots', 'work/specs']) {
    fs.mkdirSync(path.join(out, d), { recursive: true });
  }

  // Before the first network call: a mistyped chain or a missing file should fail now, not
  // after minutes of syncing.
  const staged = stageUpgrades(opts.upgrades, chains, out, opts.upgradeCheckVersion ?? true);

  console.log(`=== 1/6 collecting chain specs (network: ${net.name}) ===`);
  for (const chain of chains) await collectSpec(chain, net, out, baseUrl, dgDir);

  console.log('=== 2/6 recording what we are biting ===');
  const fork = await import('./fork.js');
  // Written to work/, not to the bundle root: a manifest beside empty snapshots is what
  // every reader takes as "bundle present", so an interrupted bite would leave one that
  // passes the check and fails in zombienet with a bare "No such file or directory". Step 6
  // moves it out once the snapshots it describes actually exist.
  await fork.run(['manifest', baseUrl, path.join(out, 'work', 'manifest.json')]);

  console.log('=== 3/6 generating verified storage overrides ===');
  await fork.run([
    'overrides',
    path.join(out, 'overrides'),
    baseUrl,
    ...(Object.keys(staged).length ? ['--upgrades', JSON.stringify(staged)] : []),
  ]);

  console.log('=== 4/6 biting parachains (parallel) ===');
  const relaySpec = path.join(out, 'work', 'specs', `${relay.spec}.json`);
  await Promise.all(
    parachains.map(async (para, i) => {
      const id = String(para.paraId);
      const work = path.join(out, 'work', id);
      fs.mkdirSync(work, { recursive: true });
      // The bite node always exits non-zero: doppelganger ends an essential task to stop
      // the node once the state import is captured. Success is judged by the info file.
      await runBiteNode(
        'doppelganger-parachain',
        [
          '--chain', path.join(out, 'work', 'specs', `${para.spec}.json`),
          '--sync', 'warp',
          '-d', path.join(work, 'db'),
          '--rpc-port', String(19990 + i),
          '--prometheus-port', String(19890 + i),
          // Every port a bite node takes is pinned into the 197xx-199xx band, clear of the
          // 3033x p2p ports a spawn uses. Left to itself a node defaults to 30333, which is
          // Bulletin's — so a bite and a spawn contended for the same ports, and the loser
          // was whichever ran second.
          '--port', String(19790 + i),
          '--relay-chain-rpc-url', relayRpc,
          ...COMMON_ARGS,
          // The relay-side node behind `--` gets its own, for the same reason.
          '--', '--chain', relaySpec, '--port', String(19740 + i),
        ],
        {
          ...env,
          ZOMBIE_PARA_OVERRIDES_PATH: path.join(out, 'overrides', `${id}_overrides.json`),
          ZOMBIE_PARA_HEAD_PATH: path.join(work, 'head.txt'),
          ZOMBIE_INFO_PATH: path.join(work, 'info.txt'),
          ZOMBIE_PARA_ID: id,
          RUST_LOG: 'doppelganger=info',
        },
        path.join(biteLogDir(out), `${id}.log`),
        `${para.key} (${id})`
      );
    })
  );

  const biteBlocks: Record<string, number> = {};
  for (const para of parachains) {
    const id = String(para.paraId);
    const info = path.join(out, 'work', id, 'info.txt');
    const block = fs.existsSync(info) ? fs.readFileSync(info, 'utf-8').trim() : '';
    if (!block) {
      const log = path.join(biteLogDir(out), `${id}.log`);
      const hint = logTail(log, 3, /not present on the host|error|panic/i);
      throw new Error(
        `para ${id}: bite FAILED (log: ${log})\n${hint.map((l) => '         ' + l).join('\n')}`
      );
    }
    biteBlocks[id] = Number(block);
    console.log(`  para ${id} bitten at block ${block}`);
  }

  console.log('=== 5/6 biting relay with parachain heads injected ===');
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'work', 'manifest.json'), 'utf-8'));
  console.log(`  relay Babe::EpochDuration = ${manifest.epochDuration}`);

  // doppelganger scans its environment for names containing the Paras::Heads storage
  // prefix and overrides those entries during the relay's state import — which is how the
  // relay is made to agree with wherever the parachains landed, rather than the reverse.
  const { headEnvLines } = await import('../fork/manifest.js');
  const headEnv = Object.fromEntries(
    headEnvLines(path.join(out, 'work')).map((line) => {
      const eq = line.indexOf('=');
      return [line.slice(0, eq), line.slice(eq + 1)];
    })
  );
  console.log(`  injecting ${Object.keys(headEnv).length} parachain heads over Paras::Heads`);

  const relayWork = path.join(out, 'work', 'relay');
  fs.mkdirSync(relayWork, { recursive: true });
  await runBiteNode(
    'doppelganger',
    ['--chain', relaySpec, '--sync', 'warp', '-d', path.join(relayWork, 'db'),
      '--rpc-port', '19999', '--prometheus-port', '19899', '--port', '19799', ...COMMON_ARGS],
    {
      ...env,
      ...headEnv,
      ZOMBIE_RC_OVERRIDES_PATH: path.join(out, 'overrides', 'rc_overrides.json'),
      ZOMBIE_INFO_PATH: path.join(relayWork, 'info.txt'),
      ZOMBIE_CHAIN: net.relay.chain,
      ZOMBIE_RC_EPOCH_DURATION: String(manifest.epochDuration),
      RUST_LOG: 'doppelganger=info',
    },
    path.join(biteLogDir(out), 'relay.log'),
    `relay (${net.relay.chain})`
  );

  const relayInfo = path.join(relayWork, 'info.txt');
  const relayBlock = fs.existsSync(relayInfo) ? fs.readFileSync(relayInfo, 'utf-8').trim() : '';
  if (!relayBlock) {
    const log = path.join(biteLogDir(out), 'relay.log');
    const tail = logTail(log, 5);
    throw new Error(`relay bite FAILED (log: ${log})\n${tail.map((l) => '         ' + l).join('\n')}`);
  }
  biteBlocks.relay = Number(relayBlock);

  console.log('=== 6/6 packing snapshots ===');
  const snapshotBytes: Record<string, number> = {};
  packSnapshot(path.join(relayWork, 'db'), path.join(out, 'snapshots', 'relay.tgz'), 'relay');
  snapshotBytes.relay = fs.statSync(path.join(out, 'snapshots', 'relay.tgz')).size;
  for (const para of parachains) {
    const id = String(para.paraId);
    const dest = path.join(out, 'snapshots', `${id}.tgz`);
    packSnapshot(path.join(out, 'work', id, 'db'), dest, `${para.key} (${id})`);
    snapshotBytes[id] = fs.statSync(dest).size;
  }

  // Sizes are recorded here rather than measured from the tarball later: the column layout
  // of `tar -tzv` differs between BSD and GNU tar.
  // Last write of the whole bite: the bundle is only "present" once this lands.
  fs.writeFileSync(
    path.join(out, 'manifest.json'),
    JSON.stringify(
      {
        ...manifest,
        biteBlocks,
        snapshotBytes,
        ...(Object.keys(staged).length ? { seededUpgrades: staged } : {}),
      },
      null,
      2
    ) + '\n'
  );
  // work/ holds the chain databases the snapshots were packed from — gigabytes, and no longer
  // where the logs live, so dropping it costs nothing to diagnose with.
  fs.rmSync(path.join(out, 'work'), { recursive: true, force: true });
  console.log(`  node logs: ${biteLogDir(out)}`);

  const total = Object.values(snapshotBytes).reduce((a, b) => a + b, 0);
  console.log(`\n=== bundle ready: ${out} ===`);
  console.log(`  snapshots  ${(total / 1024 / 1024).toFixed(0)} MB across ${Object.keys(snapshotBytes).length} chains`);
  console.log(`  bite blocks: ${JSON.stringify(biteBlocks)}`);
  for (const key of Object.keys(staged)) {
    console.log(`  ${key}: runtime authorized at import — \`ppn runtime-upgrade ${key}\` enacts it`);
  }
}

/**
 * Download a published bundle instead of biting one. This is the default path for
 * `make start FORK=1`: no doppelganger needed, no bite to wait for.
 *
 * Previewnet's asset keeps its historical name; every other network's is suffixed.
 */
export async function fetchBundle(args: string[]): Promise<void> {
  const net = loadCurrentNetwork();
  const out = path.resolve(args[0] || path.join(WS, forkBundleName(net.name)));
  const asset = forkBundleAsset(net.name);
  const versions = readEnvFile(path.join(REPO, 'config', 'versions.env'));
  const token = githubToken();
  const { fetchRelease, downloadAsset } = await import('../lib/github.js');

  // Bundles live on ONE rolling pre-release (PPN_BITE_TAG), replaced by the nightly bite.
  // There is nothing to walk back through: the tag is either current or the nightly failed,
  // and an older bundle is not what a fork of "now" wants anyway.
  const tag = versions.PPN_BITE_TAG || 'bites';
  fs.mkdirSync(out, { recursive: true });
  const tmp = path.join(out, asset);

  const release = await fetchRelease(versions.PPN_REPO, tag, token);
  if (!release.assets.some((a) => a.name === asset)) {
    throw new Error(
      `${versions.PPN_REPO}@${tag} carries no ${asset}\n` +
        `       The nightly bite has not produced one for ${net.name} yet, or it failed.\n` +
        `       Bite the source yourself instead: ppn start --fork ${net.name} --fresh-bite`
    );
  }
  console.log(`Downloading ${asset} from ${versions.PPN_REPO}@${tag}`);
  if (!(await downloadAsset(release, asset, tmp, token))) {
    throw new Error(`download of ${asset} from ${versions.PPN_REPO}@${tag} failed`);
  }
  extractTarGz(tmp, out);
  fs.rmSync(tmp);

  const manifestPath = path.join(out, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`bundle has no manifest.json`);
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  console.log(`  bitten:          ${m.bittenAt}`);
  console.log(`  source node:     ${m.nodeVersion}`);
  console.log(`  bite blocks:     ${JSON.stringify(m.biteBlocks)}`);

  // A bundle is only restorable by a node that can run the runtimes in its state.
  const localPolkadot = path.join(WS, 'bin', net.name === 'previewnet' ? '' : net.name, 'polkadot');
  if (fs.existsSync(localPolkadot)) {
    const local = execFileSync(localPolkadot, ['--version'], { encoding: 'utf-8' }).split(' ')[1]?.trim();
    if (local && local !== m.nodeVersion) {
      console.log(`\n  NOTE: local polkadot is ${local}, the bundle was bitten against ${m.nodeVersion}.`);
      console.log('  Usually fine (the runtime travels in the bundle), but if the fork misbehaves,');
      console.log('  `make fetch` to align the binaries with the bundle.');
    }
  }
  console.log(`✓ Fork bundle ready: ${out}`);
}

/**
 * Download the runtimes a fork of this network can be upgraded to.
 *
 * `ppn fork fetch-runtimes <tag> [outDir]`: one `<chain>.wasm` per chain in the descriptor's
 * `upgrades.runtimes` table, from the release `upgrades.repo` publishes under that tag. The
 * fellowship names its assets `<runtime>_runtime-v<spec>.compact.compressed.wasm`; the spec
 * number is not known in advance, so the asset is matched on stem and suffix. Files land
 * under `bin/<network>/runtimes/<tag>/`, which is what `make bite RUNTIMES=<tag>` stages.
 */
export async function fetchRuntimes(args: string[]): Promise<void> {
  const net = loadCurrentNetwork();
  const [tag, outArg] = args;
  if (!tag) throw new Error('fetch-runtimes needs a release tag, e.g. v2.5.0');
  if (!net.upgrades) {
    throw new Error(`networks/${net.name}.json declares no \`upgrades\` table — nothing says where its runtimes are published`);
  }
  const out = path.resolve(outArg || path.join(WS, 'bin', net.name === 'previewnet' ? '' : net.name, 'runtimes', tag));
  const { repo, runtimes } = net.upgrades;
  const token = githubToken();
  const { fetchRelease, downloadAsset } = await import('../lib/github.js');
  const release = await fetchRelease(repo, tag, token);

  fs.mkdirSync(out, { recursive: true });
  console.log(`Fetching runtimes from ${repo}@${tag} into ${out}`);
  for (const [chain, runtime] of Object.entries(runtimes)) {
    const matches = release.assets.filter(
      (a) => a.name.startsWith(`${runtime}_runtime-v`) && a.name.endsWith('.compact.compressed.wasm')
    );
    if (matches.length !== 1) {
      throw new Error(
        `${repo}@${tag} has ${matches.length} asset(s) matching ${runtime}_runtime-v*.compact.compressed.wasm ` +
          `(wanted exactly one for ${chain})`
      );
    }
    const dest = path.join(out, `${chain}.wasm`);
    if (!(await downloadAsset(release, matches[0].name, dest, token))) {
      throw new Error(`download of ${matches[0].name} failed`);
    }
    const code = fs.readFileSync(dest);
    console.log(`  ${chain}: ${matches[0].name} (${(code.length / 1024).toFixed(0)} KiB, blake2 ${blake2AsHex(code, 256).slice(2, 18)}…)`);
  }
  console.log(`✓ ${Object.keys(runtimes).length} runtime(s) ready: make bite NETWORK=${net.name} RUNTIMES=${tag}`);
}
