// `ppn service <name>` — the processes zombienet starts alongside the nodes.
//
// zombienet's `custom_processes` spawns a command path, so each of these keeps a one-line
// launcher under scripts/. The launcher is all that stays in shell; the decisions live
// here, next to the descriptor they are made from.
//
// zombie-cli does not forward environment variables to custom processes, which is why the
// network selector is read off disk (config/ports.local.env, written by `make start`)
// rather than inherited.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import type { ServiceContext } from './service-context.js';
import { loadCurrentNetwork, readEnvFile, hrmpChannels, type NetworkDef, repoRoot,
  workspaceRoot,
  BOB_SS58,
} from '@parity/ppn-network-config';
import { forkBundleName } from '../lib/fork-bundle-name.js';
import { loadSecrets } from '../lib/secrets.js';

const REPO = repoRoot();
/** Mutable state — binaries, chain data, bundles — lives in the workspace, not the package. */
const WS = workspaceRoot();

export type { ServiceContext } from './service-context.js';


function loadContext(): ServiceContext {
  // The deployable profile's keys, if the operator named a secrets file. See lib/secrets.ts.
  loadSecrets();
  const ports = readEnvFile(path.join(REPO, 'config', 'ports.env'));
  const localOverride = path.join(WS, 'config', 'ports.local.env');
  if (fs.existsSync(localOverride)) {
    for (const [k, v] of Object.entries(readEnvFile(localOverride))) {
      ports[k] = v;
      process.env[k] ??= v;
    }
  }
  const net = loadCurrentNetwork();
  // `make start` exports BIN for the custom processes, and the test harness relies on it
  // to point a service at a fixture directory.
  const binDir = process.env.BIN
    ? path.resolve(process.env.BIN)
    : path.join(WS, 'bin', net.name === 'previewnet' ? '' : net.name);
  return {
    net,
    ports,
    binDir,
    sharedBinDir: net.name === 'previewnet' || process.env.BIN ? binDir : path.dirname(binDir),
    relayWs: process.env.RELAY_WS || `ws://127.0.0.1:${ports.RELAY_ALICE_PORT}`,
    sudoUri: process.env.PPN_SUDO_URI || '//Alice',
  };
}

type Service = (ctx: ServiceContext, deps: ServiceDeps) => Promise<void>;

/** Injected in tests; in production these are the real implementations. */
export interface ServiceDeps {
  scanProducts?: (assetHubRpc: string, bulletinRpc: string, resolver: string) => Promise<{
    resolver: string;
    records: number;
    bulletinEntries: number;
    unmatched: number;
    cids: string[];
  }>;
}

const services: Record<string, Service> = {
  'assign-cores': assignCores,
  dashboard: async (ctx) => (await import('./dashboard.js')).dashboard(ctx),
  'force-open-hrmp': forceOpenHrmp,
  'increase-people-lite-attestation-allowance': increaseAttestationAllowance,
  'grant-invites': grantInvites,
  'set-dispatcher-address': setDispatcherAddress,
  'patch-bootnodes': patchBootnodes,
  'storage-provider-node': storageProviderNode,
  'pin-bulletin-products': pinBulletinProducts,
};

export { pinBulletinProducts };

export function serviceNames(): string[] {
  return Object.keys(services);
}

export async function run(args: string[], deps: ServiceDeps = {}): Promise<void> {
  const name = args[0];
  const service = services[name];
  if (!service) {
    throw new Error(
      `unknown service "${name ?? ''}" (one of: ${serviceNames().join(', ')})\n` +
        '       Services not listed here are still shell scripts under scripts/.'
    );
  }
  await service(loadContext(), deps);
}

// ---------------------------------------------------------------------------
// assign-cores — Asset Hub's 2-second blocks
// ---------------------------------------------------------------------------

/**
 * Give Asset Hub two extra cores so it can author at 2 seconds via elastic scaling.
 * zombienet assigns it one; these are cores 0 and 1 at 100% each (57600 parts).
 *
 * Which para id gets them comes from the descriptor — this used to be a shell script
 * exporting an env var into a Node script, with the id fetched by a third process.
 */
