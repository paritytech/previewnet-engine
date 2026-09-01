// SCALE encoding and storage-key derivation for the bite.
//
// Everything here is deterministic and covered by tests. It is worth testing: hand-encoding
// these values once produced a `ParaScheduler::ValidatorGroups` that was missing the inner
// compact length, decoded as `[[], …]`, and would have silently mis-assigned cores.

import { blake2AsHex, xxhashAsHex } from '@polkadot/util-crypto';

/** twox128(pallet) ++ twox128(item), without the 0x prefix. */
export function keyOf(pallet: string, item: string): string {
  return (xxhashAsHex(pallet, 128) + xxhashAsHex(item, 128).slice(2)).slice(2);
}

/** Blake2_128Concat — the hasher of System::Account and most account-keyed maps. */
export function blake2128Concat(encodedHex: string): string {
  return blake2AsHex('0x' + encodedHex, 128).slice(2) + encodedHex;
}

/** A u128 as little-endian hex — balances and account flags. */
export function u128le(v: bigint): string {
  const b = Buffer.alloc(16);
  b.writeBigUInt64LE(v & 0xffffffffffffffffn, 0);
  b.writeBigUInt64LE(v >> 64n, 8);
  return b.toString('hex');
}

/** A u32 as little-endian hex — how para ids and validator indices are encoded. */
export function u32le(n: number): string {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b.toString('hex');
}

/** Paras::Heads(paraId) storage key, matching zombie-bite's para_head_key(). */
export function parasHeadKey(paraId: number): string {
  const le = u32le(paraId);
  return keyOf('Paras', 'Heads') + xxhashAsHex('0x' + le, 64).slice(2) + le;
}

/** A twox64-concat map key: twox64(encoded) ++ encoded. */
export function twox64Concat(encodedHex: string): string {
  return xxhashAsHex('0x' + encodedHex, 64).slice(2) + encodedHex;
}

/**
 * SCALE compact length prefix for a sequence.
 *
 * Only the single-byte mode is supported, which covers every count here (at most six
 * validators, at most one collator). Anything larger is a bug in the caller, not a case to
 * silently mis-encode.
 */
export function compactLen(n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new Error(`compactLen needs a non-negative integer, got ${n}`);
  if (n >= 64) throw new Error(`compactLen only supports n < 64, got ${n}`);
  return (n << 2).toString(16).padStart(2, '0');
}

/** HeadData(Vec<u8>).encode() — a compact length prefix followed by the header bytes. */
export function encodeHeadData(hex: string): string {
  const b = Buffer.from(hex.replace(/^0x/, ''), 'hex');
  const l = b.length;
  let c: Buffer;
  if (l < 64) c = Buffer.from([l << 2]);
  else if (l < 16384) c = Buffer.from([((l << 2) | 1) & 0xff, (l << 2) >> 8]);
  else {
    c = Buffer.alloc(4);
    c.writeUInt32LE((l << 2) | 2);
  }
  return Buffer.concat([c, b]).toString('hex');
}

// ---------------------------------------------------------------------------
// IPFS CIDs
//
// Bulletin records a content hash, a codec and a hash function per stored
// transaction; that is everything needed to rebuild the CID the gateway serves.
// ---------------------------------------------------------------------------

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** RFC 4648 base32, lower-case, unpadded — the multibase 'b' alphabet. */
export function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Unsigned LEB128, as multicodec and multihash prefixes use. */
export function varint(n: number): number[] {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
}

/** Multihash codes for the hash functions bulletin actually uses. */
export const MULTIHASH: Record<string, number> = {
  Sha2_256: 0x12,
  Blake2b256: 0xb220,
};

/**
 * CIDv1 as the multibase-base32 string a gateway accepts:
 *   <0x01><codec><multihash code><32><digest>
 *
 * `cidCodec` is bulletin's own field — 85 (raw) for whole blobs, 112 (dag-pb)
 * for chunked ones. Both appear in practice.
 */
export function cidV1(cidCodec: number, hashing: string, digestHex: string): string {
  const code = MULTIHASH[hashing];
  if (code === undefined) throw new Error(`unsupported hashing: ${hashing}`);
  const digest = Buffer.from(digestHex.replace(/^0x/, ''), 'hex');
  if (digest.length !== 32) throw new Error(`expected a 32-byte digest, got ${digest.length}`);
  const prefix = Buffer.from([0x01, ...varint(cidCodec), ...varint(code), 0x20]);
  return 'b' + base32(Buffer.concat([prefix, digest]));
}
