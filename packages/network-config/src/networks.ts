// Network descriptors: which networks PPN can run, and what each one is made of.
//
// One JSON file per network under networks/ at the repo root — see networks/README.md
// for the schema. A descriptor is self-contained: it names every artifact the network
// needs (node binary per chain, runtime WASM per chain for genesis, service binaries,
// the bite tool) and the exact release each comes from. Nothing resolves against
// config/versions.env, which holds only the shared local toolchain (zombienet, kubo,
// postgres, …) that is not part of any network.
//
// Releases are declared once in the `releases` table and referred to by name, so a
// version is written in one place per network. Every name is the descriptor author's
// own — there are no reserved or special-cased names.
//
// Everything that needs to know what a network is made of reads it through this one
// module: the config generators, every `ppn` command, and — through those — the shell
// that fetches artifacts, builds chain specs and bites live networks. When the shell
// could not call this, it grew its own copy of these rules in jq; two sets of rules over
// one file is how they drift.
//
// Local ports are NOT in the descriptor. Networks run one at a time on a machine, and
// every descriptor's parachains use the shared keys (asset-hub, people, …), so the
// ports.env slot for a key applies to whichever network is running.

import fs from 'node:fs';
import path from 'node:path';
import { defaultHome, packageRoot, networksDirs } from './repo-root.js';

/** The parachain keys PPN knows: what its port and per-chain flag tables are keyed by. */
export type Parachain = 'asset-hub' | 'people' | 'bulletin' | 'web3-storage';
export type ChainKey = 'relay' | Parachain;

/**
 * A descriptor may use any subset of these keys, in any order, with any para ids.
 */
export const PARACHAIN_KEYS: Parachain[] = ['asset-hub', 'people', 'bulletin', 'web3-storage'];

/** A GitHub release artifacts are taken from. */
export interface ReleasePin {
  repo: string;
  tag: string;
}

/** A binary a chain or service runs, and the release it comes from. */
export interface BinaryRef {
  /** Bare binary name, also the release asset name (plus platform suffix). */
  name: string;
  /** A key of the network's `releases` table. */
  release: string;
  /**
   * Set when the binary ships inside a tarball rather than as a bare asset.
   * `{tag}` and `{triple}` are substituted at fetch time.
   */
  archive?: string;
}

/** A runtime WASM a chain runs from genesis. Genesis networks (previewnet) only. */
export interface RuntimeRef {
  /** Asset name on the release. */
  asset: string;
  /** A key of the network's `releases` table. */
  release: string;
  /** Local filename under bin/, as the chain-spec builder and upgrade tooling expect it. */
  file: string;
}

/**
 * The chain spec a genesis network builds for this chain. `ppn generate` builds it and the
 * genesis config generator points zombienet at it, both from here — `chainId` is mandatory
 * alongside the file, or zombienet applies one spec to every parachain.
 */
export interface GenesisSpec {
  chainId: string;
  /** Human-readable chain name baked into the spec. */
  name: string;
  /** named-preset passed to chain-spec-builder. */
  preset: string;
  /** Local chain-spec filename under bin/. */
  file: string;
}

/** Genesis-wide settings for a network that builds its own chain specs. */
export interface GenesisConfig {
  /** chain-spec-builder -t, e.g. 'local'. */
  chainType: string;
  /** chain-spec-builder --properties, e.g. 'tokenSymbol=PAS,tokenDecimals=10'. */
  properties: string;
  /** Relay node names are `<validator>-<suffix>`; zombienet derives keys from them. */
  validatorNameSuffix: string;
  /**
   * The namespace product contexts are derived in, written into genesis. Optional: a
   * network that leaves it out keeps whatever its runtimes' presets ship with.
   * See `setNetworkSuffix` for which chains carry it.
   */
  networkSuffix?: string;
}

/** `MAX_NETWORK_SUFFIX_LENGTH` in indiv-support: the pallet's BoundedVec bound. */
export const MAX_NETWORK_SUFFIX_BYTES = 16;

/** Curve an Aura authority key is on. */
export type AuraScheme = 'sr25519' | 'ed25519';

