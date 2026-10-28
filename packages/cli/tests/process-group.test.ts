// Tests that a network is stopped as the process group `ppn start` recorded, and only that group.
// Run with: tsx --test packages/cli/tests/process-group.test.ts

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  GROUP_FILE,
  classifyGroup,
  groupIndexFile,
  recordedGroups,
  removeGroupRecord,
  runsFrom,
  stopGroup,
  systemProcesses,
  writeGroupRecord,
  type GroupRecord,
  type Member,
  type Processes,
} from '../src/lib/process-group.js';

const WS = '/home/dev/.ppn';
const ours = runsFrom([WS, '/opt/ppn']);

function fakeProcesses(groups: Record<number, Member[]>, starts: Record<number, string>) {
  const signals: string[] = [];
  const procs: Processes & { signals: string[]; onSignal?: (pgid: number, signal: NodeJS.Signals) => void } = {
    signals,
    members: (pgid) => groups[pgid] ?? [],
    startOf: (pid) => starts[pid],
    signalGroup(pgid, signal) {
      signals.push(`${signal} -${pgid}`);
      procs.onSignal?.(pgid, signal);
    },
    sleep: () => {},
  };
  return procs;
}

describe('a recorded process group', () => {
  const record = { pgid: 4100, leaderStart: 'Fri Oct  2 10:00:00 2026' };

  it('is gone when nothing is in it', () => {
    assert.equal(classifyGroup(record, fakeProcesses({}, {}), ours), 'gone');
  });

  it('is ours while its leader is the recorded one, by start time', () => {
    const procs = fakeProcesses({ 4100: [{ pid: 4100, command: `${WS}/bin/zombie-cli spawn` }] }, { 4100: record.leaderStart });
    assert.equal(classifyGroup(record, procs, ours), 'ours');
  });

  it('is not ours when the id belongs to a leader that started at another time (a reused pid)', () => {
    const procs = fakeProcesses({ 4100: [{ pid: 4100, command: `${WS}/bin/zombie-cli spawn` }] }, { 4100: 'Fri Oct  2 11:30:00 2026' });
    assert.equal(classifyGroup(record, procs, ours), 'foreign');
  });

  it('is ours when the leader has exited and a member runs this workspace', () => {
    const procs = fakeProcesses({ 4100: [{ pid: 4210, command: `${WS}/bin/ipfs daemon` }] }, {});
    assert.equal(classifyGroup(record, procs, ours), 'ours');
  });

  it('is not ours when the leader has exited and no member runs this workspace or package', () => {
    const procs = fakeProcesses({ 4100: [{ pid: 4210, command: '/home/dev/.ppn-other/bin/ipfs daemon' }] }, {});
    assert.equal(classifyGroup(record, procs, ours), 'foreign');
  });
});

describe('stopping a group', () => {
  it('sends SIGTERM to the whole group and is done when it empties', () => {
    const groups: Record<number, Member[]> = { 4100: [{ pid: 4100, command: 'zombie-cli' }, { pid: 4101, command: 'postgres' }] };
    const procs = fakeProcesses(groups, {});
    procs.onSignal = (pgid) => { groups[pgid] = []; };
    assert.deepEqual(stopGroup(4100, procs), { members: 2, forced: false });
    assert.deepEqual(procs.signals, ['SIGTERM -4100']);
  });

  it('sends SIGKILL to what is left after the grace period', () => {
    const groups: Record<number, Member[]> = { 4100: [{ pid: 4101, command: 'eturnal' }] };
    const procs = fakeProcesses(groups, {});
    procs.onSignal = (pgid, signal) => { if (signal === 'SIGKILL') groups[pgid] = []; };
    assert.deepEqual(stopGroup(4100, procs, { graceMs: 1_000, pollMs: 250 }), { members: 1, forced: true });
    assert.deepEqual(procs.signals, ['SIGTERM -4100', 'SIGKILL -4100']);
  });

  it('signals nothing for a group that is already gone', () => {
    const procs = fakeProcesses({}, {});
    assert.deepEqual(stopGroup(4100, procs), { members: 0, forced: false });
    assert.deepEqual(procs.signals, []);
  });
});

