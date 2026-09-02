// Extra bite overrides for a fork of a *shared* relay — one carrying parachains we do not run.
//
// previewnet's relay is ours end to end: the only parachains registered on it are the five we
// spawn, so production's inherited state is exactly what we want and the bite leaves it alone
// (docs/FORK.md, "Deliberately not overridden"). paseo-next-v2, kusama and polkadot are forks of
// a relay shared with everybody else, and there two pieces of that state are actively wrong:
//
//   cores  Every registered parachain occupies a core, and the relay splits its validator set
//          into one group per core. Paseo has 18 cores; a fork runs 6 dev validators, so the
//          runtime deals 6 validators into 18 groups and 12 come out empty:
//          `[[0],[1],[2],[3],[4],[5],[],[],…]`. Our parachains sit on cores 7-13, which no
//          group is assigned to for two thirds of every rotation, and the foreign parachains
//          hold the staffed cores 0-5 — with no collators to use them.
//
//   HRMP   Each parachain is snapshotted at its own height and the relay after them. Messages
//          delivered in that window are pruned from the relay's channel contents but counted in
//          its `mqc_head`, so a parachain can never reach the head the relay expects. cumulus
//          asserts on it — `HRMP head mismatch` — and fails to build any block at all.
//
// zombie-bite handles both by shrinking the world to the bitten parachains: it rewrites
// `Paras::Parachains`, assigns cores from index 0, sizes the validator set to the cores
// (`(1 + req_cores).min(7)`), and empties `Hrmp::HrmpIngressChannelsIndex` and
// `Dmp::DownwardMessageQueueHeads` per parachain. This does the cores the same way, with one
// deliberate difference: it patches `scheduler_params.num_cores` inside the *decoded*
// HostConfiguration rather than substituting a hand-encoded blob, because that struct also
// carries `EnabledHostFunction(EccRfc163)` — without which the relay's validators reject
// People's PVFs.
//
// HRMP is handled differently: the channels are kept and their message-queue chains reset on
// both sides, rather than the ingress index being emptied. Emptying the index leaves the
// channels registered but unreachable, and the only way back is `force_open_hrmp_channel` —
// a root call a fork of Kusama or Polkadot can never make. A reset needs no call afterwards:
// every channel into or out of one of our parachains gets `mqc_head` cleared and its pending
// contents dropped on the relay, and the parachain's `LastHrmpMqcHeads` is emptied to match.
// cumulus then computes an empty chain on both sides and the channel carries messages again.

import { compactLen, keyOf, twox64Concat, u32le } from './codec.js';

/** One core, and the parachain that runs on it. */
export interface CoreAssignment {
  core: number;
  paraId: number;
}

/** A parachain as the descriptor describes it, narrowed to what core planning needs. */
export interface PlannedPara {
  key: string;
  paraId: number;
}

/**
 * How many cores each parachain gets.
 *
 * Asset Hub keeps three: that is what gives it 2-second blocks through elastic scaling, and it
 * is the one place where the number is a property of the network rather than a default. The
 * rest get one each.
 */
export function coresFor(key: string): number {
  return key === 'asset-hub' ? 3 : 1;
}

/**
 * Lay the parachains out from core 0 upward.
 *
 * Upward from zero because those are the cores that end up with validator groups: the runtime
 * fills groups in order, so with `num_cores` set to exactly what we plan here, every core in
 * the plan is staffed and none of the plan depends on rotation luck.
 */
export function planCores(paras: PlannedPara[]): CoreAssignment[] {
  const plan: CoreAssignment[] = [];
  let core = 0;
  for (const para of paras) {
    for (let i = 0; i < coresFor(para.key); i++) plan.push({ core: core++, paraId: para.paraId });
  }
  return plan;
}

