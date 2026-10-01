// What `ppn bite --cores <chain=n> --collators <chain=n>` asks for, checked against the network
// and settled into the ForkTopology the bundle records.
//
// Settled at bite time, not at spawn: the collator authority sets and the relay's core layout
// are state inside the snapshots (fork/validators.ts, fork/shared-relay.ts), so the fork TOML
// can only follow what the bundle says. A bundle bitten with the defaults carries no topology.

import type { ForkTopology, NetworkDef } from '@parity/ppn-network-config';
import { planCores } from './shared-relay.js';
import { MAX_VALIDATORS } from './validators.js';

function parseCounts(flag: string, specs: string[] | undefined, net: NetworkDef): Record<string, number> {
  const counts: Record<string, number> = {};
  const known = net.parachains.map((p) => p.key);
  for (const spec of specs ?? []) {
    const at = spec.indexOf('=');
    if (at < 1) throw new Error(`${flag} wants <chain>=<count>, got "${spec}"`);
    const key = spec.slice(0, at);
    const count = Number(spec.slice(at + 1));
    if (!known.includes(key as never)) {
      throw new Error(`${flag} names "${key}", which ${net.name} does not run (${known.join(', ')})`);
    }
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`${flag} ${key}: a count is a whole number of at least 1, not "${spec.slice(at + 1)}"`);
    }
    counts[key] = count;
  }
  return counts;
}

/**
 * The topology a bite was asked for, or undefined when it was asked for nothing.
 *
 * The validator count is not asked for: every core needs a validator group of its own or nothing
 * backs the blocks on it, so it is the descriptor's count or the number of cores, whichever is
 * larger. That is capped where the relay ports run out (MAX_VALIDATORS).
 */
export function resolveTopology(
  opts: { cores?: string[]; collators?: string[] },
  net: NetworkDef
): ForkTopology | undefined {
  const cores = parseCounts('--cores', opts.cores, net);
  const collators = parseCounts('--collators', opts.collators, net);
  if (!Object.keys(cores).length && !Object.keys(collators).length) return undefined;

  const totalCores = planCores(net.parachains, cores).length;
  const validators = Math.max(net.relay.validators, totalCores);
  if (validators > MAX_VALIDATORS) {
    throw new Error(
      `--cores adds up to ${totalCores} cores, which need ${totalCores} validators; a fork runs at most ${MAX_VALIDATORS}`
    );
  }
  return { validators, cores, collators };
}

/** Whether a bundle was bitten with this topology — both absent counts as the same. */
export function sameTopology(a: ForkTopology | undefined, b: ForkTopology | undefined): boolean {
  const norm = (t: ForkTopology | undefined) =>
    JSON.stringify(t ? { v: t.validators, c: sorted(t.cores), k: sorted(t.collators) } : null);
  const sorted = (r: Record<string, number>) => Object.fromEntries(Object.entries(r).sort());
  return norm(a) === norm(b);
}

/** The flags that ask for a topology, for an error message that says how to re-bite. */
export function topologyFlags(t: ForkTopology): string {
  return [
    ...Object.entries(t.cores).map(([k, n]) => `--cores ${k}=${n}`),
    ...Object.entries(t.collators).map(([k, n]) => `--collators ${k}=${n}`),
  ].join(' ');
}
