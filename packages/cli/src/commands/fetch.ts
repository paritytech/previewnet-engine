// `ppn fetch` — download everything the selected network needs.
//
// What gets fetched is decided by the descriptor, not by a list here: every chain, service
// and tool in networks/<name>.json names its binary and the release it comes from, and
// this downloads exactly that set. The shared toolchain around them — zombienet, kubo,
// postgres, the identity binaries, design families — has no per-network dimension and is
// pinned in config/versions.env.
//
// Two destinations, which is why they are named separately below:
//   node binaries   bin/ for previewnet, bin/<network>/ for anything else, since two
//                   networks legitimately run different builds of the same binary
//   shared tooling  always plain bin/, one copy whichever network is running
//
// `--if-needed` makes this the whole of `make`'s "ensure binaries" step: whether the set
// is complete is a decision about the descriptor, so it belongs here rather than in a
// Makefile probing for one filename it had to be told.
//
// Usage: ppn fetch [binDir] [--if-needed]

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  loadCurrentNetwork,
  networkBinaries,
  networkRuntimes,
  readEnvFile,
  type ResolvedBinary,
  repoRoot,
  workspaceRoot,
} from '@parity/ppn-network-config';
import {
  githubToken,
  fetchRelease,
  downloadAsset,
  downloadRepoFile,
  downloadUrl,
  makeExecutable,
  type Release,
} from '../lib/github.js';
import { extractTarGz, extractZip, findFile, withTempDir } from '../lib/archive.js';
import { writeProvenance, readProvenance, reusable, type StampInput } from '../lib/provenance.js';

/**
 * A `file:` pin is a path, not a repo: `--binary polkadot=file:/build/polkadot`, or
 * `--runtime asset-hub=file:/artifacts/asset-hub-kusama.wasm`. It is how something built
 * elsewhere — a CI artifact, an srtool run, a local cargo build — is fed in without being
 * published anywhere first.
 *
 * `parseOverride` has accepted this spelling all along and `ppn show` printed it, but nothing
 * here honoured it: the pin went to the GitHub API as a repo name and came back "could not
 * read release file:/... (HTTP 404) — check that your token can read file:/...", which is
 * advice about a token for a path on disk.
 */
function localPin(repo: string): string | null {
  return repo.startsWith('file:') ? repo.slice('file:'.length) : null;
}

