// Finding the DotNS products a forked network can still serve.
//
// A fork carries chain state but not bulletin's stored bytes: those live in block
// bodies, and the bite is a warp sync. So a forked bulletin lists content it does
// not hold. Copying all of it is not an option — measured on paseo-next-v2 that is
// 35 GiB across 33k entries.
//
// Almost none of it is wanted, though. What a user actually loads is the current
// version of a registered product, and DotNS says exactly which those are:
//
//   Revive::AccountInfoOf[resolver]        -> the contract's trie id
//   its child trie                         -> every storage word it owns
//   words beginning e3 01 01               -> ENS EIP-1577 contenthash records
//   intersect with bulletin's own entries  -> the ones still in retention
//
// On paseo-next-v2 that reduces 35 GiB to 797 products totalling 3.0 GiB, because
// most registered contenthashes point at content already pruned past the retention
// period, and every superseded publish is skipped.
//
// Each product resolves to a single UnixFS file whose bytes are a CAR archive of the
// whole site, so there are no child objects to chase — fetching the root is the
// whole product.

import { cidV1, keyOf } from './codec.js';
import { rpc, storageIndex } from './rpc.js';
import type { StorageIndex } from './rpc.js';

/** ENS EIP-1577 ipfs-ns prefix, followed by the CID bytes. */
const CONTENTHASH_PREFIX = 'e30101';

/**
 * Bytes of the digest that survive in the first 32-byte word, for a sha2-256 record.
 *
 * This is the *most* a word can expose: 32 bytes less a 6-byte header. A blake2b-256 record
 * has a wider header (its multihash code is a three-byte varint) and so exposes 24. Rather
 * than truncate everything to the shorter of the two, each record keeps whatever it has and
 * `matchProducts` joins on the shorter of the two sides — see `digestPrefixOf`.
 */
const DIGEST_PREFIX_BYTES = 26;

/** What the widest header (blake2b-256's) leaves readable — the shortest join key we accept. */
const MIN_DIGEST_PREFIX_BYTES = 24;

export interface BulletinEntry {
  contentHash: string;
  cidCodec: number;
  hashing: string;
  size: number;
}

/**
 * The digest prefix each contenthash record exposes.
 *
 * A contenthash is Solidity `bytes`, 38 bytes for a CIDv1, so it spans two storage
 * words. Revive hashes storage keys, so the second word cannot be located by
 * incrementing the first one's key — only the leading 26 digest bytes are readable
 * here. That is enough to identify the entry against bulletin, which holds the full
 * hash; `matchProducts` does the join.
 */
export function contenthashPrefixes(words: readonly string[]): string[] {
  const out: string[] = [];
  for (const word of words) {
    const digest = digestPrefixOf(word);
    if (digest) out.push(digest);
  }
  return out;
}

/**
 * The readable digest prefix of one contenthash word, or null if it is not one.
 *
 * The header is `e3 01 01 | codec | multihash code | length`, and the multihash code is an
 * LEB128 varint — one byte for sha2-256 (0x12), but three for blake2b-256 (0xb220 encodes as
 * a0 e4 02). Assuming one byte reads a blake2b record two bytes early, so its "digest" is the
 * tail of the code plus the length byte, matches nothing in bulletin, and the product is
 * dropped from the fork with no error — silently, and only for blake2b. So the code is
 * decoded rather than assumed. The codec is likewise a varint, though both codecs bulletin
 * uses (85 raw, 112 dag-pb) are single-byte.
 */
export function digestPrefixOf(word: string): string | null {
  const hex = word.replace(/^0x/, '').toLowerCase();
  if (!hex.startsWith(CONTENTHASH_PREFIX)) return null;

  let at = CONTENTHASH_PREFIX.length / 2; // bytes consumed so far
  const byteAt = (i: number) => parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  const skipVarint = () => {
    while (at < hex.length / 2 && (byteAt(at) & 0x80) !== 0) at++;
    at++; // the final byte, which has the continuation bit clear
  };

  skipVarint(); // codec
  skipVarint(); // multihash code
  at++; // digest length

  // Up to DIGEST_PREFIX_BYTES, and whatever the word actually holds after its header: 26 for
  // sha2-256, 24 for blake2b-256. A word carrying fewer than 24 is not a CIDv1 contenthash.
  const digest = hex.slice(at * 2, at * 2 + DIGEST_PREFIX_BYTES * 2);
  return digest.length >= MIN_DIGEST_PREFIX_BYTES * 2 ? digest : null;
}

