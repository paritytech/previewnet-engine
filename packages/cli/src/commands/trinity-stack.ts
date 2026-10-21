// `ppn service trinity-stack` — writes the network's Trinity stack descriptor.
//
// One zombienet custom_process. Once the chains answer, it writes into the data directory a
// light-client spec per chain and the descriptor that names them, then rewrites both every
// PPN_STACK_REFRESH_SECONDS so the relay's checkpoint stays recent. The descriptor is a file,
// not an API: a signature and a content hash cover exact bytes, and nginx, CI and the
// dashboard can all serve the same file. See docs/TRINITY-STACK.md.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  chainKey,
  dashboardModel,
  trinityStackModel,
  trinityStackUrl,
  type ChainKey,
  type DashboardChain,
  type StackChainFacts,
  type StackFacts,
} from '@parity/ppn-network-config';
import { encodeLink, lightSpecGenesis, publicKey, publish } from '@parity/trinity-stack';
import type { ServiceContext } from './service-context.js';
import { rpc } from '../fork/rpc.js';
import { chainSpecNames } from '../lib/chain-specs.js';
import { foreignBootnodes, lightClientBootnodes, lightSpec } from '../lib/light-spec.js';
import { readSpawnStamp } from '../lib/spawn-stamp.js';
import { STACK_FILE, STACK_STATE_FILE, lightSpecFile, type StackStateFile } from '../lib/stack-files.js';

const RETRY_SECONDS = 30;
const DEFAULT_REFRESH_SECONDS = 6 * 3600;

const sleep = (seconds: number) => new Promise((r) => setTimeout(r, seconds * 1000));
const asHttp = (url: string) => url.replace(/^ws/, 'http');
const sha256 = (bytes: Uint8Array) => `0x${crypto.createHash('sha256').update(bytes).digest('hex')}`;

/** Replaces a file only when its bytes change, so a reader never sees a half-written one. */
function writeIfChanged(file: string, bytes: Uint8Array): void {
  if (fs.existsSync(file) && Buffer.from(bytes).equals(fs.readFileSync(file))) return;
  fs.writeFileSync(`${file}.tmp`, bytes);
  fs.renameSync(`${file}.tmp`, file);
}

function readState(file: string): StackStateFile | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as StackStateFile;
  } catch {
    return null;
  }
}

/** The first node of each chain: the relay's is alice, a parachain's its first collator. */
function chainNodes(chains: DashboardChain[]): [ChainKey, DashboardChain][] {
  const nodes = new Map<ChainKey, DashboardChain>();
  for (const c of chains) if (!nodes.has(chainKey(c.id))) nodes.set(chainKey(c.id), c);
  return [...nodes];
}

export interface Settings {
  /** JSON-RPC to a local node; a fake in tests. */
  call: typeof rpc;
  now: () => Date;
  baseUrl: string;
  dataDir: string;
  bootnodeHost: string;
  secret?: Uint8Array;
  faucet?: string;
  expiresAt?: number;
  validFor?: number;
}

/** One chain's genesis, its light spec written to disk, and its specs' hashes. */
async function chainFacts(
  s: Settings,
  key: ChainKey,
  node: DashboardChain,
  specName: string | undefined,
  forkBlock: number | undefined
): Promise<StackChainFacts> {
  const url = asHttp(node.directUrl);
  const genesisHash = await s.call<string>(url, 'chain_getBlockHash', [0]);
  if (!genesisHash) throw new Error(`${key}: no genesis block yet`);
  const facts: StackChainFacts = { genesisHash };
  if (forkBlock !== undefined) {
    const hash = await s.call<string | null>(url, 'chain_getBlockHash', [forkBlock]);
    if (!hash) throw new Error(`${key}: the node has no block #${forkBlock}, where it was bitten`);
    facts.forkedAt = { number: forkBlock, hash };
  }
  if (!specName) return facts;

  const fullBytes = fs.readFileSync(path.join(s.dataDir, `${specName}.json`));
  const full = JSON.parse(fullBytes.toString('utf-8')) as Record<string, unknown> & { bootNodes?: string[] };
  const bootNodes = full.bootNodes ?? [];
  const foreign = foreignBootnodes(bootNodes, [s.bootnodeHost, '127.0.0.1']);
  if (foreign.length > 0) {
    throw new Error(`${specName}.json names nodes this network does not run: ${foreign.join(', ')}`);
  }
  if (foreignBootnodes(bootNodes, [s.bootnodeHost]).length > 0) {
    throw new Error(`${specName}.json: bootnodes not patched to ${s.bootnodeHost} yet`);
  }
  facts.fullSpec = { url: `${s.baseUrl}/chainspecs/${specName}.json`, sha256: sha256(fullBytes) };

  const header = await s.call<{ stateRoot: string }>(url, 'chain_getHeader', [genesisHash]);
  const peerId = await s.call<string>(url, 'system_localPeerId');
  let checkpoint: unknown;
  if (key === 'relay') {
    try {
      checkpoint = (await s.call<{ lightSyncState?: unknown }>(url, 'sync_state_genSyncSpec', [true])).lightSyncState;
    } catch (err) {
      console.warn(`trinity-stack: no relay checkpoint yet (${(err as Error).message})`);
      return facts;
    }
  }
  const bootnodes = lightClientBootnodes(s.baseUrl, s.bootnodeHost, key, peerId);
  const lightBytes = new TextEncoder().encode(JSON.stringify(lightSpec(full, header.stateRoot, bootnodes, checkpoint)));
  const implied = lightSpecGenesis(lightBytes);
  if (implied !== genesisHash) throw new Error(`${specName}: light spec implies genesis ${implied}, chain has ${genesisHash}`);
  writeIfChanged(path.join(s.dataDir, lightSpecFile(specName)), lightBytes);
  facts.lightSpec = { url: `${s.baseUrl}/chainspecs/${lightSpecFile(specName)}`, sha256: sha256(lightBytes) };
  return facts;
}

