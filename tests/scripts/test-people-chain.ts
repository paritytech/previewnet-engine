import type { PolkadotClient } from "polkadot-api";
import type { NetworkInfo } from "./types/zombienet";
import {
  SUCCESS,
  FAILURE,
  connectWithRetry,
  getCurrentBlock,
  waitForChainReady,
  safeDisconnect,
} from "./utils";

const DEFAULT_ALLOWANCE_ACCOUNT =
  "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const DEFAULT_ALLOWANCE_COUNT = 1000;

/**
 * Test individuality/identity pallets on People Chain
 *
 * @param nodeName - The name of the node to test
 * @param networkInfo - Network information from Zombienet
 * @param _args - Additional arguments (unused)
 * @returns 1 on success, 0 on failure
 */
export async function run(
  nodeName: string,
  networkInfo: NetworkInfo,
  args: string[]
): Promise<number> {
  let client: PolkadotClient | null = null;
  const warnings: string[] = [];

  try {
    console.log(
      `[TEST] Starting People Chain individuality test on ${nodeName}`
    );

    // Get connection info from Zombienet
    const nodeInfo = networkInfo.nodesByName[nodeName];
    if (!nodeInfo) {
      console.error(`[TEST] Node ${nodeName} not found in network info`);
      return FAILURE;
    }

    const { wsUri } = nodeInfo;
    console.log(`[TEST] Connecting to ${wsUri}`);

    // Connect to the node with PAPI
    const connection = await connectWithRetry(wsUri, "people");
    client = connection.client;
    const api = connection.api;

    // 1. Wait for chain to be ready (handles race condition with collator sync)
    const blockNumber = await waitForChainReady(api);
    console.log(`[TEST] Current block number: ${blockNumber}`);

    // 2. Get chain information
    const chainSpec = await client.getChainSpecData();
    console.log(`[TEST] Chain: ${chainSpec.name}`);

    // 3. Check for individuality-specific pallets using PAPI's typed API
    const foundPallets: string[] = [];

    // Check for Identity pallet
    if ("Identity" in api.query) {
      foundPallets.push("Identity");
      console.log("[TEST] Identity pallet found!");

      try {
        // Query identity storage using PAPI
        const identity = api.query.Identity as {
          IdentityOf?: { getEntries: () => Promise<unknown[]> };
          Registrars?: { getValue: () => Promise<unknown[]> };
        };

        if (identity.IdentityOf) {
          const identities = await identity.IdentityOf.getEntries();
          console.log(`[TEST] Registered identities: ${identities.length}`);
        }

        if (identity.Registrars) {
          const registrars = await identity.Registrars.getValue();
          console.log(`[TEST] Registrars: ${registrars.length}`);
        }
      } catch (queryError) {
        const err = queryError as Error;
        warnings.push(`Identity pallet query: ${err.message}`);
      }
    }

    // Check for People pallet
    if ("People" in api.query) {
      foundPallets.push("People");
      console.log("[TEST] People pallet found!");
    }

    // Verify PeopleLite attestation allowance was set by startup script
    const allowanceAccount =
      args[0] || process.env.ALLOWANCE_ACCOUNT || DEFAULT_ALLOWANCE_ACCOUNT;
    const allowanceCountRaw = args[1] || process.env.ALLOWANCE_COUNT;
    const configuredAllowanceCount = allowanceCountRaw
      ? Number.parseInt(allowanceCountRaw, 10)
      : DEFAULT_ALLOWANCE_COUNT;
    const expectedMinAllowance =
      Number.isInteger(configuredAllowanceCount) && configuredAllowanceCount > 0
        ? configuredAllowanceCount
        : DEFAULT_ALLOWANCE_COUNT;

    if (
      allowanceCountRaw &&
      (!Number.isInteger(configuredAllowanceCount) || configuredAllowanceCount <= 0)
    ) {
      console.warn(
        `[TEST] Invalid ALLOWANCE_COUNT "${allowanceCountRaw}", using fallback ${DEFAULT_ALLOWANCE_COUNT}`
      );
    }

    // This is mandatory — uses direct property access (not `in` operator) per PAPI conventions
    console.log(
      `[TEST] Querying PeopleLite.AttestationAllowance for ${allowanceAccount}...`
    );
    const allowance = await (api.query as any).PeopleLite.AttestationAllowance.getValue(
      allowanceAccount
    );
    console.log(
      `[TEST] Attestation allowance for ${allowanceAccount}: ${allowance}`
    );

    if (Number(allowance) >= expectedMinAllowance) {
      foundPallets.push("PeopleLite");
      console.log("[TEST] Attestation allowance verified!");
    } else {
      console.error(
        `[TEST] FAILED: Expected attestation allowance for ${allowanceAccount} >= ${expectedMinAllowance}, got ${allowance}`
      );
      return FAILURE;
    }

    // Check for Game pallet
    if ("Game" in api.query) {
      foundPallets.push("Game");
      console.log("[TEST] Game pallet found!");
    }

    // Check for Score pallet
    if ("Score" in api.query) {
      foundPallets.push("Score");
      console.log("[TEST] Score pallet found!");
    }

    // Check for ProofOfInk pallet
    if ("ProofOfInk" in api.query) {
      foundPallets.push("ProofOfInk");
      console.log("[TEST] ProofOfInk pallet found!");
    }

    // Check for MobRule pallet
    if ("MobRule" in api.query) {
      foundPallets.push("MobRule");
      console.log("[TEST] MobRule pallet found!");
    }

    console.log(
      `[TEST] Found individuality pallets: ${foundPallets.length > 0 ? foundPallets.join(", ") : "none"}`
    );

    // 4. Verify the chain is operational (final check)
    const finalBlock = await getCurrentBlock(api);
    console.log(`[TEST] Final block number: ${finalBlock}`);

    if (finalBlock > blockNumber) {
      console.log("[TEST] Chain is actively producing blocks");
    }

    // Summary of warnings encountered
    if (warnings.length > 0) {
      console.warn(`[TEST] Warnings encountered (${warnings.length}):`);
      warnings.forEach((w) => console.warn(`[TEST]   - ${w}`));
    }

    console.log(
      `[TEST] People Chain test completed successfully with ${foundPallets.length} individuality pallets`
    );

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