async function assignCores(ctx: ServiceContext, _deps: ServiceDeps = {}): Promise<void> {
  const assetHub = ctx.net.parachains.find((p) => p.key === 'asset-hub');
  if (!assetHub) {
    console.log(`assign-cores: ${ctx.net.name} has no asset-hub — nothing to assign`);
    return;
  }
  const waitSeconds = Number(process.env.WAIT_SECONDS ?? 30);
  if (waitSeconds > 0) {
    console.log(`assign-cores: waiting ${waitSeconds}s for the relay chain to be ready...`);
    await new Promise((r) => setTimeout(r, waitSeconds * 1000));
  }

  const { ApiPromise, WsProvider, Keyring } = await import('@polkadot/api');
  console.log(`assign-cores: relay ${ctx.relayWs}, para ${assetHub.paraId}`);
  const api = await ApiPromise.create({ provider: new WsProvider(ctx.relayWs) });
  try {
    console.log(`  connected to ${(await api.rpc.system.chain()).toString()}`);
    const signer = new Keyring({ type: 'sr25519' }).addFromUri(ctx.sudoUri);

    // assignCore(coreIndex, begin=0 (immediately), [[assignment, parts]], endHint=null)
    const assign = (core: number) =>
      api.tx.coretime.assignCore(core, 0, [[{ Task: assetHub.paraId }, 57600]], null);
    const call = api.tx.sudo.sudo(api.tx.utility.batch([assign(0), assign(1)]));

    await new Promise<void>((resolve, reject) => {
      call
        .signAndSend(signer, ({ status, dispatchError }) => {
          if (status.isInBlock) console.log(`  included in ${status.asInBlock.toString()}`);
          if (!status.isFinalized) return;
          console.log(`  finalized in ${status.asFinalized.toString()}`);
          if (!dispatchError) return resolve();
          if (dispatchError.isModule) {
            const e = api.registry.findMetaError(dispatchError.asModule);
            reject(new Error(`${e.section}.${e.name}: ${e.docs.join(' ')}`));
          } else {
            reject(new Error(dispatchError.toString()));
          }
        })
        .catch(reject);
    });
    console.log(`assign-cores: para ${assetHub.paraId} now has 3 cores (1 from zombienet + 2 here) — ~2s blocks`);
  } finally {
    await api.disconnect();
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const sleep = (seconds: number) => new Promise((r) => setTimeout(r, seconds * 1000));

/** Reject after `seconds` if the promise has not settled, so a silent stall becomes an error. */
function withDeadline<T>(promise: Promise<T>, seconds: number, why: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(why)), seconds * 1000);
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

async function waitSeconds(label: string, fallback: number): Promise<void> {
  const s = Number(process.env.WAIT_SECONDS ?? fallback);
  if (s <= 0) return;
  console.log(`  waiting ${s}s for ${label} to be ready...`);
  await sleep(s);
}

/** Submit a sudo-wrapped batch and resolve once it is finalized, surfacing module errors. */
async function submitSudo(
  api: { tx: any; registry: any; events?: any },
  signer: unknown,
  call: { signAndSend: Function }
): Promise<void> {
  // Several services start together and all sign as the same sudo account, so two can pick
  // the same nonce and the node rejects the loser: "Priority is too low — too low priority to
  // replace another transaction already in the pool". It is transient contention between
  // independent processes, not a bad call, so back off and take a fresh nonce. Without this,
  // force-open-hrmp lost the race and opened nothing while reporting success.
  const transient = (e: unknown) =>
    /priority is too low|temporarily banned|1014|already imported|not included within/i.test(
      e instanceof Error ? e.message : String(e)
    );
  for (let attempt = 0; ; attempt++) {
    try {
      // Never wait forever. A transaction can be accepted into the pool and then simply
      // never included — another service having taken the same nonce is enough — and
      // signAndSend just stays silent, so the service hangs with no error at all. That is
      // how force-open-hrmp ended a run having printed its intentions and nothing else.
      await withDeadline(submitOnce(api, signer, call), 120, 'not included within 120s');
      return;
    } catch (err) {
      if (attempt >= 5 || !transient(err)) throw err;
      const wait = 3 + attempt * 2;
      console.log(`  sudo pool collision, retrying in ${wait}s`);
      await sleep(wait);
    }
  }
}

async function submitOnce(
  api: { tx: any; registry: any; events?: any },
  signer: unknown,
  call: { signAndSend: Function }
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    call
      // nonce -1 means "next index, counting what is already in the pool". Several services
      // start at once and all sign as the same sudo account, so with an implicit nonce the
      // second one collides with the first and the node rejects it: "Priority is too low —
      // the transaction has too low priority to replace another transaction already in the
      // pool". That rejection is why force-open-hrmp opened nothing while appearing to work.
      .signAndSend(signer, { nonce: -1 }, ({ status, events, dispatchError }: any) => {
        if (status.isInBlock) console.log(`  included in ${status.asInBlock.toString()}`);
        if (!status.isFinalized) return;
        console.log(`  finalized in ${status.asFinalized.toString()}`);

        const describe = (err: any): string => {
          if (err?.isModule) {
            const e = api.registry.findMetaError(err.asModule);
            return `${e.section}.${e.name}: ${e.docs.join(' ')}`;
          }
          return String(err);
        };

        if (dispatchError) return reject(new Error(describe(dispatchError)));

        // `dispatchError` only covers the *outer* extrinsic. Wrapped in sudo, and again in
        // utility.batch, a failing inner call leaves the outer one perfectly successful — so
        // checking it alone reports "done" while nothing happened. That is not hypothetical:
        // force-open-hrmp announced four open channels and opened none, and the failure only
        // surfaced later as an XCM test finding every channel CLOSED.
        for (const { event } of events ?? []) {
          if (api.events?.sudo?.Sudid?.is?.(event)) {
            const result = event.data?.[0];
            if (result?.isErr) return reject(new Error(`sudo call failed — ${describe(result.asErr)}`));
          }
          if (api.events?.utility?.BatchInterrupted?.is?.(event)) {
            const [index, error] = event.data ?? [];
            return reject(
              new Error(`batch stopped at call ${index?.toString()} — ${describe(error)}`)
            );
          }
          if (api.events?.system?.ExtrinsicFailed?.is?.(event)) {
            return reject(new Error(describe(event.data?.[0])));
          }
        }
        resolve();
      })
      .catch(reject);
  });
}

