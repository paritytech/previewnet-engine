// Make sure the sudo account can pay fees, topping it up from a well-known dev account.
//
// A fork makes //Alice sudo everywhere (the bite overrides Sudo::Key), but on the
// production relay Alice has been spent down to exactly the existential deposit — and
// an account at ED cannot pay for anything: any withdrawal would reap it, so the tx
// pool rejects with Invalid::Payment before the upgrade logic runs.
//
// Why a transfer and not something else: teleporting from Asset Hub bounces off the
// vanilla paseo relay runtime — para 1500 is not among its trusted teleport locations
// (`UntrustedTeleportLocation`). A bite-time System.Account inject also works (verified
// on-chain), but it only helps bundles bitten after the fix — this transfer funds the
// sudo on ANY bundle, published ones included. Previewnet's relay genesis endows every
// other dev account with 1M PAS, so a plain transfer_keep_alive from the first funded
// donor settles it in one block, on the same chain, with keys everyone has.
//
// Browser-clean like upgrade.ts: no node: imports, provider injected by the caller.

import { createClient } from 'polkadot-api';
import type { PolkadotSigner } from 'polkadot-api/signer';
import { TX_OPTIONS } from './upgrade.js';
import { signerFromUri, type SudoSigner } from './signer.js';

type Provider = Parameters<typeof createClient>[0];

/**
 * Below this free balance the account cannot be trusted to pay upgrade fees: 1000 PAS.
 * Two bars hide in here. The obvious one is the existential deposit — 1 PAS on the
 * paseo relay (mirroring Polkadot), and production's relay Alice sits at exactly that,
 * unable to pay for anything. The real one is the apply step: apply_authorized_upgrade
 * carries the entire runtime as a signed extrinsic, and at Polkadot-scale byte fees a
 * ~2 MB blob costs on the order of 200 PAS in length fee alone.
 */
export const MIN_FREE = 10_000_000_000_000n;
/** What a top-up transfers. 10k PAS — pocket change next to a dev account's 1M. */
export const TOP_UP = 100_000_000_000_000n;

/**
 * Well-known dev accounts to draw the top-up from, in the order previewnet is likely
 * to have left them untouched. Alice herself is deliberately absent — she is the one
 * being funded.
 */
export const DONOR_URIS = [
  '//Bob',
  '//Charlie',
  '//Dave',
  '//Eve',
  '//Ferdie',
  '//Alice//stash',
  '//Bob//stash',
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface EnsureFundsOptions {
  provider: Provider;
  wsUrl: string;
  /** The account that must be able to pay — the sudo signer. Defaults to //Alice. */
  sudo?: SudoSigner;
  minFree?: bigint;
  topUp?: bigint;
  timeoutMs?: number;
  log?: (msg: string) => void;
}

/**
 * Make sure the sudo account can pay fees on the chain, transferring a top-up from the
 * first funded well-known dev account when it cannot. A no-op when already funded —
 * genesis networks and deployable profiles (whose operator key is funded, and whose dev
 * accounts are stripped) never reach the transfer.
 */
export async function ensureFunds(opts: EnsureFundsOptions): Promise<bigint> {
  const log = opts.log ?? (() => {});
  const minFree = opts.minFree ?? MIN_FREE;
  const topUp = opts.topUp ?? TOP_UP;
  const sudo = opts.sudo ?? signerFromUri('//Alice');
  const address = sudo.address();

  const client = createClient(opts.provider);
  try {
    const api = client.getUnsafeApi();
    const free = async (who: string): Promise<bigint> => {
      const account = (await api.query.System.Account.getValue(who)) as
        | { data?: { free?: bigint } }
        | undefined;
      return account?.data?.free ?? 0n;
    };

    const before = await free(address);
    if (before >= minFree) return before;

    let donor: SudoSigner | null = null;
    for (const uri of DONOR_URIS) {
      const candidate = signerFromUri(uri);
      if (candidate.address() === address) continue;
      if ((await free(candidate.address())) >= topUp * 2n) {
        donor = candidate;
        log(`sudo account holds ${before} — transferring ${topUp} from ${uri}`);
        break;
      }
    }
    if (!donor) {
      throw new Error(
        `the sudo account (${address}) holds ${before}, below the ${minFree} needed to pay ` +
          'fees, and no well-known dev account on this chain can top it up — fund it manually'
      );
    }

    const tx = api.tx.Balances.transfer_keep_alive({
      dest: { type: 'Id', value: address },
      value: topUp,
    }) as unknown as {
      signSubmitAndWatch: (s: PolkadotSigner, options?: object) => { subscribe: Function };
    };

    await new Promise<void>((resolve, reject) => {
      const sub = tx.signSubmitAndWatch(donor!.signer, TX_OPTIONS).subscribe({
        next: (ev: { type: string; ok?: boolean; dispatchError?: unknown }) => {
          if (ev.type !== 'finalized') return;
          if (ev.ok) resolve();
          else reject(new Error(`top-up transfer failed: ${JSON.stringify(ev.dispatchError)}`));
          (sub as { unsubscribe?: () => void }).unsubscribe?.();
        },
        error: (err: Error) => reject(new Error(`top-up transfer failed: ${err.message}`)),
      });
    });

    // Finalization already implies the balance moved; the poll only covers RPC lag.
    const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
    for (;;) {
      const now = await free(address);
      if (now >= minFree) {
        log(`sudo account funded: ${now}`);
        return now;
      }
      if (Date.now() > deadline) {
        throw new Error(`top-up finalized but ${address} still holds ${now} on ${opts.wsUrl}`);
      }
      await sleep(2_000);
    }
  } finally {
    client.destroy();
  }
}
