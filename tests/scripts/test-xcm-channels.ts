import type { PolkadotClient, TypedApi } from "polkadot-api";
import type { NetworkInfo } from "./types/zombienet";
import { SUCCESS, FAILURE, connectWithRetry, sleep, safeDisconnect, type ChainName } from "./utils";
import type { bulletin, people, assetHub } from "@polkadot-api/descriptors";

type ParachainApi = TypedApi<typeof bulletin | typeof people | typeof assetHub>;

/**
 * Expected HRMP channel configuration
 * Each entry: [sender paraId, recipient paraId]
 */
const EXPECTED_CHANNELS: [number, number][] = [
  [1502, 1501], // People -> Bulletin
  [1501, 1502], // Bulletin -> People
  [1502, 1500], // People -> Asset Hub
  [1500, 1502], // Asset Hub -> People
];

/**
 * Parachain info for connecting and checking channels
 */
const PARACHAINS: Record<number, { collator: string; chain: ChainName }> = {
  1500: { collator: "asset-hub-collator1", chain: "assetHub" },
  1502: { collator: "people-collator1", chain: "people" },
  1501: { collator: "bulletin-collator1", chain: "bulletin" },
};

/**
 * Check if a parachain has an open egress channel to a sibling
 */
async function hasEgressChannel(
  api: ParachainApi,
  siblingParaId: number,
  maxAttempts: number = 10
): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const messagingState = await api.query.ParachainSystem.RelevantMessagingState.getValue();

      if (messagingState) {
        const egressChannels = messagingState.egress_channels as Array<[unknown, unknown]>;

        // Check if sibling paraId is in egress channels
        const found = egressChannels.some((channel: [unknown, unknown]) => {
          const channelParaId = typeof channel[0] === "number"
            ? channel[0]
            : Number(String(channel[0]));
          return channelParaId === siblingParaId;
        });

        if (found) {
          return true;
        }
      }

      // Channel not found yet, wait and retry
      if (attempt < maxAttempts) {
        console.log(`[CHANNEL] Attempt ${attempt}/${maxAttempts}: channel to ${siblingParaId} not found, waiting...`);
        await sleep(6000);
      }
    } catch (error) {
      const err = error as Error;
      console.log(`[CHANNEL] Attempt ${attempt}/${maxAttempts} error: ${err.message}`);
      if (attempt < maxAttempts) {
        await sleep(6000);
      }
    }
  }

  return false;
}

/**
 * Test XCM HRMP channels are open between parachains
 *
 * @param nodeName - The name of the node to test (used as entry point)
 * @param networkInfo - Network information from Zombienet
 * @param _args - Additional arguments (unused)
 * @returns 1 on success, 0 on failure
 */
export async function run(
  nodeName: string,
  networkInfo: NetworkInfo,
  _args: string[]
): Promise<number> {
  const connections: Map<number, { client: PolkadotClient; api: ParachainApi }> = new Map();

  try {
    console.log(`[TEST] Starting XCM HRMP channel verification`);
    console.log(`[TEST] Expected channels: ${EXPECTED_CHANNELS.map(([s, r]) => `${s}->${r}`).join(", ")}`);

    // Connect to all parachains
    for (const [paraId, { collator, chain }] of Object.entries(PARACHAINS)) {
      const nodeInfo = networkInfo.nodesByName[collator];
      if (!nodeInfo) {
        console.error(`[TEST] Node ${collator} not found in network info`);
        return FAILURE;
      }

      console.log(`[TEST] Connecting to parachain ${paraId} via ${collator}...`);
      const connection = await connectWithRetry(nodeInfo.wsUri, chain);
      connections.set(Number(paraId), connection);
    }

    // Verify each expected channel
    const results: { channel: string; status: "OPEN" | "CLOSED" }[] = [];

    for (const [sender, recipient] of EXPECTED_CHANNELS) {
      const connection = connections.get(sender);
      if (!connection) {
        console.error(`[TEST] No connection for parachain ${sender}`);
        return FAILURE;
      }

      console.log(`[TEST] Checking channel ${sender} -> ${recipient}...`);
      const isOpen = await hasEgressChannel(connection.api, recipient);

      results.push({
        channel: `${sender} -> ${recipient}`,
        status: isOpen ? "OPEN" : "CLOSED",
      });

      if (isOpen) {
        console.log(`[TEST] ✓ Channel ${sender} -> ${recipient} is OPEN`);
      } else {
        console.error(`[TEST] ✗ Channel ${sender} -> ${recipient} is CLOSED`);
      }
    }

    // Summary
    console.log(`\n[TEST] === HRMP Channel Summary ===`);
    for (const result of results) {
      console.log(`[TEST] ${result.channel}: ${result.status}`);
    }

    const allOpen = results.every((r) => r.status === "OPEN");
    const openCount = results.filter((r) => r.status === "OPEN").length;

    console.log(`[TEST] ${openCount}/${results.length} channels open`);

    if (allOpen) {
      console.log(`[TEST] All XCM channels verified successfully!`);
      return SUCCESS;
    } else {
      console.error(`[TEST] Some XCM channels are not open`);
      return FAILURE;
    }
  } catch (error) {
    const err = error as Error;
    console.error(`[TEST] Test failed with error: ${err.message}`);
    console.error(err.stack);
    return FAILURE;
  } finally {
    // Disconnect all connections
    for (const [paraId, { client }] of connections) {
      console.log(`[TEST] Disconnecting from parachain ${paraId}...`);
      safeDisconnect(client);
    }
  }
}

// CommonJS export for Zombienet compatibility
export default { run };