/**
 * The `dot` CLI signs the two calls that go through it. It cannot take a SURI derivation
 * path, so `//Alice`-style keys are rejected with the reason rather than a codec error
 * deep inside the tool.
 */
function dotSudoAccount(): string {
  const uri = process.env.PPN_SUDO_URI;
  if (!uri) return 'Alice';
  if (uri.startsWith('//')) {
    throw new Error(
      'PPN_SUDO_URI starts with "//" — the dot CLI does not accept SURI derivation paths.\n' +
        '       Use a BIP39 mnemonic or a 0x-prefixed 32-byte hex seed.'
    );
  }
  const dot = (args: string[]) =>
    execFileSync('dot', args, { stdio: ['pipe', 'pipe', 'ignore'], env: dotEnv() });
  try {
    dot(['account', 'remove', 'ppn-sudo']);
  } catch {
    /* not present */
  }
  dot(['account', 'add', 'ppn-sudo', '--env', 'PPN_SUDO_URI']);
  return 'ppn-sudo';
}

/**
 * A config root of this process's own. Three services run as concurrent custom processes and
 * each calls `dot chain add`, while `dot` rewrites its config whole with no locking: on a
 * shared root that loses writes or tears the file, and the sudo call then never lands.
 */
let dotHome: string | null = null;
function dotEnv(): NodeJS.ProcessEnv {
  dotHome ??= fs.mkdtempSync(path.join(os.tmpdir(), 'ppn-dot-'));
  return { ...process.env, DOT_HOME: dotHome };
}

const dotRun = (args: string[]) =>
  execFileSync('dot', args, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'inherit'],
    env: dotEnv(),
  }).trim();

async function chainReachable(httpUrl: string, attempts: number, gapSeconds: number): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(httpUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'system_health', params: [] }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(gapSeconds);
  }
  return false;
}

// ---------------------------------------------------------------------------
// force-open-hrmp
// ---------------------------------------------------------------------------

/**
 * Open the network's HRMP channels on a running relay. Which channels those are comes from
 * the same list the genesis config is generated from — this used to parse the generated
 * TOML back out of the file to rediscover them.
 */
async function forceOpenHrmp(ctx: ServiceContext, _deps: ServiceDeps = {}): Promise<void> {
  const channels = hrmpChannels(ctx.net.parachains.map((p) => p.key));
  if (channels.length === 0) {
    console.log(`force-open-hrmp: ${ctx.net.name} declares no channels — nothing to open`);
    return;
  }
  await waitSeconds('the relay chain', 30);

  const { ApiPromise, WsProvider, Keyring } = await import('@polkadot/api');
  console.log(`force-open-hrmp: relay ${ctx.relayWs}, ${channels.length} channel(s)`);
  const api = await ApiPromise.create({ provider: new WsProvider(ctx.relayWs) });
  try {
    console.log(`  connected to ${(await api.rpc.system.chain()).toString()}`);

    // A channel cannot be opened for a parachain the relay has not onboarded yet, and the
    // call fails inside the batch — where, wrapped in sudo, it used to look like success.
    // Waiting a fixed number of seconds is a guess about how long registration takes; this
    // waits for the fact itself.
    const wanted = [...new Set(channels.flatMap((c) => [c.sender, c.recipient]))];
    const onboarded = async () => {
      const states = await Promise.all(
        wanted.map(async (id) => (await api.query.paras.paraLifecycles(id)).toString())
      );
      return states.every((s) => s === 'Parachain');
    };
    for (let i = 0; i < 60; i++) {
      if (await onboarded()) break;
      if (i === 0) console.log(`  waiting for ${wanted.join(', ')} to be onboarded...`);
      if (i === 59) throw new Error(`parachains ${wanted.join(', ')} were not onboarded in 5 minutes`);
      await sleep(5);
    }
    console.log(`  onboarded: ${wanted.join(', ')}`);
    const signer = new Keyring({ type: 'sr25519' }).addFromUri(ctx.sudoUri);
    const calls = channels.map((c) =>
      api.tx.hrmp.forceOpenHrmpChannel(c.sender, c.recipient, c.maxCapacity, c.maxMessageSize)
    );
    for (const c of channels) console.log(`  ${c.sender} -> ${c.recipient}`);
    await submitSudo(api, signer, api.tx.sudo.sudo(api.tx.utility.batch(calls)));
    console.log('force-open-hrmp: channels open');
  } finally {
    await api.disconnect();
  }
}

// ---------------------------------------------------------------------------
// increase-people-lite-attestation-allowance
// ---------------------------------------------------------------------------

/**
 * Grant attestation allowance to the account the identity backend signs PeopleLite.attest
 * with. Runs in both genesis and fork mode: a fork carries the source network's grants,
 * which say nothing about the account signing here. The grant is additive, so re-running
 * it is safe.
 */