/**
 * `ParaScheduler::ValidatorGroups` — every planned core gets at least one validator.
 *
 * Round-robin rather than contiguous chunks: with 6 validators over 5 cores the remainder has
 * to land somewhere, and spreading it means no group is empty. An empty group is the whole bug
 * this file exists for.
 */
export function validatorGroups(cores: number, validators: number): string {
  const groups: number[][] = Array.from({ length: cores }, () => []);
  for (let v = 0; v < validators; v++) groups[v % cores].push(v);
  return (
    compactLen(groups.length) +
    groups.map((g) => compactLen(g.length) + g.map(u32le).join('')).join('')
  );
}

/** `Dmp::DownwardMessageQueueHeads`: the zero hash, i.e. nothing received yet. */
export const DMP_HEAD_EMPTY = '00'.repeat(32);

/** An empty SCALE `Vec` or `BTreeMap`: a single zero-length compact. */
export const SCALE_EMPTY = '00';

/**
 * `Dmp::DownwardMessageQueueHeads` per parachain. Injects rather than overrides — these are
 * storage map entries, and `verify()` only decode-checks plain values.
 */
export function dmpWipes(paraIds: number[]): Record<string, string> {
  const wipes: Record<string, string> = {};
  for (const id of paraIds) {
    wipes[keyOf('Dmp', 'DownwardMessageQueueHeads') + twox64Concat(u32le(id))] = DMP_HEAD_EMPTY;
  }
  return wipes;
}

/** One HRMP channel, as the relay keys it: `HrmpChannelId { sender, recipient }`. */
export interface ChannelId {
  sender: number;
  recipient: number;
}

/** The map key of a channel-keyed `Hrmp` entry (`HrmpChannels`, `HrmpChannelContents`). */
export function hrmpChannelKey(item: 'HrmpChannels' | 'HrmpChannelContents', ch: ChannelId): string {
  return keyOf('Hrmp', item) + twox64Concat(u32le(ch.sender) + u32le(ch.recipient));
}

/** The map key of a para-keyed `Hrmp` entry (the indexes and `HrmpChannelDigests`). */
export function hrmpParaKey(
  item: 'HrmpIngressChannelsIndex' | 'HrmpEgressChannelsIndex' | 'HrmpChannelDigests',
  paraId: number
): string {
  return keyOf('Hrmp', item) + twox64Concat(u32le(paraId));
}

/**
 * Every channel that has one of our parachains at either end, from the relay's own indexes.
 *
 * Each channel appears once even when both ends are ours (1000 -> 1004 is in 1000's egress and
 * 1004's ingress), and in a stable order so the override file is reproducible.
 */
