// The fork-bundle format: what `ppn bite` writes and `generateForkToml` reads.
//
// The shape lives here, in the package both sides depend on, rather than next to the code
// that produces it — otherwise config generation would have to import the bite tooling,
// which is backwards and would make the dependency graph a cycle.

export interface ForkManifestChain {
  paraId: number | null;
  /** Basename of the chain spec inside the bundle. */
  spec: string;
  /** Resolved http(s) JSON-RPC URL the chain was bitten from. Absent in old bundles. */
  endpoint?: string;
  specName: string;
  specVersion: number;
  headAtStart: number;
  genesis: string;
}

export interface ForkManifest {
  bittenAt: string;
  source: string;
  /** Which networks/<name>.json this bundle is a bite of. Absent in old bundles: previewnet. */
  network?: string;
  nodeVersion: string;
  epochDuration: number;
  chains: Record<string, ForkManifestChain>;
  /** Keyed by para id, plus "relay". Written by bite.sh once each chain is bitten. */
  biteBlocks: Record<string, number>;
  /** Same keys as biteBlocks. Absent in bundles bitten before it was recorded. */
  snapshotBytes?: Record<string, number>;
  /**
   * Runtimes authorized at import, keyed as biteBlocks is. A fork of a chain with no sudo
   * cannot authorize an upgrade once it is running, so the authorization is written into
   * state at bite time and the blob travels in the bundle under upgrades/<key>.wasm —
   * `ppn runtime-upgrade` submits the apply half, which needs no privilege.
   */
  seededUpgrades?: Record<string, { file: string; codeHash: string; checkVersion: boolean }>;
}

