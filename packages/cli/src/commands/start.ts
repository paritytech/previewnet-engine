// `ppn start` and `ppn kill` — bring a network up, and take it down.
//
// These were the last workflows living only in the Makefile, which is why "installing PPN"
// meant cloning the repo: `make` was the interface. A tool you can install has to be able to
// do the thing everybody actually types.
//
// The Makefile keeps the targets as a front door for anyone working in a checkout; they
// delegate here, so there is one implementation and one set of decisions.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  loadNetwork,
  currentNetworkName,
  readEnvFile,
  repoRoot,
  runsTurnRelay,
  workspaceRoot,
  type ForkManifest,
  type ForkTopology,
  type NetworkDef,
} from '@parity/ppn-network-config';
import { readSpawnStamp, writeSpawnStamp, SPAWN_FILE } from '../lib/spawn-stamp.js';
import { localEnvContent, childEnv } from '../lib/spawn-env.js';
import { forkBundleName } from '../lib/fork-bundle-name.js';
import {
  classifyGroup,
  recordedGroups,
  removeGroupRecord,
  runsFrom,
  stopGroup,
  systemProcesses,
  writeGroupRecord,
  type GroupRecord,
} from '../lib/process-group.js';
import { resolveTopology, sameTopology, topologyFlags } from '../fork/topology.js';

const REPO = repoRoot();
/** Mutable state — binaries, chain data, bundles — lives in the workspace, not the package. */
const WS = workspaceRoot();

/** Node processes zombienet starts that do not answer on a port, so a port sweep misses them. */
const NODE_BINARIES = [
  'zombie-cli',
  'polkadot',
  'polkadot-omni-node',
  'polkadot-parachain',
  'polkadot-execute-worker',
  'polkadot-prepare-worker',
  // `ppn kill` has to reach what `ppn bite` starts. A bite node that outlives its bite keeps
  // holding a port, and a `--fork FRESH_BITE=1` run bites and then spawns on the same machine:
  // the spawn failed on a port no sweep could free, identically on every retry.
  'doppelganger',
  'doppelganger-parachain',
];

/** Ports the auxiliary services listen on: refused when held before a start, reported after a kill. */
const SERVICE_PORT_KEYS = [
  'IPFS_GATEWAY_PORT',
  'IPFS_API_PORT',
  'IPFS_SWARM_PORT',
  'ETH_RPC_PORT',
  'WEB3_STORAGE_PROVIDER_PORT',
  'DUB_PORT',
  'DUB_POSTGRES_PORT',
  // Without this the dashboard outlives `ppn kill`: the next spawn's dashboard dies on
  // EADDRINUSE and the surviving one serves the previous run's workspace — a fork rendered
  // with the old genesis stamp.
  'DASHBOARD_PORT',
];

/** The TURN relay's own listeners (docs/TURN.md), for a network that runs it. */
const TURN_PORT_KEYS = ['TURN_PORT', 'TURN_PROXY_PORT'];

export interface StartOptions {
  /** Continue from a bitten bundle instead of genesis. */
  fork?: boolean;
  /** Wipe the data directory first. */
  clean?: boolean;
  /** No persistence — zombienet keeps state in its own temp dir. */
  ephemeral?: boolean;
  /** Rebuild the genesis chain specs before starting. */
  regenerate?: boolean;
  /** Bite the source network now rather than using a published bundle. */
  freshBite?: boolean;
  /** With a bite: `<chain>=<wasm>` runtimes to authorize at import. See `ppn bite --upgrade`. */
  upgrades?: string[];
  /** With a bite: authorize a runtime whose spec_version is not bumped. */
  upgradeSameSpec?: boolean;
  /** With a bite: `<chain>=<n>` cores per parachain. See `ppn bite --cores`. */
  cores?: string[];
  /** With a bite: `<chain>=<n>` collators per parachain. See `ppn bite --collators`. */
  collators?: string[];
  /** Override the data directory. */
  dataDir?: string;
  /** Override the zombienet config, bypassing the generated one. */
  toml?: string;
}

/** Where a network's mutable state lives, mirroring the Makefile's DATA_DIR rule. */
export function dataDirFor(name: string, fork: boolean, override?: string): string {
  if (override) return path.resolve(override);
  const suffix = `${fork ? '-fork' : ''}${name === 'previewnet' ? '' : `-${name}`}`;
  return path.join(WS, `data${suffix}`);
}

export function binDirFor(name: string): string {
  return name === 'previewnet' ? path.join(WS, 'bin') : path.join(WS, 'bin', name);
}

