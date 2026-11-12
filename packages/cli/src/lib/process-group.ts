// The network `ppn start` runs is one process group: zombie-cli is spawned as its leader, and
// everything zombienet starts (nodes, custom processes, their launchers) is in that group unless
// it makes a group of its own. The group is recorded beside the network's data, so `ppn kill`
// stops exactly it, and a later `ppn start` of the same workspace can stop one a dead `ppn`
// left behind. Nothing is matched by name or by port.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** A started network's process group, as recorded beside its data. */
export interface GroupRecord {
  readonly version: 1;
  readonly pgid: number;
  /**
   * The leader's start time as `ps -o lstart=` gave it when recorded. A pid can be reused once
   * the group is gone; a leader with that pid and another start time is not ours.
   */
  readonly leaderStart: string;
  readonly network: string;
  readonly workspace: string;
  /** Absent for an ephemeral run, whose data is zombienet's own temp dir. */
  readonly dataDir?: string;
  readonly recordedAt: string;
}

/** Beside the network's data. */
export const GROUP_FILE = 'ppn-process-group.json';

/** The workspace's index of recorded groups, one file per network, so `ppn kill` finds them all. */
export const groupIndexDir = (workspace: string) => path.join(workspace, 'run');
export const groupIndexFile = (workspace: string, network: string) => path.join(groupIndexDir(workspace), `${network}.json`);

export interface Member {
  readonly pid: number;
  readonly command: string;
}

/** What this module needs from the system; the real one is `systemProcesses`, tests use their own. */
export interface Processes {
  /** Every process in the group `pgid`, the leader included while it lives. */
  members(pgid: number): Member[];
  /** `ps -o lstart=` of `pid`, or undefined when it is not running. */
  startOf(pid: number): string | undefined;
  /** Signal the whole group; a group that is already gone is not an error. */
  signalGroup(pgid: number, signal: NodeJS.Signals): void;
  sleep(ms: number): void;
}

function psLines(args: string[]): string[] {
  const out = spawnSync('ps', args, { encoding: 'utf-8' });
  return (out.stdout ?? '').split('\n').filter((line) => line.trim());
}

export const systemProcesses: Processes = {
  members(pgid) {
    // A zombie (state Z: exited, not yet reaped by its parent) is not a member to stop, and
    // signalling a group of zombies only fails with EPERM on macOS.
    return psLines(['-axo', 'pid=,pgid=,stat=,command=']).flatMap((line) => {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
      return m && Number(m[2]) === pgid && !m[3]!.startsWith('Z') ? [{ pid: Number(m[1]), command: m[4]! }] : [];
    });
  },
  startOf(pid) {
    const [line] = psLines(['-o', 'lstart=', '-p', String(pid)]);
    return line?.trim() || undefined;
  },
  signalGroup(pgid, signal) {
    try {
      process.kill(-pgid, signal);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
    }
  },
  sleep(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  },
};

/**
 * Whether a recorded group is still this network's. `gone`: nothing is in it. `ours`: its leader
 * is the recorded one (same start time), or, the leader having exited, a member runs this
 * workspace's or this package's files (POSIX does not reuse a group id while the group lives).
 * `foreign`: the id now belongs to something else, which is left alone.
 */
export function classifyGroup(
  record: Pick<GroupRecord, 'pgid' | 'leaderStart'>,
  procs: Pick<Processes, 'members' | 'startOf'>,
  ours: (command: string) => boolean
): 'gone' | 'ours' | 'foreign' {
  const members = procs.members(record.pgid);
  if (!members.length) return 'gone';
  if (members.some((m) => m.pid === record.pgid)) {
    return procs.startOf(record.pgid) === record.leaderStart ? 'ours' : 'foreign';
  }
  return members.some((m) => ours(m.command)) ? 'ours' : 'foreign';
}

export interface StopResult {
  /** How many processes the group had when the stop began. */
  readonly members: number;
  /** Whether some were still there after the grace period and got SIGKILL. */
  readonly forced: boolean;
}

/**
 * Stop a group: SIGTERM to all of it (zombie-cli tears its nodes down, Postgres releases its
 * shared memory), then SIGKILL to whatever is left after `graceMs`.
 */
export function stopGroup(
  pgid: number,
  procs: Processes,
  { graceMs = 15_000, pollMs = 250, first = 'SIGTERM' as NodeJS.Signals } = {}
): StopResult {
  const members = procs.members(pgid).length;
  if (!members) return { members: 0, forced: false };
  procs.signalGroup(pgid, first);
  for (let waited = 0; waited < graceMs; waited += pollMs) {
    if (!procs.members(pgid).length) return { members, forced: false };
    procs.sleep(pollMs);
  }
  procs.signalGroup(pgid, 'SIGKILL');
  for (let waited = 0; waited < 5_000 && procs.members(pgid).length; waited += pollMs) procs.sleep(pollMs);
  return { members, forced: true };
}

export function writeGroupRecord(record: GroupRecord): void {
  const text = `${JSON.stringify(record, null, 2)}\n`;
  if (record.dataDir) fs.writeFileSync(path.join(record.dataDir, GROUP_FILE), text);
  fs.mkdirSync(groupIndexDir(record.workspace), { recursive: true });
  fs.writeFileSync(groupIndexFile(record.workspace, record.network), text);
}

export function removeGroupRecord(record: Pick<GroupRecord, 'workspace' | 'network' | 'dataDir' | 'pgid'>): void {
  const index = groupIndexFile(record.workspace, record.network);
  // Only the record of this group: a later start of the same network may have replaced it.
  if (readRecord(index)?.pgid === record.pgid) fs.rmSync(index, { force: true });
  if (record.dataDir) {
    const beside = path.join(record.dataDir, GROUP_FILE);
    if (readRecord(beside)?.pgid === record.pgid) fs.rmSync(beside, { force: true });
  }
}

function readRecord(file: string): GroupRecord | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf-8')) as GroupRecord;
    return value?.version === 1 && Number.isInteger(value.pgid) && value.pgid > 1 ? value : undefined;
  } catch {
    // Absent or unreadable: no record to act on.
    return undefined;
  }
}

/** The groups this workspace has recorded. */
export function recordedGroups(workspace: string): GroupRecord[] {
  const dir = groupIndexDir(workspace);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.json'))
    .flatMap((file) => readRecord(path.join(dir, file)) ?? []);
}

/** A process runs this workspace's or this package's files (the same anchors as the sweep). */
export function runsFrom(roots: readonly string[]): (command: string) => boolean {
  const prefixes = roots.map((root) => `${path.resolve(root)}${path.sep}`);
  return (command) => prefixes.some((prefix) => command.includes(prefix));
}
