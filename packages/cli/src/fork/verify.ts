// Is a running fork actually working?
//
// Spawning a fork succeeds long before it is correct. The failures seen in practice were
// all of the "looks fine, isn't" kind: parachains converging on one chain because `chain`
// was missing, nodes producing but never finalizing because the dispute lifetime was
// unset, collators dying a hundred blocks in on pruned state, and a fork quietly rejoining
// production because bootNodes were not stripped. None of those show up as a failed spawn.
//
// So the checks here are the ones those bugs would have failed, against a live network.

import { rpc } from './rpc.js';
import type { ForkManifest } from './manifest.js';
import { sleep as realSleep, type Sleep } from './sleep.js';

export interface ChainTarget {
  key: string;
  url: string;
  /** Block the bite captured; the fork must continue from here, not restart. */
  biteBlock: number;
}

export interface ChainResult {
  key: string;
  best: number;
  finalized: number;
  produced: number;
  ok: boolean;
  problems: string[];
}

async function head(url: string): Promise<{ best: number; finalized: number }> {
  const [h, fh] = await Promise.all([
    rpc<{ number: string }>(url, 'chain_getHeader'),
    rpc<string>(url, 'chain_getFinalizedHead'),
  ]);
  const f = await rpc<{ number: string }>(url, 'chain_getHeader', [fh]);
  return { best: parseInt(h.number, 16), finalized: parseInt(f.number, 16) };
}

/**
 * Sample each chain twice, `waitMs` apart.
 *
 * Two samples rather than one because the interesting failures are all "stops after a
 * while": a single reading cannot tell a live chain from one that stalled at a plausible
 * height.
 */
export async function checkChains(
  targets: readonly ChainTarget[],
  waitMs: number,
  sleep: Sleep = realSleep
): Promise<ChainResult[]> {
  const first = new Map<string, { best: number; finalized: number }>();
  for (const t of targets) {
    try {
      first.set(t.key, await head(t.url));
    } catch {
      /* reported below as unreachable */
    }
  }
  await sleep(waitMs);

  const results: ChainResult[] = [];
  for (const t of targets) {
    const problems: string[] = [];
    const before = first.get(t.key);
    let now: { best: number; finalized: number } | null = null;
    try {
      now = await head(t.url);
    } catch (e) {
      problems.push(`unreachable: ${(e as Error).message}`);
    }

    if (!now) {
      results.push({ key: t.key, best: 0, finalized: 0, produced: 0, ok: false, problems });
      continue;
    }
    if (!before) {
      // Reachable now but not when sampling began, so the heights are real and the delta
      // is not. Reporting this as a plain zeroed row is what made four healthy collators
      // look dead in CI: say which half of the measurement is missing.
      problems.push('was unreachable when sampling started — production not measured');
      results.push({
        key: t.key,
        best: now.best,
        finalized: now.finalized,
        produced: 0,
        ok: false,
        problems,
      });
      continue;
    }

    // Continuing from the bite, not restarted at genesis: the whole point of a fork.
    if (now.best < t.biteBlock) {
      problems.push(`best #${now.best} is below the bite block #${t.biteBlock} — restarted?`);
    }
    const produced = now.best - before.best;
    if (produced <= 0) problems.push(`not producing (stuck at #${now.best})`);
    // Blocks without finality is the signature of the dispute-lifetime bug.
    if (now.finalized <= before.finalized) {
      problems.push(`not finalizing (stuck at #${now.finalized})`);
    }
    if (now.finalized < t.biteBlock) {
      problems.push(
        `finalized #${now.finalized} is below the bite block #${t.biteBlock} — restarted?`
      );
    }

    results.push({
      key: t.key,
      best: now.best,
      finalized: now.finalized,
      produced,
      ok: problems.length === 0,
      problems,
    });
  }
  return results;
}

export interface WaitOptions {
  /**
   * Also require each chain's finalized height to advance.
   *
   * A parachain block is only final once the relay block carrying its candidate is
   * finalized by GRANDPA, so for the first minute of a fork every parachain produces
   * blocks while its finality sits still — indistinguishable, in a 30s sample, from the
   * dispute-lifetime bug that leaves a chain permanently unfinalized. Waiting for one
   * finality step proves the pipeline is primed, and turns that race into a bounded wait.
   */
  requireFinality?: boolean;
  pollMs?: number;
  sleep?: Sleep;
  now?: () => number;
}

