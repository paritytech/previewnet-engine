// Tests for packages/network-config/src/toml-generator.ts
// Run with: tsx --test packages/network-config/tests/toml-generator.test.ts

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateToml,
  calcValidatorCount,
  VALID_PARACHAINS,
  CHAIN_ARGS,
  P2P_PORTS,
  POPULAR_LOG_TARGETS,
  LOG_LEVELS,
} from '../src/toml-generator.js';
import { loadNetwork } from '../src/load.js';
import type { Parachain, LogLevel } from '../src/types.js';

// Genesis is previewnet's, and the generator reads previewnet's descriptor for the
// values below rather than restating them. Reading the same source here would make the
// assertions vacuous, so they check the descriptor's *current* values literally — if
// someone edits the descriptor, these fail and say so.
describe('generateToml — follows the previewnet descriptor', () => {
  const net = loadNetwork('previewnet');
  const toml = generateToml([...VALID_PARACHAINS]);

  it('takes the relay chain id, spec file and binary from it', () => {
    assert.equal(net.relay.genesisSpec!.chainId, 'paseo-local');
    assert.equal(net.relay.genesisSpec!.file, 'relay_paseo.json');
    assert.equal(net.relay.binary.name, 'polkadot');
    assert.ok(toml.includes(`chain = "${net.relay.genesisSpec!.chainId}"`));
    assert.ok(toml.includes(`chain_spec_path = "{{BIN}}/${net.relay.genesisSpec!.file}"`));
    assert.ok(toml.includes(`default_command = "{{BIN}}/${net.relay.binary.name}"`));
  });

  it('takes each parachainid, chain id and spec file from it', () => {
    for (const p of net.parachains) {
      assert.ok(toml.includes(`id = ${p.paraId}`), `${p.key} para id ${p.paraId}`);
      assert.ok(toml.includes(`chain = "${p.genesisSpec!.chainId}"`), `${p.key} chain id`);
      assert.ok(
        toml.includes(`chain_spec_path = "{{BIN}}/${p.genesisSpec!.file}"`),
        `${p.key} spec file`
      );
    }
    // The values the descriptor holds today, so an accidental edit is caught here.
    const ids = Object.fromEntries(net.parachains.map((p) => [p.key, p.paraId]));
    assert.deepEqual(ids, { 'asset-hub': 1500, people: 1502, bulletin: 1501, 'web3-storage': 1600 });
  });

  it('names relay validators with the descriptor suffix', () => {
    assert.equal(net.genesisConfig!.validatorNameSuffix, 'paseo-validator');
    assert.ok(toml.includes(`name = "alice-${net.genesisConfig!.validatorNameSuffix}"`));
  });

  // The genesis generator used to ignore `services` entirely; fork mode honoured it.
  it('omits a custom process the descriptor switches off', () => {
    assert.ok(toml.includes('name = "eth-rpc"'), 'eth-rpc runs when not disabled');
    assert.ok(toml.includes('name = "assign-cores"'));
    assert.ok(toml.includes('name = "patch-bootnodes"'));
  });
});

