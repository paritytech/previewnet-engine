// Overrides: repointing a binary or a release without editing the descriptor.
//
// The failure these prevent is specific. A consumer's release gate declares "this binary from
// that tag", and the run reports the declared pins while executing different ones. Every test
// here is about that gap: the override must reach the resolution every command reads, a typo
// must fail instead of being ignored, and what was applied must be reportable.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseOverride,
  overridesFromEnv,
  mergeOverrides,
  applyOverrides,
  overriddenKeys,
  overrideReleaseKey,
  loadNetwork,
  networkBinaries,
  type OverrideSet,
} from '../src/index.js';

const STABLE = 'paritytech/polkadot-sdk@polkadot-stable2606-1';
const none: OverrideSet = { releases: [], binaries: [], runtimes: [] };
const set = (o: Partial<OverrideSet>): OverrideSet => ({ ...none, ...o });

describe('parseOverride', () => {
  it('reads owner/repo@tag', () => {
    const o = parseOverride(`polkadot-omni-node=${STABLE}`, '--binary');
    assert.equal(o.key, 'polkadot-omni-node');
    assert.deepEqual(o.pin, { repo: 'paritytech/polkadot-sdk', tag: 'polkadot-stable2606-1' });
  });

  // A tag can contain no @, but a repo path can, so split on the last one.
  it('splits on the final @', () => {
    assert.deepEqual(parseOverride('x=a/b@v1@2', '--binary').pin, { repo: 'a/b@v1', tag: '2' });
  });

  // The declared form of what pre-seeding bin/ used to do by side effect.
  it('accepts a local file source', () => {
    const o = parseOverride('polkadot=file:/tmp/build/polkadot', '--binary');
    assert.equal(o.pin.tag, 'local');
    assert.match(o.pin.repo, /^file:/);
  });

  it('rejects every malformed shape, naming the flag', () => {
    for (const bad of ['polkadot', 'polkadot=', '=a/b@v1', 'x=noslash@v1', 'x=a/b@', 'x=a/b']) {
      assert.throws(() => parseOverride(bad, '--binary'), /--binary/, `accepted "${bad}"`);
    }
  });
});

describe('overridesFromEnv', () => {
  it('reads comma-separated entries from both variables', () => {
    const o = overridesFromEnv({
      PPN_RELEASES: `polkadot-sdk=${STABLE}`,
      PPN_BINARIES: `polkadot=${STABLE}, eth-rpc=${STABLE}`,
    } as NodeJS.ProcessEnv);
    assert.equal(o.releases.length, 1);
    assert.deepEqual(
      o.binaries.map((b) => b.key),
      ['polkadot', 'eth-rpc']
    );
  });

  it('is empty when nothing is set', () => {
    assert.deepEqual(overridesFromEnv({} as NodeJS.ProcessEnv), none);
  });
});

describe('mergeOverrides', () => {
  // The environment carries the standing choice; a flag is the one-off that must win.
  it('lets the last entry for a key win', () => {
    const merged = mergeOverrides(
      set({ binaries: [parseOverride('polkadot=a/b@one', 'env')] }),
      set({ binaries: [parseOverride('polkadot=a/b@two', '--binary')] })
    );
    assert.equal(merged.binaries.length, 1);
    assert.equal(merged.binaries[0].pin.tag, 'two');
  });
});

describe('applyOverrides', () => {
  const base = loadNetwork('previewnet');

  it('changes nothing when there is nothing to change', () => {
    assert.equal(applyOverrides(base, none), base);
  });

  it('moves one binary and leaves the rest alone', () => {
    const out = applyOverrides(
      base,
      set({ binaries: [parseOverride(`polkadot-omni-node=${STABLE}`, '--binary')] })
    );
    const bins = new Map(networkBinaries(out).map((b) => [b.name, `${b.repo}@${b.tag}`]));
    assert.equal(bins.get('polkadot-omni-node'), STABLE);
    assert.equal(bins.get('polkadot'), 'paritytech/release-automation@latest');
  });

  it('moves every binary and runtime sharing an overridden release', () => {
    const out = applyOverrides(
      base,
      set({ releases: [parseOverride(`polkadot-sdk=${STABLE}`, '--release')] })
    );
    for (const b of networkBinaries(out)) {
      const onSdk = ['polkadot', 'polkadot-omni-node', 'eth-rpc', 'chain-spec-builder'].includes(b.name);
      if (onSdk) assert.equal(`${b.repo}@${b.tag}`, STABLE, `${b.name} was not moved`);
    }
  });

  it('does not mutate the descriptor it was given', () => {
    const before = JSON.stringify(base);
    applyOverrides(base, set({ binaries: [parseOverride(`polkadot=${STABLE}`, '--binary')] }));
    assert.equal(JSON.stringify(base), before);
  });

  // Silently ignoring a typo is the whole failure mode: the gate would test the binary it was
  // trying to replace and report success.
  it('refuses a binary the network does not have', () => {
    assert.throws(
      () => applyOverrides(base, set({ binaries: [parseOverride(`polkadot-nope=${STABLE}`, '--binary')] })),
      /is not a binary of previewnet/
    );
  });

  it('refuses a release the network does not declare', () => {
    assert.throws(
      () => applyOverrides(base, set({ releases: [parseOverride(`nope=${STABLE}`, '--release')] })),
      /is not a release of previewnet/
    );
  });
});

