// Talking to a live previewnet chain, and indexing its storage so override values can be
// decode-verified against their real on-chain types before being written.

import { Metadata, TypeRegistry } from '@polkadot/types';
import { keyOf } from './codec.js';

export async function rpc<T = any>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(60_000),
  });
  const j = (await r.json()) as { result?: T; error?: unknown };
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result as T;
}

export interface StorageEntry {
  label: string;
  /** Lookup id of the stored type, or null for maps (which have no single plain value). */
  plain: number | null;
  /**
   * Lookup id of a map's *value* type, or null for plain entries.
   *
   * Injects write into maps, so `plain` is null for every one of them and they would otherwise
   * be written with nothing checking the shape. The value type is the thing to check them
   * against — a hand-encoded AccountInfo or DMQ head that the runtime disagrees with is
   * exactly the failure a bite must not carry silently into a bundle.
   */
  mapValue: number | null;
  /**
   * A map's key hashers, e.g. `['Twox64Concat']`. Injects build their keys by hand, so the
   * hasher assumed has to be the one the runtime uses, or the write lands on a key nothing
   * ever reads.
   */
  hashers: string[];
}

export interface StorageIndex {
  reg: TypeRegistry;
  meta: Metadata;
  byKey: Map<string, StorageEntry>;
  pallets: Set<string>;
}

export async function storageIndex(url: string): Promise<StorageIndex> {
  const reg = new TypeRegistry();
  const meta = new Metadata(reg, await rpc<`0x${string}`>(url, 'state_getMetadata'));
  reg.setMetadata(meta);

  const byKey = new Map<string, StorageEntry>();
  const pallets = new Set<string>();
  for (const p of meta.asLatest.pallets) {
    pallets.add(p.name.toString());
    if (p.storage.isNone) continue;
    const storage = p.storage.unwrap();
    for (const it of storage.items) {
      byKey.set(keyOf(storage.prefix.toString(), it.name.toString()), {
        label: `${p.name}::${it.name}`,
        plain: it.type.isPlain ? it.type.asPlain.toNumber() : null,
        mapValue: it.type.isMap ? it.type.asMap.value.toNumber() : null,
        hashers: it.type.isMap ? it.type.asMap.hashers.map((h) => h.type) : [],
      });
    }
  }
  return { reg, meta, byKey, pallets };
}

/** Read a runtime constant, e.g. constantOf(index, 'Babe', 'EpochDuration'). */
export function constantOf({ meta, reg }: StorageIndex, pallet: string, name: string): string | null {
  for (const p of meta.asLatest.pallets) {
    if (p.name.toString() !== pallet) continue;
    for (const c of p.constants) {
      if (c.name.toString() === name) {
        return reg.createType(reg.createLookupType(c.type.toNumber()), c.value).toString();
      }
    }
  }
  return null;
}