describe('generateToml', () => {
  it('throws on empty parachains', () => {
    assert.throws(() => generateToml([]), /At least one parachain/);
    assert.throws(() => generateToml(null), /At least one parachain/);
  });

  it('throws on unknown parachain', () => {
    assert.throws(() => generateToml(['unknown' as Parachain]), /Unknown parachain/);
  });

  it('generates valid TOML for all parachains', () => {
    const toml = generateToml(['asset-hub', 'people', 'bulletin']);

    // Settings
    assert.ok(toml.includes('[settings]'));
    assert.ok(toml.includes('timeout = 600'));

    // Elastic scaling for asset-hub
    assert.ok(toml.includes('[relaychain.genesis.configuration.config.scheduler_params]'));
    assert.ok(toml.includes('num_cores = 2'));

    // Relay chain
    assert.ok(toml.includes('[relaychain]'));
    assert.ok(toml.includes('chain = "paseo-local"'));
    assert.ok(toml.includes('chain_spec_path = "{{BIN}}/relay_paseo.json"'));

    // 6 validators (3 parachains + 2 for asset-hub + 1 = 6, clamped to 6)
    assert.ok(toml.includes('alice-paseo-validator'));
    assert.ok(toml.includes('bob-paseo-validator'));
    assert.ok(toml.includes('charlie-paseo-validator'));
    assert.ok(toml.includes('dave-paseo-validator'));
    assert.ok(toml.includes('eve-paseo-validator'));
    assert.ok(toml.includes('ferdie-paseo-validator'));

    // All parachains
    assert.ok(toml.includes('id = 1500'));
    assert.ok(toml.includes('id = 1502'));
    assert.ok(toml.includes('id = 1501'));

    // HRMP channels (people<->bulletin, people<->asset-hub)
    const hrmpCount = (toml.match(/\[\[hrmp_channels\]\]/g) || []).length;
    assert.equal(hrmpCount, 4); // 2 pairs x 2 directions

    // Custom processes
    assert.ok(toml.includes('name = "eth-rpc"'));
    assert.ok(toml.includes('name = "ipfs-daemon"'));
    assert.ok(toml.includes('name = "ipfs-swarm"'));
    assert.ok(toml.includes('name = "force-open-hrmp"'));
    assert.ok(toml.includes('name = "increase-people-lite-attestation-allowance"'));
    assert.ok(!toml.includes('name = "inject-bootnodes"'));
    assert.ok(toml.includes('name = "patch-bootnodes"'));
    assert.ok(toml.includes('name = "assign-cores"'));
  });

  it('generates TOML for asset-hub only', () => {
    const toml = generateToml(['asset-hub']);

    // Elastic scaling present
    assert.ok(toml.includes('num_cores = 2'));

    // 4 validators (1 + 2 + 1 = 4)
    assert.ok(toml.includes('alice-paseo-validator'));
    assert.ok(toml.includes('dave-paseo-validator'));
    assert.ok(!toml.includes('eve-paseo-validator'));

    // Only asset-hub parachain
    assert.ok(toml.includes('id = 1500'));
    assert.ok(!toml.includes('id = 1502'));
    assert.ok(!toml.includes('id = 1501'));

    // No HRMP channels
    assert.ok(!toml.includes('[[hrmp_channels]]'));

    // Only eth-rpc and assign-cores
    assert.ok(toml.includes('name = "eth-rpc"'));
    assert.ok(toml.includes('name = "assign-cores"'));
    assert.ok(!toml.includes('name = "ipfs-daemon"'));
    assert.ok(!toml.includes('name = "force-open-hrmp"'));
    assert.ok(!toml.includes('name = "increase-people-lite-attestation-allowance"'));
  });

  it('generates TOML for people + bulletin', () => {
    const toml = generateToml(['people', 'bulletin']);

    // No elastic scaling
    assert.ok(!toml.includes('num_cores'));

    // 4 validators (2 + 0 + 1 = 3, clamped to 4)
    assert.ok(toml.includes('dave-paseo-validator'));
    assert.ok(!toml.includes('eve-paseo-validator'));

    // People and bulletin only
    assert.ok(!toml.includes('id = 1500'));
    assert.ok(toml.includes('id = 1502'));
    assert.ok(toml.includes('id = 1501'));

    // HRMP channels between people and bulletin only
    const hrmpCount = (toml.match(/\[\[hrmp_channels\]\]/g) || []).length;
    assert.equal(hrmpCount, 2); // 1 pair x 2 directions

    // Bulletin custom processes
    assert.ok(toml.includes('name = "ipfs-daemon"'));
    assert.ok(toml.includes('name = "ipfs-swarm"'));
    assert.ok(toml.includes('name = "force-open-hrmp"'));
    assert.ok(toml.includes('name = "increase-people-lite-attestation-allowance"'));
    assert.ok(!toml.includes('name = "eth-rpc"'));
    assert.ok(!toml.includes('name = "assign-cores"'));
  });

  it('generates TOML for bulletin only', () => {
    const toml = generateToml(['bulletin']);

    // 4 validators minimum
    assert.ok(toml.includes('dave-paseo-validator'));
    assert.ok(!toml.includes('eve-paseo-validator'));

    // Only bulletin
    assert.ok(toml.includes('id = 1501'));
    assert.ok(!toml.includes('id = 1500'));
    assert.ok(!toml.includes('id = 1502'));

    // No HRMP channels (no pair partner)
    assert.ok(!toml.includes('[[hrmp_channels]]'));

    // No force-open-hrmp
    assert.ok(!toml.includes('name = "force-open-hrmp"'));
    assert.ok(!toml.includes('name = "increase-people-lite-attestation-allowance"'));
    assert.ok(toml.includes('name = "ipfs-daemon"'));
  });

  it('generates TOML for people only', () => {
    const toml = generateToml(['people']);

    assert.ok(toml.includes('id = 1502'));
    assert.ok(!toml.includes('id = 1500'));
    assert.ok(!toml.includes('id = 1501'));

    // patch-bootnodes and pin-design-families (always present)
    assert.ok(toml.includes('name = "patch-bootnodes"'));
    assert.ok(toml.includes('name = "pin-design-families"'));
    assert.ok(!toml.includes('name = "inject-bootnodes"'));
    assert.ok(!toml.includes('name = "eth-rpc"'));
    assert.ok(!toml.includes('name = "ipfs-daemon"'));
    assert.ok(!toml.includes('name = "assign-cores"'));
    assert.ok(toml.includes('name = "increase-people-lite-attestation-allowance"'));
  });

  it('uses {{BIN}} and {{SCRIPTS}} placeholders', () => {
    const toml = generateToml(['asset-hub', 'bulletin']);
    assert.ok(toml.includes('{{BIN}}/polkadot'));
    assert.ok(toml.includes('{{SCRIPTS}}/eth-rpc.sh'));
  });

  // Collators go through the wrapper, which forces libp2p on the relay-chain node they run
  // in-process. On the default backend (litep2p) that node's websocket listener dies and
  // takes the essential `network-worker` task, and the collator, with it.
  it('runs collators through the omni-node wrapper, not the bare binary', () => {
    const toml = generateToml(['asset-hub', 'bulletin']);
    assert.equal(toml.split('command = "{{SCRIPTS}}/omni-node.sh"').length - 1, 2);
    assert.ok(!toml.includes('{{BIN}}/polkadot-omni-node'));
  });

  it('includes p2p_port for all nodes with bootnodes', () => {
    const toml = generateToml(['asset-hub', 'people', 'bulletin']);
    // p2p_port for: relay alice + asset-hub + people + bulletin = 4
    const p2pCount = (toml.match(/p2p_port/g) || []).length;
    assert.equal(p2pCount, 4);
    assert.ok(toml.includes(`p2p_port = ${P2P_PORTS.relay}`)); // relay alice
    assert.ok(toml.includes(`p2p_port = ${P2P_PORTS['asset-hub']}`)); // asset-hub
    assert.ok(toml.includes(`p2p_port = ${P2P_PORTS.people}`)); // people
    assert.ok(toml.includes(`p2p_port = ${P2P_PORTS.bulletin}`)); // bulletin
  });

  it('does not produce triple blank lines', () => {
    const combos: Parachain[][] = [
      ['asset-hub'],
      ['people'],
      ['bulletin'],
      ['asset-hub', 'people'],
      ['people', 'bulletin'],
      ['asset-hub', 'bulletin'],
      ['asset-hub', 'people', 'bulletin'],
    ];
    for (const combo of combos) {
      const toml = generateToml(combo);
      assert.ok(
        !toml.includes('\n\n\n'),
        `Triple blank line in combo: ${combo.join(', ')}`
      );
    }
  });

  it('ends with a single newline', () => {
    const toml = generateToml(['asset-hub', 'people', 'bulletin']);
    assert.ok(toml.endsWith('\n'));
    assert.ok(!toml.endsWith('\n\n'));
  });

  it('exports VALID_PARACHAINS', () => {
    assert.deepEqual(VALID_PARACHAINS, ['asset-hub', 'people', 'bulletin', 'web3-storage']);
  });
});