/**
 * Join contenthash records to the bulletin entries that still hold their bytes.
 *
 * Returns one CID per distinct product. A record with no match points at content
 * outside bulletin's retention window — nothing can serve it, so it is dropped.
 */
export function matchProducts(
  prefixes: readonly string[],
  entries: readonly BulletinEntry[]
): { cids: string[]; matched: number; unmatched: number } {
  // Keyed at the shortest prefix any record can offer, because how much of the digest is
  // readable depends on the hash function's multihash width. A longer prefix is truncated to
  // the same key below, so sha2 and blake2b records join through one map.
  const byPrefix = new Map<string, BulletinEntry>();
  for (const e of entries) {
    byPrefix.set(
      e.contentHash.replace(/^0x/, '').toLowerCase().slice(0, MIN_DIGEST_PREFIX_BYTES * 2),
      e
    );
  }
  const cids = new Set<string>();
  let matched = 0;
  let unmatched = 0;
  for (const p of prefixes) {
    const entry = byPrefix.get(p.slice(0, MIN_DIGEST_PREFIX_BYTES * 2));
    if (!entry) {
      unmatched++;
      continue;
    }
    matched++;
    cids.add(cidV1(entry.cidCodec, entry.hashing, entry.contentHash));
  }
  return { cids: [...cids], matched, unmatched };
}

// ---------------------------------------------------------------------------
// Reading the two chains
// ---------------------------------------------------------------------------

/** Addresses of every revive contract on the chain. */
export async function contractAddresses(url: string): Promise<string[]> {
  const prefix = '0x' + keyOf('Revive', 'AccountInfoOf');
  const keys: string[] = [];
  let start = prefix;
  for (;;) {
    const page = await rpc<string[]>(url, 'state_getKeysPaged', [prefix, 1000, start]);
    keys.push(...page);
    if (page.length < 1000) break;
    start = page[page.length - 1];
  }
  // Identity-hashed map: the last 20 bytes of the key are the address.
  return keys.map((k) => '0x' + k.slice(-40));
}

/**
 * Find the content resolver by what it holds rather than by its address.
 *
 * DotNS is redeployed on every release, so a configured address goes stale the moment
 * the network is wiped — and the previous deployment is usually still on chain, holding
 * nothing, which makes the failure look like "this network has no products". A fork is
 * worse again: its state is from whenever it was bitten, so it agrees with neither the
 * current release nor the previous one.
 *
 * The resolver is identifiable without any of that: it is the contract holding ENS
 * contenthash records. Returns the address with the most, or null if none has any.
 */
export async function discoverResolver(url: string): Promise<string | null> {
  let best: { address: string; records: number } | null = null;
  for (const address of await contractAddresses(url)) {
    let words: string[];
    try {
      words = await contractWords(url, address);
    } catch {
      continue; // not a contract, or storage unreadable
    }
    const records = contenthashPrefixes(words).length;
    if (records > 0 && (!best || records > best.records)) best = { address, records };
  }
  return best?.address ?? null;
}