/**
 * Block until every chain is ready, or `timeoutMs` elapses.
 *
 * `checkChains` measures across two samples, so a chain it cannot reach for the first one
 * is unmeasurable however healthy it is. In fork mode the collators restore multi-hundred-MB
 * DB snapshots and come up long after the relay, so "the relay answers" is not a readiness
 * signal for the network — waiting on that alone is what made a CI run indict four
 * collators that were busily producing blocks.
 *
 * Chains drop out of the poll once ready; one that goes down afterwards is caught by the
 * production check that follows.
 */
export async function waitForChains(
  targets: readonly ChainTarget[],
  timeoutMs: number,
  opts: WaitOptions = {}
): Promise<{ ok: boolean; waitedMs: number; missing: string[] }> {
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? (() => Date.now());
  const pollMs = opts.pollMs ?? 5_000;
  const started = now();
  const firstFinalized = new Map<string, number>();
  let missing = targets.map((t) => t.key);

  for (;;) {
    const pending: string[] = [];
    for (const t of targets) {
      if (!missing.includes(t.key)) continue;
      try {
        const h = await head(t.url);
        if (opts.requireFinality) {
          const first = firstFinalized.get(t.key);
          if (first === undefined) firstFinalized.set(t.key, h.finalized);
          if (first === undefined || h.finalized <= first) pending.push(t.key);
        }
      } catch {
        pending.push(t.key);
      }
    }
    missing = pending;
    if (missing.length === 0) return { ok: true, waitedMs: now() - started, missing: [] };
    if (now() - started >= timeoutMs) return { ok: false, waitedMs: now() - started, missing };
    await sleep(pollMs);
  }
}

/**
 * Every parachain must be on its own chain.
 *
 * `fork-toml.ts` does set `chain` alongside `chain_spec_path` — this guards against losing
 * it again. Without it zombienet applies one spec to every parachain, and the only symptom
 * is their heights drifting together, so compare genesis hashes, which are unambiguous.
 */
export async function checkDistinctChains(
  targets: readonly ChainTarget[]
): Promise<{ ok: boolean; problems: string[] }> {
  const seen = new Map<string, string>();
  const problems: string[] = [];
  for (const t of targets) {
    try {
      const genesis = await rpc<string>(t.url, 'chain_getBlockHash', [0]);
      const other = seen.get(genesis);
      if (other) problems.push(`${t.key} and ${other} share genesis ${genesis}`);
      else seen.set(genesis, t.key);
    } catch {
      problems.push(`${t.key}: could not read genesis`);
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * The fork must have diverged from the network it was bitten from.
 *
 * Leaving bootNodes in the spawn specs makes the fork rejoin production and follow its
 * chain — which looks healthy on every other metric while not being a fork at all.
 */
export async function checkDiverged(
  forkRelayUrl: string,
  sourceRelayUrl: string,
  biteBlock: number
): Promise<{ ok: boolean; detail: string }> {
  const at = biteBlock + 5;
  const [mine, theirs] = await Promise.all([
    rpc<string | null>(forkRelayUrl, 'chain_getBlockHash', [at]).catch(() => null),
    rpc<string | null>(sourceRelayUrl, 'chain_getBlockHash', [at]).catch(() => null),
  ]);
  if (!mine) return { ok: false, detail: `fork has no block #${at}` };
  if (!theirs) return { ok: true, detail: `source has no block #${at}; nothing to compare` };
  return mine === theirs
    ? { ok: false, detail: `fork and source share block #${at} (${mine}) — not diverged` }
    : { ok: true, detail: `block #${at} differs from source` };
}

/** Chain targets for every chain the bundle carries. */
export function targetsFromManifest(
  manifest: ForkManifest,
  portOf: (key: string) => number,
  host = 'http://127.0.0.1'
): ChainTarget[] {
  return Object.entries(manifest.chains).map(([key, chain]) => ({
    key,
    url: `${host}:${portOf(key)}`,
    biteBlock: manifest.biteBlocks[chain.paraId === null ? 'relay' : String(chain.paraId)] ?? 0,
  }));
}