export interface NetworkParachain {
  key: Parachain;
  /** The network's real para id — previewnet band (1500+) or system-chain band (1000+). */
  paraId: number;
  /** Basename of the chain spec inside a bundle: specs/<spec>.json. */
  spec: string;
  /** Absolute ws(s)/http(s) URL, or a path resolved against bite.source. */
  rpc: string;
  /** 'builtin', an absolute URL, or a path against bite.source. */
  specSource: string;
  /** The node binary this chain runs. Explicit — every chain declares its own. */
  binary: BinaryRef;
  /** The runtime this chain starts from at genesis. Genesis networks only. */
  runtime?: RuntimeRef;
  /** The chain spec built for this chain at genesis. Genesis networks only. */
  genesisSpec?: GenesisSpec;
  /** Extra node args for this chain, appended to the shared per-key flag table. */
  extraArgs: string[];
  /**
   * Curve this chain's Aura keys are on. Nearly every chain is sr25519; Polkadot's Asset Hub
   * is ed25519, and the collator authors nothing at all if the fork guesses wrong.
   */
  aura?: AuraScheme;
}

export interface NetworkRelay extends Omit<NetworkParachain, 'key' | 'paraId'> {
  /** Built-in chain name doppelganger runs with (ZOMBIE_CHAIN), e.g. 'paseo'. */
  chain: string;
  /** Dev-key validators the fork runs with, max 6 (alice…ferdie). */
  validators: number;
}

/** A chain of either kind, as networkChains() yields them. */
export type NetworkChain = Omit<NetworkParachain, 'key' | 'paraId'> & {
  key: ChainKey;
  paraId: number | null;
};

/** false disables a service; an object configures it (its binary, when it has one). */
export type ServiceConfig = boolean | { binary?: BinaryRef };

export interface NetworkDef {
  name: string;
  displayName: string;
  /** Spawnable from genesis. Previewnet only. */
  genesis: boolean;
  /** The live network has sudo. Without it CI cannot pre-bite. */
  sudo: boolean;
  bite: {
    prebaked: boolean;
    source: string;
    /** The doppelganger release that can execute this network's runtimes during a bite. */
    doppelganger?: ReleasePin;
    /**
     * The live relay carries parachains this network does not run.
     *
     * True for anything forked off a shared relay — paseo-next-v2, kusama, polkadot — and
     * false for previewnet, whose relay is ours end to end. It changes what a bite has to
     * override, because two things in the inherited relay state are then wrong for us:
     *
     *   cores  every registered parachain occupies one, so the relay splits our six dev
     *          validators across all of them and most groups come out empty. Ours sit on
     *          cores no group is ever assigned to, so nothing backs their blocks.
     *   HRMP   channel MQC heads move between the parachain snapshots and the relay
     *          snapshot. Messages delivered in that window are pruned from the relay, so a
     *          parachain can never reach the head the relay expects, and cumulus panics on
     *          `HRMP head mismatch` — it cannot build a block at all.
     *
     * See docs/FORK.md.
     */
    sharedRelay?: boolean;
  };
  /** Named releases every binary/runtime reference points into. */
  releases: Record<string, ReleasePin>;
  /** Genesis-wide chain-spec settings. Present on a genesis network. */
  genesisConfig?: GenesisConfig;
  relay: NetworkRelay;
  parachains: NetworkParachain[];
  /** Per-service switches and binaries for the custom processes. */
  services: Record<string, ServiceConfig>;
  /** Local tools this network needs that are neither a chain nor a service. */
  tools: Record<string, BinaryRef>;
  /**
   * DotNS product import (`ppn service pin-bulletin-products`), per network because every
   * DotNS deployment has its own contracts and its own place to fetch product bytes from.
   * `gateway` is only needed where that is not `bite.source`.
   */
  dotns?: {
    resolver?: string;
    gateway?: string;
    /** Known contract addresses of this network's DotNS deployment, name -> address. */
    addresses?: Record<string, string>;
    /**
     * Import this network's product content into the fork's IPFS. Off unless a network asks
     * for it: the import walks every product the resolver knows about and pulls each one's
     * bytes from the source gateway, which is minutes of work for a network whose products
     * are not what you are running it for. Override per spawn with PPN_PIN_PRODUCTS.
     */
    pinProducts?: boolean;
  };
  /** Every `_todo` note found in the file — non-empty means the descriptor is a stub. */
  todos: string[];
}

export interface ResolvedBinary extends ReleasePin {
  name: string;
  archive?: string;
}

export interface ResolvedRuntime extends ReleasePin {
  chain: string;
  asset: string;
  file: string;
}

export const DEFAULT_NETWORK = 'previewnet';



function collectTodos(value: unknown, at: string, into: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => collectTodos(v, `${at}[${i}]`, into));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === '_todo') into.push(`${at}: ${v}`);
      else collectTodos(v, at === '' ? k : `${at}.${k}`, into);
    }
  }
}