async function increaseAttestationAllowance(ctx: ServiceContext, _deps: ServiceDeps = {}): Promise<void> {
  const ALLOWANCE_COUNT = '1000';
  const profile = process.env.PPN_PROFILE ?? 'local';
  // In deployable mode Alice has been stripped from balances, so granting to her would be
  // silently useless — the recipient must be named.
  if (profile === 'deployable' && !process.env.PPN_ALLOWANCE_SS58) {
    throw new Error(
      'the deployable profile requires PPN_ALLOWANCE_SS58 (the attestation allowance\n' +
        '       recipient) in the file named by PPN_SECRETS_FILE'
    );
  }
  const account =
    process.env.PPN_ALLOWANCE_SS58 ||
    process.env.ALLOWANCE_ACCOUNT ||
    '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';

  await waitSeconds('the People chain', 20);
  const peopleWs = `ws://127.0.0.1:${ctx.ports.PEOPLE_PORT}`;
  dotRun(['chain', 'add', 'People', '--rpc', peopleWs]);
  const from = dotSudoAccount();
  console.log(`increase-attestation-allowance: ${ALLOWANCE_COUNT} to ${account}`);
  const encoded = dotRun([
    'People.tx.PeopleLite.increase_attestation_allowance',
    account,
    ALLOWANCE_COUNT,
    '--encode',
  ]);
  dotRun(['People.tx.Sudo.sudo', encoded, '--from', from]);
}

// ---------------------------------------------------------------------------
// grant-invites
// ---------------------------------------------------------------------------

/**
 * Give the identity backend's inviter account invites to hand out, in both dimensions.
 *
 * Without this, invite-tickets-pool is not merely idle — it is actively harmful. It submits a
 * `Utility.force_batch` of `set_invite_ticket` every ~30 seconds regardless, every inner call
 * fails with no invites available (`submitted=1 registered=0 failed=1`, for ever), and the
 * batch still consumes a nonce. Before the inviter was moved off Alice that starved
 * the chain writer out of its own nonce lane and no username could ever land.
 *
 * Sudo, because the origin is `InvitationsOrigin`. Additive, so re-running is safe, which
 * matters in fork mode where the source network's grants say nothing about the account
 * signing here.
 */
async function grantInvites(ctx: ServiceContext, _deps: ServiceDeps = {}): Promise<void> {
  const INVITE_COUNT = 1000;
  if (!ctx.net.parachains.some((p) => p.key === 'people')) {
    console.log(`grant-invites: ${ctx.net.name} has no people chain — nothing to grant`);
    return;
  }
  // Kept in step with INVITER_ADDRESS in the generated TOML and INVITER_SIGNER_SURI in
  // scripts/dub/service.sh: granting to a different account than the one signing leaves
  // the pool failing exactly as it did before.
  const inviter = process.env.PPN_INVITER_SS58 || BOB_SS58;

  // The dot CLI, not @polkadot/api, for the same reason the allowance grant uses it: People
  // Chain's runtime carries signed extensions polkadot-js does not know (AsPerson,
  // PeopleLiteAuth, AsResources…), and an extrinsic it builds anyway is rejected by
  // validate_transaction with a wasm trap rather than a readable error.
  await waitSeconds('the People chain', 20);
  const peopleWs = `ws://127.0.0.1:${ctx.ports.PEOPLE_PORT}`;
  dotRun(['chain', 'add', 'People', '--rpc', peopleWs]);
  const from = dotSudoAccount();

  // Both dimensions the ticket pool cycles through; each pallet keeps its own invite book.
  const dims = ['ProofOfInk', 'Game'] as const;
  const available = (pallet: string) =>
    Number(dotRun([`People.query.${pallet}.AvailableInvites`, inviter]).trim() || '0');

  // Submit, then read the invite book back. Every other service that signs as sudo here has
  // taught the same lesson: a submission can be accepted and then lose its nonce to another
  // service starting at the same moment, and reporting success off the submission alone is
  // how force-open-hrmp opened no channels while printing that it had.
  for (let attempt = 1; ; attempt++) {
    const short = dims.filter((d) => available(d) < INVITE_COUNT);
    if (short.length === 0) {
      console.log(`grant-invites: ${inviter} holds invites for ${dims.join(' and ')}`);
      return;
    }
    if (attempt > 4) {
      throw new Error(
        `grant-invites: ${short.join(', ')} still short of invites for ${inviter} after ${attempt - 1} attempts`
      );
    }
    for (const pallet of short) {
      console.log(`grant-invites: ${INVITE_COUNT} ${pallet} invites to ${inviter}`);
      const encoded = dotRun([`People.tx.${pallet}.grant_invites`, inviter, String(INVITE_COUNT), '--encode']);
      try {
        dotRun(['People.tx.Sudo.sudo', encoded, '--from', from]);
      } catch (err) {
        // A rejected submission is not the answer — the next pass reads the invite book and
        // decides. Back-to-back sudo calls collide on the nonce here ("Invalid: Stale") because
        // the tool takes a fresh nonce per call while the previous one is still in the pool,
        // and the allowance grant is signing as the same account at the same moment.
        console.log(`  ${pallet} submission rejected (${(err as Error).message.split('\n')[0]}), will re-check`);
      }
      // Enough for the previous submission to be in a block, so the next call sees its nonce.
      await sleep(6);
    }
  }
}

