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
  workspaceRoot,
  type NetworkDef,
} from '@parity/ppn-network-config';
import { writeSpawnStamp } from '../lib/spawn-stamp.js';
import { localEnvContent, childEnv } from '../lib/spawn-env.js';

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

/** Ports the auxiliary services listen on; freed before a start and after a kill. */
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

export function forkDirFor(name: string): string {
  return path.join(WS, `fork-bundle${name === 'previewnet' ? '' : `-${name}`}`);
}

const ports = () => readEnvFile(path.join(REPO, 'config', 'ports.env'));

/** Free a TCP port by killing whatever holds it. Uses lsof, as the shell version did. */
function freePorts(numbers: string[]): void {
  const pids = new Set<string>();
  for (const port of numbers) {
    if (!port) continue;
    const out = spawnSync('lsof', ['-ti', `:${port}`], { encoding: 'utf-8' });
    for (const pid of out.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) pids.add(pid);
  }
  for (const pid of pids) {
    try {
      process.kill(Number(pid), 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  if (pids.size) console.log(`  freed ${pids.size} process(es) holding service ports`);
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
  if (opts.freshBite) {
    console.log('biting the source network now (--fresh-bite)');
    const { run: bite } = await import('./bite.js');
    await bite([forkDir], {});
  } else if (usableBundle(forkDir)) {
    const m = JSON.parse(fs.readFileSync(path.join(forkDir, 'manifest.json'), 'utf-8'));
    const packed = fs.readdirSync(path.join(forkDir, 'snapshots')).filter((f) => f.endsWith('.tgz'));
    console.log(`✓ fork bundle present (bitten ${m.bittenAt}, ${packed.length} snapshots)`);
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
      await bite([forkDir], {});
    }
  }
  run(nodeBin, [ppn, 'fork', 'toml', forkDir, forkToml]);
  console.log(`✓ fork config: ${forkToml}`);
  return opts.toml ?? forkToml;
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

  const p = ports();
  freePorts(SERVICE_PORT_KEYS.map((k) => p[k]).filter(Boolean));

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
  } else if (opts.fork) {
    // zombienet restores a bundle's snapshot only into an empty base path; if a database is
    // already there it runs on that instead, which is how a fork ends up on another chain's
    // state. See docs/FORK.md.
    console.log(`fork mode: wiping ${dataDir} so the bundle's snapshot is restored`);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  if (opts.regenerate) {
    const { run: generate } = await import('./generate.js');
    await generate([binDir], {});
  }

  ensureLaunchersExecutable();

  const tomlFile = await ensureDeps(netDef, opts, binDir);
  if (!fs.existsSync(tomlFile)) throw new Error(`no zombienet config at ${tomlFile}`);
  if (!opts.ephemeral) fs.mkdirSync(dataDir, { recursive: true });

  // When and from what this network was spawned — a fact of this run, recorded beside its
  // state. The dashboard reads it; re-deriving later would resolve moving pins differently.
  // Ephemeral runs write none: the state they describe is gone at the next start.
  //
  // The writer is shared with `ppn stamp-spawn`, which is how a server (where ppn.service
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

  const child = spawn(zombie, spawnArgs, {
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

  // Ctrl-C reaches zombie-cli too — the terminal signals the whole foreground group — but
  // zombienet takes down only the nodes it supervises. The custom processes (dashboard,
  // eth-rpc, ipfs, the dub stack) outlive it still holding their ports, so the next start
  // failed on a port nothing visible was using and `ppn kill` was the only way out. Taking
  // our own SIGINT stops node from exiting first, leaving us alive to run the same sweep.
  const onInterrupt = () => {
    if (interrupted) {
      // A second Ctrl-C means the first did not take: stop waiting on it.
      child.kill('SIGKILL');
      return;
    }
    interrupted = true;
    console.log('\ninterrupted — stopping the network...');
    // zombie-cli has the signal already; this only covers a build that ignores it.
    setTimeout(() => child.kill('SIGKILL'), 15_000).unref();
  };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);

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
  }

  await announce;
  if (interrupted) kill();
}

export function kill(): void {
  console.log('stopping zombienet processes...');
  spawnSync('killall', ['-9', ...NODE_BINARIES], { stdio: 'ignore' });

  // The one-shot services hold no port, so the sweep below cannot reach them. Left running
  // they keep waiting for a chain, and a stale one submits its extrinsic to whatever network
  // comes up on those ports next.
  spawnSync('pkill', ['-9', '-f', `${path.join(REPO, 'bin', 'ppn.mjs')} service`], { stdio: 'ignore' });

  // The backend stack has to die wrapper-first. service.sh supervises its role and restarts
  // it after 5s, and only the two listeners (all-in-one, postgres) are reachable by the port
  // sweep at all — the workers hold no port. Killing the ports alone left the wrappers
  // alive respawning children against the next network, with an indexer whose watermark was
  // ahead of that network's chain: registrations were accepted and never projected.
  //
  // Both paths have moved once already — scripts/identity/ -> scripts/dub/, and the binary
  // `ibv2` -> `dub` in v0.3.0 — and a pkill pattern that matches nothing fails silently, which
  // is exactly the bug this call exists to prevent. Keep them in step with what runs.
  spawnSync('pkill', ['-9', '-f', path.join(REPO, 'scripts', 'dub', 'service.sh')], { stdio: 'ignore' });
  spawnSync('pkill', ['-9', '-f', path.join(WS, 'bin', 'dub')], { stdio: 'ignore' });

  // Postgres gets SIGTERM first, and only then SIGKILL. It takes a SysV shared-memory segment
  // at startup and releases it on shutdown; SIGKILL skips that, leaving the segment behind with
  // nothing attached. macOS allows 32 system-wide (`kern.sysv.shmmni`), so on a machine that
  // has started ~32 networks every later cluster dies at initdb with "could not create shared
  // memory segment: No space left on device" — whose own HINT says it is not about disk. The
  // network then comes up with no backend at all. Recovery is manual: `ipcs -m` to list,
  // `ipcrm -m <id>` per orphan.
  spawnSync('pkill', ['-TERM', '-f', path.join('postgres-dist', 'bin', 'postgres')], { stdio: 'ignore' });
  spawnSync('sleep', ['2'], { stdio: 'ignore' });
  spawnSync('pkill', ['-9', '-f', path.join('postgres-dist', 'bin', 'postgres')], { stdio: 'ignore' });

  console.log('stopping auxiliary services...');
  const p = ports();
  freePorts(SERVICE_PORT_KEYS.map((k) => p[k]).filter(Boolean));

  for (const dir of fs.existsSync('/tmp') ? fs.readdirSync('/tmp') : []) {
    if (dir.startsWith('zombie-')) fs.rmSync(path.join('/tmp', dir), { recursive: true, force: true });
  }
  console.log('✓ stopped');
}
