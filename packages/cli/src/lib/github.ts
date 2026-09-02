// Downloading release assets from GitHub.
//
// Assets are fetched through the API by asset id, not through browser_download_url: a
// private repo's assets are only reachable that way, and several of the repos PPN pulls
// from are private.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

export interface Release {
  repo: string;
  tag: string;
  assets: ReleaseAsset[];
}

/** From the environment, or from git's credential helper (what `gh auth login` writes). */
export function githubToken(): string {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const out = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const line = out.split('\n').find((l) => l.startsWith('password='));
    if (line) return line.slice('password='.length).trim();
  } catch {
    /* no credential helper */
  }
  throw new Error(
    'no GitHub token — set GITHUB_TOKEN, or run `gh auth login` (choose HTTPS and let it\n' +
      '       configure git credentials). Release assets on private repos need it.'
  );
}

const api = (token: string) => ({
  Authorization: `token ${token}`,
  Accept: 'application/vnd.github+json',
});

/**
 * Read a release's metadata. `latest` tries the /latest endpoint first; anything else is a tag.
 * Throws with the repo named, because "cannot read release X" is nearly always a token
 * that cannot see a private repo rather than a wrong pin.
 *
 * `/releases/latest` only exists once a repo has marked a full (non-prerelease) release —
 * a repo publishing only nightlies or prereleases 404s on it forever. In that case fall back
 * to the newest release in the list, whatever kind it is: for a `latest` pin, "the freshest
 * thing published" is what the descriptor means.
 */
export async function fetchRelease(
  repo: string,
  tag: string,
  token: string,
  /**
   * Asset names the caller is going to ask this release for. Only consulted on the `latest`
   * fallback below, where it is the difference between the right release and a coin toss.
   */
  wanted: string[] = []
): Promise<Release> {
  if (tag === 'latest') {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: api(token),
    });
    if (res.ok) {
      const json = (await res.json()) as { tag_name: string; assets: ReleaseAsset[] };
      return { repo, tag: json.tag_name, assets: json.assets ?? [] };
    }
    if (res.status === 404) {
      // A repo publishing only prereleases 404s here for ever, so fall back to the list. The
      // list is ordered by creation, and "newest" alone is not enough to pick correctly:
      // individuality-community publishes a nightly *and* a rolling `e2e-zombienet-snapshot`
      // that share a created_at to the second. The snapshot carries node tarballs and no
      // runtime WASM, so whichever of the two the tie happens to put first decided whether a
      // fetch worked — and the tie flips whenever the rolling tag is republished.
      //
      // So prefer the newest release that actually carries what the caller came for, and only
      // fall back to the plain newest when nothing does (or when nothing was named).
      const releases = await listReleaseDetails(repo, token, 20);
      const carries = (r: { assets: ReleaseAsset[] }) =>
        wanted.length > 0 && wanted.every((w) => r.assets.some((a) => a.name === w));
      const match = releases.find(carries);
      if (match) {
        if (match !== releases[0]) {
          console.log(
            `  (${repo} marks no latest release; its newest is ${releases[0].tag_name}, which ` +
              `does not carry ${wanted.join(', ')} — using ${match.tag_name})`
          );
        } else {
          console.log(`  (${repo} marks no latest release; using its newest, ${match.tag_name})`);
        }
        return { repo, tag: match.tag_name, assets: match.assets };
      }
      const newest = releases[0];
      if (newest) {
        console.log(`  (${repo} marks no latest release; using its newest, ${newest.tag_name})`);
        return { repo, tag: newest.tag_name, assets: newest.assets };
      }
    }
    throw new Error(
      `could not read release ${repo} @ latest (HTTP ${res.status})\n` +
        `       Check the pin, and that your token can read ${repo}.`
    );
  }
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, {
    headers: api(token),
  });
  if (!res.ok) {
    throw new Error(
      `could not read release ${repo} @ ${tag} (HTTP ${res.status})\n` +
        `       Check the pin, and that your token can read ${repo}.`
    );
  }
  const json = (await res.json()) as { tag_name: string; assets: ReleaseAsset[] };
  return { repo, tag: json.tag_name, assets: json.assets ?? [] };
}