// ---------------------------------------------------------------------------
// set-dispatcher-address
// ---------------------------------------------------------------------------

/**
 * Point DotnsGateway at whichever contract fronts the PoP controller in this release.
 *
 * A release either carries a `RootGatewayDispatcher`, whose job is to prove the substrate
 * Root origin before forwarding, or it does not, because the controller checks Root itself.
 * The two travel together: a release drops the dispatcher in the same change that stops the
 * controller authorising on the caller address. So the dispatcher's presence in the manifest
 * decides where the pallet must point, and pointing at the controller while a release still
 * ships a dispatcher would leave gateway calls failing its caller check.
 */
async function setDispatcherAddress(ctx: ServiceContext, _deps: ServiceDeps = {}): Promise<void> {
  const addrFile = path.join(ctx.binDir, 'dotns-addresses.json');
  if (!fs.existsSync(addrFile)) {
    console.log(`set-dispatcher-address: no ${addrFile} — skipping (release predates the manifest)`);
    return;
  }
  const addresses = JSON.parse(fs.readFileSync(addrFile, 'utf-8'));
  const target = addresses.RootGatewayDispatcher ?? addresses.DotnsPopController;
  if (!target) {
    throw new Error(
      `set-dispatcher-address: ${addrFile} names neither RootGatewayDispatcher nor ` +
        'DotnsPopController, so DotnsGateway would be left unset and every gateway call ' +
        'would fail with DispatcherAddressNotSet',
    );
  }
  const via = addresses.RootGatewayDispatcher ? 'RootGatewayDispatcher' : 'DotnsPopController';

  await waitSeconds('Asset Hub', 20);
  dotRun(['chain', 'add', 'AssetHub', '--rpc', `ws://127.0.0.1:${ctx.ports.ASSET_HUB_PORT}`]);
  const from = dotSudoAccount();
  console.log(`set-dispatcher-address: DotnsGateway.DispatcherAddress = ${target} (${via})`);
  const encoded = dotRun(['AssetHub.tx.DotnsGateway.set_dispatcher_address', target, '--encode']);
  dotRun(['AssetHub.tx.Sudo.sudo', encoded, '--from', from]);
}

// ---------------------------------------------------------------------------
// patch-bootnodes
// ---------------------------------------------------------------------------

/**
 * zombienet regenerates bootNodes from the running nodes, so the specs it publishes
 * advertise /ip4/127.0.0.1/. Without this, the chainspecs a deployment serves are unusable
 * to anything off the box. It rewrites addresses only; it touches no chain state.
 */
async function patchBootnodes(ctx: ServiceContext, _deps: ServiceDeps = {}): Promise<void> {
  const hostname = ctx.ports.BOOTNODE_HOSTNAME ?? '127.0.0.1';
  if (hostname === '127.0.0.1') {
    console.log('patch-bootnodes: BOOTNODE_HOSTNAME is 127.0.0.1, nothing to advertise');
    return;
  }
  // Where the specs are depends on the mode: data/ for genesis, data-fork-<network>/ for a
  // fork. `ppn start` records the answer in ports.local.env, which ctx.ports merges in; a
  // deployment that spawns zombie-cli itself sets DATA_DIR. Only then the genesis default.
  const dir = process.env.DATA_DIR || ctx.ports.PPN_DATA_DIR || path.join(WS, 'data');
  if (!fs.existsSync(dir)) throw new Error(`DATA_DIR does not exist: ${dir}`);

  // A raw chainspec is any top-level JSON with an id and a bootNodes list. Matching by
  // shape rather than name matters: previewnet's specs are <chain>-local.json, but a fork
  // of a public network carries the source's ids.
  const rawSpecs = () =>
    fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json') && !f.endsWith('-plain.json') && f !== 'zombie.json')
      .filter((f) => {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
          return Boolean(s?.id) && Array.isArray(s.bootNodes);
        } catch {
          return false;
        }
      });

  console.log(`patch-bootnodes: ${dir} -> ${hostname}`);
  for (let waited = 0; rawSpecs().length === 0 && waited < 120; waited += 5) {
    await sleep(5);
    console.log(`  waiting for raw chainspecs... (${waited + 5}s)`);
  }
  const specs = rawSpecs();
  if (specs.length === 0) throw new Error('no raw chainspecs found after 120s');

  const addrType = /^\d+\.\d+\.\d+\.\d+$/.test(hostname) ? 'ip4' : 'dns4';
  for (const file of specs) {
    const full = path.join(dir, file);
    const spec = JSON.parse(fs.readFileSync(full, 'utf-8'));
    if (!spec.bootNodes?.length) {
      console.log(`  ${file}: no bootNodes to patch`);
      continue;
    }
    spec.bootNodes = spec.bootNodes.map((bn: string) =>
      bn.replaceAll('/ip4/127.0.0.1/', `/${addrType}/${hostname}/`)
    );
    fs.writeFileSync(full, JSON.stringify(spec, null, 2) + '\n');
    console.log(`  ${file}: ${spec.bootNodes.length} bootNode(s) -> ${addrType}/${hostname}`);
  }
}

