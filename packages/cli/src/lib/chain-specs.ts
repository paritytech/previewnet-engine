// Which raw chain spec in the data directory belongs to which chain.
//
// Which basename exists depends on the mode (genesis writes <chainId>.json, a fork the
// source's name), and a fork's parachain specs land under the *source's* chain id
// (asset-hub-paseo.json, not asset-hub.json), which no descriptor field predicts. So the
// model's candidates are a hint and the disk is the authority: any <name>.json in the data
// directory that is not a plain spec or one of the engine's own files is offered, matched to
// a chain by longest shared prefix.

import fs from 'node:fs';

const SPEC_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const NOT_SPECS = new Set(['zombie', 'spawn', 'trinity-stack']);

/** Chain entry id -> spec basename, for the chains whose spec is on disk. */
export function chainSpecNames(
  dataDir: string,
  chains: { id: string; specCandidates?: string[] }[]
): Map<string, string> {
  let onDisk: string[];
  try {
    onDisk = fs
      .readdirSync(dataDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length))
      .filter((n) => SPEC_NAME.test(n) && !n.endsWith('-plain') && !NOT_SPECS.has(n));
  } catch {
    return new Map();
  }
  const specFor = (c: { id: string; specCandidates?: string[] }): string | undefined => {
    for (const n of c.specCandidates ?? []) if (onDisk.includes(n)) return n;
    // A relay entry is relay-<validator>; its spec is the relay's, already in candidates.
    if (c.id.startsWith('relay-')) return undefined;
    // Otherwise take the on-disk name that contains the chain key (asset-hub-paseo for
    // asset-hub); the longest match wins so `people` cannot claim `paseo-people`'s file
    // ahead of a more specific candidate.
    const matches = onDisk.filter((n) => n === c.id || n.includes(c.id));
    return matches.sort((a, b) => b.length - a.length)[0];
  };
  const names = new Map<string, string>();
  for (const c of chains) {
    const found = specFor(c);
    if (found) names.set(c.id, found);
  }
  return names;
}
