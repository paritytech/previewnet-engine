// Tests for packages/cli/src/fork/products.ts and the CID helpers in ./codec.ts
// Run with: tsx --test packages/cli/tests/fork-products.test.ts

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { base32, cidV1, varint, MULTIHASH } from '../src/fork/codec.js';
import { contenthashPrefixes, digestPrefixOf, matchProducts } from '../src/fork/products.js';
import type { BulletinEntry } from '../src/fork/products.js';

// A real bulletin entry, and the CID production's gateway serves for it (HTTP 200,
// content-length matching the recorded size).
const RAW_ENTRY: BulletinEntry = {
  contentHash: '0x1d2b8597fb33aa6893475423de20af99bec854e545609d0fd8d34e01b8f7667a',
  cidCodec: 85, // raw
  hashing: 'Sha2_256',
  size: 1836578,
};
const RAW_CID = 'bafkreia5foczp6ztvjujgr2ueppcbl4zx3efjzkfmcoq7wgtjya3r53gpi';

// A real contenthash word from the paseo-next-v2 content resolver's child trie:
// e3 01 01 | 70 (dag-pb) | 12 20 (sha2-256, 32 bytes) | first 26 digest bytes
const WORD = '0xe301017012204b2ccb11e8ffc468118bd331a495ef7b3198e642486b204f4e46';

// A blake2b-256 contenthash: the multihash code 0xb220 is a *three*-byte varint (a0 e4 02),
// so its header is 8 bytes where sha2-256's is 6. Reading it at the sha2 offset yields the tail
// of the code plus the length byte instead of the digest — a value that matches nothing in
// bulletin, so the product is dropped from the fork silently and only for blake2b entries.
// e3 01 01 | 70 (dag-pb) | a0 e4 02 (blake2b-256) | 20 (32 bytes) | digest…
const BLAKE_WORD =
  '0xe3010170a0e402200102030405060708090a0b0c0d0e0f101112131415161718';
const BLAKE_DIGEST_24 = '0102030405060708090a0b0c0d0e0f101112131415161718';

describe('digestPrefixOf', () => {
  it('reads the digest of a sha2-256 record', () => {
    // The real production word: header e3 01 01 | 70 | 12 | 20, so the digest starts at byte 6.
    assert.equal(digestPrefixOf(WORD), '4b2ccb11e8ffc468118bd331a495ef7b3198e642486b204f4e46');
  });

  it('reads the digest of a blake2b-256 record, whose multihash code is three bytes', () => {
    assert.equal(digestPrefixOf(BLAKE_WORD), BLAKE_DIGEST_24);
  });

  // The bug this replaced: a fixed 6-byte header put the read two bytes early on blake2b.
  it('does not read a blake2b record at the sha2 offset', () => {
    assert.notEqual(digestPrefixOf(BLAKE_WORD), BLAKE_WORD.slice(2).slice(12, 12 + 48));
  });

  it('ignores a word that is not a contenthash', () => {
    assert.equal(digestPrefixOf('0x' + '11'.repeat(32)), null);
  });
});

describe('varint', () => {
  it('encodes single bytes below 0x80 unchanged', () => {
    assert.deepEqual(varint(0x55), [0x55]); // raw codec
    assert.deepEqual(varint(0x70), [0x70]); // dag-pb codec
    assert.deepEqual(varint(0x12), [0x12]); // sha2-256
  });

  // Blake2b-256 is 0xb220, which needs multiple bytes — hardcoding a single-byte
  // multihash silently produces CIDs that 404 for every blake2b entry.
  it('encodes multi-byte values LEB128', () => {
    assert.deepEqual(varint(MULTIHASH.Blake2b256), [0xa0, 0xe4, 0x02]);
  });
});

describe('base32', () => {
  it('is lower-case, unpadded RFC 4648', () => {
    assert.equal(base32(Buffer.from('foobar')), 'mzxw6ytboi');
    assert.match(base32(Buffer.from([0xff, 0x00])), /^[a-z2-7]+$/);
  });

  it('handles input that is not a multiple of five bits', () => {
    assert.equal(base32(Buffer.from([0x00])), 'aa');
  });
});