/** Where a network's bitten bundle lives. See lib/fork-bundle-name.ts on the naming. */
export function forkDirFor(name: string): string {
  return path.join(WS, forkBundleName(name));
}

const ports = () => readEnvFile(path.join(REPO, 'config', 'ports.env'));

/** A service port as ports.env names it. */
export interface ServicePort {
  key: string;
  port: string;
}

/** The service ports a network listens on: the auxiliary services, and the relay's when it runs one. */
export function servicePorts(net: NetworkDef, values: Record<string, string>): ServicePort[] {
  const keys = [...SERVICE_PORT_KEYS, ...(runsTurnRelay(net) ? TURN_PORT_KEYS : [])];
  return keys.filter((key) => values[key]).map((key) => ({ key, port: values[key] }));
}

/**
 * The processes listening on a TCP port, as `command(pid)`. Listeners only: a bare `lsof -i :port`
 * also matches every client whose connection has that port at the *other* end — a browser on some
 * host's :8080, a wallet talking to a remote :8545.
 */
export function listenersOn(port: string): string[] {
  const out = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'pc'], { encoding: 'utf-8' });
  const holders: string[] = [];
  let pid = '';
  for (const line of out.stdout.split('\n')) {
    if (line.startsWith('p')) pid = line.slice(1);
    else if (line.startsWith('c') && pid) holders.push(`${line.slice(1)}(${pid})`);
  }
  return holders;
}

/**
 * Refuse a start while anything listens on a service port. Nothing is killed: the holder may be a
 * previous run of this network, but it may as well be another checkout's network or a service that
 * has nothing to do with PPN (a developer's own Postgres, IPFS daemon or dashboard on the same
 * port), and a signal cannot tell them apart. `ppn kill` stops a previous run of this workspace.
 */
export function refuseOccupiedPorts(ports: ServicePort[], holders: (port: string) => string[] = listenersOn): void {
  const taken = ports.map((p) => ({ ...p, by: holders(p.port) })).filter((p) => p.by.length > 0);
  if (taken.length === 0) return;
  throw new Error(
    `${taken.length} service port(s) this network needs are in use, and nothing was stopped:\n` +
      taken.map((t) => `       ${t.port} (${t.key}) — ${t.by.join(', ')}`).join('\n') +
      '\n       `ppn kill` stops a previous run of this workspace; otherwise stop the holder or move the port in config/ports.env.'
  );
}

/**
 * Service binaries the custom processes run from bin/ or bin/<network>/. The port sweep used to be
 * what stopped them; `ppn kill` now names them, as it names the nodes.
 */
const SERVICE_BINARIES = ['eth-rpc', 'ipfs', 'storage-provider-node', 'dub'];

/** Launchers that restart what they run, so they have to stop before it does. */
const RESTARTING_LAUNCHERS = ['ipfs-daemon.sh', 'ipfs-swarm.sh', 'dub/service.sh'];

/** Escape a path for an extended regular expression (pkill -f). */
const ere = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The `pkill -f` patterns `ppn kill` sweeps with, each anchored to this workspace's or this
 * package's own paths, so that a network started from another checkout or workspace, or another
 * user's, is never matched: before, `killall -9 polkadot` took every polkadot on the machine.
 * Node binaries run from bin/, bin/<network>/ or bin/<network>/dg/ (the bite's doppelganger).
 */
export function sweepPatterns(
  ws: string,
  repo: string
): { launchers: string; binaries: string; services: string; postgres: string } {
  const bin = ere(path.join(ws, 'bin'));
  return {
    launchers: `${ere(path.join(repo, 'scripts'))}/(${RESTARTING_LAUNCHERS.map(ere).join('|')})( |$)`,
    binaries: `^${bin}/(.*/)?(${[...NODE_BINARIES, ...SERVICE_BINARIES].map(ere).join('|')})( |$)`,
    // Installed from npm the launchers run dist/bin.js; in a checkout, bin/ppn.mjs.
    services: `(${ere(path.join(repo, 'bin', 'ppn.mjs'))}|${ere(path.join(repo, 'dist', 'bin.js'))}) service( |$)`,
    postgres: `^${bin}/postgres-dist/bin/postgres( |$)`,
  };
}

/** True when something is already listening — a start would fight it for the port. */
async function inUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const done = (answer: boolean) => {
      socket.destroy();
      resolve(answer);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(500, () => done(false));
  });
}