describe('generateToml with custom log targets', () => {
  it('uses default log targets when no options provided', () => {
    const toml = generateToml(['asset-hub']);
    // Relay defaults: runtime=debug,xcm=trace
    assert.ok(toml.includes('-lruntime=debug,xcm=trace'));
    // Asset Hub defaults: xcm=trace
    assert.ok(toml.includes('-lxcm=trace'));
  });

  it('accepts custom log targets for relay', () => {
    const toml = generateToml(['asset-hub'], {
      logTargets: { relay: { babe: 'debug', grandpa: 'trace' } },
    });
    assert.ok(toml.includes('-lbabe=debug,grandpa=trace'));
    // Required relay args still present
    assert.ok(toml.includes('--network-backend=libp2p'));
    // Default relay logs replaced
    assert.ok(!toml.includes('runtime=debug'));
  });

  it('accepts custom log targets for parachain', () => {
    const toml = generateToml(['asset-hub'], {
      logTargets: { 'asset-hub': { xcm: 'debug', pallet_revive: 'trace' } },
    });
    assert.ok(toml.includes('-lxcm=debug,pallet_revive=trace'));
    // Required parachain args still present
    assert.ok(toml.includes('--force-authoring'));
    assert.ok(toml.includes('--authoring=slot-based'));
  });

  it('uses defaults for chains not specified in logTargets', () => {
    const toml = generateToml(['asset-hub', 'people'], {
      logTargets: { 'asset-hub': { p2p: 'trace' } },
    });
    // Asset Hub gets custom
    assert.ok(toml.includes('-lp2p=trace'));
    // People gets default (parachain=debug,xcm=trace)
    assert.ok(toml.includes('-lparachain=debug,xcm=trace'));
  });

  it('preserves required args with custom log targets', () => {
    const toml = generateToml(['people'], {
      logTargets: { people: { sync: 'debug' } },
    });
    assert.ok(toml.includes('--enable-statement-store'));
    assert.ok(toml.includes('--network-backend=libp2p'));
    assert.ok(toml.includes('--authoring=slot-based'));
    assert.ok(toml.includes('--force-authoring'));
  });

  it('preserves required args for bulletin with custom log targets', () => {
    const toml = generateToml(['bulletin'], {
      logTargets: { bulletin: { sync: 'info' } },
    });
    assert.ok(toml.includes('--ipfs-server'));
    assert.ok(toml.includes('--force-authoring'));
    assert.ok(toml.includes('-lsync=info'));
  });
});