/** Every network with a descriptor, sorted. */
export function listNetworks(): string[] {
  // Union, not first-wins: a workspace that adds a network must not hide the ones that
  // shipped, and the error message for an unknown name has to list everything runnable.
  const dirs = networksDirs();
  if (dirs.length === 0) {
    throw new Error(
      'no networks/ directory found.\n' +
        '       A network is defined by a descriptor, and none shipped with this install.\n' +
        '       Point PPN_HOME at a directory containing networks/<name>.json,\n' +
        `       or put them in ${defaultHome()}/networks/, which is checked by default.`
    );
  }
  const names = new Set<string>();
  for (const dir of dirs) {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.json')) names.add(f.replace(/\.json$/, ''));
    }
  }
  return [...names].sort();
}

/** Read and validate one network descriptor. */
/** Parse and validate one descriptor. Overrides are applied by ./load.ts. */
export function loadDescriptor(name: string): NetworkDef {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`invalid network name: ${name}`);
  const file = networksDirs()
    .map((dir) => path.join(dir, `${name}.json`))
    .find((f) => fs.existsSync(f));
  if (!file) {
    throw new Error(`unknown network "${name}" — known: ${listNetworks().join(', ')}`);
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));

  const bad = (why: string): never => {
    throw new Error(`networks/${name}.json: ${why}`);
  };
  if (raw.name !== name) bad(`"name" is "${raw.name}", must match the filename`);
  if (raw.dotns?.pinProducts !== undefined && typeof raw.dotns.pinProducts !== 'boolean') {
    bad('dotns.pinProducts must be true or false');
  }
  if (!raw.relay?.chain || !raw.relay?.spec || !raw.relay?.rpc || !raw.relay?.specSource) {
    bad('relay needs chain, spec, rpc and specSource');
  }
  if (!raw.bite?.source) bad('bite.source is required');
  if (!Array.isArray(raw.parachains) || raw.parachains.length === 0) {
    bad('at least one parachain is required');
  }

  const releases: Record<string, ReleasePin> = Object.fromEntries(
    Object.entries(raw.releases ?? {}).filter(([k]) => !k.startsWith('_'))
  ) as Record<string, ReleasePin>;
  for (const [rel, pin] of Object.entries(releases)) {
    if (!pin?.repo || !pin?.tag) bad(`releases.${rel} needs repo and tag`);
  }

  // Every chain names its binary, and every reference resolves inside this file. One
  // binary name must not come from two releases — the files collide in bin/.
  const usedReleases = new Set<string>();
  const binaryRelease = new Map<string, string>();
  // Runtime WASMs are fetched into the same flat bin/ as the binaries, keyed by `file`, so two
  // chains naming one file is the same collision — with a worse failure. A binary that clashes
  // is at least the same program; two runtimes silently overwrite each other and whichever
  // chain fetches second boots the *other* chain's WASM, with nothing to say so.
  const runtimeFile = new Map<string, string>();
  const checkRelease = (at: string, rel: unknown): string => {
    if (typeof rel !== 'string' || !(rel in releases)) {
      bad(
        `${at}.release "${rel}" is not declared in releases ` +
          `(${Object.keys(releases).join(', ') || 'empty'})`
      );
    }
    usedReleases.add(rel as string);
    return rel as string;
  };
  const checkBinary = (at: string, ref: BinaryRef): BinaryRef => {
    if (!ref?.name) bad(`${at}.binary needs { name, release }`);
    if (!/^[a-z0-9-]+$/.test(ref.name)) bad(`${at}.binary.name must be a bare binary name`);
    checkRelease(`${at}.binary`, ref.release);
    const prev = binaryRelease.get(ref.name);
    if (prev !== undefined && prev !== ref.release) {
      bad(
        `binary "${ref.name}" is bound to two releases ("${prev}" and "${ref.release}") — ` +
          'they would collide in bin/'
      );
    }
    binaryRelease.set(ref.name, ref.release);
    return ref;
  };
  const checkRuntime = (at: string, ref?: RuntimeRef): RuntimeRef | undefined => {
    if (ref === undefined) return undefined;
    if (!ref.asset || !ref.file) bad(`${at}.runtime needs { asset, release, file }`);
    checkRelease(`${at}.runtime`, ref.release);
    const prev = runtimeFile.get(ref.file);
    if (prev !== undefined && prev !== at) {
      bad(
        `runtime file "${ref.file}" is claimed by two chains ("${prev}" and "${at}") — ` +
          'they would collide in bin/'
      );
    }
    runtimeFile.set(ref.file, at);
    return ref;
  };
  const checkArgs = (at: string, args: unknown): string[] => {
    if (args === undefined) return [];
    if (!Array.isArray(args) || args.some((x) => typeof x !== 'string' || !x.startsWith('-'))) {
      bad(`${at}.extraArgs must be an array of "--flag" strings`);
    }
    return args as string[];
  };

  checkBinary('relay', raw.relay.binary);
  checkRuntime('relay', raw.relay.runtime);
  const seen = new Set<string>();
  for (const p of raw.parachains) {
    if (!PARACHAIN_KEYS.includes(p.key)) {
      bad(`parachain key "${p.key}" is not one of: ${PARACHAIN_KEYS.join(', ')}`);
    }
    if (!Number.isInteger(p.paraId) || p.paraId <= 0) {
      bad(`parachain ${p.key} needs a positive paraId`);
    }
    if (!p.spec || !p.rpc || !p.specSource) bad(`parachain ${p.key} needs spec, rpc and specSource`);
    if (p.aura !== undefined && p.aura !== 'sr25519' && p.aura !== 'ed25519') {
      bad(`parachain ${p.key}: aura must be "sr25519" or "ed25519"`);
    }
    checkBinary(`parachains.${p.key}`, p.binary);
    checkRuntime(`parachains.${p.key}`, p.runtime);
    if (seen.has(p.key)) bad(`parachain ${p.key} listed twice`);
    seen.add(p.key);
  }
  const ids = raw.parachains.map((p: NetworkParachain) => p.paraId);
  if (new Set(ids).size !== ids.length) bad('duplicate para ids');

  // A genesis network builds its chain specs locally, so every chain needs a runtime to
  // build from and a spec to build into, and the network needs the settings they share.
  if (raw.genesis === true) {
    const gc = raw.genesisConfig;
    if (!gc?.chainType || !gc?.properties || !gc?.validatorNameSuffix) {
      bad('a genesis network needs genesisConfig { chainType, properties, validatorNameSuffix }');
    }
    // The suffix goes into a BoundedVec<u8, 16>, so an over-long one is rejected here
    // rather than by genesis validation with a much less helpful message.
    if (gc?.networkSuffix !== undefined) {
      const bytes = Buffer.byteLength(gc.networkSuffix, 'utf8');
      if (bytes === 0) bad('genesisConfig.networkSuffix cannot be empty');
      if (bytes > MAX_NETWORK_SUFFIX_BYTES) {
        bad(`genesisConfig.networkSuffix is ${bytes} bytes, over the ${MAX_NETWORK_SUFFIX_BYTES}-byte bound`);
      }
    }
    const chains: [string, NetworkParachain][] = [
      ['relay', raw.relay],
      ...raw.parachains.map((p: NetworkParachain) => [`parachains.${p.key}`, p] as [string, NetworkParachain]),
    ];
    for (const [at, chain] of chains) {
      if (!chain.runtime) bad(`a genesis network needs ${at}.runtime`);
      const g = chain.genesisSpec;
      if (!g?.chainId || !g?.name || !g?.preset || !g?.file) {
        bad(`a genesis network needs ${at}.genesisSpec { chainId, name, preset, file }`);
      }
    }
  }

  const validators = raw.relay.validators ?? 6;
  if (!Number.isInteger(validators) || validators < 1 || validators > 6) {
    bad('relay.validators must be 1..6 (alice…ferdie)');
  }

  const services: Record<string, ServiceConfig> = raw.services ?? {};
  for (const [svc, cfg] of Object.entries(services)) {
    if (cfg && typeof cfg === 'object' && cfg.binary) checkBinary(`services."${svc}"`, cfg.binary);
  }
  const tools: Record<string, BinaryRef> = Object.fromEntries(
    Object.entries(raw.tools ?? {}).filter(([k]) => !k.startsWith('_'))
  ) as Record<string, BinaryRef>;
  for (const [tool, ref] of Object.entries(tools)) checkBinary(`tools."${tool}"`, ref);

  const dg = raw.bite.doppelganger;
  if (dg && (!dg.repo || !dg.tag)) bad('bite.doppelganger needs repo and tag');

  const unused = Object.keys(releases).filter((r) => !usedReleases.has(r));
  if (unused.length) bad(`releases declared but never used: ${unused.join(', ')}`);

  const todos: string[] = [];
  collectTodos(raw, '', todos);

  return {
    name: raw.name,
    displayName: raw.displayName ?? raw.name,
    genesis: raw.genesis === true,
    sudo: raw.sudo === true,
    bite: {
      prebaked: raw.bite.prebaked === true,
      source: raw.bite.source,
      doppelganger: dg,
      sharedRelay: raw.bite.sharedRelay === true,
    },
    releases,
    genesisConfig: raw.genesisConfig,
    relay: { ...raw.relay, validators, extraArgs: checkArgs('relay', raw.relay.extraArgs) },
    parachains: raw.parachains.map((p: NetworkParachain) => ({
      ...p,
      extraArgs: checkArgs(`parachains.${p.key}`, p.extraArgs),
    })),
    services,
    tools,
    dotns: raw.dotns,
    todos,
  };
}

