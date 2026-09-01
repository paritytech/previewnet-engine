// Tests for packages/cli/src/upgrade/fund.ts — the sudo fee top-up drawn from well-known
// dev accounts. The live path needs a chain; what is pinned here is the donor policy,
// because a wrong list fails in the least helpful place (mid-upgrade, on a fork).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DONOR_URIS, MIN_FREE, TOP_UP } from '../src/upgrade/fund.js';
import { signerFromUri } from '../src/upgrade/signer.js';

describe('sudo funding policy', () => {
  it('never lists the default sudo (//Alice) as a donor', () => {
    const alice = signerFromUri('//Alice').address();
    for (const uri of DONOR_URIS) {
      assert.notEqual(signerFromUri(uri).address(), alice, `${uri} resolves to the sudo account`);
    }
  });

  it('lists distinct, derivable donors', () => {
    const addresses = DONOR_URIS.map((uri) => signerFromUri(uri).address());
    assert.equal(new Set(addresses).size, DONOR_URIS.length);
  });

  it('keeps the thresholds sane: ED < minimum < top-up', () => {
    const ED = 10_000_000_000n; // 1 PAS on the paseo relay — an account at ED cannot pay
    assert.ok(MIN_FREE > ED, 'the funding bar must clear the existential deposit');
    assert.ok(TOP_UP >= 10n * MIN_FREE);
  });
});