/**
 * True when a port can actually be bound, which is not the same question as `inUse`.
 * zombienet reserves every node port by binding 0.0.0.0 up front, so a port that refuses a
 * bind — held on another interface, or still in TIME_WAIT — fails there while answering no
 * connection here.
 */
async function bindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '0.0.0.0' }, () => server.close(() => resolve(true)));
  });
}

/** Whatever holds a port, as `command(pid)` — best effort, for the error message only. */
function holderOf(port: number): string {
  const out = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'cp'], { encoding: 'utf-8' });
  const pid = out.stdout.match(/^p(\d+)/m)?.[1];
  const cmd = out.stdout.match(/^c(.+)/m)?.[1];
  return pid ? `${cmd ?? 'held'}(${pid})` : 'not a listening socket — possibly TIME_WAIT';
}

/**
 * Refuse to spawn when a port the config names cannot be bound.
 *
 * Without this the failure surfaces from inside zombienet as
 * `panicked at crates/orchestrator/src/lib.rs:842: removal index (is 0) should be < len (is 0)`,
 * which names neither a port nor a node: it drops the node whose port would not bind into an
 * error list nothing ever reads, then panics on the empty collator list minutes later. See
 * paritytech/zombienet-sdk#570 — the ports are ours to check either way.
 */
export async function checkPorts(tomlFile: string): Promise<void> {
  const owners = new Map<number, string>();
  let node = 'config';
  for (const line of fs.readFileSync(tomlFile, 'utf-8').split('\n')) {
    const named = line.match(/^\s*name\s*=\s*"([^"]+)"/);
    if (named) node = named[1];
    const port = line.match(/^\s*(rpc_port|ws_port|p2p_port|prometheus_port)\s*=\s*(\d+)/);
    if (port) owners.set(Number(port[2]), `${node} ${port[1]}`);
  }

  const taken: string[] = [];
  for (const [port, owner] of owners) {
    if (!(await bindable(port))) taken.push(`       ${port} (${owner}) — ${holderOf(port)}`);
  }
  if (taken.length === 0) return;

  throw new Error(
    `${taken.length} of the ${owners.size} port(s) this network needs cannot be bound:\n` +
      taken.join('\n') +
      '\n       `ppn kill` clears a previous run; otherwise stop whatever holds them.'
  );
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} ${args[0] ?? ''} failed`);
}

/**
 * Everything the spawn needs on disk: binaries, and either chain specs (genesis) or a bundle
 * and its config (fork). Mirrors the Makefile's ensure-deps chain.
 */
async function ensureDeps(netDef: NetworkDef, opts: StartOptions, binDir: string): Promise<string> {
  const ppn = process.argv[1];
  const nodeBin = process.execPath;

  const { run: fetch } = await import('./fetch.js');
  await fetch([binDir], { ifNeeded: true });

  // The `dot` CLI is a runtime dependency of the services that submit extrinsics.
  const dotCli = path.join(REPO, 'scripts', 'ensure-dot-cli.sh');
  if (fs.existsSync(dotCli)) run('bash', [dotCli]);

  if (!opts.fork) {
    const { run: generate } = await import('./generate.js');
    await generate([binDir], { ifNeeded: true });
    return opts.toml ?? path.join(REPO, 'zombienet-configs', 'local-dev.toml');
  }

  const forkDir = forkDirFor(netDef.name);
  const forkToml = path.join(forkDir, 'fork.toml');
  const biteOpts = {
    upgrades: opts.upgrades,
    upgradeCheckVersion: !opts.upgradeSameSpec,
    cores: opts.cores,
    collators: opts.collators,
  };
  const asked = resolveTopology(opts, netDef);
  if (opts.freshBite) {
    console.log('biting the source network now (--fresh-bite)');
    const { run: bite } = await import('./bite.js');
    await bite([forkDir], biteOpts);
  } else if (usableBundle(forkDir)) {
    const m = JSON.parse(fs.readFileSync(path.join(forkDir, 'manifest.json'), 'utf-8'));
    const packed = fs.readdirSync(path.join(forkDir, 'snapshots')).filter((f) => f.endsWith('.tgz'));
    console.log(`✓ fork bundle present (bitten ${m.bittenAt}, ${packed.length} snapshots)`);
    // The authorization is state inside the snapshot, so the blob staged for it is fixed at
    // bite time: a different --upgrade needs a new bite, not a new start.
    for (const [chain, u] of Object.entries(m.seededUpgrades ?? {}) as [string, { codeHash: string }][]) {
      console.log(`  ${chain}: runtime ${u.codeHash.slice(0, 16)}… authorized — \`ppn upgrade ${chain}\` enacts it`);
    }
    if (opts.upgrades?.length) {
      throw new Error(
        `--upgrade changes what the bite authorizes, and this bundle is already bitten.\n` +
          `       Re-bite with it: ppn start ${netDef.name} --fork --fresh-bite ${opts.upgrades.map((u) => `--upgrade ${u}`).join(' ')}`
      );
    }
  } else {
    // No published bundle for this network is the normal case for one CI has never
    // pre-baked, and the old failure spent its last line telling the user to run a bite —
    // which is a strange thing for a tool to know and refuse to do. So it offers, rather
    // than instructs.
    //
    // Not silent, and not automatic in CI: a bite warp-syncs a live public network for
    // ~20 minutes and can leave gigabytes behind (devnet's bundle is 4.9 GB). An
    // unattended run must fail with the instruction, exactly as before; only an
    // interactive one may fall back, and only after saying what it is about to do.
    try {
      run(nodeBin, [ppn, 'fork', 'fetch-bundle', forkDir]);
    } catch (err) {
      // A failed fetch leaves the directory it created behind; a later run must not mistake
      // an empty one for a bundle, and a bite should start from nothing.
      if (fs.existsSync(forkDir) && fs.readdirSync(forkDir).length === 0) {
        fs.rmSync(forkDir, { recursive: true, force: true });
      }
      const interactive = process.stdin.isTTY && process.stdout.isTTY && !process.env.CI;
      if (!interactive) throw err;
      console.log('');
      console.log(`No published bundle for ${netDef.name}. Biting ${netDef.bite.source} now instead —`);
      console.log('this warp-syncs the live network and takes several minutes. Ctrl-C to stop.');
      console.log('');
      const { run: bite } = await import('./bite.js');
      await bite([forkDir], biteOpts);
    }
  }
  assertBundleTopology(forkDir, netDef.name, asked);
  run(nodeBin, [ppn, 'fork', 'toml', forkDir, forkToml]);
  console.log(`✓ fork config: ${forkToml}`);
  return opts.toml ?? forkToml;
}

