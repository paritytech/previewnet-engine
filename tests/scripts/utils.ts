import { createClient, type PolkadotClient, type TypedApi } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/node";
import {
  createDerive,
  sr25519,
  sr25519Derive,
  DEV_MINI_SECRET,
  ss58Address,
} from "@polkadot-labs/hdkd-helpers";
import { getPolkadotSigner } from "polkadot-api/signer";
import type { PolkadotSigner } from "polkadot-api/signer";
import { bulletin, people, assetHub } from "@polkadot-api/descriptors";

// Create a derive function for dev accounts
const devDerive = createDerive({
  seed: DEV_MINI_SECRET,
  curve: sr25519,
  derive: sr25519Derive,
});

/** Test passed */
export const SUCCESS = 1 as const;

/** Test failed */
export const FAILURE = 0 as const;

/** Chain descriptors */
export const CHAINS = {
  bulletin,
  people,
  assetHub,
} as const;

export type ChainName = keyof typeof CHAINS;

/**
 * Create a dev account signer (Alice, Bob, etc.)
 * @param name - Dev account name (e.g., "Alice", "Bob")
 * @returns PolkadotSigner for the dev account
 */
export function getDevSigner(name: string): PolkadotSigner {
  const keyPair = devDerive(`//${name}`);
  return getPolkadotSigner(keyPair.publicKey, "Sr25519", keyPair.sign);
}

/**
 * Get the public key for a dev account
 * @param name - Dev account name (e.g., "Alice", "Bob")
 * @returns Public key as Uint8Array
 */
export function getDevPublicKey(name: string): Uint8Array {
  const keyPair = devDerive(`//${name}`);
  return keyPair.publicKey;
}

/**
 * Get the SS58 address for a dev account
 * @param name - Dev account name (e.g., "Alice", "Bob")
 * @param ss58Prefix - SS58 prefix (default: 42 for generic substrate)
 * @returns SS58 address string
 */
export function getDevAddress(name: string, ss58Prefix: number = 42): string {
  const keyPair = devDerive(`//${name}`);
  return ss58Address(keyPair.publicKey, ss58Prefix);
}

/**
 * Convert public key to hex string
 */
export function publicKeyToHex(publicKey: Uint8Array): string {
  return (
    "0x" +
    Array.from(publicKey)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  );
}

/**
 * Connect to a node with retry logic
 * @param wsUri - WebSocket URI
 * @param chain - Chain descriptor name
 * @param maxRetries - Maximum number of retries
 * @param delayMs - Initial delay in milliseconds
 * @returns Connected TypedApi instance and client
 */
export async function connectWithRetry<T extends ChainName>(
  wsUri: string,
  chain: T,
  maxRetries: number = 5,
  delayMs: number = 2000
): Promise<{ client: PolkadotClient; api: TypedApi<(typeof CHAINS)[T]> }> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(
        `[CONNECT] Attempt ${attempt}/${maxRetries} to ${wsUri} (${chain})`
      );
      const client = createClient(getWsProvider(wsUri));
      const api = client.getTypedApi(CHAINS[chain]);

      // Wait for connection to be ready by fetching something
      await api.query.System.Number.getValue();

      console.log(`[CONNECT] Successfully connected to ${wsUri}`);
      return { client, api };
    } catch (error) {
      lastError = error as Error;
      console.log(`[CONNECT] Attempt ${attempt} failed: ${lastError.message}`);

      if (attempt < maxRetries) {
        const waitTime = delayMs * Math.pow(2, attempt - 1);
        console.log(`[CONNECT] Waiting ${waitTime}ms before retry...`);
        await sleep(waitTime);
      }
    }
  }

  throw new Error(
    `Failed to connect to ${wsUri} after ${maxRetries} attempts: ${lastError?.message}`
  );
}

/**
 * Get the current block number
 * @param api - Connected TypedApi instance
 * @returns Current block number
 */
export async function getCurrentBlock(
  api: TypedApi<typeof bulletin | typeof people | typeof assetHub>
): Promise<number> {
  const blockNumber = await api.query.System.Number.getValue();
  return blockNumber;
}

/**
 * Wait for chain to be ready (producing blocks)
 * This handles the race condition where the collator RPC is available
 * but hasn't synced blocks yet
 * @param api - Connected TypedApi instance
 * @param timeoutMs - Timeout in milliseconds
 * @returns Current block number once ready
 */
export async function waitForChainReady(
  api: TypedApi<typeof bulletin | typeof people | typeof assetHub>,
  timeoutMs: number = 60000
): Promise<number> {
  console.log(`[READY] Waiting for chain to be ready (timeout: ${timeoutMs}ms)...`);
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const blockNumber = await getCurrentBlock(api);
    if (blockNumber > 0) {
      console.log(`[READY] Chain is ready at block ${blockNumber}`);
      return blockNumber;
    }
    console.log(`[READY] Block number is ${blockNumber}, waiting...`);
    await sleep(2000);
  }

  throw new Error(`Chain not ready after ${timeoutMs}ms - block number still 0`);
}

/**
 * Wait for a specific number of blocks
 * @param api - Connected TypedApi instance
 * @param count - Number of blocks to wait
 * @param timeoutMs - Timeout in milliseconds
 * @returns true if blocks reached, false if timeout
 */
export async function waitForBlocks(
  api: TypedApi<typeof bulletin | typeof people | typeof assetHub>,
  count: number = 1,
  timeoutMs: number = 120000
): Promise<boolean> {
  console.log(
    `[BLOCKS] Waiting for ${count} block(s) (timeout: ${timeoutMs}ms)...`
  );

  const startBlock = await getCurrentBlock(api);
  const targetBlock = startBlock + count;

  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const currentBlock = await getCurrentBlock(api);
    if (currentBlock >= targetBlock) {
      console.log(
        `[BLOCKS] Reached block ${currentBlock} (started at ${startBlock})`
      );
      return true;
    }
    await sleep(1000);
  }

  console.log(`[BLOCKS] Timeout waiting for blocks (started at ${startBlock})`);
  return false;
}

/**
 * Sleep for specified milliseconds
 * @param ms - Milliseconds to sleep
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Safely disconnect from client
 * @param client - Client instance to disconnect
 */
export function safeDisconnect(client: PolkadotClient | null): void {
  if (client) {
    try {
      client.destroy();
      console.log("[DISCONNECT] Client disconnected");
    } catch (error) {
      const err = error as Error;
      console.log(`[DISCONNECT] Error during disconnect: ${err.message}`);
    }
  }
}