describe('loadNetwork', () => {
  // Overrides must land inside the loader, or fetch/generate/show can each see a different
  // network — which is how a run downloads one binary and claims another.
  it('applies the environment, so every command sees the same resolution', () => {
    const saved = process.env.PPN_BINARIES;
    process.env.PPN_BINARIES = `polkadot-omni-node=${STABLE}`;
    try {
      const bins = new Map(
        networkBinaries(loadNetwork('previewnet')).map((b) => [b.name, `${b.repo}@${b.tag}`])
      );
      assert.equal(bins.get('polkadot-omni-node'), STABLE);
    } finally {
      if (saved === undefined) delete process.env.PPN_BINARIES;
      else process.env.PPN_BINARIES = saved;
    }
  });
});

describe('overriddenKeys', () => {
  it('names release keys directly and binaries through their synthetic key', () => {
    const keys = overriddenKeys(
      set({
        releases: [parseOverride(`polkadot-sdk=${STABLE}`, '--release')],
        binaries: [parseOverride(`polkadot=${STABLE}`, '--binary')],
      })
    );
    assert.ok(keys.has('polkadot-sdk'));
    assert.ok(keys.has(overrideReleaseKey('polkadot')));
  });
});

// `--runtime <chain>=…` is how a wasm built somewhere else reaches a run: a CI artifact from a
// polkadot-fellows/runtimes branch, an srtool build on a laptop. `--release` could only move a
// whole release, and `--binary` names a file rather than a chain — neither is the right grain
// for "this one chain is under test".
describe('runtime overrides', () => {
  const net = () => loadNetwork('previewnet');

  it("repoints one chain's runtime and leaves the others alone", () => {
    const out = applyOverrides(
      net(),
      set({ runtimes: [parseOverride('asset-hub=file:/artifacts/ah.wasm', '--runtime')] })
    );
    const ah = out.parachains.find((p) => p.key === 'asset-hub')!;
    const people = out.parachains.find((p) => p.key === 'people')!;
    assert.deepEqual(out.releases[ah.runtime!.release], {
      repo: 'file:/artifacts/ah.wasm',
      tag: 'local',
    });
    assert.equal(
      people.runtime!.release,
      net().parachains.find((p) => p.key === 'people')!.runtime!.release
    );
    // The binary is a separate axis: overriding a runtime must not move the node.
    assert.equal(
      ah.binary.release,
      net().parachains.find((p) => p.key === 'asset-hub')!.binary.release
    );
  });

  it('repoints the relay too, which is a chain like any other here', () => {
    const out = applyOverrides(
      net(),
      set({ runtimes: [parseOverride('relay=paseo-network/runtimes@v2.4.5', '--runtime')] })
    );
    assert.deepEqual(out.releases[out.relay.runtime!.release], {
      repo: 'paseo-network/runtimes',
      tag: 'v2.4.5',
    });
  });

  it('refuses a chain the network does not run', () => {
    // Silently ignoring it would leave the declared runtime in place, and the run would then
    // test the runtime it was trying to replace.
    assert.throws(
      () =>
        applyOverrides(net(), set({ runtimes: [parseOverride('nope=file:/x.wasm', '--runtime')] })),
      /not a chain of previewnet/
    );
  });

  it('refuses a fork-only network, which declares no runtimes at all', () => {
    assert.throws(
      () =>
        applyOverrides(
          loadNetwork('kusama'),
          set({ runtimes: [parseOverride('asset-hub=file:/x.wasm', '--runtime')] })
        ),
      /declares no runtime/
    );
  });
});