// ---------------------------------------------------------------------------
// storage-provider-node
// ---------------------------------------------------------------------------

/**
 * Run the Web3 Storage provider. Mostly a launcher, but it decides three things: which
 * binary (release or a sibling dev build), where content lives (disk or in-memory, which
 * follows DATA_DIR so genesis and fork stay separate), and the multiaddr it advertises —
 * which must match what the genesis preset registered, or the node re-syncs it to its
 * loopback bind address and clients can no longer reach it.
 */
async function storageProviderNode(ctx: ServiceContext, _deps: ServiceDeps = {}): Promise<void> {
  let binary = path.join(ctx.binDir, 'storage-provider-node');
  if (!fs.existsSync(binary)) {
    const sibling = path.join(WS, '..', 'web3-storage', 'target', 'release', 'storage-provider-node');
    if (!fs.existsSync(sibling)) {
      throw new Error(
        `storage-provider-node not found.\n` +
          `       Expected at:    ${binary}\n` +
          `       Or fallback at: ${sibling}\n` +
          '       To build it:    (cd ../web3-storage && cargo build --release -p storage-provider-node)'
      );
    }
    binary = sibling;
    console.log(`  using sibling build: ${binary}`);
  }

  const keyfile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ppn-sp-')), 'key');
  fs.writeFileSync(keyfile, '//Alice\n', { mode: 0o600 });
  process.on('exit', () => fs.rmSync(path.dirname(keyfile), { recursive: true, force: true }));

  const chainPort = ctx.ports.WEB3_STORAGE_PORT;
  console.log(`storage-provider-node: waiting for the web3-storage chain on 127.0.0.1:${chainPort}...`);
  if (await chainReachable(`http://127.0.0.1:${chainPort}`, 60, 2)) console.log('  chain reachable');

  let publicMultiaddr = process.env.PUBLIC_MULTIADDR ?? '';
  const hostname = ctx.ports.BOOTNODE_HOSTNAME ?? '127.0.0.1';
  if (!publicMultiaddr && hostname !== '127.0.0.1') {
    publicMultiaddr = `/dns4/${hostname}/tcp/443/tls/http/http-path/web3-storage-provider`;
  }

  const inMemory = (ctx.ports.WEB3_STORAGE_PROVIDER_STORAGE_MODE ?? 'disk') === 'inmemory';
  const storageArgs = ['--storage-mode', 'inmemory'];
  if (!inMemory) {
    const storagePath =
      process.env.STORAGE_PATH ||
      ctx.ports.WEB3_STORAGE_PROVIDER_DATA_DIR ||
      path.join(process.env.DATA_DIR || ctx.ports.PPN_DATA_DIR || path.join(WS, 'data'), 'web3-storage-provider');
    fs.mkdirSync(storagePath, { recursive: true });
    storageArgs.length = 0;
    storageArgs.push('--storage-mode', 'disk', '--storage-path', storagePath);
  }

  const args = [
    '--keyfile', keyfile,
    ...storageArgs,
    '--bind-addr', `127.0.0.1:${ctx.ports.WEB3_STORAGE_PROVIDER_PORT}`,
    '--chain-rpc', `ws://127.0.0.1:${chainPort}`,
    ...(publicMultiaddr ? ['--public-multiaddr', publicMultiaddr] : []),
    '--enable-checkpoint-coordinator',
  ];
  console.log(`  storage: ${storageArgs.join(' ')}`);
  if (publicMultiaddr) console.log(`  advertising: ${publicMultiaddr}`);

  // Replaces this process for the lifetime of the network, the way the wrapper's exec did.
  const child = spawn(binary, args, {
    stdio: 'inherit',
    env: { ...process.env, RUST_LOG: process.env.RUST_LOG ?? 'info' },
  });
  await new Promise<void>((resolve, reject) => {
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`storage-provider-node exited ${code}`))));
    child.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// pin-bulletin-products
// ---------------------------------------------------------------------------

/**
 * Import the DotNS products a forked bulletin cannot serve on its own.
 *
 * A fork carries chain state but not bulletin's stored bytes — those live in block bodies
 * and the bite is a warp sync. So a forked bulletin lists content it does not hold. Copying
 * all of bulletin is not viable (35 GiB on paseo-next-v2), so this copies only what DotNS
 * points at, and only the versions still within bulletin's retention window.
 *
 * Which CIDs are needed is resolved from the fork's own state, so it never guesses; only
 * the bytes come from the source, over HTTP. Best effort by design — it must never block a
 * spawn, so every failure path returns rather than throwing.
 */