/** The EVM chain id eth-rpc reports, or undefined while it is not up. */
async function ethChainId(s: Settings, directUrl: string): Promise<number | undefined> {
  try {
    return parseInt(await s.call<string>(directUrl, 'eth_chainId'), 16);
  } catch {
    return undefined;
  }
}

/**
 * Writes the light specs and the descriptor once. Returns what the dashboard shows, and whether
 * the descriptor is complete: a relay has no checkpoint until it finalizes a block, and eth-rpc
 * is left out until it answers.
 */
export async function writeStack(
  ctx: Pick<ServiceContext, 'net'>,
  s: Settings
): Promise<{ written: StackStateFile; complete: boolean }> {
  const model = dashboardModel(ctx.net, s.baseUrl);
  const spawn = readSpawnStamp(s.dataDir);
  const forked = spawn?.mode === 'fork';
  const bite = forked ? spawn.bite : null;
  const specs = chainSpecNames(s.dataDir, model.chains);

  const chains: StackFacts['chains'] = {};
  for (const [key, node] of chainNodes(model.chains)) {
    const paraId = node.paraId === null ? 'relay' : String(node.paraId);
    chains[key] = await chainFacts(s, key, node, specs.get(node.id), bite?.blocks[paraId]);
  }
  const eth = model.services.find((e) => e.id === 'eth-rpc');
  const chainId = eth && (await ethChainId(s, eth.directUrl));
  const now = s.now();
  const stack = trinityStackModel(ctx.net, model, {
    chains,
    ethChainId: chainId,
    forked,
    forkAt: bite ? Math.floor(Date.parse(bite.at) / 1000) : undefined,
    faucet: s.faucet,
    expiresAt: s.expiresAt,
    validUntil: s.validFor ? Math.floor(now.getTime() / 1000) + s.validFor : undefined,
  });

  // The generation is minted with the data directory, so it changes exactly when the chains
  // restart from scratch: a wipe, or a fork started again from its bite.
  const stateFile = path.join(s.dataDir, STACK_STATE_FILE);
  const previous = readState(stateFile);
  const generation = previous?.generation ?? spawn?.spawnedAt ?? now.toISOString();
  const published = await publish(stack, { generation, state: previous?.state, secret: s.secret, now });
  writeIfChanged(path.join(s.dataDir, STACK_FILE), published.document);

  const pointer = { url: trinityStackUrl(s.baseUrl), ...(s.secret && { key: publicKey(s.secret) }) };
  const written: StackStateFile = { generation, state: published.state, pointer, link: encodeLink(pointer) };
  writeIfChanged(stateFile, new TextEncoder().encode(JSON.stringify(written, null, 2) + '\n'));
  const specsComplete = Object.values(chains).every((c) => !c?.fullSpec || c.lightSpec);
  return { written, complete: specsComplete && (!eth || chainId !== undefined) };
}

function hexSecret(value: string | undefined): Uint8Array | undefined {
  if (!value) return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('PPN_STACK_SECRET must be 0x and 64 hex digits');
  return Uint8Array.from(Buffer.from(value.slice(2), 'hex'));
}

function optionalNumber(name: string, value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

export async function trinityStack(ctx: ServiceContext): Promise<void> {
  // zombienet hands custom processes no environment, so the deployment's settings arrive in
  // the ports files, which loadContext merged into process.env.
  const setting = (name: string) => process.env[name] || ctx.ports[name] || undefined;
  if (setting('PPN_EPHEMERAL') === '1') {
    console.log('trinity-stack: an ephemeral run has no data directory to publish from');
    return;
  }
  if (!ctx.net.stack?.tld && !ctx.net.genesisConfig?.networkSuffix) {
    console.log(`trinity-stack: networks/${ctx.net.name}.json names no TLD, so there is no descriptor to write`);
    return;
  }
  const s: Settings = {
    call: rpc,
    now: () => new Date(),
    baseUrl: ctx.baseUrl,
    dataDir: ctx.dataDir,
    bootnodeHost: setting('BOOTNODE_HOSTNAME') || '127.0.0.1',
    secret: hexSecret(setting('PPN_STACK_SECRET')),
    faucet: setting('PPN_STACK_FAUCET_URL'),
    expiresAt: optionalNumber('PPN_STACK_EXPIRES_AT', setting('PPN_STACK_EXPIRES_AT')),
    validFor: optionalNumber('PPN_STACK_VALID_FOR', setting('PPN_STACK_VALID_FOR')),
  };
  // A copy must be replaced before its validUntil, or readers show the stack as stale.
  const refresh = Math.min(
    optionalNumber('PPN_STACK_REFRESH_SECONDS', setting('PPN_STACK_REFRESH_SECONDS')) ?? DEFAULT_REFRESH_SECONDS,
    s.validFor ? Math.max(RETRY_SECONDS, Math.floor(s.validFor / 2)) : Infinity
  );

  for (;;) {
    try {
      const { written, complete } = await writeStack(ctx, s);
      console.log(`trinity-stack: sequence ${written.state.sequence}, ${written.link}`);
      await sleep(complete ? refresh : RETRY_SECONDS);
    } catch (err) {
      console.log(`trinity-stack: ${(err as Error).message}; retrying in ${RETRY_SECONDS}s`);
      await sleep(RETRY_SECONDS);
    }
  }
}