/**
 * Refuse a bundle bitten with a different layout than the run asks for.
 *
 * `--cores`/`--collators` are bite-time: the collator authority sets and the relay's core
 * layout are state inside the snapshots, and the fork TOML follows the manifest, so a spawn
 * cannot take a layout its bundle was not bitten with. Asking for none matches only a bundle
 * bitten with the defaults.
 */
export function assertBundleTopology(forkDir: string, network: string, asked: ForkTopology | undefined): void {
  const m = JSON.parse(fs.readFileSync(path.join(forkDir, 'manifest.json'), 'utf-8')) as ForkManifest;
  if (m.topology) console.log(`  bitten with ${topologyFlags(m.topology)} (${m.topology.validators} validators)`);
  if (sameTopology(asked, m.topology)) return;
  throw new Error(
    `--cores/--collators change how the bite lays the network out, and the bundle in ${forkDir} was bitten` +
      (m.topology ? ` with ${topologyFlags(m.topology)}.` : ' with the defaults.') +
      `\n       Re-bite with it: ppn start ${network} --fork --fresh-bite${asked ? ' ' + topologyFlags(asked) : ''}`
  );
}

export type ForkDataVerdict =
  | { action: 'fresh'; reason: string }
  | { action: 'resume'; reason: string }
  | { action: 'wipe'; reason: string };

/**
 * What to do with a fork's data directory before spawning.
 *
 * `resume` when the databases there were spawned from exactly this bundle — the spawn stamp
 * names the bite they came from, and a bundle is identified by when it was bitten. Anything
 * else is wiped: a different bite, a genesis run that shared the directory, or state with no
 * stamp to vouch for it. Resuming on the wrong database is the failure FORK.md describes —
 * healthy for a hundred blocks, then `Trie lookup error` — so the default is only ever taken
 * when the stamp matches.
 */
