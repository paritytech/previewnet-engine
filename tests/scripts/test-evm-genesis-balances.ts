import type { PolkadotClient } from "polkadot-api";
import type { NetworkInfo } from "./types/zombienet";
import {
  SUCCESS,
  FAILURE,
  connectWithRetry,
  waitForChainReady,
  safeDisconnect,
} from "./utils";

// EVM-mapped SS58 addresses — deterministic from DEV_PHRASE, never change.
// These are the pallet-revive AccountId32 mappings: [h160 ++ 0xEE*12] → SS58
const EVM_ACCOUNTS: Array<{ name: string; h160: string; ss58: string }> = [
  {
    name: "Alice",
    h160: "0x9621dde636de098b43efb0fa9b61facfe328f99d",
    ss58: "5FTZ6n1wY3GBqEZ2DWEdspbTarvRnp8DM8x2YXbWubu7JN98",
  },
  {
    name: "Bob",
    h160: "0x41dccbd49b26c50d34355ed86ff0fa9e489d1e01",
    ss58: "5DZ4ZRZVipXuQ5BtamrqwymLZggk6J1iLW6LvGVGrJjVSyFj",
  },
  {
    name: "Charlie",
    h160: "0xe2235a2ffe0354b27a6a1c543be6bf2920ff2134",
    ss58: "5HBDBSu2q6fbnDR6djKKJ2WbJQt3orNanKe8QEnou8FSYopF",
  },
  {
    name: "Hardhat deployer",
    h160: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    ss58: "5Ha8yXQgvWcvpFya1BmjtJX386xUskafNTzU4Zmb6B3UwYd9",
  },
];

/**
 * Test that EVM-mapped dev accounts have genesis balances on Asset Hub.
 *
 * Verifies that patch-evm-genesis.js correctly funded:
 * - Alice, Bob, Charlie EVM-mapped accounts
 * - Hardhat deployer EVM-mapped account
 */
export async function run(
  nodeName: string,
  networkInfo: NetworkInfo,
  _args: string[]
): Promise<number> {
  let client: PolkadotClient | null = null;

  try {
    console.log(`[TEST] Starting EVM genesis balance test on ${nodeName}`);

    const nodeInfo = networkInfo.nodesByName[nodeName];
    if (!nodeInfo) {
      console.error(`[TEST] Node ${nodeName} not found in network info`);
      return FAILURE;
    }

    const { wsUri } = nodeInfo;
    const connection = await connectWithRetry(wsUri, "assetHub");
    client = connection.client;
    const api = connection.api;

    await waitForChainReady(api);

    let passed = 0;
    let failed = 0;

    for (const { name, h160, ss58 } of EVM_ACCOUNTS) {
      const account = await api.query.System.Account.getValue(ss58);
      const free = account.data.free;

      if (free > 0n) {
        console.log(
          `[TEST] ✓ ${name} EVM (${h160.slice(0, 10)}...) balance: ${free}`
        );
        passed++;
      } else {
        console.error(
          `[TEST] ✗ ${name} EVM (${h160.slice(0, 10)}...) has zero balance!`
        );
        failed++;
      }
    }

    console.log(`[TEST] Results: ${passed} passed, ${failed} failed`);

    if (failed > 0) {
      console.error("[TEST] EVM genesis balance test FAILED");
      return FAILURE;
    }

    console.log("[TEST] EVM genesis balance test PASSED");
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