/** The same list with each release's assets, so a caller can tell which one holds what. */
export async function listReleaseDetails(
  repo: string,
  token: string,
  perPage = 10
): Promise<{ tag_name: string; assets: ReleaseAsset[] }[]> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=${perPage}`, {
    headers: api(token),
  });
  if (!res.ok) throw new Error(`could not list releases for ${repo} (HTTP ${res.status})`);
  return ((await res.json()) as { tag_name: string; assets?: ReleaseAsset[] }[]).map((r) => ({
    tag_name: r.tag_name,
    assets: r.assets ?? [],
  }));
}

async function writeStream(res: Response, dest: string): Promise<void> {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

/**
 * Download one named asset out of a release. Returns false when the release has no such
 * asset — callers decide whether that is fatal, because several assets are optional.
 */
/**
 * Retry a download that died mid-stream.
 *
 * These are 100 MB+ binaries pulled from a CDN, and a cut connection surfaces from undici as
 * `TypeError: terminated` — no status code, nothing the caller can distinguish from a real
 * failure. One interrupted stream then fails the whole fetch, which on CI means a red run that
 * says nothing about the change under test. A 404 or 403 is *not* retried: those are answers,
 * not accidents.
 */
async function withRetry<T>(what: string, attempt: () => Promise<T>): Promise<T> {
  const delays = [1000, 3000, 8000];
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (i >= delays.length) {
        throw new Error(
          `${what} failed after ${delays.length + 1} attempts: ` +
            (err instanceof Error ? err.message : String(err))
        );
      }
      const why = err instanceof Error ? err.message : String(err);
      console.log(`  … ${what} interrupted (${why}), retrying in ${delays[i] / 1000}s`);
      await new Promise((r) => setTimeout(r, delays[i]));
    }
  }
}

export async function downloadAsset(
  release: Release,
  assetName: string,
  dest: string,
  token: string
): Promise<boolean> {
  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) return false;
  return withRetry(`download of ${assetName}`, async () => {
    const res = await fetch(asset.url, {
      headers: { Authorization: `token ${token}`, Accept: 'application/octet-stream' },
    });
    if (!res.ok) return false;
    await writeStream(res, dest);
    return true;
  });
}

/**
 * Download one file out of a repository at a tag, rather than out of a release.
 *
 * Needed because not everything a release implies is published as an asset. The identity
 * backend's API reference is committed under `docs/api-reference/` and its release carries
 * only the binary tarballs, so the reference has to come from the tree — at the same tag as
 * the binary, or it documents a different version of the service than the one running.
 *
 * Returns false on 404 (the path is not there at that tag), which callers treat as optional.
 */
export async function downloadRepoFile(
  repo: string,
  ref: string,
  repoPath: string,
  dest: string,
  token: string
): Promise<boolean> {
  return withRetry(`download of ${repoPath}`, async () => {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/contents/${repoPath}?ref=${encodeURIComponent(ref)}`,
      { headers: { Authorization: `token ${token}`, Accept: 'application/vnd.github.raw' } }
    );
    if (!res.ok) return false;
    await writeStream(res, dest);
    return true;
  });
}

/** Download a plain URL — the release/download path, for repos that need no auth. */
export async function downloadUrl(url: string, dest: string): Promise<boolean> {
  return withRetry(`download of ${path.basename(dest)}`, async () => {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) return false;
    await writeStream(res, dest);
    return true;
  });
}

/** One authenticated GET against the REST API, e.g. `githubApi('repos/o/r/pulls/1', token)`. */
export async function githubApi<T = any>(apiPath: string, token: string): Promise<T> {
  const res = await fetch(`https://api.github.com/${apiPath}`, { headers: api(token) });
  if (!res.ok) throw new Error(`GET ${apiPath}: ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/**
 * Download a workflow-run artifact as a zip. The API answers with a redirect to blob storage,
 * which fetch follows — dropping the Authorization header across origins, as the storage URL
 * is pre-signed and rejects a token.
 */
export async function downloadArtifact(repo: string, artifactId: number, dest: string, token: string): Promise<boolean> {
  return withRetry(`download of artifact ${artifactId}`, async () => {
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/artifacts/${artifactId}/zip`, {
      headers: api(token),
      redirect: 'follow',
    });
    if (!res.ok) return false;
    await writeStream(res, dest);
    return true;
  });
}

export function makeExecutable(file: string): void {
  fs.chmodSync(file, 0o755);
}