export function forkDataVerdict(dataDir: string, network: string, manifestPath: string): ForkDataVerdict {
  const populated = fs.existsSync(dataDir) && fs.readdirSync(dataDir).some((f) => f !== SPAWN_FILE);
  if (!populated) return { action: 'fresh', reason: 'no chain data yet' };

  const stamp = readSpawnStamp(dataDir);
  if (!stamp) return { action: 'wipe', reason: 'chain data present but no spawn stamp says which bite it came from' };
  if (stamp.mode !== 'fork') return { action: 'wipe', reason: `it holds a ${stamp.mode} run, not a fork` };
  if (stamp.network !== network) return { action: 'wipe', reason: `it holds a fork of ${stamp.network}` };

  let bittenAt: string | undefined;
  try {
    bittenAt = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')).bittenAt;
  } catch {
    return { action: 'wipe', reason: 'the bundle has no readable manifest to compare against' };
  }
  if (!stamp.bite?.at || stamp.bite.at !== bittenAt) {
    return { action: 'wipe', reason: `it continues a bite from ${stamp.bite?.at ?? 'unknown'}, the bundle is from ${bittenAt}` };
  }
  return { action: 'resume', reason: `continuing the fork spawned ${stamp.spawnedAt} from the bite of ${bittenAt}` };
}

/**
 * Is there a bundle here worth spawning from — and if not, clear what is.
 *
 * A manifest alone is not a bundle. An interrupted bite used to leave one beside an empty
 * snapshots/ (the manifest was written at step 2 and completed at step 6), and every later
 * start announced "present" then died inside zombienet with a bare "No such file or
 * directory". Bundles written before that fix are still on disk, so the debris is recognised
 * and discarded rather than reported: there is nothing in it worth keeping, and telling
 * somebody to `rm -rf` it is a chore, not an answer. The caller then fetches or bites.
 */
function usableBundle(forkDir: string): boolean {
  if (!fs.existsSync(path.join(forkDir, 'manifest.json'))) return false;
  const snaps = path.join(forkDir, 'snapshots');
  const packed = fs.existsSync(snaps) ? fs.readdirSync(snaps).filter((f) => f.endsWith('.tgz')) : [];
  if (packed.length > 0) return true;
  console.log(`${forkDir} holds a manifest but no snapshots — discarding that interrupted bite`);
  fs.rmSync(forkDir, { recursive: true, force: true });
  return false;
}

/**
 * Put the executable bit back on the launchers zombienet execs by path.
 *
 * npm does not preserve the mode of files outside `bin`, so every shell script in a published
 * tarball installs as 0644 however it looked in the repo. zombienet runs them as commands —
 * starting with a `--help` probe before it spawns anything — and the failure is a bare
 * `Permission denied (os error 13)` from inside a Rust panic, naming a path that exists and
 * looks fine. Cheap to fix here, and it costs nothing in a checkout where the bit is already set.
 */
function ensureLaunchersExecutable(): void {
  const dir = path.join(REPO, 'scripts');
  if (!fs.existsSync(dir)) return;
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.sh')) {
        try {
          const mode = fs.statSync(full).mode;
          if (!(mode & 0o111)) fs.chmodSync(full, mode | 0o755);
        } catch {
          /* a read-only install is fine as long as the bit is already there */
        }
      }
    }
  };
  walk(dir);
}

