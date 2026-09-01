import { createClient, type PolkadotClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/node";
import type { NetworkInfo } from "./types/zombienet";
import { SUCCESS, FAILURE, safeDisconnect, sleep } from "./utils";

/**
 * The namespace product contexts are derived in, and what `genesisConfig.networkSuffix`
 * in networks/previewnet.json asks for. Stated here independently on purpose: this test
 * is the outside check that genesis carried the descriptor's value onto the chain, so it
 * must not read that value from the same place the code under test does.
 */
const EXPECTED = "testnet";

/**
 * The suffix lives in a pallet that only the People and Asset Hub runtimes carry
 * (individuality-community#20), and PAPI's generated descriptors are built from whichever
 * WASM was in bin/ at `npm install` time. Reading it through the unsafe API keeps the
 * check honest against the chain's own metadata rather than a stale descriptor.
 */
async function readSuffix(client: PolkadotClient): Promise<string> {
  const api = client.getUnsafeApi();
  const value = await api.query.NetworkSuffix.NetworkSuffix.getValue();
  // A BoundedVec<u8> decodes as Binary (or a byte array on older codecs).
  const bytes: Uint8Array =
    value instanceof Uint8Array
      ? value
      : typeof (value as { asBytes?: () => Uint8Array }).asBytes === "function"
        ? (value as { asBytes: () => Uint8Array }).asBytes()
        : Uint8Array.from(value as number[]);
  return new TextDecoder().decode(bytes);
}

/**
 * Verify the chain derives product contexts in this network's namespace.
 *
 * Runs against both chains that hold the pallet. A wrong suffix is not a loud failure at
 * runtime — contexts simply resolve somewhere else, so registrations and aliases land in
 * a namespace nothing else reads — which is exactly why it is worth asserting at launch.
 */
export async function run(
  nodeName: string,
  networkInfo: NetworkInfo,
  _args: string[]
): Promise<number> {
  let client: PolkadotClient | null = null;

  try {
    const nodeInfo = networkInfo.nodesByName[nodeName];
    if (!nodeInfo) {
      console.error(`[TEST] Node ${nodeName} not found in network info`);
      return FAILURE;
    }
    console.log(`[TEST] Checking network suffix on ${nodeName} (${nodeInfo.wsUri})`);
    client = createClient(getWsProvider(nodeInfo.wsUri));

    // The collator answers before it has metadata to answer *with*, so give the first
    // read a few tries rather than reporting a missing pallet that is merely not up yet.
    let suffix: string | null = null;
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        suffix = await readSuffix(client);
        break;
      } catch (error) {
        lastError = error as Error;
        console.log(`[TEST] Attempt ${attempt}/5 failed: ${lastError.message}`);
        await sleep(2000 * attempt);
      }
    }

    if (suffix === null) {
      console.error(
        `[TEST] Could not read NetworkSuffix.NetworkSuffix: ${lastError?.message}\n` +
          "       If the pallet is absent, this runtime predates individuality-community#20 —\n" +
          "       re-run `ppn fetch` (or `make fetch`) for one that carries it."
      );
      return FAILURE;
    }

    if (suffix !== EXPECTED) {
      console.error(`[TEST] Network suffix is "${suffix}", expected "${EXPECTED}"`);
      return FAILURE;
    }

    console.log(`[TEST] Network suffix is "${suffix}" — PASSED`);
    return SUCCESS;
  } catch (error) {
    const err = error as Error;
    console.error(`[TEST] Test failed with error: ${err.message}`);
    console.error(err.stack);
    return FAILURE;
  } finally {
    safeDisconnect(client);
  }
}

export default { run };