describe('the record', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ppn-group-'));
  const dataDir = path.join(workspace, 'data', 'paseo-next-v2');
  fs.mkdirSync(dataDir, { recursive: true });
  const record: GroupRecord = {
    version: 1, pgid: 4100, leaderStart: 'Fri Oct  2 10:00:00 2026', network: 'paseo-next-v2', workspace, dataDir, recordedAt: '2026-10-02T07:00:00.000Z',
  };

  it('is written beside the data and in the workspace index, and read back', () => {
    writeGroupRecord(record);
    assert.ok(fs.existsSync(path.join(dataDir, GROUP_FILE)));
    assert.deepEqual(recordedGroups(workspace), [record]);
  });

  it('is removed only for its own group: a newer start of the same network keeps its record', () => {
    writeGroupRecord({ ...record, pgid: 5200 });
    removeGroupRecord(record);
    assert.deepEqual(recordedGroups(workspace).map((r) => r.pgid), [5200]);
    removeGroupRecord({ ...record, pgid: 5200 });
    assert.deepEqual(recordedGroups(workspace), []);
    assert.ok(!fs.existsSync(path.join(dataDir, GROUP_FILE)));
  });

  it('ignores an index entry that is not a record', () => {
    fs.writeFileSync(groupIndexFile(workspace, 'broken'), '{"pgid": 1}');
    fs.writeFileSync(groupIndexFile(workspace, 'garbled'), 'not json');
    assert.deepEqual(recordedGroups(workspace), []);
  });

  it('matches another workspace only by its own path', () => {
    const match = runsFrom(['/home/dev/.ppn']);
    assert.equal(match('/home/dev/.ppn/bin/ipfs daemon'), true);
    assert.equal(match('/home/dev/.ppn2/bin/ipfs daemon'), false);
  });
});

/** A real process group: a detached leader that starts a child, both sleeping; optionally the child ignores SIGTERM. */
function realGroup(childIgnoresTerm = false): Promise<{ pgid: number; child: number }> {
  const childScript = `${childIgnoresTerm ? "process.on('SIGTERM', () => {});" : ''} setInterval(() => {}, 1000)`;
  const leader = spawn(
    process.execPath,
    ['-e', `const c = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000)`],
    { detached: true, stdio: ['ignore', 'pipe', 'ignore'] }
  );
  return new Promise((resolve) => {
    leader.stdout!.once('data', (chunk) => {
      leader.stdout!.destroy();
      leader.unref();
      resolve({ pgid: leader.pid!, child: Number(String(chunk).trim()) });
    });
  });
}

/** Running, not a zombie this test has yet to reap. */
const alive = (pid: number) => {
  const stat = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf-8' }).stdout.trim();
  return stat !== '' && !stat.startsWith('Z');
};

describe('a real process group', () => {
  it('stops the leader and the child it started, and nothing outside the group', async () => {
    const outside = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    const { pgid, child } = await realGroup();
    try {
      const record = { pgid, leaderStart: systemProcesses.startOf(pgid)! };
      assert.equal(classifyGroup(record, systemProcesses, () => false), 'ours', 'the leader is the recorded one');
      assert.equal(classifyGroup({ ...record, leaderStart: 'Thu Jan  1 00:00:00 1970' }, systemProcesses, () => false), 'foreign');
      assert.deepEqual(stopGroup(pgid, systemProcesses, { graceMs: 5_000, pollMs: 50 }), { members: 2, forced: false });
      assert.equal(alive(pgid), false);
      assert.equal(alive(child), false, "the leader's child is stopped with the group");
      assert.equal(alive(outside.pid!), true, 'a process outside the group keeps running');
    } finally {
      outside.kill('SIGKILL');
      for (const pid of [pgid, child]) if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
  });

  it('kills a member that ignores SIGTERM once the grace period is over', async () => {
    const { pgid, child } = await realGroup(true);
    try {
      // The child installs its handler as it starts: give it that moment.
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.deepEqual(stopGroup(pgid, systemProcesses, { graceMs: 500, pollMs: 50 }), { members: 2, forced: true });
      assert.equal(alive(child), false);
    } finally {
      for (const pid of [pgid, child]) if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
  });
});