export async function start(args: string[], opts: StartOptions = {}): Promise<void> {
  const name = args[0] || currentNetworkName();
  // Everything downstream — fetch, fork fetch-bundle, the services — resolves the network
  // from $PPN_NETWORK. An explicit argument has to become that answer, or `ppn start devnet`
  // fetches previewnet's artifacts into bin/devnet and downloads previewnet's bundle under
  // devnet's name.
  process.env.PPN_NETWORK = name;
  const netDef = loadNetwork(name);

  // Only a genesis network can be built from nothing; everything else must continue from a
  // bitten bundle, and saying so here beats a spawn that fails for an unrelated-looking reason.
  if (!opts.fork && !netDef.genesis) {
    throw new Error(
      `${name} cannot start from genesis — it is fork-only.\n` +
        `       ppn start ${name} --fork`
    );
  }

  const dataDir = dataDirFor(name, Boolean(opts.fork), opts.dataDir);
  const binDir = binDirFor(name);

  // A network an earlier `ppn start` of this workspace left running (that ppn was killed, or its
  // terminal closed) is stopped first: its recorded process group proves it is ours. Only then
  // are the ports checked, so what still holds one is someone else's, and refused.
  stopRecordedGroups('a previous run');

  const p = ports();
  refuseOccupiedPorts(servicePorts(netDef, p));

  const relayPort = Number(p.RELAY_ALICE_PORT);
  if (relayPort && (await inUse(relayPort))) {
    throw new Error(
      `something is already listening on ${relayPort} (the relay's RPC port).\n` +
        '       `ppn kill` first, or point this run at another machine.'
    );
  }

  if (opts.clean) {
    console.log(`cleaning ${dataDir}`);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  if (opts.regenerate) {
    const { run: generate } = await import('./generate.js');
    await generate([binDir], {});
  }

  ensureLaunchersExecutable();

  const tomlFile = await ensureDeps(netDef, opts, binDir);
  if (!fs.existsSync(tomlFile)) throw new Error(`no zombienet config at ${tomlFile}`);

  // Decided after ensureDeps, which is where a --fresh-bite produces the bundle the data is
  // compared against. zombienet restores a bundle's snapshot only into an empty base path;
  // a database already there is run on as-is — which is right when it is this bundle's own
  // fork continuing from where it stopped, and wrong for anything else. See docs/FORK.md.
  if (opts.fork && !opts.ephemeral) {
    const verdict = forkDataVerdict(dataDir, name, path.join(forkDirFor(name), 'manifest.json'));
    if (verdict.action === 'wipe') {
      console.log(`fork mode: wiping ${dataDir} — ${verdict.reason}`);
      fs.rmSync(dataDir, { recursive: true, force: true });
    } else if (verdict.action === 'resume') {
      console.log(`fork mode: resuming ${dataDir} — ${verdict.reason} (--clean restarts from the bite block)`);
    }
  }
  if (!opts.ephemeral) fs.mkdirSync(dataDir, { recursive: true });

  // When and from what this network was spawned — a fact of this run, recorded beside its
  // state. The dashboard reads it; re-deriving later would resolve moving pins differently.
  // Ephemeral runs write none: the state they describe is gone at the next start.
  //
  // The writer is shared with `ppn stamp-spawn`, which is how a deployment (where the supervisor
  // spawns zombie-cli itself and this code never runs) gets the same stamp.
  if (!opts.ephemeral) {
    writeSpawnStamp(dataDir, {
      network: name,
      mode: opts.fork ? 'fork' : 'genesis',
      forkManifest: opts.fork ? path.join(forkDirFor(name), 'manifest.json') : null,
      repoRoot: REPO,
    });
  }

  // zombie-cli does not forward environment variables to custom_processes, so the few things
  // those processes cannot derive travel through a gitignored file they read instead.
  // mkdir because the workspace is not necessarily a checkout: `~/.ppn` starts as bare
  // networks/ and grows bin/ and data/ as they are fetched, so config/ may not exist yet.
  const localEnv = path.join(WS, 'config', 'ports.local.env');
  fs.mkdirSync(path.dirname(localEnv), { recursive: true });
  // The identity databases project chain state, so they have to be exactly as durable as the
  // chain. Ephemeral means zombienet keeps chain state in its own temp dir and the next start
  // is genesis again — pointing the cluster at the persistent data/ regardless would leave the
  // username indexer with a watermark past the new chain's finalized head, where it reports
  // `blocks_processed=0` for ever and every registration is accepted and never projected.
  // The zombie- prefix is deliberate: `ppn kill` already sweeps those out of the temp dir.
  const identityData = opts.ephemeral
    ? path.join(os.tmpdir(), `zombie-identity-${process.pid}`, 'identity-pgdata')
    : path.join(dataDir, 'identity-pgdata');
  fs.writeFileSync(
    localEnv,
    localEnvContent({
      network: name,
      dataDir,
      ephemeral: Boolean(opts.ephemeral),
      identityDataDir: identityData,
    })
  );

  // Last thing before spawning: the config is final, so these are exactly the ports
  // zombienet is about to reserve.
  await checkPorts(tomlFile);

  const zombie = path.join(WS, 'bin', 'zombie-cli');
  if (!fs.existsSync(zombie)) throw new Error(`zombie-cli is not in ${path.dirname(zombie)} — run \`ppn fetch\``);

  const spawnArgs = ['spawn', '-p', 'native', ...(opts.ephemeral ? [] : ['-d', dataDir]), tomlFile];
  console.log(`\n${netDef.displayName}: ${opts.fork ? 'fork' : 'genesis'}, config ${path.basename(tomlFile)}\n`);

  // Detached: zombie-cli leads a process group of its own, and everything zombienet starts joins
  // it. The terminal's Ctrl-C now reaches only this process, which forwards it to that group (below),
  // and `ppn kill` or a later `ppn start` can stop exactly that group from its record.
  const child = spawn(zombie, spawnArgs, {
    detached: true,
    stdio: 'inherit',
    env: {
      ...process.env,
      ...childEnv({
        binDir,
        workspace: WS,
        scriptsDir: path.join(REPO, 'scripts'),
        dataDir,
        ephemeral: Boolean(opts.ephemeral),
      }),
    },
  });
  let interrupted = false;
  const group: GroupRecord | undefined = child.pid
    ? {
        version: 1,
        pgid: child.pid,
        leaderStart: systemProcesses.startOf(child.pid) ?? '',
        network: name,
        workspace: WS,
        ...(opts.ephemeral ? {} : { dataDir }),
        recordedAt: new Date().toISOString(),
      }
    : undefined;
  if (group) writeGroupRecord(group);
  // If this process exits any other way (an error below), the network does not outlive it. A
  // SIGKILL leaves no chance: the next `ppn start` or `ppn kill` stops the recorded group.
  let groupStopped = false;
  const onExit = () => {
    if (group && !groupStopped) systemProcesses.signalGroup(group.pgid, 'SIGTERM');
  };
  process.on('exit', onExit);

  // zombienet's last word is "network is up", and then it goes quiet — so the one thing a
  // reader wants next (where to look) is announced here rather than left to be guessed.
  // Keyed on zombie.json, which zombienet writes when every node is started, and on the
  // dashboard actually answering: a link printed before either would be a broken one.
  const announce = (async () => {
    const stamp = path.join(dataDir, 'zombie.json');
    const dashPort = Number(p.DASHBOARD_PORT || 8090);
    if (netDef.services.dashboard === false) return;
    for (let i = 0; i < 240; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (child.exitCode !== null || interrupted) return;
      if (!fs.existsSync(stamp) || !(await inUse(dashPort))) continue;
      console.log(`\n🖥  dashboard: http://127.0.0.1:${dashPort}\n`);
      return;
    }
  })();

  // Ctrl-C (and SIGTERM, or the terminal closing) is forwarded to the whole group, as the
  // terminal used to deliver it: zombie-cli tears its nodes down, and the custom processes get the
  // same signal. What is still in the group once zombie-cli has exited is stopped below.
  const onInterrupt = () => {
    if (!group) return;
    if (interrupted) {
      // A second Ctrl-C means the first did not take: stop waiting on it.
      systemProcesses.signalGroup(group.pgid, 'SIGKILL');
      return;
    }
    interrupted = true;
    console.log('\ninterrupted — stopping the network...');
    systemProcesses.signalGroup(group.pgid, 'SIGINT');
    setTimeout(() => systemProcesses.signalGroup(group.pgid, 'SIGKILL'), 15_000).unref();
  };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);
  process.on('SIGHUP', onInterrupt);

  try {
    await new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      // zombienet runs until interrupted; a non-zero exit is the spawn failing, and Ctrl-C
      // arrives as a signal rather than a code.
      child.on('exit', (code, signal) =>
        signal || interrupted || code === 0 ? resolve() : reject(new Error(`zombie-cli exited with ${code}`))
      );
    });
  } finally {
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);
    process.off('SIGHUP', onInterrupt);
    // zombienet takes down only the nodes it supervises; the custom processes (dashboard, eth-rpc,
    // ipfs, the dub stack) are still in the group, holding their ports. Whichever way zombie-cli
    // ended, the rest of its group goes with it.
    if (group) {
      finishGroup(group, 'this run');
      groupStopped = true;
    }
    process.off('exit', onExit);
  }

  await announce;
}

