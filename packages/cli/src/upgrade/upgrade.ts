// Live runtime upgrade for a running chain (relay or parachain).
//
// The genesis-time WASM substitution (`POST /api/runtimes` + --wasm-runtime-overrides)
// cannot touch a fork: forked state belongs to the runtimes production is running, which
// is why spawn-request.ts rejects runtime overrides in fork mode. Upgrading on-chain —
// authorize_upgrade, then apply_authorized_upgrade — is the one correct way to change a
// fork's runtime, and it works the same against a genesis network.
//
// Two hard-won implementation constraints, both discovered against live PPN chains:
//
// - Built on polkadot-api, not @polkadot/api: the next-* runtimes reject every extrinsic
//   polkadot-js signs (the node panics in validate_transaction), while PAPI-signed ones —
//   the stack the integration tests already use — are accepted on all five chains.
//
// - PAPI is used for encoding and signing ONLY; everything after submission is verified
//   over plain legacy JSON-RPC (fork/verify.ts style). Watching the enacting extrinsic
//   through PAPI leaks unboundedly when its own block swaps the runtime (relay), and
//   PAPI storage queries need pinned blocks — on a 2-second-block parachain the watcher
//   falls behind, blocks unpin, and the fallback hits archive_* methods the omni-node
//   does not serve. Raw `state_getStorageHash(':code')` needs none of that, and it *is*
//   the blake2-256 of the code blob — the very hash the upgrade authorized.
//
// Deliberately browser-clean: no `node:` imports, no file IO, provider injected by the
// caller. Files, argv and secrets live in scripts/runtime-upgrade.js; a later browser
// bundle can reuse this module unchanged with the web WS provider.

import { Binary, createClient } from 'polkadot-api';
import type { PolkadotSigner } from 'polkadot-api/signer';
import { blake2b256, ss58Decode } from '@polkadot-labs/hdkd-helpers';
import { keyOf } from '../fork/codec.js';
import { signerFromUri } from './signer.js';

type Provider = Parameters<typeof createClient>[0];

/** The well-known ':code' storage key — where a chain keeps its runtime. */
const CODE_KEY = '0x3a636f6465';

export type WasmFormat = 'compressed' | 'raw';

/**
 * A runtime blob is either compact-compressed (what srtool and release CI produce —
 * same magic check the spawner's upload endpoint does) or a raw wasm module. Anything
 * else is a wrong file, and better rejected here than as an inscrutable on-chain error.
 */
export function wasmFormat(bytes: Uint8Array): WasmFormat {
  if (bytes.length >= 4) {
    if (bytes[0] === 0x52 && bytes[1] === 0xbc && bytes[2] === 0x53 && bytes[3] === 0x76) {
      return 'compressed';
    }
    if (bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6d) {
      return 'raw';
    }
  }
  throw new Error(
    'not a runtime WASM: expected compact-compressed (0x52bc5376) or raw (\\0asm) magic bytes'
  );
}

/** One way of getting new code onto a chain, as pallet/call names plus argument shape. */
export interface Strategy {
  label: string;
  /** Root call to wrap in sudo.sudo; null for the bare set_code fallback. */
  authorize: { pallet: string; call: string; args: (hash: Binary) => Record<string, unknown> } | null;
  /** Plain signed call carrying the code; null for the bare set_code fallback. */
  apply: { pallet: string; call: string; args: (code: Binary) => Record<string, unknown> } | null;
  /** Root call to wrap in sudo.sudo_unchecked_weight; only for the set_code fallback. */
  setCode: { pallet: string; call: string; args: (code: Binary) => Record<string, unknown> } | null;
}

/**
 * Upgrade paths in preference order; the first one the runtime actually exposes wins
 * (existence is probed by encoding the call against live metadata).
 *
 * Preferred: frame-system authorize_upgrade + apply_authorized_upgrade — present on the
 * relay and all four parachains here, and safe on parachains (enactment goes through the
 * relay's PVF pre-check and go-ahead). `allowSameSpec` swaps in the without-checks
 * variant for applying a blob whose spec_version is not bumped — exactly what an e2e run
 * applying production's own runtime to a fork needs.
 *
 * Fallbacks, for runtimes predating the frame-system calls: cumulus's
 * parachainSystem.authorize_upgrade (whose check_version flag covers allowSameSpec), and
 * finally bare set_code under sudo_unchecked_weight — still parachain-safe, because
 * cumulus routes frame_system's OnSetCode through schedule_code_upgrade.
 */
