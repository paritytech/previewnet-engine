/**
 * Type definitions for Zombienet test scripts
 *
 * Zombienet executes JavaScript tests via the `js-script` directive in ZNDSL files.
 * Each test script must export a `run` function that follows the ZombienetTestFn signature.
 */

/**
 * Information about a single node in the network
 */
export interface NodeInfo {
  /** The name of the node as defined in the network config */
  name: string;
  /** WebSocket URI for connecting to the node */
  wsUri: string;
  /** Optional user-defined types for the node */
  userDefinedTypes?: Record<string, unknown>;
  /** Multiaddress for p2p connections */
  multiAddress?: string;
}

/**
 * Information about a parachain in the network
 */
export interface ParachainInfo {
  /** Parachain ID */
  chainId: string;
  /** Nodes belonging to this parachain */
  nodes: NodeInfo[];
}

/**
 * Network information provided by Zombienet to test scripts
 */
export interface NetworkInfo {
  /** Map of node names to their info - primary way to access nodes */
  nodesByName: Record<string, NodeInfo>;
  /** Relay chain nodes */
  relay?: NodeInfo[];
  /** Parachains indexed by their ID */
  paras?: Record<string, ParachainInfo>;
  /** Temporary directory used by Zombienet */
  tmpDir?: string;
  /** Chain spec path */
  chainSpecPath?: string;
}

/**
 * Test function signature expected by Zombienet
 *
 * @param nodeName - The name of the node to test (from ZNDSL)
 * @param networkInfo - Network information including all nodes
 * @param args - Additional arguments passed from ZNDSL
 * @returns Promise resolving to 1 (SUCCESS) or 0 (FAILURE)
 */
export type ZombienetTestFn = (
  nodeName: string,
  networkInfo: NetworkInfo,
  args: string[]
) => Promise<number>;

/** Test passed */
export const SUCCESS = 1;

/** Test failed */
export const FAILURE = 0;
