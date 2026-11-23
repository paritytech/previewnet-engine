import type { PolkadotClient } from "polkadot-api";
import type { NetworkInfo } from "./types/zombienet";
import { SUCCESS, FAILURE, CHAINS, connectWithRetry, safeDisconnect, sleep, waitForChainReady, type ChainName } from "./utils";

const WINDOW_SECONDS = 60;

/**
 * Passes when chain `args[0]` (a CHAINS key) averages at most `args[1]` seconds per block over a
 * minute. On one core a parachain makes a block every 6 s; on three cores, every 2 s.
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

    const start = await api.query.System.Number.getValue({ at: "best" });
    await sleep(WINDOW_SECONDS * 1000);
    const blocks = (await api.query.System.Number.getValue({ at: "best" })) - start;
    const average = WINDOW_SECONDS / blocks;
    console.log(`[TEST] ${blocks} ${chain} blocks in ${WINDOW_SECONDS}s: ${average.toFixed(2)}s per block, at most ${maxSeconds}s`);
    return average <= maxSeconds ? SUCCESS : FAILURE;
  } catch (error) {
    console.error(`[TEST] ${(error as Error).message}`);
    return FAILURE;
  } finally {
    safeDisconnect(client);
  }
}
