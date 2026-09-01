// Repointing a binary or a whole release at a different source, without editing the descriptor.
//
// Why this exists: a consumer (triangle-e2e's release gate, a CI job testing one PR build)
// needs "previewnet, but this binary from that tag". Its options before this were to edit
// networks/<name>.json, duplicate it, or pre-seed bin/ and rely on `fetch --if-needed`
// skipping — and that skip is all-or-nothing, so a partial pre-seed makes PPN refetch and
// silently overwrite the pins it was given. A gate that reports pinned versions while running
// different ones is the worst failure that path can produce.
//
// Applied inside loadNetwork, so `fetch`, `generate`, `show` and `bite` cannot disagree about
// what a network is made of, and `ppn show --json` reports exactly what will run.

import type { NetworkDef, ReleasePin, RuntimeRef } from './networks.js';

/** One parsed override: which slot, and where it now comes from. */
export interface Override {
  /** Release key (`--release`) or binary name (`--binary`). */
  key: string;
  pin: ReleasePin;
}

export interface OverrideSet {
  releases: Override[];
  binaries: Override[];
  /** Keyed by chain (`asset-hub`), not by file: a chain has exactly one runtime. */
  runtimes: Override[];
}

/** Synthetic release key for a per-binary override, so validation still sees a declared pin. */
export const overrideReleaseKey = (binary: string) => `override:${binary}`;

/**
 * Parse `name=owner/repo@tag`. Also accepts `name=file:/abs/path` for a locally built
 * artifact, which is the honest spelling of what pre-seeding bin/ was doing implicitly.
 */
export function parseOverride(spec: string, what: string): Override {
  const eq = spec.indexOf('=');
  if (eq <= 0) {
    throw new Error(`${what} "${spec}" must be <name>=<owner/repo@tag> (or <name>=file:/path)`);
  }
  const key = spec.slice(0, eq).trim();
  const source = spec.slice(eq + 1).trim();
  if (!key) throw new Error(`${what} "${spec}" has an empty name`);

  if (source.startsWith('file:')) {
    const file = source.slice('file:'.length);
    if (!file) throw new Error(`${what} "${spec}" has an empty file path`);
    return { key, pin: { repo: source, tag: 'local' } };
  }

  const at = source.lastIndexOf('@');
  if (at <= 0) {
    throw new Error(`${what} "${spec}": "${source}" must be <owner/repo@tag> or file:/path`);
  }
  const repo = source.slice(0, at);
  const tag = source.slice(at + 1);
  if (!repo.includes('/')) throw new Error(`${what} "${spec}": "${repo}" must be owner/repo`);
  if (!tag) throw new Error(`${what} "${spec}": missing tag after @`);
  return { key, pin: { repo, tag } };
}

/**
 * Overrides from the environment. Flags cannot reach every caller — zombienet spawns custom
 * processes with no arguments, and a cloud VM gets env — so both channels exist and the flag
 * wins.
 *
 *   PPN_RELEASES="polkadot-sdk=paritytech/polkadot-sdk@polkadot-stable2606-1"
 *   PPN_BINARIES="polkadot-omni-node=paritytech/release-automation@polkadot-weekly2026w33-rc2"
 */
export function overridesFromEnv(env: NodeJS.ProcessEnv = process.env): OverrideSet {
  const parse = (value: string | undefined, what: string): Override[] =>
    (value ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => parseOverride(s, what));
  return {
    releases: parse(env.PPN_RELEASES, 'PPN_RELEASES entry'),
    binaries: parse(env.PPN_BINARIES, 'PPN_BINARIES entry'),
    runtimes: parse(env.PPN_RUNTIMES, 'PPN_RUNTIMES entry'),
  };
}

/** Later wins, so a flag overrides the same key set in the environment. */
export function mergeOverrides(...sets: OverrideSet[]): OverrideSet {
  const pick = (all: Override[]): Override[] => {
    const byKey = new Map<string, Override>();
    for (const o of all) byKey.set(o.key, o);
    return [...byKey.values()];
  };
  return {
    releases: pick(sets.flatMap((s) => s.releases)),
    binaries: pick(sets.flatMap((s) => s.binaries)),
    runtimes: pick(sets.flatMap((s) => s.runtimes)),
  };
}

/**
 * Apply overrides to a validated descriptor. Mutates nothing the caller owns: the returned
 * definition is a shallow-cloned structure with new releases and binary refs.
 *
 * A release override repoints every binary and runtime on that key. A binary override moves
 * one file only, through a synthetic release, so `polkadot` can stay on the weekly build
 * while `polkadot-omni-node` comes from somewhere else.
 */