/** This workspace's processes the sweep would stop, other than this process. */
function workspaceStrays(sweep = sweepPatterns(WS, REPO)): string[] {
  const patterns = Object.values(sweep).map((pattern) => new RegExp(pattern));
  const out = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf-8' });
  return (out.stdout ?? '').split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m || Number(m[1]) === process.pid || !patterns.some((re) => re.test(m[2]!))) return [];
    return [`${path.basename(m[2]!.split(' ')[0]!)}(${m[1]})`];
  });
}

/** Stop what is left of a group, then anything of this workspace that left it (the sweep, as the fallback). */
function finishGroup(group: GroupRecord, what: string): void {
  const stopped = stopGroup(group.pgid, systemProcesses);
  if (stopped.members)
    console.log(`  ${what}: stopped process group ${group.pgid} (${stopped.members} process(es)${stopped.forced ? ', some only by SIGKILL' : ''})`);
  removeGroupRecord(group);
  const strays = workspaceStrays();
  if (strays.length) {
    console.log(`  ${strays.length} process(es) of this workspace had left the group: ${strays.join(', ')}; stopping them by path`);
    sweepByPath();
  }
}

/**
 * Stop the groups this workspace recorded and that are still its own. A recorded group whose id
 * now belongs to something else is left alone, and its record dropped.
 */
