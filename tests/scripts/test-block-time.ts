import type { PolkadotClient } from "polkadot-api";
import type { NetworkInfo } from "./types/zombienet";
import { SUCCESS, FAILURE, CHAINS, connectWithRetry, safeDisconnect, sleep, waitForChainReady, type ChainName } from "./utils";

const WINDOW_MS = 60_000;
const SAMPLE_MS = 5_000;
// Under the 300 s the .zndsl files allow, leaving room to connect.
const DEADLINE_MS = 240_000;

/**
 * Passes once chain `args[0]` (a CHAINS key) averages at most `args[1]` seconds per block over a
 * minute, and fails when no minute within the deadline does. On one core a parachain makes a
 * block every 6 s; on three cores, every 2 s. The extra cores take effect a few relay blocks
 * after assign-cores sends them, so the first minute after a spawn may still run on one.
 */
export async function run(nodeName: string, networkInfo: NetworkInfo, args: string[]): Promise<number> {
  let client: PolkadotClient | null = null;
  try {
    const [chain, max] = args;
    const maxSeconds = Number(max);
    const node = networkInfo.nodesByName[nodeName];
    if (!node || !(chain in CHAINS) || !(maxSeconds > 0)) {
      console.error(`[TEST] needs a known node, chain and block time in seconds, got ${nodeName}, ${chain}, ${max}`);
      return FAILURE;
    }
    const connection = await connectWithRetry(node.wsUri, chain as ChainName);
    client = connection.client;
    const api = connection.api;
    await waitForChainReady(api);

    const samples: { time: number; block: number }[] = [];
    const deadline = Date.now() + DEADLINE_MS;
    let average = Infinity;
    while (Date.now() < deadline) {
      const sample = { time: Date.now(), block: await api.query.System.Number.getValue({ at: "best" }) };
      samples.push(sample);
      const windowStart = samples.filter((earlier) => sample.time - earlier.time >= WINDOW_MS).at(-1);
      if (windowStart && sample.block > windowStart.block) {
        average = (sample.time - windowStart.time) / 1000 / (sample.block - windowStart.block);
        if (average <= maxSeconds) {
          console.log(`[TEST] ${chain}: ${average.toFixed(2)}s per block over the last minute, at most ${maxSeconds}s`);
          return SUCCESS;
        }
      }
      await sleep(SAMPLE_MS);
    }
    console.error(`[TEST] ${chain}: ${average.toFixed(2)}s per block over the last minute, at most ${maxSeconds}s, within ${DEADLINE_MS / 1000}s`);
    return FAILURE;
  } catch (error) {
    console.error(`[TEST] ${(error as Error).message}`);
    return FAILURE;
  } finally {
    safeDisconnect(client);
  }
}