describe('generateToml with enableHop', () => {
  it('includes --enable-hop in bulletin args when enableHop is true', () => {
    const toml = generateToml(['bulletin'], { enableHop: true });
    assert.ok(toml.includes('--enable-hop'));
  });

  it('does not include --enable-hop when enableHop is false', () => {
    const toml = generateToml(['bulletin'], { enableHop: false });
    assert.ok(!toml.includes('--enable-hop'));
  });

  it('does not include --enable-hop when enableHop is omitted', () => {
    const toml = generateToml(['bulletin']);
    assert.ok(!toml.includes('--enable-hop'));
  });

  it('only applies --enable-hop to bulletin, not other chains', () => {
    const toml = generateToml(['asset-hub', 'people', 'bulletin'], { enableHop: true });
    // Split by parachain sections and check each
    const bulletinSection = toml.split('## Bulletin Chain')[1];
    const assetHubSection = toml.split('## Asset Hub')[1]?.split('## People Chain')[0] || '';
    const peopleSection = toml.split('## People Chain')[1]?.split('## Bulletin Chain')[0] || '';

    assert.ok(bulletinSection.includes('--enable-hop'), 'bulletin should have --enable-hop');
    assert.ok(!assetHubSection.includes('--enable-hop'), 'asset-hub should not have --enable-hop');
    assert.ok(!peopleSection.includes('--enable-hop'), 'people should not have --enable-hop');
  });

  it('combines --enable-hop with custom log targets for bulletin', () => {
    const toml = generateToml(['bulletin'], {
      enableHop: true,
      logTargets: { bulletin: { sync: 'info' } },
    });
    assert.ok(toml.includes('--enable-hop'));
    assert.ok(toml.includes('-lsync=info'));
    assert.ok(toml.includes('--ipfs-server'));
  });
});