function stopRecordedGroups(what: string): number {
  const ours = runsFrom([WS, REPO]);
  let stopped = 0;
  for (const record of recordedGroups(WS)) {
    const state = classifyGroup(record, systemProcesses, ours);
    if (state === 'ours') {
      console.log(`${what} of ${record.network} in this workspace is still running (process group ${record.pgid}, since ${record.recordedAt}): stopping it`);
      finishGroup(record, record.network);
      stopped++;
    } else {
      if (state === 'foreign') console.log(`  process group ${record.pgid}, recorded for ${record.network}, is no longer this workspace's: left alone`);
      removeGroupRecord(record);
    }
  }
  return stopped;
}

export function kill(): void {
  console.log('stopping zombienet processes...');
  // The groups `ppn start` recorded: exactly what it started, whatever it is called.
  const groups = stopRecordedGroups('the network');
  // The fallback: a network started without a record (an older ppn, or a supervisor that spawns
  // zombie-cli itself), or processes that left their group.
  const strays = workspaceStrays();
  if (strays.length) {
    console.log(
      groups
        ? `  ${strays.length} process(es) of this workspace were outside its process group(s): ${strays.join(', ')}; stopping them by path`
        : `  no recorded process group; stopping this workspace's processes by path: ${strays.join(', ')}`
    );
    sweepByPath();
  }

  // What still listens on a service port is not a process of this workspace: say so, and leave it.
  const p = ports();
  for (const key of [...SERVICE_PORT_KEYS, ...TURN_PORT_KEYS]) {
    const by = p[key] ? listenersOn(p[key]) : [];
    if (by.length) console.log(`  ! ${p[key]} (${key}) is held by ${by.join(', ')}, which this workspace did not start: left running`);
  }

  for (const dir of fs.existsSync('/tmp') ? fs.readdirSync('/tmp') : []) {
    if (dir.startsWith('zombie-')) fs.rmSync(path.join('/tmp', dir), { recursive: true, force: true });
  }
  console.log('✓ stopped');
}

/**
 * The path-anchored sweep: every pattern names this workspace's or this package's own paths
 * (sweepPatterns), so nothing started from another checkout or workspace is matched, and no port
 * holder is killed.
 */
function sweepByPath(): void {
  const sweep = sweepPatterns(WS, REPO);

  // Launchers that restart what they run go first. service.sh supervises its role and restarts
  // it after 5s, and the workers hold no port at all. Leaving the wrappers alive had them
  // respawning children against the next network, with an indexer whose watermark was ahead of
  // that network's chain: registrations were accepted and never projected.
  //
  // These paths have moved before — scripts/identity/ -> scripts/dub/, and the binary `ibv2` ->
  // `dub` in v0.3.0 — and a pkill pattern that matches nothing fails silently, which is exactly
  // the bug this call exists to prevent. Keep them in step with what runs.
  spawnSync('pkill', ['-9', '-f', sweep.launchers], { stdio: 'ignore' });
  spawnSync('pkill', ['-9', '-f', sweep.binaries], { stdio: 'ignore' });

  // The one-shot services hold no port, so no port check can find them. Left running they keep
  // waiting for a chain, and a stale one submits its extrinsic to whatever network comes up on
  // those ports next. SIGTERM first, SIGKILL below: `ppn service turn` stops its eturnal on
  // SIGTERM, and a SIGKILL alone left the relay running with nothing to stop it.
  spawnSync('pkill', ['-TERM', '-f', sweep.services], { stdio: 'ignore' });

  // Postgres gets SIGTERM first, and only then SIGKILL. It takes a SysV shared-memory segment
  // at startup and releases it on shutdown; SIGKILL skips that, leaving the segment behind with
  // nothing attached. macOS allows 32 system-wide (`kern.sysv.shmmni`), so on a machine that
  // has started ~32 networks every later cluster dies at initdb with "could not create shared
  // memory segment: No space left on device" — whose own HINT says it is not about disk. The
  // network then comes up with no backend at all. Recovery is manual: `ipcs -m` to list,
  // `ipcrm -m <id>` per orphan.
  spawnSync('pkill', ['-TERM', '-f', sweep.postgres], { stdio: 'ignore' });
  spawnSync('sleep', ['2'], { stdio: 'ignore' });
  spawnSync('pkill', ['-9', '-f', sweep.services], { stdio: 'ignore' });
  spawnSync('pkill', ['-9', '-f', sweep.postgres], { stdio: 'ignore' });
}
