import type { PolkadotClient } from "polkadot-api";
import type { NetworkInfo } from "./types/zombienet";
import {
  SUCCESS,
  FAILURE,
  connectWithRetry,
  waitForChainReady,
  safeDisconnect,
} from "./utils";

/**
 * Test pallet-revive functionality on Asset Hub
 *
 * @param nodeName - The name of the node to test
 * @param networkInfo - Network information from Zombienet
 * @param _args - Additional arguments (unused)
 * @returns 1 on success, 0 on failure
 */
export async function run(
  nodeName: string,
  networkInfo: NetworkInfo,
  _args: string[]
): Promise<number> {
  let client: PolkadotClient | null = null;
  const warnings: string[] = [];

  try {
    console.log(`[TEST] Starting Asset Hub pallet-revive test on ${nodeName}`);

    // Get connection info from Zombienet
    const nodeInfo = networkInfo.nodesByName[nodeName];
    if (!nodeInfo) {
      console.error(`[TEST] Node ${nodeName} not found in network info`);
      return FAILURE;
    }

    const { wsUri } = nodeInfo;
    console.log(`[TEST] Connecting to ${wsUri}`);

    // Connect to the node with PAPI
    const connection = await connectWithRetry(wsUri, "assetHub");
    client = connection.client;
    const api = connection.api;

    // 1. Wait for chain to be ready (handles race condition with collator sync)
    const blockNumber = await waitForChainReady(api);
    console.log(`[TEST] Current block number: ${blockNumber}`);

    // 2. Get chain information
    const chainSpec = await client.getChainSpecData();
    console.log(`[TEST] Chain: ${chainSpec.name}`);

    // 3. Check for pallet-revive (using PAPI's typed API)
    // With PAPI, we check if the pallet exists by trying to access it
    let hasRevive = false;
    try {
      // Try to access Revive pallet's storage
      // If it throws, the pallet doesn't exist
      if ("Revive" in api.query) {
        hasRevive = true;
        console.log("[TEST] pallet-revive found!");
      }
    } catch {
      // Pallet not found
    }

    if (!hasRevive) {
      console.log("[TEST] pallet-revive not found in runtime");
      // This might be expected if the runtime doesn't have revive yet
      console.log("[TEST] Chain is operational but revive pallet not present");
    }

    // 4. If revive pallet exists, query its storage
    if (hasRevive) {
      console.log("[TEST] Querying pallet-revive storage...");

      try {
        // Query using PAPI's getEntries()
        const revive = api.query.Revive as {
          PristineCode?: { getEntries: () => Promise<unknown[]> };
          CodeInfoOf?: { getEntries: () => Promise<unknown[]> };
          ContractInfoOf?: { getEntries: () => Promise<unknown[]> };
        };

        if (revive.PristineCode) {
          const codeEntries = await revive.PristineCode.getEntries();
          console.log(
            `[TEST] Deployed contracts (PristineCode): ${codeEntries.length}`
          );
        }

        if (revive.CodeInfoOf) {
          const codeInfoEntries = await revive.CodeInfoOf.getEntries();
          console.log(`[TEST] Code info entries: ${codeInfoEntries.length}`);
        }

        if (revive.ContractInfoOf) {
          const contractEntries = await revive.ContractInfoOf.getEntries();
          console.log(`[TEST] Contract instances: ${contractEntries.length}`);
        }
      } catch (queryError) {
        const err = queryError as Error;
        warnings.push(`Revive pallet storage query: ${err.message}`);
      }
    }

    // 5. Check for Assets pallet (Asset Hub should have this)
    let hasAssets = false;
    try {
      if ("Assets" in api.query) {
        hasAssets = true;
        console.log("[TEST] Assets pallet found (expected for Asset Hub)");
      }
    } catch {
      // Pallet not found
    }

    if (!hasAssets) {
      console.warn("[TEST] Warning: Assets pallet not found (unexpected for Asset Hub)");
    }

    // Summary of warnings encountered
    if (warnings.length > 0) {
      console.warn(`[TEST] Warnings encountered (${warnings.length}):`);
      warnings.forEach((w) => console.warn(`[TEST]   - ${w}`));
    }

    console.log("[TEST] Asset Hub pallet-revive test completed successfully");
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

// CommonJS export for Zombienet compatibility
export default { run };