describe('cidV1', () => {
  it('rebuilds the CID a gateway actually served', () => {
    assert.equal(cidV1(RAW_ENTRY.cidCodec, RAW_ENTRY.hashing, RAW_ENTRY.contentHash), RAW_CID);
  });

  it('tolerates a digest with or without 0x', () => {
    assert.equal(cidV1(85, 'Sha2_256', RAW_ENTRY.contentHash.slice(2)), RAW_CID);
  });

  // These prefixes are how you eyeball a CID: bafkrei = raw+sha2, bafybei = dag-pb+sha2.
  it('produces the expected multibase prefix per codec', () => {
    const digest = RAW_ENTRY.contentHash;
    assert.ok(cidV1(85, 'Sha2_256', digest).startsWith('bafkrei'), 'raw');
    assert.ok(cidV1(112, 'Sha2_256', digest).startsWith('bafybei'), 'dag-pb');
  });

  it('supports blake2b, which bulletin also uses', () => {
    const cid = cidV1(85, 'Blake2b256', RAW_ENTRY.contentHash);
    assert.match(cid, /^b[a-z2-7]+$/);
    assert.notEqual(cid, RAW_CID, 'hashing must change the CID');
  });

  it('refuses what it cannot encode rather than emitting a bad CID', () => {
    assert.throws(() => cidV1(85, 'Keccak256', RAW_ENTRY.contentHash), /unsupported hashing/);
    assert.throws(() => cidV1(85, 'Sha2_256', '0xabcd'), /32-byte digest/);
  });
});

describe('contenthashPrefixes', () => {
  it('extracts the 26 readable digest bytes from an ENS contenthash word', () => {
    const [p] = contenthashPrefixes([WORD]);
    assert.equal(p, '4b2ccb11e8ffc468118bd331a495ef7b3198e642486b204f4e46');
    assert.equal(p.length, 52);
  });

  it('ignores every other kind of word', () => {
    const others = [
      '0x' + '00'.repeat(32), // empty
      '0x000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266', // address
      '0x000000000000000000000000000000000000000000000000000000000000004d', // small int
    ];
    assert.deepEqual(contenthashPrefixes(others), []);
  });

  it('is case- and prefix-insensitive', () => {
    assert.equal(contenthashPrefixes([WORD.toUpperCase().replace('0X', '0x')]).length, 1);
    assert.equal(contenthashPrefixes([WORD.slice(2)]).length, 1);
  });
});

describe('matchProducts', () => {
  const other: BulletinEntry = {
    contentHash: '0x' + 'ab'.repeat(32),
    cidCodec: 112,
    hashing: 'Sha2_256',
    size: 10,
  };

  it('joins a record to the bulletin entry holding its bytes', () => {
    const prefix = RAW_ENTRY.contentHash.slice(2, 2 + 52);
    const r = matchProducts([prefix], [RAW_ENTRY, other]);
    assert.deepEqual(r.cids, [RAW_CID]);
    assert.equal(r.matched, 1);
    assert.equal(r.unmatched, 0);
  });

  // Most registered contenthashes on a mature network point at content already
  // pruned past the retention window. Nothing can serve those, so they are dropped
  // rather than turned into CIDs that would 404.
  it('drops records whose content is no longer retained', () => {
    const r = matchProducts(['ff'.repeat(26)], [RAW_ENTRY]);
    assert.deepEqual(r.cids, []);
    assert.equal(r.matched, 0);
    assert.equal(r.unmatched, 1);
  });

  it('deduplicates records pointing at the same content', () => {
    const prefix = RAW_ENTRY.contentHash.slice(2, 2 + 52);
    const r = matchProducts([prefix, prefix, prefix], [RAW_ENTRY]);
    assert.deepEqual(r.cids, [RAW_CID]);
    assert.equal(r.matched, 3, 'every record still counts as matched');
  });

  it('returns nothing for an empty scan', () => {
    assert.deepEqual(matchProducts([], []).cids, []);
  });
});
