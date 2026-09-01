// The dashboard's only data source. Components never fetch — they read the store.

export interface Endpoint {
  id: string;
  label: string;
  path: string;
  port: number;
  protocol: 'ws' | 'http';
  url: string;
  directUrl: string;
  health: { kind: 'rpc' } | { kind: 'http'; path: string } | null;
  links: Record<string, string>;
}
export interface Chain extends Endpoint {
  paraId: number | null;
}
export interface Model {
  schemaVersion: number;
  network: { name: string; displayName: string; genesis: boolean };
  baseUrl: string;
  chains: Chain[];
  services: Endpoint[];
  logs: string[];
}
export interface Health {
  id: string;
  status: 'ok' | 'down';
  block?: number;
  /**
   * What a chain is running *right now*, as opposed to what provenance says was fetched:
   * a live runtime upgrade moves specVersion without touching a single artifact on disk,
   * so the two answers are different questions and both are worth showing.
   */
  runtime?: { specName: string; specVersion: number; implVersion: number; transactionVersion: number };
  /** The node binary's own version string, from system_version. */
  clientVersion?: string;
  error?: string;
  checkedAt: string;
}
export interface ProvenanceArtifact {
  name: string;
  repo: string;
  pinned: string;
  resolved: string;
  sha256: string;
  version?: string;
}
export interface Provenance {
  provenance: {
    fetchedAt: string;
    network: string;
    platform: string;
    binaries: ProvenanceArtifact[];
    runtimes: ProvenanceArtifact[];
    /** DUB, zombienet, kubo, postgres. Absent from stamps written before it was recorded. */
    toolchain?: ProvenanceArtifact[];
  } | null;
  spawn: {
    spawnedAt: string;
    network: string;
    mode: 'genesis' | 'fork';
    bite: { at: string; source: string; blocks: Record<string, number> } | null;
    profile: string;
    ppnVersion?: string;
  } | null;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const fetchModel = () => get<Model>('/api/network');
export const fetchHealth = () => get<Health[]>('/api/health');
export const fetchProvenance = () => get<Provenance>('/api/provenance');
export interface LogGroups {
  chains: string[];
  services: string[];
  scripts: string[];
}
export const fetchLogGroups = () => get<LogGroups>('/api/logs');
export const logStream = (id: string) => new EventSource(`/api/logs/${id}`);

export interface ActionsState {
  enabled: boolean;
  running: { id: number; chain: string } | null;
}

export const fetchActions = () => get<ActionsState>('/api/actions');

/**
 * Start an upgrade: from a dropped/picked file, or from a path on the machine the network
 * runs on (the usual case locally — a runtime repo's target/ artifact). Returns the SSE
 * events path to follow.
 */
export async function startUpgrade(chain: string, wasm: File | { path: string }): Promise<string> {
  const q = `chain=${encodeURIComponent(chain)}`;
  const res =
    wasm instanceof File
      ? await fetch(`/api/actions/upgrade?${q}`, { method: 'POST', body: wasm })
      : await fetch(`/api/actions/upgrade?${q}&path=${encodeURIComponent(wasm.path)}`, { method: 'POST' });
  if (res.status === 409) throw new Error('another action is still running');
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `upgrade rejected: HTTP ${res.status}`);
  }
  const { events } = (await res.json()) as { events: string };
  return events;
}

export interface Addresses {
  dotns: Record<string, string> | null;
  dub: Record<string, string>;
}
export const fetchAddresses = () => get<Addresses>('/api/addresses');
