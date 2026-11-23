// What `ppn bite --cores <chain=n> --collators <chain=n>` asks for, checked against the network
// and settled into the ForkTopology the bundle records.
//
// Settled at bite time, not at spawn: the collator authority sets and the relay's core layout
// are state inside the snapshots (fork/validators.ts, fork/shared-relay.ts), so the fork TOML
// can only follow what the bundle says. A bundle carries a topology only when it was asked for
// one or its descriptor's cores need more validators than `relay.validators`.

import { MAX_VALIDATORS, type ForkTopology, type NetworkDef } from '@parity/ppn-network-config';
import { planCores, replacesCoreLayout } from './shared-relay.js';

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
 * The topology of a bite, or undefined when it was asked for nothing and the descriptor's
 * validators staff every core it lays out.
 *
 * The validator count is not asked for: every core a bite lays out needs a validator group of its
 * own or nothing backs the blocks on it, so it is the descriptor's count or the number of those
 * cores, whichever is larger. That is capped where the relay ports run out (MAX_VALIDATORS).
 */
export function resolveTopology(
  opts: { cores?: string[]; collators?: string[] },
  net: NetworkDef
): ForkTopology | undefined {
  const cores = parseCounts('--cores', opts.cores, net);
  const collators = parseCounts('--collators', opts.collators, net);
  const totalCores = replacesCoreLayout(net.bite.sharedRelay === true, cores) ? planCores(net.parachains, cores).length : 0;
  const validators = Math.max(net.relay.validators, totalCores);
  if (validators > MAX_VALIDATORS) {
    throw new Error(
      `the bite lays out ${totalCores} cores, which need ${totalCores} validators; a fork runs at most ${MAX_VALIDATORS}`
    );
  }
  const asked = Object.keys(cores).length > 0 || Object.keys(collators).length > 0;
  return asked || validators > net.relay.validators ? { validators, cores, collators } : undefined;
}

/**
 * Whether a bundle was bitten with the `--cores` and `--collators` a run asks for, none on both
 * sides counting as the same. The validator count follows from them and the descriptor of the
 * engine that bit the bundle, and the fork TOML takes it from the bundle.
 */
export function sameTopology(a: ForkTopology | undefined, b: ForkTopology | undefined): boolean {
  const sorted = (r: Record<string, number> = {}) => Object.fromEntries(Object.entries(r).sort());
  const norm = (t: ForkTopology | undefined) => JSON.stringify({ c: sorted(t?.cores), k: sorted(t?.collators) });
  return norm(a) === norm(b);
}

/** The flags that ask for a topology, for an error message that says how to re-bite. */
export function topologyFlags(t: ForkTopology): string {
  return [
    ...Object.entries(t.cores).map(([k, n]) => `--cores ${k}=${n}`),
    ...Object.entries(t.collators).map(([k, n]) => `--collators ${k}=${n}`),
  ].join(' ');
}