export function strategyCandidates(allowSameSpec: boolean): Strategy[] {
  const system = (call: string): Strategy => ({
    label: `System.${call}`,
    authorize: { pallet: 'System', call, args: (hash) => ({ code_hash: hash }) },
    apply: {
      pallet: 'System',
      call: 'apply_authorized_upgrade',
      args: (code) => ({ code }),
    },
    setCode: null,
  });
  const parachainSystem: Strategy = {
    label: 'ParachainSystem.authorize_upgrade',
    authorize: {
      pallet: 'ParachainSystem',
      call: 'authorize_upgrade',
      args: (hash) => ({ code_hash: hash, check_version: !allowSameSpec }),
    },
    apply: {
      pallet: 'ParachainSystem',
      call: 'enact_authorized_upgrade',
      args: (code) => ({ code }),
    },
    setCode: null,
  };
  const setCode = (call: string): Strategy => ({
    label: `System.${call}`,
    authorize: null,
    apply: null,
    setCode: { pallet: 'System', call, args: (code) => ({ code }) },
  });

  return allowSameSpec
    ? [system('authorize_upgrade_without_checks'), parachainSystem, setCode('set_code_without_checks')]
    : [system('authorize_upgrade'), parachainSystem, setCode('set_code')];
}

/** The decoded event shape PAPI yields in transaction results. */
export interface DecodedEvent {
  type: string;
  value: { type: string; value?: unknown };
}

/**
 * The dispatch error buried in a Sudo.Sudid event, or null. sudo.sudo reports success at
 * the extrinsic level even when the inner call failed — trusting that is how an upgrade
 * "succeeds" without authorizing anything.
 */
export function sudidError(events: readonly DecodedEvent[]): string | null {
  for (const e of events) {
    if (e.type !== 'Sudo' || e.value.type !== 'Sudid') continue;
    const result = (e.value.value as { sudo_result?: { success: boolean; value: unknown } })
      ?.sudo_result;
    if (result && !result.success) return JSON.stringify(result.value);
  }
  return null;
}

/** The HTTP endpoint of a substrate WS endpoint — same port, same path. */
/**
 * Whether the chain already runs exactly this blob — the same compare the upgrade
 * itself short-circuits on. Exposed so callers can skip work a no-op never needs
 * (the sudo top-up: its transfer is itself a transaction, and on previewnet's
 * bulletin that transfer is the flakiest call in the whole flow).
 */
export async function alreadyInstalled(wsUrl: string, wasm: Uint8Array): Promise<boolean> {
  const codeHash = Binary.fromBytes(blake2b256(wasm)).asHex();
  const onChain = await rawRpc<string>(httpFromWs(wsUrl), 'state_getStorageHash', [CODE_KEY]);
  return onChain === codeHash;
}

export function httpFromWs(wsUrl: string): string {
  return wsUrl.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
}

async function rawRpc<T>(httpUrl: string, method: string, params: unknown[] = []): Promise<T> {
  let r: Response;
  try {
    r = await fetch(httpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    // undici's "fetch failed" says neither where nor why; the cause does.
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const why = cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err));
    throw new Error(`${method} at ${httpUrl}: ${why}`);
  }
  const j = (await r.json()) as { result?: T; error?: unknown };
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result as T;
}

export interface UpgradeOptions {
  /** Connection to the target chain, e.g. wsProvider() from ./provider-node.js. */
  provider: Provider;
  /** The WS endpoint the provider points at; verification derives its HTTP URL from it. */
  wsUrl: string;
  /** Override for the HTTP JSON-RPC endpoint when it is not simply http(s)://<wsUrl>. */
  httpUrl?: string;
  wasm: Uint8Array;
  /** Sudo signer; defaults to //Alice (sudo on every PPN chain, genesis and fork). */
  signer?: PolkadotSigner;
  /** Use the without-checks path so a blob without a spec_version bump can be applied. */
  allowSameSpec?: boolean;
  /** How long to wait for the upgrade to enact (parachains wait on the relay go-ahead). */
  enactTimeoutMs?: number;
  /** Finalized blocks required after enactment before the upgrade counts as healthy. */
  finalityBlocks?: number;
  finalityTimeoutMs?: number;
  pollMs?: number;
  log?: (msg: string) => void;
}

