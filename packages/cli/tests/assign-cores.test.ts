// assign-cores runs on every start, from genesis and on kept chains alike. A plan that moved an
// assigned core would take it from a running chain, and one that used a core without a validator
// group would leave blocks on it unbacked.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadNetwork } from '@parity/ppn-network-config';
import { planExtraCores } from '../src/commands/service.js';

const PARACHAINS = loadNetwork('previewnet').parachains;

/** Cores to para ids, as readCoreAssignments() reads them off the relay. */
const cores = (layout: Record<number, number>) =>
  new Map(Object.entries(layout).map(([core, paraId]) => [Number(core), [paraId]]));

describe('planExtraCores', () => {
  it('hands the genesis extra cores to the parachains that run on more than one', () => {
    // The genesis TOML adds four cores; the relay puts each parachain on one after them.
    const genesis = cores({ 4: 1500, 5: 1502, 6: 1501, 7: 1600 });
    assert.deepEqual(planExtraCores(PARACHAINS, genesis, 8), {
      assignments: [
        { core: 0, paraId: 1500 },
        { core: 1, paraId: 1500 },
        { core: 2, paraId: 1502 },
        { core: 3, paraId: 1502 },
      ],
      missing: [],
    });
  });

  it('changes nothing on a relay that is already laid out', () => {
    const laidOut = cores({ 0: 1500, 1: 1500, 2: 1500, 3: 1502, 4: 1501, 5: 1600, 6: 1502, 7: 1502 });
    assert.deepEqual(planExtraCores(PARACHAINS, laidOut, 8), { assignments: [], missing: [] });
  });

  it('reports the cores a relay lacks validators for instead of taking them from another chain', () => {
    const sixValidators = cores({ 0: 1500, 1: 1500, 2: 1500, 3: 1502, 4: 1501, 5: 1600 });
    assert.deepEqual(planExtraCores(PARACHAINS, sixValidators, 6), {
      assignments: [],
      missing: [{ key: 'people', cores: 2 }],
    });
  });

  it('gives a grown relay its new cores, leaving the assigned ones where they are', () => {
    const grown = cores({ 0: 1500, 1: 1500, 2: 1500, 3: 1502, 4: 1501, 5: 1600 });
    assert.deepEqual(planExtraCores(PARACHAINS, grown, 8), {
      assignments: [
        { core: 6, paraId: 1502 },
        { core: 7, paraId: 1502 },
      ],
      missing: [],
    });
  });

  it('gives a relay one validator short the free core there is, and reports the other', () => {
    const oneShort = cores({ 0: 1500, 1: 1500, 2: 1500, 3: 1502, 4: 1501, 5: 1600 });
    assert.deepEqual(planExtraCores(PARACHAINS, oneShort, 7), {
      assignments: [{ core: 6, paraId: 1502 }],
      missing: [{ key: 'people', cores: 1 }],
    });
  });

  // `PPN_PARACHAINS=people,bulletin`: Asset Hub comes first in the descriptor but is not registered.
  it('gives no core to a parachain the relay does not run', () => {
    const subset = cores({ 2: 1502, 3: 1501 });
    assert.deepEqual(planExtraCores(PARACHAINS, subset, 5), {
      assignments: [
        { core: 0, paraId: 1502 },
        { core: 1, paraId: 1502 },
      ],
      missing: [],
    });
  });
});