/** PPN_NETWORK, or previewnet. */
export function currentNetworkName(): string {
  return process.env.PPN_NETWORK || DEFAULT_NETWORK;
}

/**
 * Every binary the network declares, with its release resolved — exactly what `make
 * fetch` downloads into the network's bin directory. A service switched off with
 * `false` contributes nothing; which of the remaining processes actually run is decided
 * when the zombienet config is generated, not here.
 */
export function networkBinaries(net: NetworkDef): ResolvedBinary[] {
  const refs: BinaryRef[] = [net.relay.binary, ...net.parachains.map((p) => p.binary)];
  for (const cfg of Object.values(net.services)) {
    if (cfg !== false && typeof cfg === 'object' && cfg.binary) refs.push(cfg.binary);
  }
  refs.push(...Object.values(net.tools));

  const out = new Map<string, ResolvedBinary>();
  for (const ref of refs) {
    const pin = net.releases[ref.release];
    out.set(ref.name, { name: ref.name, archive: ref.archive, ...pin });
  }
  return [...out.values()];
}

/**
 * Every runtime WASM the network's genesis needs, with its release resolved. Empty for
 * a fork-only network, which restores every runtime from the state it carries.
 */
export function networkRuntimes(net: NetworkDef): ResolvedRuntime[] {
  const entries: [string, RuntimeRef | undefined][] = [
    ['relay', net.relay.runtime],
    ...net.parachains.map((p) => [p.key, p.runtime] as [string, RuntimeRef | undefined]),
  ];
  return entries
    .filter((e): e is [string, RuntimeRef] => e[1] !== undefined)
    .map(([chain, r]) => ({
      chain,
      asset: r.asset,
      file: r.file,
      ...net.releases[r.release],
    }));
}

