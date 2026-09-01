// Tests for packages/cli/src/upgrade/ — the pure parts of the runtime-upgrade tooling.
// Run with: tsx --test packages/cli/tests/upgrade.test.ts
//
// Strategy selection is the piece most worth pinning down: pick a version-checked call
// and the ALLOW_SAME_SPEC case triangle-e2e needs (applying production's own runtime to
// a fork, where spec_version cannot move) is rejected on-chain long after the wasm was
// shipped. The event helpers matter for the same reason from the other side: a sudo
// extrinsic "succeeds" even when its inner call failed, and enactment of byte-identical
// code is invisible to a spec-version check — events are the only honest signal.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  wasmFormat,
  strategyCandidates,
  sudidError,
  httpFromWs,
  type DecodedEvent,
} from '../src/upgrade/upgrade.js';
import { localWsUrl, UPGRADE_CHAINS } from '../src/upgrade/chains.js';
import { parseEnvFile, resolveSudoUri } from '../src/upgrade/sudo.js';
import { splitSuri, signerFromUri } from '../src/upgrade/signer.js';

describe('wasmFormat', () => {
  it('accepts compact-compressed blobs (0x52bc5376)', () => {
    assert.equal(wasmFormat(new Uint8Array([0x52, 0xbc, 0x53, 0x76, 0xff])), 'compressed');
  });

  it('accepts raw wasm (\\0asm)', () => {
    assert.equal(wasmFormat(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01])), 'raw');
  });

  it('rejects anything else', () => {
    assert.throws(() => wasmFormat(new Uint8Array([0xde, 0xad, 0xbe, 0xef])), /not a runtime WASM/);
  });

  it('rejects a file shorter than its own magic', () => {
    assert.throws(() => wasmFormat(new Uint8Array([0x52, 0xbc])), /not a runtime WASM/);
  });
});

describe('strategyCandidates', () => {
  it('prefers frame-system authorize + apply, with fallbacks in order', () => {
    const labels = strategyCandidates(false).map((s) => s.label);
    assert.deepEqual(labels, [
      'System.authorize_upgrade',
      'ParachainSystem.authorize_upgrade',
      'System.set_code',
    ]);
  });

  it('routes every allowSameSpec candidate around version checks', () => {
    const [system, paraSys, setCode] = strategyCandidates(true);
    assert.equal(system.label, 'System.authorize_upgrade_without_checks');
    assert.deepEqual(paraSys.authorize!.args('h' as never), {
      code_hash: 'h',
      check_version: false,
    });
    assert.equal(setCode.setCode!.call, 'set_code_without_checks');
  });

  it('keeps the version check on by default', () => {
    const [, paraSys, setCode] = strategyCandidates(false);
    assert.deepEqual(paraSys.authorize!.args('h' as never), {
      code_hash: 'h',
      check_version: true,
    });
    assert.equal(setCode.setCode!.call, 'set_code');
  });

  it('apply always carries the code, authorize always carries the hash', () => {
    for (const s of [...strategyCandidates(false), ...strategyCandidates(true)]) {
      if (s.setCode) {
        assert.deepEqual(s.setCode.args('c' as never), { code: 'c' });
        continue;
      }
      assert.equal((s.authorize!.args('h' as never) as { code_hash: unknown }).code_hash, 'h');
      assert.deepEqual(s.apply!.args('c' as never), { code: 'c' });
    }
  });
});

const ev = (type: string, name: string, value?: unknown): DecodedEvent => ({
  type,
  value: { type: name, value },
});

describe('httpFromWs', () => {
  it('maps ws/wss to http/https, keeping port and path', () => {
    assert.equal(httpFromWs('ws://127.0.0.1:10020'), 'http://127.0.0.1:10020');
    assert.equal(
      httpFromWs('wss://previewnet.substrate.dev/asset-hub'),
      'https://previewnet.substrate.dev/asset-hub'
    );
  });
});

describe('sudidError', () => {
  it('surfaces a failed inner sudo call', () => {
    const events = [
      ev('Sudo', 'Sudid', {
        sudo_result: { success: false, value: { type: 'Module', value: { type: 'System' } } },
      }),
    ];
    assert.match(sudidError(events)!, /Module/);
  });

  it('returns null for a successful sudo', () => {
    const events = [ev('Sudo', 'Sudid', { sudo_result: { success: true, value: undefined } })];
    assert.equal(sudidError(events), null);
  });

  it('returns null when no Sudid event is present', () => {
    assert.equal(sudidError([ev('System', 'ExtrinsicSuccess')]), null);
  });
});

describe('localWsUrl', () => {
  it('resolves every chain key from the ports.env table', () => {
    // Values come from config/ports.env via toml-generator, so this pins the mapping
    // without restating the numbers.
    for (const chain of UPGRADE_CHAINS) {
      assert.match(localWsUrl(chain), /^ws:\/\/127\.0\.0\.1:\d+$/);
    }
    assert.equal(new Set(UPGRADE_CHAINS.map(localWsUrl)).size, UPGRADE_CHAINS.length);
  });

  it('rejects unknown chains, naming the valid ones', () => {
    assert.throws(() => localWsUrl('kusama'), /unknown chain "kusama".*relay/);
  });
});

describe('resolveSudoUri', () => {
  it('defaults to //Alice', () => {
    assert.equal(resolveSudoUri(undefined, null), '//Alice');
  });

  it('explicit env wins over the secrets file', () => {
    assert.equal(resolveSudoUri('//Operator', 'PPN_SUDO_URI=//FromFile'), '//Operator');
  });

  it('reads PPN_SUDO_URI from the secrets file', () => {
    const secrets = '# deployable profile\nPPN_PROFILE=deployable\nPPN_SUDO_URI="//FromFile"\n';
    assert.equal(resolveSudoUri(undefined, secrets), '//FromFile');
  });

  it('a secrets file without the key falls through to //Alice', () => {
    assert.equal(resolveSudoUri(undefined, 'PPN_PROFILE=local\n'), '//Alice');
  });
});

describe('parseEnvFile', () => {
  it('strips quotes and skips comments and malformed lines', () => {
    const vars = parseEnvFile('# c\nA=1\nB="two"\nC=\'three\'\nnot a line\n D=4');
    assert.deepEqual(vars, { A: '1', B: 'two', C: 'three', D: '4' });
  });
});

describe('splitSuri', () => {
  it('handles the bare dev-account form', () => {
    assert.deepEqual(splitSuri('//Alice'), { phrase: '', paths: '//Alice' });
  });

  it('splits phrase, junctions and password', () => {
    assert.deepEqual(splitSuri('word soup//op/soft///pw'), {
      phrase: 'word soup',
      paths: '//op/soft',
      password: 'pw',
    });
  });

  it('a phrase alone has no paths', () => {
    assert.deepEqual(splitSuri('word soup'), { phrase: 'word soup', paths: '' });
  });
});

describe('signerFromUri', () => {
  it('derives the well-known Alice address from //Alice', () => {
    assert.equal(
      signerFromUri('//Alice').address(),
      '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY'
    );
  });

  it('rejects a malformed raw seed', () => {
    assert.throws(() => signerFromUri('0x1234//x'), /64 hex characters/);
  });
});