/** Every storage word owned by a revive contract, via its child trie. */
export async function contractWords(url: string, address: string): Promise<string[]> {
  const ix = await storageIndex(url);
  const item = ix.meta.asLatest.pallets
    .find((p) => p.name.toString() === 'Revive')
    ?.storage.unwrap()
    .items.find((i) => i.name.toString() === 'AccountInfoOf');
  if (!item) throw new Error('no Revive::AccountInfoOf — is this Asset Hub?');

  // The map is Identity-hashed, so the key is the address itself.
  const key = '0x' + keyOf('Revive', 'AccountInfoOf') + address.toLowerCase().replace(/^0x/, '');
  const raw = await rpc<string | null>(url, 'state_getStorage', [key]);
  if (!raw) throw new Error(`no contract at ${address}`);

  const valueType = ix.reg.createLookupType(item.type.asMap.value.toNumber());
  const info = ix.reg.createType(valueType, raw).toJSON() as {
    accountType?: { contract?: { trieId: string } };
  };
  const trieId = info.accountType?.contract?.trieId;
  if (!trieId) throw new Error(`${address} is not a contract`);

  const childKey =
    '0x' + Buffer.from(':child_storage:default:').toString('hex') + trieId.replace(/^0x/, '');
  const keys = await pageChildKeys(url, childKey);

  const words: string[] = [];
  for (let i = 0; i < keys.length; i += 200) {
    const batch = keys.slice(i, i + 200);
    const values = await rpc<(string | null)[]>(url, 'childstate_getStorageEntries', [childKey, batch]);
    for (const v of values) if (v) words.push(v);
  }
  return words;
}

async function pageChildKeys(url: string, childKey: string): Promise<string[]> {
  const keys: string[] = [];
  let start: string | null = null;
  for (;;) {
    const page: string[] = await rpc<string[]>(url, 'childstate_getKeysPaged', [
      childKey, '0x', 1000, start,
    ]);
    keys.push(...page);
    if (page.length < 1000) return keys;
    start = page[page.length - 1];
  }
}

/** Every transaction bulletin currently retains. */
export async function bulletinEntries(url: string): Promise<BulletinEntry[]> {
  const ix: StorageIndex = await storageIndex(url);
  const item = ix.meta.asLatest.pallets
    .find((p) => p.name.toString() === 'TransactionStorage')
    ?.storage.unwrap()
    .items.find((i) => i.name.toString() === 'Transactions');
  if (!item) throw new Error('no TransactionStorage::Transactions — is this the bulletin chain?');
  const valueType = ix.reg.createLookupType(item.type.asMap.value.toNumber());

  const prefix = '0x' + keyOf('TransactionStorage', 'Transactions');
  const keys: string[] = [];
  let start = prefix;
  for (;;) {
    const page = await rpc<string[]>(url, 'state_getKeysPaged', [prefix, 1000, start]);
    keys.push(...page);
    if (page.length < 1000) break;
    start = page[page.length - 1];
  }

  const entries: BulletinEntry[] = [];
  for (let i = 0; i < keys.length; i += 250) {
    const res = await rpc<{ changes: [string, string | null][] }[]>(url, 'state_queryStorageAt', [
      keys.slice(i, i + 250),
    ]);
    for (const block of res) {
      for (const [, value] of block.changes) {
        if (!value) continue;
        const list = ix.reg.createType(valueType, value).toJSON() as unknown as BulletinEntry[];
        for (const t of list) {
          entries.push(t);
        }
      }
    }
  }
  return entries;
}

export interface ProductScan {
  /** The resolver actually used — may differ from the one asked for. */
  resolver: string;
  cids: string[];
  records: number;
  matched: number;
  unmatched: number;
  bulletinEntries: number;
}

export async function scanProducts(
  assetHubUrl: string,
  bulletinUrl: string,
  resolverAddress: string
): Promise<ProductScan> {
  // The configured address is a fast path, not a source of truth: fall back to finding
  // the resolver by its contents whenever it is absent or holds nothing.
  let resolver = resolverAddress;
  let words: string[] = [];
  try {
    words = await contractWords(assetHubUrl, resolver);
  } catch {
    words = [];
  }
  if (contenthashPrefixes(words).length === 0) {
    const found = await discoverResolver(assetHubUrl);
    if (found && found.toLowerCase() !== resolver.toLowerCase()) {
      resolver = found;
      words = await contractWords(assetHubUrl, resolver);
    }
  }
  const entries = await bulletinEntries(bulletinUrl);
  const prefixes = contenthashPrefixes(words);
  const { cids, matched, unmatched } = matchProducts(prefixes, entries);
  return { resolver, cids, records: prefixes.length, matched, unmatched, bulletinEntries: entries.length };
}
