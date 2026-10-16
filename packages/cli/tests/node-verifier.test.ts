// Tests for `ppn start --node-verifier`, zombie-cli's own option passed through.
// Run with: tsx --test packages/cli/tests/node-verifier.test.ts

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildProgram } from '../src/cli.js';
import { zombieSpawnArgs } from '../src/commands/start.js';

describe('ppn start --node-verifier', () => {
  it('passes nothing when not asked, so zombie-cli keeps its default (metric)', () => {
    assert.deepEqual(zombieSpawnArgs({}, '/data', 'net.toml'), ['spawn', '-p', 'native', '-d', '/data', 'net.toml']);
    assert.deepEqual(zombieSpawnArgs({ ephemeral: true }, '/data', 'net.toml'), ['spawn', '-p', 'native', 'net.toml']);
  });

  it('passes the verifier it was given to zombie-cli', () => {
    assert.deepEqual(zombieSpawnArgs({ nodeVerifier: 'none' }, '/data', 'net.toml'), [
      'spawn', '-p', 'native', '--node-verifier', 'none', '-d', '/data', 'net.toml',
    ]);
    assert.deepEqual(zombieSpawnArgs({ nodeVerifier: 'metric', ephemeral: true }, '/data', 'net.toml'), [
      'spawn', '-p', 'native', '--node-verifier', 'metric', 'net.toml',
    ]);
  });

  const startCommand = () => {
    const program = buildProgram();
    const start = program.commands.find((c) => c.name() === 'start');
    assert.ok(start, 'ppn has a start command');
    return { program, start };
  };

  it('accepts exactly zombie-cli\'s values', () => {
    const option = startCommand().start.options.find((o) => o.long === '--node-verifier');
    assert.ok(option, 'ppn start declares --node-verifier');
    assert.deepEqual(option.argChoices, ['metric', 'none']);
  });

  it('refuses any other value before starting anything', async () => {
    const { program, start } = startCommand();
    let stderr = '';
    start.exitOverride().configureOutput({ writeErr: (s) => (stderr += s), writeOut: () => {} });
    await assert.rejects(
      () => program.parseAsync(['start', 'previewnet', '--node-verifier', 'bogus'], { from: 'user' }),
      (err: { code?: string }) => err.code === 'commander.invalidArgument'
    );
    assert.match(stderr, /Allowed choices are metric, none/);
  });
});