export function applyOverrides(net: NetworkDef, set: OverrideSet): NetworkDef {
  if (set.releases.length === 0 && set.binaries.length === 0 && set.runtimes.length === 0) return net;

  const releases: Record<string, ReleasePin> = { ...net.releases };
  const applied: string[] = [];

  for (const o of set.releases) {
    if (!(o.key in releases)) {
      throw new Error(
        `--release "${o.key}" is not a release of ${net.name} ` +
          `(declared: ${Object.keys(net.releases).join(', ')})`
      );
    }
    releases[o.key] = o.pin;
    applied.push(o.key);
  }

  const binaryPins = new Map(set.binaries.map((o) => [o.key, o.pin]));
  const known = new Set<string>();
  const repoint = <T extends { name: string; release: string }>(ref: T): T => {
    known.add(ref.name);
    const pin = binaryPins.get(ref.name);
    if (!pin) return ref;
    const key = overrideReleaseKey(ref.name);
    releases[key] = pin;
    return { ...ref, release: key };
  };

  // A runtime is keyed by the chain that runs it: `--runtime asset-hub=file:/path` is how a
  // wasm built elsewhere — a CI artifact from a polkadot-fellows/runtimes branch, an srtool
  // build on a laptop — is fed in without publishing it anywhere first. `--release` could only
  // ever move a whole release, which is the wrong grain for one chain under test.
  const runtimePins = new Map(set.runtimes.map((o) => [o.key, o.pin]));
  const knownChains = new Set<string>();
  const repointRuntime = <T extends { runtime?: RuntimeRef }>(ref: T, chainKey: string): T => {
    knownChains.add(chainKey);
    const pin = runtimePins.get(chainKey);
    if (!pin) return ref;
    if (!ref.runtime) {
      throw new Error(
        `--runtime "${chainKey}" names a chain of ${net.name} that declares no runtime ` +
          '(a fork carries every runtime in the state it restores — use `ppn bite --upgrade` there)'
      );
    }
    const key = overrideReleaseKey(`runtime:${chainKey}`);
    releases[key] = pin;
    return { ...ref, runtime: { ...ref.runtime, release: key } };
  };

  const out: NetworkDef = {
    ...net,
    releases,
    relay: repointRuntime({ ...net.relay, binary: repoint(net.relay.binary) }, 'relay'),
    parachains: net.parachains.map((p) => repointRuntime({ ...p, binary: repoint(p.binary) }, p.key)),
    services: Object.fromEntries(
      Object.entries(net.services).map(([name, cfg]) =>
        cfg && typeof cfg === 'object' && cfg.binary
          ? [name, { ...cfg, binary: repoint(cfg.binary) }]
          : [name, cfg]
      )
    ) as NetworkDef['services'],
    tools: Object.fromEntries(
      Object.entries(net.tools).map(([name, ref]) => [name, repoint(ref)])
    ) as NetworkDef['tools'],
  };

  // A typo in a chain name would silently leave the declared runtime in place, and the run
  // would then test the runtime it was trying to replace.
  for (const chain of runtimePins.keys()) {
    if (!knownChains.has(chain)) {
      throw new Error(
        `--runtime "${chain}" is not a chain of ${net.name} (declared: ${[...knownChains].join(', ')})`
      );
    }
  }

  // A typo in a binary name would otherwise be silently ignored, and the gate would test the
  // binary it was trying to replace.
  for (const name of binaryPins.keys()) {
    if (!known.has(name)) {
      throw new Error(
        `--binary "${name}" is not a binary of ${net.name} (has: ${[...known].sort().join(', ')})`
      );
    }
  }
  return out;
}

/** Which slots an override set touched, for `show` and for logging what a run actually used. */
export function overriddenKeys(set: OverrideSet): Set<string> {
  return new Set([...set.releases.map((o) => o.key), ...set.binaries.map((o) => overrideReleaseKey(o.key))]);
}

/**
 * Everything that will actually be applied: the environment, plus flags on top. Callers report
 * from this rather than from their own flags — otherwise `ppn show` marks a flag override and
 * stays silent about an identical one arriving through PPN_BINARIES, which is the same
 * "reported one thing, ran another" trap the overrides exist to remove.
 */
export function effectiveOverrides(extra?: OverrideSet): OverrideSet {
  return mergeOverrides(overridesFromEnv(), extra ?? { releases: [], binaries: [], runtimes: [] });
}
