// Tests for biteHashes in packages/cli/src/fork/manifest.ts
// Run with: tsx --test tests/fork-bite-hashes.test.ts
//
// A fork's own block at the bite height is not its source's, so the bite reads the source's
// hash while it is fresh. A fork's descriptor names every chain's source block or none.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { biteHashes } from '../src/fork/manifest.js';
import type { ForkManifest } from '@parity/ppn-network-config';

const chain = (paraId: number | null, endpoint?: string) => ({
  paraId, spec: 'x', endpoint, specName: 'x', specVersion: 1, headAtStart: 1, genesis: '0x00',
});
const chains: ForkManifest['chains'] = {
  relay: chain(null, 'https://source/relay'),
  'asset-hub': chain(1500, 'https://source/asset-hub'),
};
const blocks = { relay: 100, '1500': 200 };

describe('biteHashes', () => {
  it("asks each chain's source for its block at the bite, keyed as biteBlocks", async () => {
    const asked: string[] = [];
    const call = (async (url: string, _method: string, params: unknown[]) => {
      asked.push(`${url}#${params[0]}`);
      return `0x${params[0]}`;
    }) as never;
    assert.deepEqual(await biteHashes(chains, blocks, call), { relay: '0x100', '1500': '0x200' });
    assert.deepEqual(asked, ['https://source/relay#100', 'https://source/asset-hub#200']);
  });

  it('records none when one source does not answer', async () => {
    const call = (async (url: string) => {
      if (url.endsWith('asset-hub')) throw new Error('down');
      return '0xaa';
    }) as never;
    assert.equal(await biteHashes(chains, blocks, call), null);
  });

  it('records none for a bundle whose chains carry no endpoint', async () => {
    assert.equal(await biteHashes({ relay: chain(null) }, { relay: 1 }, (async () => '0xaa') as never), null);
  });
});
