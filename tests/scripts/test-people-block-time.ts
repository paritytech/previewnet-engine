import type { PolkadotClient } from "polkadot-api";
import type { NetworkInfo } from "./types/zombienet";
import { SUCCESS, FAILURE, connectWithRetry, safeDisconnect, sleep, waitForChainReady } from "./utils";

const WINDOW_SECONDS = 60;

/**
 * Passes when People averages at most `args[0]` seconds per block over a minute. On one core it
 * makes a block every 6 s; on the three cores the descriptor gives it, every 2 s.
 */
export async function run(nodeName: string, networkInfo: NetworkInfo, args: string[]): Promise<number> {
  let client: PolkadotClient | null = null;
  try {
    const maxSeconds = Number(args[0]);
    const node = networkInfo.nodesByName[nodeName];
    if (!node || !(maxSeconds > 0)) {
      console.error(`[TEST] needs a known node and a block time in seconds, got ${nodeName} and ${args[0]}`);
      return FAILURE;
    }
    const connection = await connectWithRetry(node.wsUri, "people");
    client = connection.client;
    const api = connection.api;
    await waitForChainReady(api);

    const start = await api.query.System.Number.getValue({ at: "best" });
    await sleep(WINDOW_SECONDS * 1000);
    const blocks = (await api.query.System.Number.getValue({ at: "best" })) - start;
    const average = WINDOW_SECONDS / blocks;
    console.log(`[TEST] ${blocks} People blocks in ${WINDOW_SECONDS}s: ${average.toFixed(2)}s per block, at most ${maxSeconds}s`);
    return average <= maxSeconds ? SUCCESS : FAILURE;
  } catch (error) {
    console.error(`[TEST] ${(error as Error).message}`);
    return FAILURE;
  } finally {
    safeDisconnect(client);
  }
}