function copyLocal(src: string, dest: string, what: string): void {
  if (!fs.existsSync(src)) throw new Error(`${what}: no file at ${src}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

const REPO = repoRoot();
/** Mutable state — binaries, chain data, bundles — lives in the workspace, not the package. */
const WS = workspaceRoot();

// The identity backend is one binary with ten roles as of v0.2.0. Absent, the identity
// processes do not start; everything else still works, which is why it is reported rather
// than fatal on its own.
// `dub` since v0.3.0, `ibv2` before it — the name is part of the asset name too, so an older
// DUB_TAG needs the pair below changed with it rather than just the tag.
const IDENTITY_BINARY = 'dub';

interface Platform {
  /** Suffix on polkadot-sdk-style release assets; empty on Linux x86_64. */
  suffix: string;
  /** Rust target triple, for archives whose name embeds it. */
  triple: string;
  zombienet: string;
  kubo: string;
}

function platform(): Platform {
  const key = `${process.platform}-${process.arch}`;
  switch (key) {
    case 'darwin-arm64':
      return {
        suffix: '-aarch64-apple-darwin',
        triple: 'aarch64-apple-darwin',
        zombienet: 'zombie-cli-aarch64-apple-darwin',
        kubo: 'darwin-arm64',
      };
    case 'linux-x64':
      return {
        suffix: '',
        triple: 'x86_64-unknown-linux-gnu',
        zombienet: 'zombie-cli-x86_64-unknown-linux-gnu',
        kubo: 'linux-amd64',
      };
    default:
      throw new Error(`unsupported platform: ${key} (PPN builds for linux-x64 and darwin-arm64)`);
  }
}

const ok = (what: string) => console.log(`  ✓ ${what}`);
/**
 * Already on disk, at the same resolved tag and the same bytes — nothing downloaded. Marked
 * distinctly from ✓ so a fetch that reuses everything is visibly different from one that
 * re-pulled it all, which is the whole point of the skip.
 */
const current = (what: string) => console.log(`  = ${what} (current)`);

// Every absence, collected rather than thrown at, so one run reports all of them. The run
// still fails at the end: printing ✗ and exiting 0 half-installs bin/ and the real error
// surfaces later as an unexplained spawn failure. That matters most on a moving tag —
// `latest` on a release channel that has published incomplete builds (1, 4 and 11 assets
// against a normal 47) would otherwise leave binaries silently absent.
const absent: string[] = [];
const missing = (what: string, why = '') => {
  absent.push(`${what}${why ? ` (${why})` : ''}`);
  console.log(`  ✗ ${what}${why ? ` (${why})` : ''}`);
};

export interface FetchOptions {
  /** Skip the download when everything the descriptor declares is already present. */
  ifNeeded?: boolean;
  /**
   * Re-download every artifact even when the previous stamp proves it is current. The escape
   * hatch for a suspect bin/ — a partial extract, a file edited by hand — where the stamp
   * agrees with the disk but neither is what the release holds.
   */
  force?: boolean;
}

export async function run(args: string[], opts: FetchOptions = {}): Promise<void> {
  const binDirArg = args[0];
  const net = loadCurrentNetwork();
  const plat = platform();
  const token = githubToken();
  const versions = readEnvFile(path.join(REPO, 'config', 'versions.env'));

  // Node binaries are per network; the tooling around them is shared.
  const nodeDest = binDirArg ? path.resolve(binDirArg) : path.join(WS, 'bin', net.name === 'previewnet' ? '' : net.name);
  const sharedDest = net.name === 'previewnet' ? nodeDest : path.dirname(nodeDest);
  fs.mkdirSync(nodeDest, { recursive: true });
  fs.mkdirSync(sharedDest, { recursive: true });

  if (opts.ifNeeded) {
    const absent = whatIsMissing(net, nodeDest, sharedDest);
    if (absent.length === 0) {
      console.log(`✓ ${net.name} artifacts present in ${nodeDest}`);
      return;
    }
    console.log(`Fetching ${net.name}: missing ${absent.slice(0, 4).join(', ')}${absent.length > 4 ? `, +${absent.length - 4} more` : ''}`);
  }

  console.log(`Fetching for ${net.name} into ${nodeDest}`);
  console.log(`Platform: ${process.platform}-${process.arch}`);
  if (!net.genesis) {
    // Runtime WASMs and the DotNS artifacts are inputs to `ppn generate`, and only a
    // genesis network builds one. Skipping them also means a fork-only user needs no
    // access to the private repo previewnet's runtimes come from.
    console.log(`${net.name} is fork-only — skipping genesis runtimes and DotNS artifacts`);
  }
  console.log('');

  // Read each release's metadata once, however many assets come from it.
  //
  // `wanted` names the assets this call is about to ask for. It matters only when a `latest`
  // pin has to fall back to the release list, where more than one release can be "newest":
  // individuality-community publishes a nightly and a rolling e2e snapshot with the same
  // created_at, and only one of them carries runtime WASM. Naming the assets lets the
  // resolver pick the release that actually has them instead of whichever the tie ordered
  // first. Memoised per repo@tag, so the first caller's `wanted` decides — which is why the
  // runtimes below pass theirs.
  const releases = new Map<string, Release>();
  const release = async (repo: string, tag: string, wanted: string[] = []): Promise<Release> => {
    const key = `${repo}@${tag}`;
    if (!releases.has(key)) releases.set(key, await fetchRelease(repo, tag, token, wanted));
    return releases.get(key)!;
  };

  // What actually landed, recorded next to the binaries — see lib/provenance.ts.
  const stamps: StampInput[] = [];

  // Last fetch's stamp, used as the download cache index: it records what each pin *resolved
  // to* and the hash of what landed, which is exactly what "is this file already the right
  // one?" needs. Read once, before anything overwrites it.
  //
  // Without this a fetch re-downloaded every artifact every time — 3.7 GB for previewnet, on
  // a laptop and on every deploy, almost always to write back bytes that were already there.
  const previous = opts.force ? null : readProvenance(nodeDest);
  let reused = 0;
  /**
   * Record the artifact and say whether its download can be skipped. Every stamped download
   * goes through this, so the stamp and the skip decision can never disagree about an
   * artifact: they are the same call.
   */
  const stamp = (i: StampInput): boolean => {
    const known = reusable(previous, i.name, i.resolved, i.file);
    stamps.push(known ? { ...i, sha256: known } : i);
    if (known) reused++;
    return known !== null;
  };

  // ---- node binaries, from the descriptor ---------------------------------
  console.log(`Node binaries (networks/${net.name}.json):`);
  const byRelease = new Map<string, ResolvedBinary[]>();
  for (const b of networkBinaries(net)) {
    const key = `${b.repo}@${b.tag}`;
    byRelease.set(key, [...(byRelease.get(key) ?? []), b]);
  }
  for (const [key, bins] of byRelease) {
    const [repo, tag] = key.split('@');
    const local = localPin(repo);
    if (local) {
      for (const b of bins) {
        const dest = path.join(nodeDest, b.name);
        copyLocal(local, dest, `--binary ${b.name}`);
        makeExecutable(dest);
        stamps.push({ kind: 'binary', name: b.name, repo, pinned: tag, resolved: 'local', file: dest });
        ok(`${b.name} (from ${local})`);
      }
      continue;
    }
    const rel = await release(repo, tag);
    console.log(`  from ${repo} @ ${rel.tag}:`);
    for (const b of bins) {
      // Stamped first, which is also the skip decision — see `stamp` above. polkadot is the
      // one entry that cannot simply `continue` on a hit: its two PVF workers are fetched
      // inside this same iteration, and each is checked on its own below.
      const haveBinary = stamp({ kind: 'binary', name: b.name, repo: repo, pinned: tag,
        resolved: rel.tag, file: path.join(nodeDest, b.name) });
      if (haveBinary) current(b.name);
      if (haveBinary && b.name !== 'polkadot') continue;

      if (!haveBinary) {
        if (b.archive) {
          await fetchArchivedBinary(b, rel, nodeDest, plat, token);
          if (b.name !== 'polkadot') continue;
        } else {
          // The asset carries the platform suffix; locally the binary keeps its bare name.
          const dest = path.join(nodeDest, b.name);
          if (await downloadAsset(rel, `${b.name}${plat.suffix}`, dest, token)) {
            makeExecutable(dest);
            ok(b.name);
          } else {
            missing(`${b.name}${plat.suffix}`, 'not in release');
          }
        }
      }
      // polkadot cannot validate a PVF without its two workers, and they must come from
      // the same build — a mismatched worker is rejected at spawn.
      if (b.name === 'polkadot') {
        for (const worker of ['polkadot-execute-worker', 'polkadot-prepare-worker']) {
          if (stamp({ kind: 'binary', name: worker, repo, pinned: tag, resolved: rel.tag,
            file: path.join(nodeDest, worker) })) { current(worker); continue; }
          const wDest = path.join(nodeDest, worker);
          if (await downloadAsset(rel, `${worker}${plat.suffix}`, wDest, token)) {
            makeExecutable(wDest);
            ok(worker);
          } else missing(worker, 'not in release');
        }
      }
    }
  }
  console.log('');

  // ---- runtimes, genesis networks only ------------------------------------
  if (net.genesis) {
    console.log(`Runtimes (networks/${net.name}.json):`);
    // Grouped by release first, so the resolver is told every asset a release must carry
    // before it picks which release `latest` means.
    const wantedFrom = new Map<string, string[]>();
    for (const r of networkRuntimes(net)) {
      const key = `${r.repo}@${r.tag}`;
      wantedFrom.set(key, [...(wantedFrom.get(key) ?? []), r.asset]);
    }
    for (const r of networkRuntimes(net)) {
      const localRuntime = localPin(r.repo);
      if (localRuntime) {
        const dest = path.join(nodeDest, r.file);
        copyLocal(localRuntime, dest, `--runtime for ${r.file}`);
        stamps.push({ kind: 'runtime', name: r.file, repo: r.repo, pinned: r.tag,
          resolved: 'local', file: dest });
        ok(`${r.file} (from ${localRuntime})`);
        continue;
      }
      const rel = await release(r.repo, r.tag, wantedFrom.get(`${r.repo}@${r.tag}`));
      if (stamp({ kind: 'runtime', name: r.file, repo: r.repo, pinned: r.tag,
        resolved: rel.tag, file: path.join(nodeDest, r.file) })) { current(r.file); continue; }
      if (await downloadAsset(rel, r.asset, path.join(nodeDest, r.file), token)) ok(r.file);
      else missing(r.asset, `not in ${r.repo} @ ${rel.tag}`);
    }
    console.log('');
  }

  // ---- DotNS: genesis + addresses, from dotns's own release ----------------
  // dotns builds the genesis in its release CI, address-parity-checked against its
  // committed manifest (paritytech/dotns#253); PPN used to clone dotns and run the
  // deploy pipeline itself.
  if (net.genesis && !net.genesisConfig?.networkSuffix) {
    console.log('DotNS: skipped — this network declares no networkSuffix, so no namespace');
    console.log('');
  }
  if (net.genesis && net.genesisConfig?.networkSuffix) {
    // The descriptor's networkSuffix IS the DotNS TLD: the chain namespace and the
    // registry's namespace are the same product-level value, pinned once so they
    // cannot drift. A dotns TLD rename therefore fails this fetch loudly (the asset
    // name below stops existing) instead of quietly shipping a mismatched registry.
    const tld = net.genesisConfig.networkSuffix;
    const genesisAsset = `dotns-genesis-${tld}.json`;
    const dotnsRel = await release(versions.DOTNS_REPO, versions.DOTNS_TAG, [genesisAsset]);
    console.log(`DotNS (${versions.DOTNS_REPO} @ ${dotnsRel.tag}):`);
    if (await downloadAsset(dotnsRel, genesisAsset, path.join(nodeDest, genesisAsset), token)) {
      ok(genesisAsset);
    } else missing(genesisAsset, `not in ${versions.DOTNS_REPO} @ ${dotnsRel.tag}`);

    // Addresses come from the canonical manifest at the same tag — the exact file the
    // genesis's parity check ran against, so the pair cannot disagree. Not the
    // deployments.json release asset: pre-releases deliberately do not carry it (no live
    // deploy has happened), and the manifest works for both. Underscore-prefixed keys
    // (_seed, _deployedFrom) are manifest metadata, not contracts.
    const addrDest = path.join(nodeDest, 'dotns-addresses.json');
    if (await downloadRepoFile(versions.DOTNS_REPO, dotnsRel.tag,
        'deployments/paseo-assethub/420420417.json', addrDest, token)) {
      const all = JSON.parse(fs.readFileSync(addrDest, 'utf-8'));
      const contracts = Object.fromEntries(
        Object.entries(all).filter(([k]) => !k.startsWith('_'))
      );
      fs.writeFileSync(addrDest, JSON.stringify(contracts, null, 2) + '\n');
      ok('dotns-addresses.json');
    } else missing('dotns-addresses.json', `no deployments manifest at ${dotnsRel.tag}`);
  }
  console.log('');

  // ---- identity backend ---------------------------------------------------
  // From device-uniqueness-backend's own releases. Until v0.2.0 that repo published container
  // images only, so PPN compiled the binaries in its own release workflow and shipped them as
  // release assets — which is why a failed identity build silently produced a PPN release that
  // no consumer could use.
  //
  // v0.2.0 ships one binary per target triple, inside an archive, and every service is
  // a `--role` of it. So: one asset, one extracted file, four processes.
  const identityTag = versions.DUB_TAG;
  console.log(`Device uniqueness backend (${versions.DUB_REPO} @ ${identityTag}):`);
  if (!identityTag) {
    missing(IDENTITY_BINARY, 'DUB_TAG is not set in config/versions.env');
  } else {
    const identityRelease = await release(versions.DUB_REPO, identityTag);
    // The asset embeds the version without its leading `v`: tag v0.3.0 -> dub-0.3.0-<triple>.
    const asset = `${IDENTITY_BINARY}-${identityTag.replace(/^v/, '')}-${plat.triple}.tar.gz`;
    const archivePath = path.join(sharedDest, asset);
    // Stamped whatever happens below: writeProvenance drops entries whose file is absent, so
    // a failed download leaves no stamp rather than a false one.
    const haveDub = stamp({ kind: 'toolchain', name: IDENTITY_BINARY, repo: versions.DUB_REPO,
      pinned: identityTag, resolved: identityRelease.tag,
      file: path.join(sharedDest, IDENTITY_BINARY) });
    if (haveDub) current(IDENTITY_BINARY);
    else if (await downloadAsset(identityRelease, asset, archivePath, token)) {
      withTempDir((tmp) => {
        extractTarGz(archivePath, tmp);
        const found = findFile(tmp, IDENTITY_BINARY);
        if (!found) {
          missing(IDENTITY_BINARY, `not found inside ${asset}`);
          return;
        }
        const dest = path.join(sharedDest, IDENTITY_BINARY);
        fs.rmSync(dest, { force: true });
        fs.copyFileSync(found, dest);
        makeExecutable(dest);
        ok(`${IDENTITY_BINARY} (from ${asset})`);
      });
      fs.rmSync(archivePath, { force: true });
    } else {
      missing(asset, `not in ${versions.DUB_REPO} @ ${identityRelease.tag}`);
    }
    // The API reference `--role all-in-one` serves at /docs. It is a ServeDir over a
    // directory, so the two files keep the names it expects (index.html, openapi.json) and
    // land together in one directory that GATEWAY_DOCS_ROOT points at.
    //
    // Out of the tree, not out of the release: the release publishes four tarballs and
    // SHA256SUMS, and nothing else. Pinned to the same tag as the binary so the reference
    // describes the service that is actually running. Missing docs do not stop a network —
    // /docs 404s and every API still works — so this warns rather than failing the fetch.
    const docsDir = path.join(sharedDest, 'identity-docs');
    for (const doc of ['index.html', 'openapi.json']) {
      const from = `docs/api-reference/${doc}`;
      if (
        await downloadRepoFile(
          versions.DUB_REPO,
          identityRelease.tag,
          from,
          path.join(docsDir, doc),
          token
        )
      ) {
        ok(`identity-docs/${doc}`);
      } else {
        console.log(`  ! ${from} not in ${versions.DUB_REPO} @ ${identityRelease.tag}`);
        console.log('    (the API reference at /docs will 404; the API itself is unaffected)');
      }
    }
  }
  console.log('');

  // ---- shared toolchain, pinned in config/versions.env -------------------
  console.log(`Zombienet (${versions.ZOMBIENET_REPO} @ ${versions.ZOMBIENET_VERSION}):`);
  const zombie = path.join(sharedDest, 'zombie-cli');
  const zombieUrl = `https://github.com/${versions.ZOMBIENET_REPO}/releases/download/${versions.ZOMBIENET_VERSION}/${plat.zombienet}`;
  // The three below are pinned to a literal version, not a moving tag, so pinned === resolved.
  if (stamp({ kind: 'toolchain', name: 'zombie-cli', repo: versions.ZOMBIENET_REPO,
    pinned: versions.ZOMBIENET_VERSION, resolved: versions.ZOMBIENET_VERSION, file: zombie })) {
    current('zombie-cli');
  } else if (await downloadUrl(zombieUrl, zombie)) {
    makeExecutable(zombie);
    ok('zombie-cli');
  } else missing('zombie-cli', zombieUrl);
  console.log('');

  console.log(`Kubo (${versions.KUBO_REPO} @ ${versions.KUBO_VERSION}):`);
  const kuboArchive = `kubo_${versions.KUBO_VERSION}_${plat.kubo}.tar.gz`;
  const kuboPath = path.join(sharedDest, kuboArchive);
  const haveKubo = stamp({ kind: 'toolchain', name: 'ipfs', repo: versions.KUBO_REPO,
    pinned: versions.KUBO_VERSION, resolved: versions.KUBO_VERSION,
    file: path.join(sharedDest, 'ipfs') });
  if (haveKubo) {
    current('ipfs');
    // The repo is state, not an artifact, so it is created on first fetch and never again —
    // re-running `ipfs init` would take a new peer identity with it and force every pin
    // (design families, bulletin products) to be fetched again.
    if (!fs.existsSync(path.join(sharedDest, '.ipfs'))) {
      execFileSync(path.join(sharedDest, 'ipfs'), ['init', '--profile', 'server'], {
        env: { ...process.env, IPFS_PATH: path.join(sharedDest, '.ipfs') },
        stdio: 'ignore',
      });
    }
  } else if (await downloadUrl(`https://github.com/${versions.KUBO_REPO}/releases/download/${versions.KUBO_VERSION}/${kuboArchive}`, kuboPath)) {
    extractTarGz(kuboPath, sharedDest, { strip: 1, only: 'kubo/ipfs' });
    makeExecutable(path.join(sharedDest, 'ipfs'));
    fs.rmSync(kuboPath);
    if (!fs.existsSync(path.join(sharedDest, '.ipfs'))) {
      execFileSync(path.join(sharedDest, 'ipfs'), ['init', '--profile', 'server'], {
        env: { ...process.env, IPFS_PATH: path.join(sharedDest, '.ipfs') },
        stdio: 'ignore',
      });
    }
    ok('ipfs');
  } else missing('ipfs', 'download failed');
  console.log('');

  // Unpacked as a whole prefix tree rather than flattened: postgres resolves
  // share/postgresql/postgres.bki relative to its own location, so splitting bin/ from
  // share/ breaks initdb.
  console.log(`PostgreSQL (${versions.POSTGRES_REPO} @ ${versions.POSTGRES_VERSION}):`);
  const pgArchive = `postgresql-${versions.POSTGRES_VERSION}-${plat.triple}.tar.gz`;
  const pgPath = path.join(sharedDest, pgArchive);
  const pgDist = path.join(sharedDest, 'postgres-dist');
  // The prefix tree's own executable, not the archive: postgres resolves its share/ files
  // relative to itself, so this path is also what runs.
  //
  // Hashing that one executable is a partial check of a whole tree — share/postgresql/ could
  // in principle be damaged while bin/postgres is intact. Accepted: the alternative is
  // hashing the tree on every fetch, and `--force` re-extracts it for the case that matters.
  const havePg = stamp({ kind: 'toolchain', name: 'postgres', repo: versions.POSTGRES_REPO,
    pinned: versions.POSTGRES_VERSION, resolved: versions.POSTGRES_VERSION,
    file: path.join(pgDist, 'bin', 'postgres') });
  if (havePg) {
    current(`postgres-dist (${execFileSync(path.join(pgDist, 'bin', 'postgres'), ['--version'], { encoding: 'utf-8' }).trim()})`);
  } else if (await downloadUrl(`https://github.com/${versions.POSTGRES_REPO}/releases/download/${versions.POSTGRES_VERSION}/${pgArchive}`, pgPath)) {
    fs.rmSync(pgDist, { recursive: true, force: true });
    extractTarGz(pgPath, pgDist, { strip: 1 });
    fs.rmSync(pgPath);
    const version = execFileSync(path.join(pgDist, 'bin', 'postgres'), ['--version'], { encoding: 'utf-8' }).trim();
    ok(`postgres-dist (${version})`);
  } else {
    missing('postgres-dist', 'download failed');
    console.log('  (identity backend will not start; see docs/DEVICE-UNIQUENESS-BACKEND.md)');
  }
  console.log('');

  // The provider binary is a declared service above; this is the dev fallback.
  const provider = path.join(nodeDest, 'storage-provider-node');
  const declaresProvider = (() => {
    const cfg = net.services['storage-provider-node'];
    return Boolean(cfg && typeof cfg === 'object' && cfg.binary);
  })();
  if (declaresProvider && (!fs.existsSync(provider) || fs.statSync(provider).size === 0)) {
    const sibling = path.join(WS, '..', 'web3-storage', 'target', 'release', 'storage-provider-node');
    if (fs.existsSync(sibling)) {
      fs.copyFileSync(sibling, provider);
      makeExecutable(provider);
      ok('storage-provider-node (from the ../web3-storage sibling build)');
    } else {
      missing('storage-provider-node', 'not in the release, no sibling build at ../web3-storage');
      console.log('    To build it: (cd ../web3-storage && cargo build --release -p storage-provider-node)');
    }
    console.log('');
  }

  console.log(`Design families (${versions.DESIGN_FAMILIES_REPO} @ ${versions.DESIGN_FAMILIES_VERSION}):`);
  const dfDir = path.join(WS, 'design-families');
  const dfRelease = await release(versions.DESIGN_FAMILIES_REPO, versions.DESIGN_FAMILIES_VERSION);
  const dfZip = path.join(sharedDest, 'design-families.zip');
  if (await downloadAsset(dfRelease, 'design-families.zip', dfZip, token)) {
    fs.rmSync(dfDir, { recursive: true, force: true });
    extractZip(dfZip, dfDir);
    fs.rmSync(dfZip);
    ok(`design-families/ (${fs.readdirSync(dfDir).length} items)`);
  } else missing('design-families.zip', 'not in release');
  console.log('');

  if (absent.length) {
    throw new Error(
      `${absent.length} artifact(s) the descriptor asked for are not in the release:\n` +
        absent.map((a) => `         - ${a}`).join('\n') +
        `\n       bin/ is incomplete, so nothing downstream would work. If the release is a` +
        `\n       partial re-publish, name a complete tag in networks/<name>.json instead of latest.`
    );
  }

  writeProvenance(nodeDest, net.name, stamps);

  if (reused > 0) {
    console.log(`Reused ${reused}/${stamps.length} artifacts already on disk at the same ` +
      'resolved tag (`--force` re-downloads everything).');
  }
  console.log('Done!');
}

/**
 * Everything the descriptor declares that is not on disk yet. An empty result means a
 * fetch would be a no-op, which is what `--if-needed` checks — rather than probing for
 * one filename and hoping it stands for the rest.
 */
function whatIsMissing(
  net: ReturnType<typeof loadCurrentNetwork>,
  nodeDest: string,
  sharedDest: string
): string[] {
  const gone = (dir: string, file: string) => {
    const p = path.join(dir, file);
    return !fs.existsSync(p) || fs.statSync(p).size === 0;
  };
  const out: string[] = [];
  for (const b of networkBinaries(net)) if (gone(nodeDest, b.name)) out.push(b.name);
  // polkadot is useless without the two workers it validates PVFs with.
  if (networkBinaries(net).some((b) => b.name === 'polkadot')) {
    for (const w of ['polkadot-execute-worker', 'polkadot-prepare-worker']) {
      if (gone(nodeDest, w)) out.push(w);
    }
  }
  for (const r of networkRuntimes(net)) if (gone(nodeDest, r.file)) out.push(r.file);
  if (gone(sharedDest, 'zombie-cli')) out.push('zombie-cli');
  // One binary now, so its absence is one entry rather than four.
  if (gone(sharedDest, IDENTITY_BINARY)) out.push(IDENTITY_BINARY);
  if (!fs.existsSync(path.join(WS, 'design-families'))) out.push('design-families/');
  return out;
}

async function fetchArchivedBinary(
  b: ResolvedBinary,
  rel: Release,
  dest: string,
  plat: Platform,
  token: string
): Promise<void> {
  // The archive name embeds the resolved tag and the target triple. The binary sits under
  // a versioned directory inside, so it is extracted to a temp dir and force-moved:
  // overwriting matters, or a redeploy keeps running an older binary that then rejects
  // newer CLI flags.
  const asset = b.archive!.replace('{tag}', rel.tag).replace('{triple}', plat.triple);
  const archivePath = path.join(dest, asset);
  if (!(await downloadAsset(rel, asset, archivePath, token))) {
    missing(b.name, `${asset} not in ${rel.repo} @ ${rel.tag}`);
    return;
  }
  withTempDir((tmp) => {
    extractTarGz(archivePath, tmp);
    const found = findFile(tmp, b.name);
    if (!found) {
      missing(b.name, `not found inside ${asset}`);
      return;
    }
    const target = path.join(dest, b.name);
    fs.rmSync(target, { force: true });
    fs.copyFileSync(found, target);
    makeExecutable(target);
    ok(`${b.name} (from ${asset})`);
  });
  fs.rmSync(archivePath, { force: true });
}