export function channelsTouching(
  paraIds: number[],
  ingress: Map<number, number[]>,
  egress: Map<number, number[]>
): ChannelId[] {
  const seen = new Set<string>();
  const out: ChannelId[] = [];
  const add = (ch: ChannelId) => {
    const k = `${ch.sender}>${ch.recipient}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(ch);
  };
  for (const id of paraIds) {
    for (const sender of ingress.get(id) ?? []) add({ sender, recipient: id });
    for (const recipient of egress.get(id) ?? []) add({ sender: id, recipient });
  }
  return out.sort((a, b) => a.sender - b.sender || a.recipient - b.recipient);
}

/**
 * The relay-side writes that do not depend on a channel's live value: pending contents
 * dropped, and the recipient's digest of blocks-with-messages emptied so nothing is ever
 * pruned out of a queue that is already empty. `HrmpChannels` itself is rebuilt from the live
 * entry in overrides.ts, because everything but its `mqc_head` and counters must survive.
 */
export function hrmpContentsWipes(channels: ChannelId[], paraIds: number[]): Record<string, string> {
  const wipes: Record<string, string> = {};
  for (const ch of channels) wipes[hrmpChannelKey('HrmpChannelContents', ch)] = SCALE_EMPTY;
  for (const id of paraIds) wipes[hrmpParaKey('HrmpChannelDigests', id)] = SCALE_EMPTY;
  return wipes;
}

/**
 * The parachain side of the same reset: `ParachainSystem::LastDmqMqcHead` and
 * `ParachainSystem::LastHrmpMqcHeads`.
 *
 * Both halves or neither. The relay's queue heads and these values are two views of one
 * number, and cumulus asserts they agree — so zeroing only the relay's simply turns the
 * mismatch around, with the parachain's stale head on the left and a zero hash on the right.
 * With every channel's `mqc_head` cleared on the relay, the map of last-seen heads here has to
 * be empty too: a missing entry reads as the default hash, which is what `None` decodes to.
 */
export function paraMessagingWipes(): Record<string, string> {
  return {
    [keyOf('ParachainSystem', 'LastDmqMqcHead')]: DMP_HEAD_EMPTY,
    [keyOf('ParachainSystem', 'LastHrmpMqcHeads')]: SCALE_EMPTY,
  };
}

/**
 * Transaction-storage chains need their proof schedule pushed out of reach.
 *
 * `pallet-transaction-storage` requires a proof of one historical transaction's data every
 * `RetentionPeriod` blocks, and asserts in `on_finalize` that it happened:
 *
 *     panicked at pallets/transaction-storage/src/lib.rs: Storage proof must be checked once in the block
 *     ERROR aura::cumulus: Unable to build block at slot
 *
 * A bite restores state but not the stored blobs, so the proof cannot be constructed and the chain
 * cannot build any block at all. Bulletin on Paseo sits at ~1.49M with a period of 201,600, so it
 * immediately wants a proof for a block whose data we do not have.
 *
 * Pushing the period past any plausible chain height means `now - RetentionPeriod` never reaches a
 * block that has transactions, so no proof is ever due. 100M blocks is ~19 years at 6s and leaves
 * `now + RetentionPeriod` far inside u32, which matters because the pallet also schedules cleanup
 * that way. Nothing is lost: the data these proofs would attest to is already absent by
 * construction.
 *
 * Applied on every bite of a chain that has the pallet, not just a shared relay: no bite carries
 * the stored blobs, so the only thing that varies is whether the source chain has passed its first
 * proof deadline yet. previewnet's bulletin passed it on 2026-08-19 and its published bundle
 * wedged one block in, which is why the scoping in overrides.ts is by pallet alone.
 */
export const FORK_RETENTION_PERIOD = 100_000_000;

export function transactionStorageWipes(): Record<string, string> {
  return { [keyOf('TransactionStorage', 'RetentionPeriod')]: u32le(FORK_RETENTION_PERIOD) };
}

/**
 * `ParaScheduler::CoreDescriptors` as JSON for the live registry to encode.
 *
 * A **`BTreeMap<CoreIndex, CoreDescriptor>`**, so it is keyed by core index rather than a list
 * of pairs. Worth stating because a list of pairs is what it looks like when read back, and
 * encoding one gets you `Cannot decode value 1` from deep inside an Option — the core index of
 * the second entry being read as the first entry's `queue`.
 *
 * Encoded through the chain's own metadata rather than by hand: nested options, an enum and a
 * map, where the one bug this file's verification already caught in a sibling value was a
 * missing compact length. The registry knows the shape; we should not restate it.
 *
 * `ratio`/`step` of 57600 is a whole core (the parts-per-core unit the relay uses), matching
 * what `ppn service assign-cores` submits for Asset Hub's extra cores on a genesis network.
 */
export const FULL_CORE = 57600;

export function coreDescriptorsValue(plan: CoreAssignment[]): Record<number, unknown> {
  return Object.fromEntries(
    plan.map(({ core, paraId }) => [
      core,
      {
        queue: null,
        currentWork: {
          assignments: [[{ Task: paraId }, { ratio: FULL_CORE, remaining: FULL_CORE }]],
          endHint: null,
          pos: 0,
          step: FULL_CORE,
        },
      },
    ])
  );
}