export interface UpgradeResult {
  specName: string;
  fromSpecVersion: number;
  toSpecVersion: number;
  strategy: string;
  codeHash: string;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s ${what}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function bytesEq(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

interface RuntimeVersion {
  specName: string;
  specVersion: number;
}

/**
 * Passthrough defaults for the custom signed extensions the PPN runtimes declare.
 * PAPI refuses to sign when metadata lists an extension it cannot fill ("Missing
 * VerifyMultiSignature signed extension" on People); `value: undefined` encodes each
 * one's empty/None branch — the same convention triangle-e2e's chain-tests use.
 * Entries a runtime does not declare are simply unused.
 */
export const TX_OPTIONS = {
  customSignedExtensions: {
    // An enum, not an Option — Disabled is its passthrough branch (the same value
    // triangle-e2e's lts-claim uses).
    VerifyMultiSignature: { value: { type: 'Disabled', value: undefined } },
    AsPgas: { value: undefined },
    AsRingAlias: { value: undefined },
  },
} as const;

/** Fields PAPI's tx event stream is read through below. */
interface TxEvent {
  type: string;
  found?: boolean;
  ok?: boolean;
  dispatchError?: unknown;
  events?: DecodedEvent[];
  block?: { hash: string };
}

/** The slice of a PAPI transaction this module touches. */
interface SubmittableTx {
  signSubmitAndWatch: (signer: PolkadotSigner, options?: object) => { subscribe: Function };
  sign: (signer: PolkadotSigner, options?: object) => Promise<string>;
  getEncodedData: () => Promise<unknown>;
  decodedCall?: unknown;
}

/**
 * Sign, submit, and wait for finalization. Rejects on a failed extrinsic — including a
 * failed inner call of sudo.sudo, which the Sudid event carries. Only for transactions
 * that do NOT enact new code (see the module header); the authorize step qualifies.
 */
function signAndFinalize(
  tx: SubmittableTx,
  signer: PolkadotSigner,
  label: string,
  log: (msg: string) => void
): Promise<{ events: DecodedEvent[] }> {
  return new Promise((resolve, reject) => {
    const sub = tx.signSubmitAndWatch(signer, TX_OPTIONS).subscribe({
      next: (ev: TxEvent) => {
        if (ev.type === 'txBestBlocksState' && ev.found) {
          log(`  ${label}: in block ${ev.block?.hash ?? ''}`);
        }
        if (ev.type !== 'finalized') return;
        const events = ev.events ?? [];
        if (!ev.ok) {
          reject(new Error(`${label} failed: ${JSON.stringify(ev.dispatchError)}`));
        } else {
          const inner = sudidError(events);
          if (inner) {
            reject(new Error(`${label} failed (inner sudo call): ${inner}`));
          } else {
            log(`  ${label}: finalized in ${ev.block?.hash ?? ''}`);
            resolve({ events });
          }
        }
        sub.unsubscribe?.();
      },
      error: (err: Error) => reject(new Error(`${label} failed: ${err.message}`)),
    });
  });
}

/**
 * Submit a pre-signed extrinsic over raw HTTP RPC, without watching (see the module
 * header for why the enacting extrinsic must not be watched — it is also why it is
 * signed BEFORE the PAPI client is destroyed and submitted after, so no client exists
 * across the runtime boundary at all). The node still validates on submission — a
 * malformed transaction is rejected here; the on-chain outcome is read back by
 * verifyUpgrade.
 */
async function submitRaw(
  httpUrl: string,
  signed: string,
  label: string,
  log: (msg: string) => void
): Promise<string> {
  const hash = await rawRpc<string>(httpUrl, 'author_submitExtrinsic', [signed]);
  log(`  ${label}: submitted ${hash}`);
  return hash;
}

/** Extrinsic hash as the node computes it: blake2-256 of the encoded bytes. */
function txHash(extrinsicHex: string): string {
  return Binary.fromBytes(blake2b256(Binary.fromHex(extrinsicHex).asBytes())).asHex();
}

/** The finalized head's number. */
async function finalizedNumber(httpUrl: string): Promise<number> {
  const finHash = await rawRpc<string>(httpUrl, 'chain_getFinalizedHead');
  const header = await rawRpc<{ number: string }>(httpUrl, 'chain_getHeader', [finHash]);
  return parseInt(header.number, 16);
}

/**
 * Wait until ':code' has been unchanged for the last `stableBlocks` finalized blocks.
 *
 * A PAPI client created within seconds of an enactment enters a hot loop and eats
 * gigabytes (observed at ~150MB/s on polkadot-api 1.23), while one created a little
 * later behaves; back-to-back upgrades of the same chain are exactly the flow that
 * hits it. Bounded: proceeds after `maxWaitMs` with a warning rather than blocking
 * forever on a chain that upgrades continuously.
 */
async function waitForQuiescence(
  httpUrl: string,
  stableBlocks: number,
  maxWaitMs: number,
  pollMs: number,
  log: (msg: string) => void
): Promise<void> {
  const deadline = Date.now() + maxWaitMs;
  let warned = false;
  for (;;) {
    const n = await finalizedNumber(httpUrl);
    const [current, earlier] = await Promise.all([
      rawRpc<string | null>(httpUrl, 'state_getStorageHash', [CODE_KEY]),
      rawRpc<string>(httpUrl, 'chain_getBlockHash', [Math.max(0, n - stableBlocks)]).then(
        (h) => rawRpc<string | null>(httpUrl, 'state_getStorageHash', [CODE_KEY, h]),
        () => null // history pruned or unavailable: treat as unknown, not as a change
      ),
    ]);
    if (earlier === null || earlier === current) return;
    if (Date.now() > deadline) {
      log('warning: the chain kept changing code; proceeding without quiescence');
      return;
    }
    if (!warned) {
      warned = true;
      log(`the code changed within the last ${stableBlocks} blocks — letting the node settle`);
    }
    await sleep(pollMs);
  }
}

/** Wait until `blocks` more finalized blocks exist; throw on timeout. */
async function verifyFinality(
  httpUrl: string,
  blocks: number,
  timeoutMs: number,
  pollMs: number,
  log: (msg: string) => void
): Promise<void> {
  const start = await finalizedNumber(httpUrl);
  const deadline = Date.now() + timeoutMs;
  let last = start;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${blocks} finalized blocks (${timeoutMs / 1000}s) — ` +
          'is the chain still finalizing?'
      );
    }
    await sleep(pollMs);
    const n = await finalizedNumber(httpUrl);
    if (n === last) continue;
    last = n;
    log(`  finalized +${Math.min(n - start, blocks)}/${blocks} (#${n})`);
    if (n >= start + blocks) return;
  }
}

/** ParachainSystem.PendingValidationCode — set while an upgrade awaits the relay. */
const PENDING_CODE_KEY = `0x${keyOf('ParachainSystem', 'PendingValidationCode')}`;

interface VerifyParams {
  httpUrl: string;
  /** Hash of the raw-submitted enacting extrinsic, to locate and judge its inclusion. */
  pendingTx: string;
  /** Finalized height before submission; inclusion is scanned upward from here. */
  startBlock: number;
  /** blake2-256 of the blob — what ':code' must hash to once enacted. */
  targetCodeHash: string;
  /** Storage key a successful apply must consume, with 0x prefix; null for set_code. */
  authKey: string | null;
  enactTimeoutMs: number;
  finalityBlocks: number;
  finalityTimeoutMs: number;
  pollMs: number;
  log: (msg: string) => void;
}

/**
 * Watch the chain over raw RPC until the upgrade is enacted and `finalityBlocks` more
 * finalized blocks exist; throw on timeout or on-chain rejection.
 *
 * Enactment means the finalized ':code' hashes to the authorized value. The trailing
 * finalized blocks are the actual contract: a chain that enacts and then stops
 * finalizing is a failed upgrade whatever the code hash says.
 *
 * Rejection has one subtle shape: apply_authorized_upgrade is designed to be callable
 * unsigned, so a bad blob does not fail the extrinsic — it "succeeds" while leaving the
 * authorization in place. Authorization-not-consumed at the inclusion block IS the
 * failure signal, and catches ExtrinsicFailed variants too.
 */
async function verifyUpgrade(p: VerifyParams): Promise<{ enactedAt: number }> {
  const deadlineEnact = Date.now() + p.enactTimeoutMs;
  const deadlineAll = deadlineEnact + p.finalityTimeoutMs;
  let scanFrom = p.startBlock + 1;
  let applyAt: number | null = null;
  let enactedAt: number | null = null;
  let lastSeen = p.startBlock;
  // On a parachain, the relay can ABORT a scheduled upgrade (observed in the wild):
  // PendingValidationCode appears with the apply and later vanishes with no code
  // change. Watching that transition turns a silent 5-minute timeout into an answer.
  let sawPendingCode = false;

  for (;;) {
    if (enactedAt === null && Date.now() > deadlineEnact) {
      throw new Error(
        `upgrade not enacted after ${p.enactTimeoutMs / 1000}s` +
          (applyAt === null
            ? ' — the apply extrinsic was never included in a finalized block'
            : ' — on a parachain the relay PVF pre-check and go-ahead take a while; check the relay is finalizing')
      );
    }
    if (Date.now() > deadlineAll) {
      throw new Error(
        `timed out waiting for ${p.finalityBlocks} finalized blocks after enactment ` +
          `(${p.finalityTimeoutMs / 1000}s) — is the chain still finalizing?`
      );
    }
    await sleep(p.pollMs);

    const finHash = await rawRpc<string>(p.httpUrl, 'chain_getFinalizedHead');
    const header = await rawRpc<{ number: string }>(p.httpUrl, 'chain_getHeader', [finHash]);
    const n = parseInt(header.number, 16);
    if (n === lastSeen) continue;
    lastSeen = n;

    // Locate the enacting extrinsic in the newly finalized blocks, and judge it.
    if (applyAt === null) {
      for (let b = scanFrom; b <= n; b++) {
        const bh = await rawRpc<string>(p.httpUrl, 'chain_getBlockHash', [b]);
        const block = await rawRpc<{ block: { extrinsics: string[] } }>(
          p.httpUrl,
          'chain_getBlock',
          [bh]
        );
        if (!block.block.extrinsics.some((x) => txHash(x) === p.pendingTx)) continue;
        applyAt = b;
        if (p.authKey) {
          const auth = await rawRpc<string | null>(p.httpUrl, 'state_getStorageHash', [
            p.authKey,
            bh,
          ]);
          if (auth) {
            throw new Error(
              'the upgrade was rejected on-chain (authorization not consumed by the apply ' +
                'extrinsic): blob/hash mismatch, or a version check — a blob without a ' +
                'spec_version bump needs ALLOW_SAME_SPEC=1'
            );
          }
        }
        p.log(`  apply included in finalized #${b}`);
        break;
      }
      scanFrom = n + 1;
    }

    if (enactedAt === null) {
      const h = await rawRpc<string | null>(p.httpUrl, 'state_getStorageHash', [
        CODE_KEY,
        finHash,
      ]);
      if (h === p.targetCodeHash) {
        enactedAt = n;
        p.log(`  enacted by finalized #${n}`);
        continue;
      }
      if (applyAt !== null) {
        const pendingCode = await rawRpc<string | null>(p.httpUrl, 'state_getStorageHash', [
          PENDING_CODE_KEY,
          finHash,
        ]);
        if (pendingCode) {
          sawPendingCode = true;
        } else if (sawPendingCode) {
          throw new Error(
            'the relay aborted the scheduled upgrade (PendingValidationCode was dropped ' +
              'without the code changing) — check the relay logs for the PVF pre-check outcome'
          );
        }
      }
      continue;
    }

    p.log(`  finalized +${Math.min(n - enactedAt, p.finalityBlocks)}/${p.finalityBlocks} (#${n})`);
    if (n >= enactedAt + p.finalityBlocks) return { enactedAt };
  }
}

/**
 * Upgrade the runtime of the chain behind `provider` and verify it survived.
 * Resolves only once the new code is enacted and the chain has finalized
 * `finalityBlocks` more blocks; throws on anything less.
 */
export async function runtimeUpgrade(opts: UpgradeOptions): Promise<UpgradeResult> {
  const log = opts.log ?? (() => {});
  const allowSameSpec = opts.allowSameSpec ?? false;
  const httpUrl = opts.httpUrl ?? httpFromWs(opts.wsUrl);

  const format = wasmFormat(opts.wasm);
  if (format === 'raw') {
    log('warning: raw (uncompressed) wasm — releases normally ship compact-compressed blobs');
  }
  const code = Binary.fromBytes(opts.wasm);
  const codeHash = Binary.fromBytes(blake2b256(opts.wasm));

  await waitForQuiescence(httpUrl, 20, 180_000, opts.pollMs ?? 2_000, log);

  const client = createClient(opts.provider);
  const api = client.getUnsafeApi();
  let clientAlive = true;
  const destroyClient = () => {
    if (clientAlive) {
      clientAlive = false;
      client.destroy();
    }
  };

  try {
    const [chainName, version] = await withTimeout(
      Promise.all([
        rawRpc<string>(httpUrl, 'system_chain'),
        rawRpc<RuntimeVersion>(httpUrl, 'state_getRuntimeVersion'),
      ]),
      30_000,
      `connecting to ${httpUrl}`
    );
    const { specName, specVersion: fromSpecVersion } = version;
    log(`connected to ${chainName} (${specName}/${fromSpecVersion}) at ${opts.wsUrl}`);
    log(`code: ${opts.wasm.length} bytes (${format}), blake2-256 ${codeHash.asHex()}`);

    // Fail before submitting anything if the signer is not sudo — on the deployed
    // profile (PPN_PROFILE=deployable) Alice is stripped and PPN_SUDO_URI is required.
    // Checked ahead of the no-op shortcut below, so a misconfigured key is always
    // reported loudly instead of being masked by a blob that happens to match.
    // A chain without a Sudo pallet (a fork of Kusama or Polkadot) has no key to check: the
    // authorization was seeded at bite time and the apply is unsigned, so the signer is unused.
    const signer = opts.signer ?? signerFromUri('//Alice').signer;
    if (api.query.Sudo) {
      const sudoKey = (await api.query.Sudo.Key.getValue()) as string | undefined;
      if (!sudoKey || !bytesEq(ss58Decode(sudoKey)[0], signer.publicKey)) {
        throw new Error(
          `signer is not the sudo key (${sudoKey ?? 'unset'}) — ` +
            'set PPN_SUDO_URI to the operator key on a deployable-profile network'
        );
      }
    } else {
      log('no Sudo pallet on this chain — relying on the authorization seeded at bite time');
    }

    // A byte-identical blob is a no-op, and must not be submitted: the chain already
    // runs this code, ':code' cannot move, and — the expensive lesson — a parachain
    // never receives a relay go-ahead for a PVF identical to its current one, so the
    // scheduled upgrade sits in PendingValidationCode forever and blocks every future
    // upgrade. Verify the chain is healthy and report success instead.
    const onChainCodeHash = await rawRpc<string>(httpUrl, 'state_getStorageHash', [CODE_KEY]);
    if (onChainCodeHash === codeHash.asHex()) {
      log('the chain already runs exactly this code — nothing to submit');
      destroyClient();
      const finalityBlocks = opts.finalityBlocks ?? 5;
      log(`verifying the chain keeps finalizing (${finalityBlocks} blocks)`);
      await verifyFinality(
        httpUrl,
        finalityBlocks,
        opts.finalityTimeoutMs ?? 180_000,
        opts.pollMs ?? 2_000,
        log
      );
      log(`upgrade complete: ${specName} ${fromSpecVersion} (already installed)`);
      return {
        specName,
        fromSpecVersion,
        toSpecVersion: fromSpecVersion,
        strategy: 'already-installed',
        codeHash: codeHash.asHex(),
      };
    }

    // First strategy whose calls exist in this runtime's metadata wins; existence is
    // probed by encoding, which is the same check submission would do.
    let strategy: Strategy | null = null;
    let authorizeTx: SubmittableTx | null = null;
    let applyTx: SubmittableTx | null = null;
    let setCodeTx: SubmittableTx | null = null;
    for (const candidate of strategyCandidates(allowSameSpec)) {
      try {
        if (candidate.setCode) {
          const t = api.tx[candidate.setCode.pallet][candidate.setCode.call](
            candidate.setCode.args(code)
          ) as SubmittableTx;
          await t.getEncodedData();
          setCodeTx = t;
        } else {
          const a = api.tx[candidate.authorize!.pallet][candidate.authorize!.call](
            candidate.authorize!.args(codeHash)
          ) as SubmittableTx;
          const p = api.tx[candidate.apply!.pallet][candidate.apply!.call](
            candidate.apply!.args(code)
          ) as SubmittableTx;
          await Promise.all([a.getEncodedData(), p.getEncodedData()]);
          authorizeTx = a;
          applyTx = p;
        }
        strategy = candidate;
        break;
      } catch {
        /* runtime does not expose this path; try the next one */
      }
    }
    if (!strategy) {
      throw new Error(
        'this runtime exposes no known upgrade call ' +
          '(System.authorize_upgrade / ParachainSystem.authorize_upgrade / System.set_code)'
      );
    }
    log(`strategy: ${strategy.label}`);

    const startHeader = await rawRpc<{ number: string }>(httpUrl, 'chain_getHeader', [
      await rawRpc<string>(httpUrl, 'chain_getFinalizedHead'),
    ]);
    const startBlock = parseInt(startHeader.number, 16);

    // Sign the enacting extrinsic while the client is alive, then destroy the client
    // BEFORE submitting it: a live PAPI client whose chainHead follow crosses the
    // runtime change leaks memory without bound (gigabytes per upgrade). Everything
    // from here on is raw HTTP RPC, which has no such state.
    let enactingLabel: string;
    let enactingSigned: string;
    if (setCodeTx) {
      const sudoTx = api.tx.Sudo.sudo_unchecked_weight({
        call: setCodeTx.decodedCall,
        weight: { ref_time: 1n, proof_size: 0n },
      }) as SubmittableTx;
      enactingLabel = `sudo(${strategy.label})`;
      enactingSigned = await sudoTx.sign(signer, TX_OPTIONS);
    } else if (!api.tx.Sudo) {
      // No Sudo pallet, so `authorize_upgrade` — a root call — can never be made here. The
      // authorization has to be in state already, written during the bite (`ppn bite
      // --upgrade <chain>=<wasm>`); this submits only the apply half, which is callable
      // unsigned by design. If nothing seeded it, the apply is rejected and verifyUpgrade
      // reports the authorization was never consumed.
      log(`${strategy.label}: no Sudo pallet — expecting an authorization seeded at bite time`);
      enactingLabel = `${strategy.apply!.pallet}.${strategy.apply!.call}`;
      enactingSigned = await applyTx!.sign(signer, TX_OPTIONS);
    } else {
      const sudoTx = api.tx.Sudo.sudo({ call: authorizeTx!.decodedCall }) as SubmittableTx;
      await signAndFinalize(sudoTx, signer, `sudo(${strategy.label})`, log);
      // On the relay the apply enacts in its own block; on a parachain it only
      // schedules, and enactment arrives with the relay go-ahead a few blocks later.
      enactingLabel = `${strategy.apply!.pallet}.${strategy.apply!.call}`;
      enactingSigned = await applyTx!.sign(signer, TX_OPTIONS);
    }
    destroyClient();

    const pendingTx = await submitRaw(httpUrl, enactingSigned, enactingLabel, log);

    await verifyUpgrade({
      httpUrl,
      pendingTx,
      startBlock,
      targetCodeHash: codeHash.asHex(),
      authKey: strategy.authorize ? `0x${keyOf(strategy.authorize.pallet, 'AuthorizedUpgrade')}` : null,
      // The PVF pre-check has been observed to take anywhere from seconds to minutes
      // for the same network, so the enactment ceiling errs on the generous side.
      enactTimeoutMs: opts.enactTimeoutMs ?? 600_000,
      finalityBlocks: opts.finalityBlocks ?? 5,
      finalityTimeoutMs: opts.finalityTimeoutMs ?? 180_000,
      pollMs: opts.pollMs ?? 2_000,
      log,
    });

    const after = await rawRpc<RuntimeVersion>(httpUrl, 'state_getRuntimeVersion');
    log(`upgrade complete: ${specName} ${fromSpecVersion} -> ${after.specName} ${after.specVersion}`);
    return {
      specName,
      fromSpecVersion,
      toSpecVersion: after.specVersion,
      strategy: strategy.label,
      codeHash: codeHash.asHex(),
    };
  } finally {
    destroyClient();
  }
}
