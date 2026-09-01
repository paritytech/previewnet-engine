import type { PolkadotClient } from "polkadot-api";
import { Binary } from "polkadot-api";
import type { NetworkInfo } from "./types/zombienet";
import {
  SUCCESS,
  FAILURE,
  connectWithRetry,
  getCurrentBlock,
  waitForChainReady,
  safeDisconnect,
  waitForBlocks,
  getDevSigner,
  getDevAddress,
} from "./utils";

function formatDispatchError(
  dispatchError: { type?: string; value?: unknown } | undefined,
  fallbackMsg: string
): string {
  if (dispatchError?.type === "Module" && dispatchError.value) {
    return `Module error: ${JSON.stringify(dispatchError.value)}`;
  } else if (dispatchError) {
    return JSON.stringify(dispatchError);
  }
  return fallbackMsg;
}

/**
 * Test transactionStorage pallet functionality on Bulletin Chain
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

  try {
    console.log(
      `[TEST] Starting Bulletin Chain transactionStorage test on ${nodeName}`
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
    const connection = await connectWithRetry(wsUri, "bulletin");
    client = connection.client;
    const api = connection.api;

    // 1. Wait for chain to be ready (handles race condition with collator sync)
    const blockNumber = await waitForChainReady(api);
    console.log(`[TEST] Current block number: ${blockNumber}`);

    // 2. Get chain information
    const chainName = await client.getChainSpecData();
    console.log(`[TEST] Chain: ${chainName.name}`);

    // 3. Query storage configuration
    console.log("[TEST] Querying transactionStorage configuration...");

    try {
      const byteFee = await api.query.TransactionStorage.ByteFee.getValue();
      console.log(`[TEST] Byte fee: ${byteFee ?? "not set"}`);

      const entryFee = await api.query.TransactionStorage.EntryFee.getValue();
      console.log(`[TEST] Entry fee: ${entryFee ?? "not set"}`);

      const retentionPeriod =
        await api.query.TransactionStorage.RetentionPeriod.getValue();
      console.log(`[TEST] Retention period: ${retentionPeriod}`);

      const maxTxSize = api.constants.TransactionStorage.MaxTransactionSize;
      console.log(`[TEST] Max transaction size: ${maxTxSize}`);
    } catch (queryError) {
      const err = queryError as Error;
      console.warn(`[TEST] Configuration query warning: ${err.message}`);
    }

    // 4. Test data storage
    console.log("[TEST] Testing data storage functionality...");

    // Create test data
    const testData = "Hello from Zombienet PAPI test! " + Date.now();
    const testDataBytes = new TextEncoder().encode(testData);
    console.log(`[TEST] Test data: "${testData}"`);
    console.log(`[TEST] Data size: ${testDataBytes.length} bytes`);

    // Set up signer with test account
    const aliceSigner = getDevSigner("Alice");
    const aliceAddress = getDevAddress("Alice");
    console.log(`[TEST] Using account: ${aliceAddress}`);

    // Check Alice's balance
    const accountInfo = await api.query.System.Account.getValue(aliceAddress);
    console.log(`[TEST] Alice balance: ${accountInfo.data.free}`);

    // Check if Alice is authorized to store data
    console.log("[TEST] Checking storage authorization...");
    let aliceAuthorized = false;
    try {
      const authorizations = await api.query.TransactionStorage.Authorizations.getEntries();
      aliceAuthorized = authorizations.some(
        (entry) => entry.keyArgs[0]?.type === "Account" && entry.keyArgs[0]?.value === aliceAddress
      );
    } catch (authCheckError) {
      const err = authCheckError as Error;
      console.warn(`[TEST] Failed to check authorization with PAPI: ${err.message}`);
    }

    if (!aliceAuthorized) {
      console.log("[TEST] Alice is not authorized, authorizing via sudo...");

      // Create the authorize_account call
      const authorizeCall = api.tx.TransactionStorage.authorize_account({
        who: aliceAddress,
        transactions: 100,    // Allow 100 transactions
        bytes: 1000000n,      // Allow 1MB of data
      });

      // Wrap it in sudo
      const sudoTx = api.tx.Sudo.sudo({ call: authorizeCall.decodedCall });

      // Submit and wait for finalization
      const sudoResult = await new Promise<{ success: boolean; error?: string }>((resolve) => {
        let resolved = false;

        sudoTx.signSubmitAndWatch(aliceSigner).subscribe({
          next: (event) => {
            console.log(`[TEST] Sudo authorization status: ${event.type}`);
            if (event.type === "finalized") {
              if (!resolved) {
                resolved = true;
                if (event.ok) {
                  console.log("[TEST] Alice authorized successfully!");
                  resolve({ success: true });
                } else {
                  resolve({ success: false, error: "Sudo call failed" });
                }
              }
            }
          },
          error: (err) => {
            if (!resolved) {
              resolved = true;
              resolve({ success: false, error: err.message });
            }
          },
        });

        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            resolve({ success: false, error: "Sudo timeout" });
          }
        }, 60000);
      });

      if (!sudoResult.success) {
        console.error(`[TEST] FAILED: Could not authorize Alice: ${sudoResult.error}`);
        return FAILURE;
      }

      // Wait for authorization to take effect
      await waitForBlocks(api, 1);
    } else {
      console.log("[TEST] Alice is already authorized");
    }

    // Store the data
    console.log("[TEST] Submitting transactionStorage.store transaction...");

    try {
      const storeTx = api.tx.TransactionStorage.store({
        data: Binary.fromBytes(testDataBytes),
      });

      // Sign and submit, waiting for finalization
      const result = await new Promise<{
        success: boolean;
        error?: string;
        events?: unknown[];
      }>((resolve) => {
        let resolved = false;

        storeTx.signSubmitAndWatch(aliceSigner).subscribe({
          next: (event) => {
            console.log(`[TEST] Transaction status: ${event.type}`);

            if (event.type === "txBestBlocksState") {
              if (event.found) {
                console.log(`[TEST] Found in block, ok: ${event.ok}`);
                if (!event.ok && !resolved) {
                  resolved = true;
                  resolve({ success: false, error: formatDispatchError(event.dispatchError, "Transaction failed") });
                }
              }
            }

            if (event.type === "finalized") {
              if (!resolved) {
                resolved = true;
                if (event.ok) {
                  console.log("[TEST] Transaction finalized successfully!");

                  // Check for Stored event
                  const storedEvents = event.events.filter(
                    (e) => e.type === "TransactionStorage"
                  );

                  if (storedEvents.length > 0) {
                    console.log("[TEST] Data stored successfully!");
                    storedEvents.forEach((e) => {
                      console.log(`[TEST] Storage event: ${JSON.stringify(e.value)}`);
                    });
                  }

                  resolve({ success: true, events: event.events });
                } else {
                  resolve({ success: false, error: formatDispatchError(event.dispatchError, "Transaction failed at finalization") });
                }
              }
            }
          },
          error: (err) => {
            if (!resolved) {
              resolved = true;
              console.error(`[TEST] Transaction error: ${err.message}`);
              resolve({ success: false, error: err.message });
            }
          },
        });

        // Timeout after 120 seconds
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            resolve({ success: false, error: "Transaction timeout after 120s" });
          }
        }, 120000);
      });

      if (!result.success) {
        console.error(`[TEST] FAILED: transactionStorage.store failed: ${result.error}`);
        return FAILURE;
      }

      // Wait for a few blocks to let the data propagate
      await waitForBlocks(api, 2);

      // Verify data can be retrieved
      console.log("[TEST] Verifying stored data...");

      const currentBlock = await getCurrentBlock(api);
      let foundTransactions = false;

      // Check recent blocks for stored transactions
      for (let i = Math.max(1, currentBlock - 5); i <= currentBlock; i++) {
        try {
          const transactions =
            await api.query.TransactionStorage.Transactions.getValue(i);
          if (transactions && transactions.length > 0) {
            console.log(
              `[TEST] Current block has ${transactions.length} stored transaction(s)`
            );
            foundTransactions = true;
            break;
          }
        } catch {
          // Ignore errors
        }
      }

      if (!foundTransactions) {
        console.warn("[TEST] Warning: No stored transactions found in recent blocks");
      }

      console.log("[TEST] Data storage test completed successfully");
    } catch (storeError) {
      const err = storeError as Error;
      console.error(`[TEST] FAILED: Store operation error: ${err.message}`);
      return FAILURE;
    }

    console.log(
      "[TEST] Bulletin Chain transactionStorage test completed successfully"
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