describe('generateToml validation', () => {
  it('rejects unknown chain in logTargets', () => {
    assert.throws(
      () => generateToml(['asset-hub'], { logTargets: { unknown: { xcm: 'debug' } } as Record<string, Record<string, LogLevel>> }),
      /Unknown chain for log targets/
    );
  });

  it('rejects invalid log level', () => {
    assert.throws(
      () => generateToml(['asset-hub'], { logTargets: { relay: { xcm: 'not valid!' as LogLevel } } }),
      /Invalid log level/
    );
  });

  it('accepts non-standard log levels', () => {
    const toml = generateToml(['asset-hub'], {
      logTargets: { relay: { xcm: 'verbose' as LogLevel } },
    });
    assert.ok(toml.includes('-lxcm=verbose'));
  });

  it('rejects invalid log target name', () => {
    assert.throws(
      () => generateToml(['asset-hub'], { logTargets: { relay: { 'rm -rf /': 'debug' } } }),
      /Invalid log target name/
    );
  });

  it('rejects non-object log targets', () => {
    assert.throws(
      () => generateToml(['asset-hub'], { logTargets: { relay: 'debug' as unknown as Record<string, LogLevel> } }),
      /must be an object/
    );
  });

  it('accepts all valid log levels', () => {
    for (const level of LOG_LEVELS) {
      const toml = generateToml(['asset-hub'], {
        logTargets: { relay: { xcm: level } },
      });
      assert.ok(toml.includes(`-lxcm=${level}`));
    }
  });

  it('accepts target names with colons, hyphens, underscores', () => {
    const toml = generateToml(['asset-hub'], {
      logTargets: { relay: { 'sub-libp2p': 'debug', 'sc_network': 'trace' } },
    });
    assert.ok(toml.includes('sub-libp2p=debug'));
    assert.ok(toml.includes('sc_network=trace'));
  });
});

describe('calcValidatorCount', () => {
  it('returns 4 for single non-asset-hub parachain', () => {
    assert.equal(calcValidatorCount(['bulletin']), 4);
    assert.equal(calcValidatorCount(['people']), 4);
  });

  it('returns 4 for asset-hub alone (1+2+1=4)', () => {
    assert.equal(calcValidatorCount(['asset-hub']), 4);
  });

  it('returns 5 for asset-hub + one other (2+2+1=5)', () => {
    assert.equal(calcValidatorCount(['asset-hub', 'people']), 5);
    assert.equal(calcValidatorCount(['asset-hub', 'bulletin']), 5);
  });

  it('returns 4 for two non-asset-hub (2+0+1=3, clamped to 4)', () => {
    assert.equal(calcValidatorCount(['people', 'bulletin']), 4);
  });

  it('returns 6 for all parachains (3+2+1=6)', () => {
    assert.equal(calcValidatorCount(['asset-hub', 'people', 'bulletin']), 6);
  });

  it('returns 4 for empty/null input', () => {
    assert.equal(calcValidatorCount([]), 4);
    assert.equal(calcValidatorCount(null), 4);
  });
});

describe('exports', () => {
  it('exports CHAIN_ARGS with all chains', () => {
    assert.ok(CHAIN_ARGS.relay);
    assert.ok(CHAIN_ARGS['asset-hub']);
    assert.ok(CHAIN_ARGS.people);
    assert.ok(CHAIN_ARGS.bulletin);
    for (const def of Object.values(CHAIN_ARGS)) {
      assert.ok(Array.isArray(def.required));
      assert.ok(typeof def.defaultLogs === 'object');
    }
  });

  it('exports POPULAR_LOG_TARGETS as non-empty array', () => {
    assert.ok(Array.isArray(POPULAR_LOG_TARGETS));
    assert.ok(POPULAR_LOG_TARGETS.length > 0);
    assert.ok(POPULAR_LOG_TARGETS.includes('xcm'));
    assert.ok(POPULAR_LOG_TARGETS.includes('runtime'));
  });

  it('exports LOG_LEVELS', () => {
    assert.deepEqual(LOG_LEVELS, ['trace', 'debug', 'info', 'warn', 'error']);
  });
});