/**
 * The chains a bite covers, in the order it needs them: relay first, then parachains.
 */
export function networkChains(net: NetworkDef): NetworkChain[] {
  return [{ key: 'relay', paraId: null, ...net.relay }, ...net.parachains];
}

/**
 * Resolve a descriptor rpc entry: absolute URLs pass through, paths join bite.source.
 */
export function endpointUrl(net: NetworkDef, rpc: string): string {
  return /^(wss?|https?):\/\//.test(rpc) ? rpc : `${net.bite.source}/${rpc}`;
}

/**
 * Where a chain spec comes from at bite time: `builtin:<chain>` for one built into the
 * node binary, otherwise an absolute URL (a relative entry joins the base URL).
 */
export function specSourceUrl(net: NetworkDef, chain: NetworkChain, baseUrl?: string): string {
  const src = chain.specSource;
  // Bare `builtin` is the relay's own spec. A parachain names its chain explicitly
  // (`builtin:asset-hub-kusama`): a public system chain carries a spec its binary can build,
  // so unlike Paseo's Asset Hub it needs no host to publish one.
  if (src === 'builtin') return `builtin:${net.relay.chain}`;
  if (src.startsWith('builtin:')) return src;
  if (/^https?:\/\//.test(src)) return src;
  return `${baseUrl ?? net.bite.source}/${src}`;
}

/** For JSON-RPC over fetch(): ws(s):// endpoints answer POSTs on their http(s) twin. */
export function asHttp(url: string): string {
  return url.replace(/^ws(s?):\/\//, 'http$1://');
}

/** For node flags like --relay-chain-rpc-url, which want a websocket URL. */
export function asWs(url: string): string {
  return url.replace(/^http(s?):\/\//, 'ws$1://');
}