async function pinBulletinProducts(ctx: ServiceContext, deps: ServiceDeps = {}): Promise<void> {
  if (process.env.PRODUCT_SYNC === '0') {
    console.log('pin-bulletin-products: PRODUCT_SYNC=0, skipping');
    return;
  }
  // Bundles are per network, previewnet included — the same rule `ppn start --fork` uses.
  // Reading only one hard-coded path made this service announce "not a fork, nothing to do"
  // on every other network's fork, indistinguishable from a fork with genuinely no products.
  const forkDir = process.env.FORK_DIR || path.join(WS, forkBundleName(ctx.net.name));
  const manifestPath = path.join(forkDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.log(`pin-bulletin-products: no ${manifestPath} — not a fork, nothing to do`);
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

  // Every DotNS deployment has its own resolver. The descriptor states it; a genesis network
  // also derives one into the release's address manifest, and the two must agree — a resolver
  // that exists in neither place is the honest failure, but one that differs between them
  // would import a deployment nobody asked for and say nothing.
  const { loadNetwork } = await import('@parity/ppn-network-config');
  const bundleNet = loadNetwork(manifest.network ?? 'previewnet');
  let resolver = bundleNet.dotns?.resolver;
  const addrFile = path.join(ctx.binDir, 'dotns-addresses.json');
  const derived = fs.existsSync(addrFile)
    ? JSON.parse(fs.readFileSync(addrFile, 'utf-8')).DotnsContentResolver
    : undefined;
  if (resolver && derived && resolver.toLowerCase() !== String(derived).toLowerCase()) {
    console.error(
      `pin-bulletin-products: ${bundleNet.name} declares resolver ${resolver}, but ` +
        `${addrFile} says ${derived}. One of them is stale; refusing to import against a guess.`
    );
    return;
  }
  if (!resolver) resolver = derived;
  if (!resolver) {
    console.log(`pin-bulletin-products: no resolver for ${bundleNet.name} — skipping`);
    return;
  }

  // Where the bytes come from. The bundle records the URL it was bitten from, which for
  // previewnet and devnet is also their IPFS gateway — but that is a coincidence of how those
  // two are hosted, not a rule. paseo-next-v2 is bitten from https://dot.li, a single-page app
  // that answers *every* path with the same 20 KB of its own HTML, status 200 and all: asking
  // it for a CAR does not 404, it quietly returns markup. So a network whose gateway lives
  // somewhere else names it, rather than being trusted to fail loudly.
  const gateway = process.env.PRODUCT_SOURCE_GATEWAY || bundleNet.dotns?.gateway || manifest.source;

  const ipfsApiPort = ctx.ports.IPFS_API_PORT;
  const ipfsApi = `/ip4/127.0.0.1/tcp/${ipfsApiPort}`;
  const assetHub = `http://127.0.0.1:${ctx.ports.ASSET_HUB_PORT}`;
  const bulletin = `http://127.0.0.1:${ctx.ports.BULLETIN_PORT}`;
  console.log(`pin-bulletin-products: resolver ${resolver}`);
  console.log(`  resolving from the fork: ${assetHub} + ${bulletin}`);
  console.log(`  fetching bytes from:     ${gateway}`);

  // Probe the API socket, not `ipfs id`: that succeeds in offline mode too by opening the
  // repo directly, and treating it as "daemon ready" is how a second process ends up
  // holding repo.lock and making every later pin fail.
  const apiUp = async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${ipfsApiPort}/api/v0/id`, {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
      });
      return r.ok;
    } catch {
      return false;
    }
  };
  for (let i = 0; i < 60; i++) {
    if ((await apiUp()) && (await chainReachable(assetHub, 1, 0)) && (await chainReachable(bulletin, 1, 0))) break;
    await sleep(5);
  }

  const scanProducts = deps.scanProducts ?? (await import('../fork/products.js')).scanProducts;
  let scan;
  try {
    scan = await scanProducts(assetHub, bulletin, resolver);
  } catch (err) {
    console.log(`  could not resolve products, skipping: ${err instanceof Error ? err.message : err}`);
    return;
  }
  if (scan.resolver.toLowerCase() !== resolver.toLowerCase()) {
    console.log(`  ${resolver} held nothing; using ${scan.resolver} found on chain`);
  }
  console.log(
    `  ${scan.records} contenthash records, ${scan.bulletinEntries} bulletin entries -> ` +
      `${scan.cids.length} products (${scan.unmatched} records no longer retained)`
  );
  if (scan.records === 0) {
    console.log('  No contenthash records on any contract — this network has no registered products.');
  }
  const limit = Number(process.env.PRODUCT_SYNC_LIMIT ?? scan.cids.length);
  const cids = scan.cids.slice(0, limit);
  // Nothing to import still ends with the summary line below, because "no products" is a real
  // outcome — a source network wiped an hour ago has none — and a reader waiting for the
  // summary cannot tell a service that finished with nothing to do from one that died before
  // printing it. Returning silently here is what made the fork-e2e leg fail with "product
  // import never reported" against a freshly redeployed previewnet.
  if (cids.length === 0) {
    console.log('pin-bulletin-products: imported 0, failed 0 — 0/0 served locally (nothing to import)');
    return;
  }
  console.log(`  ${cids.length} products to import`);

  const ipfsBin = path.join(ctx.sharedBinDir, 'ipfs');
  // kubo locates its repo through IPFS_PATH, falling back to $HOME/.ipfs. zombienet starts
  // custom processes without HOME, so without this every call dies with "$HOME is not
  // defined" before it reads the CAR — visible only as EPIPE. --api makes this a client
  // call that never opens the repo, but kubo resolves the path before it looks at --api.
  const ipfsEnv = {
    ...process.env,
    IPFS_PATH: process.env.IPFS_PATH ?? path.join(ctx.sharedBinDir, '.ipfs'),
  };
  let imported = 0;
  let failed = 0;
  let retried = 0;
  let firstError = '';

  /**
   * Fetch one product's CAR from the source and import it. Returns null on success, or the
   * reason it failed.
   *
   * The fetch and the import are one unit, because the failure worth retrying is a *truncated*
   * CAR. `?format=car` comes back chunked with no Content-Length, so a gateway that abandons a
   * DAG traversal part-way ends the stream cleanly: a well-formed HTTP 200 carrying an
   * incomplete CAR. Nothing in the status, headers or length says so — kubo is the first thing
   * to notice, and reports `unexpected EOF` after the last block it parsed whole. Re-running
   * the import on the same bytes would fail identically, so a retry has to re-fetch.
   */
  const importProduct = async (cid: string): Promise<string | null> => {
    try {
      const res = await fetch(`${gateway}/ipfs/${cid}?format=car`, { signal: AbortSignal.timeout(300_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const car = Buffer.from(await res.arrayBuffer());
      // A gateway under pressure answers 200 and then sends nothing — the plain fetch of the
      // same CID 504s. An empty body is not a product; importing it "succeeds" and the miss
      // only surfaces later as unservable, blamed on the fork instead of the source.
      if (car.length === 0) throw new Error('gateway returned an empty CAR (source timeout)');
      // --allow-big-block: a product's CAR contains blocks over kubo's 1 MiB bitswap limit
      // and the import is refused outright without it. The imported root is byte-identical
      // either way; the limit only affects bitswap exchange, and the gateway reads these
      // over HTTP.
      // Keep stderr: when kubo rejects the import it writes the reason there and exits
      // before reading the CAR off stdin, so the only error Node raises is a bare EPIPE.
      // Ignoring stderr turns every diagnosable failure into that one useless word.
      try {
        execFileSync(ipfsBin, ['--api', ipfsApi, 'dag', 'import', '--pin-roots=true', '--allow-big-block'], {
          input: car,
          stdio: ['pipe', 'ignore', 'pipe'],
          maxBuffer: 512 * 1024 * 1024,
          env: ipfsEnv,
        });
      } catch (err) {
        const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim();
        throw stderr ? new Error(stderr) : err;
      }
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  for (const cid of cids) {
    let reason = await importProduct(cid);
    if (reason) {
      // One retry, like the serve pass below. A truncation is a fact about one stream from a
      // loaded gateway, not about the bytes: the block a real run choked on fetched cleanly
      // afterwards. The pause is so a gateway that just gave up is not asked again instantly.
      await new Promise((r) => setTimeout(r, 1000));
      const second = await importProduct(cid);
      if (second === null) {
        retried++;
        console.log(`  imported on retry: ${cid} (first attempt: ${reason})`);
        reason = null;
      } else {
        reason = second;
      }
    }
    if (reason === null) {
      imported++;
      if (imported % 25 === 0) console.log(`  imported ${imported}/${cids.length}`);
    } else {
      // Keep the first reason. Swallowing it entirely turns "116 of 116 failed" into a
      // number with no cause, and the summary below can still read "116/116 served
      // locally" because ipfs-swarm lets the gateway fetch from the source network on
      // demand — so a total import failure can look like a healthy run.
      if (failed === 0) firstError = reason;
      failed++;
    }
  }
  if (failed > 0) console.log(`  first failure: ${firstError}`);
  // Reported on its own line, not folded into the summary below: that line's shape is matched
  // by the fork-e2e gate and by tests, and a retry count is diagnostic rather than a result.
  if (retried > 0) console.log(`  ${retried} product(s) imported only on the second attempt`);

  // Importing is not the same as serving: a pin can succeed while the gateway cannot return
  // the content. Ask the fork's own gateway for what was just pinned. One retry pass for
  // the misses: with the import succeeded the bytes are local, so a failed probe is nearly
  // always the gateway momentarily busy — a 377-CID sweep reliably trips one timeout, and a
  // single flaky probe should not read as a missing product.
  const serve = async (cid: string): Promise<boolean> => {
    try {
      const r = await fetch(`http://127.0.0.1:${ctx.ports.IPFS_GATEWAY_PORT}/ipfs/${cid}`, {
        signal: AbortSignal.timeout(30_000),
      });
      return r.ok;
    } catch {
      return false;
    }
  };
  let served = 0;
  const misses: string[] = [];
  for (const cid of cids) {
    if (await serve(cid)) served++;
    else misses.push(cid);
  }
  for (const cid of misses) {
    if (await serve(cid)) served++;
    else console.log(`  not served after retry: ${cid}`);
  }
  console.log(
    `pin-bulletin-products: imported ${imported}, failed ${failed} — ${served}/${cids.length} served locally`
  );
}
