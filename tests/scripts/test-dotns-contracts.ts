import type { NetworkInfo } from "./types/zombienet";
import { SUCCESS, FAILURE } from "./utils";
import { readFileSync, readdirSync } from "fs";
import { resolve } from "path";

// =============================================================================
// Constants
// =============================================================================

/**
 * EIP-1967 implementation storage slot. Also defined in paritytech/dotns's
 * scripts/genesis/extract-genesis.mjs, which produces the artifact this reads.
 */
const EIP1967_IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

/** Asset Hub eth-rpc endpoint */
const ETH_RPC_URL = "http://127.0.0.1:8545";

/** Zero value for 32-byte slot comparison */
const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000";

/** Zero address for pointer comparison */
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * EVM dev account 0 (anvil/hardhat), funded on Asset Hub at genesis by
 * `patch-genesis.js --fund-evm-dev`. A dry run needs an account with a balance
 * to cover the storage deposit, and the DotNS owner is a build secret that
 * nothing funds.
 */
const FUNDED_DEV_ACCOUNT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

/**
 * Function selectors (first 4 bytes of keccak256 of the signature) and the
 * custom-error selectors that tell us a pointer leads nowhere.
 */
const SELECTOR = {
  /** implementation() — UpgradeableBeacon and ERC-1967 proxies */
  implementation: "0x5c60da1b",
  /** owner() — OpenZeppelin Ownable */
  owner: "0x8da5cb5b",
  /** claimUserStore() — StoreFactory, clones the UserStore beacon */
  claimUserStore: "0xeccf8f55",
  /** deployLabelStoreFor(address) — StoreFactory, clones the LabelStore beacon */
  deployLabelStoreFor: "0x5269fc58",
} as const;

/**
 * OpenZeppelin raises these when a proxy or beacon points at an address with no
 * code. A store creation that fails this way means the genesis shipped a
 * pointer without the contract behind it.
 */
const MISSING_IMPLEMENTATION_ERRORS: Record<string, string> = {
  "0x4c9c8ce3": "ERC1967InvalidImplementation(address)",
  "0x847ac564": "BeaconInvalidImplementation(address)",
};

// =============================================================================
// JSON-RPC helpers (zero-dependency, uses built-in fetch)
// =============================================================================

let rpcId = 1;

async function ethRpc(method: string, params: unknown[]): Promise<unknown> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    method,
    params,
    id: rpcId++,
  });

  const res = await fetch(ETH_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });

  if (!res.ok) {
    throw new Error(`eth-rpc HTTP ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (json.error) {
    throw new Error(`eth-rpc error: ${json.error.message}`);
  }
  return json.result;
}

async function ethGetCode(address: string): Promise<string> {
  return (await ethRpc("eth_getCode", [address, "latest"])) as string;
}

async function ethGetStorageAt(
  address: string,
  slot: string
): Promise<string> {
  return (await ethRpc("eth_getStorageAt", [address, slot, "latest"])) as string;
}

interface CallResult {
  /** Return data on success */
  data?: string;
  /** Revert reason as reported by eth-rpc */
  error?: string;
  /** Revert payload, when eth-rpc includes one (first 4 bytes = error selector) */
  revertData?: string;
}

/**
 * eth_call that reports a revert instead of throwing — a revert is a result
 * here, not a transport failure.
 */
async function ethCall(
  to: string,
  data: string,
  from?: string
): Promise<CallResult> {
  const res = await fetch(ETH_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "eth_call",
      params: [{ to, data, ...(from ? { from } : {}) }, "latest"],
      id: rpcId++,
    }),
  });

  if (!res.ok) {
    throw new Error(`eth-rpc HTTP ${res.status}: ${await res.text()}`);
  }

  const json = (await res.json()) as {
    result?: string;
    error?: { message: string; data?: string };
  };

  if (json.error) {
    return { error: json.error.message, revertData: json.error.data };
  }
  return { data: json.result };
}

/**
 * Decode a 32-byte word as an address, or null if it is not one.
 *
 * Duplicated in paritytech/dotns's scripts/genesis/extract-genesis.mjs because the .mjs and
 * .ts toolchains cannot share a module — keep the two in step. Like the
 * extractor's copy, a short word is left-padded before decoding (RPC answers
 * are always full 32 bytes, so that path only matters for parity).
 */
function addressFromWord(word: string | undefined): string | null {
  if (!word) return null;
  const clean = word.replace(/^0x/, "").padStart(64, "0");
  if (clean.length !== 64) return null;
  if (clean.slice(0, 24) !== "0".repeat(24)) return null;
  const address = "0x" + clean.slice(24);
  return address === ZERO_ADDRESS ? null : address;
}

/** The 4-byte selector of a revert payload, if there is one */
function revertSelector(result: CallResult): string | null {
  const payload = result.revertData ?? "";
  return payload.startsWith("0x") && payload.length >= 10
    ? payload.slice(0, 10)
    : null;
}

// =============================================================================
// Genesis loader
// =============================================================================

interface GenesisAccount {
  address: string;
  storage?: Record<string, string>;
}

interface GenesisData {
  accounts: GenesisAccount[];
}

/**
 * Loads the DotNS genesis artifact produced by the release pipeline.
 * Throws if missing — the test should fail loud rather than fake-pass.
 */
function loadGenesis(): GenesisData {
  // From dist/test-dotns-contracts.js (post-bundle): __dirname = tests/scripts/dist
  // → ../../../bin resolves to project root's bin/. The TLD is part of the artifact's
  // name; the network descriptor decides which one is fetched, so glob rather than
  // hardcode — exactly one must be present.
  const binDir = resolve(__dirname, "../../../bin");
  const candidates = readdirSync(binDir).filter(
    (f) => f.startsWith("dotns-genesis-") && f.endsWith(".json")
  );
  if (candidates.length !== 1) {
    throw new Error(
      `Expected exactly one bin/dotns-genesis-<tld>.json, found ${candidates.length}` +
        `${candidates.length ? ` (${candidates.join(", ")})` : ""}. Run 'make fetch'.`
    );
  }
  const genesisPath = resolve(binDir, candidates[0]);
  try {
    const genesis = JSON.parse(readFileSync(genesisPath, "utf8")) as GenesisData;
    console.log(
      `[TEST] Loaded ${genesis.accounts.length} addresses from ${genesisPath}`
    );
    return genesis;
  } catch (e) {
    throw new Error(
      `Could not read ${genesisPath}: ${(e as Error).message}\n` +
        `Run 'make fetch' (which downloads it from the paritytech/dotns release ` +
        `pinned in config/versions.env).`
    );
  }
}

/**
 * Loads the named address manifest fetched next to the genesis artifact.
 * Throws if missing — same artifact set, same loud failure.
 */
function loadAddresses(): Record<string, string> {
  const manifestPath = resolve(__dirname, "../../../bin/dotns-addresses.json");
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
      string,
      string
    >;
  } catch (e) {
    throw new Error(
      `Could not read ${manifestPath}: ${(e as Error).message}\n` +
        `Run 'make fetch' (which derives it from the dotns deployments manifest ` +
        `at the tag pinned in config/versions.env).`
    );
  }
}

// =============================================================================
// Test steps — each checks one property and returns true when it holds
// =============================================================================

/** No contract lives at this address: eth_getCode came back empty */
function hasNoCode(code: string | undefined): boolean {
  return !code || code === "0x" || code === "0x0";
}

/** Every contract address from the genesis artifact has non-empty bytecode */
async function checkBytecode(genesis: GenesisData): Promise<boolean> {
  const allAddresses = genesis.accounts.map((a) => a.address.toLowerCase());
  console.log(
    `[TEST] Verifying bytecode for ${allAddresses.length} contract addresses...`
  );

  let failures = 0;
  for (const addr of allAddresses) {
    const code = await ethGetCode(addr);
    if (hasNoCode(code)) {
      console.error(`[TEST]   ✗ ${addr} — NO CODE`);
      failures++;
    } else {
      console.log(`[TEST]   ✓ ${addr} — ${code.length / 2 - 1} bytes`);
    }
  }

  if (failures > 0) {
    console.error(
      `[TEST] FAIL: ${failures}/${allAddresses.length} contracts missing bytecode`
    );
    return false;
  }
  console.log(`[TEST] All ${allAddresses.length} contracts have bytecode`);
  return true;
}

/**
 * Every proxy has a non-zero EIP-1967 implementation slot with code behind it.
 * Proxies are identified directly from the genesis artifact: any account with
 * a non-zero EIP-1967 impl slot is a UUPS proxy.
 */
async function checkProxySlots(genesis: GenesisData): Promise<boolean> {
  const proxyAddresses = genesis.accounts
    .filter(
      (a) =>
        a.storage &&
        a.storage[EIP1967_IMPL_SLOT] &&
        a.storage[EIP1967_IMPL_SLOT] !== ZERO_BYTES32
    )
    .map((a) => a.address.toLowerCase());
  console.log(
    `[TEST] Verifying EIP-1967 implementation slot for ${proxyAddresses.length} proxies...`
  );

  let failures = 0;
  for (const addr of proxyAddresses) {
    const implSlot = await ethGetStorageAt(addr, EIP1967_IMPL_SLOT);
    const implAddr =
      implSlot && implSlot !== ZERO_BYTES32 ? "0x" + implSlot.slice(-40) : null;

    if (!implAddr) {
      console.error(`[TEST]   ✗ ${addr} — EIP-1967 slot is zero or missing`);
      failures++;
      continue;
    }

    // A pointer is only worth having if there is code at the other end.
    if (hasNoCode(await ethGetCode(implAddr))) {
      console.error(
        `[TEST]   ✗ ${addr} → impl ${implAddr} has NO CODE — calls through this proxy revert`
      );
      failures++;
      continue;
    }
    console.log(`[TEST]   ✓ ${addr} → impl ${implAddr}`);
  }

  if (failures > 0) {
    console.error(
      `[TEST] FAIL: ${failures}/${proxyAddresses.length} proxies have invalid implementation slot`
    );
    return false;
  }
  console.log(
    `[TEST] All ${proxyAddresses.length} proxy implementation slots verified`
  );
  return true;
}

/**
 * Every implementation() pointer stored on chain leads to real code.
 * Beacons (UpgradeableBeacon) keep their implementation in a plain storage
 * slot rather than the EIP-1967 one, so the proxy-slot check cannot see them.
 * Ask every contract for implementation() instead, and only trust the answer
 * when the same address is really in one of that account's storage slots —
 * that rules out return data that merely happens to look like an address.
 *
 * Slot keys come from the genesis artifact, values are read off the chain:
 * a beacon that was legitimately upgraded after genesis holds a different
 * address than the artifact does, and comparing against the artifact would
 * skip it instead of checking it.
 */
async function checkImplementationPointers(
  genesis: GenesisData
): Promise<boolean> {
  console.log(
    `[TEST] Verifying implementation() pointers resolve to deployed code...`
  );

  let checked = 0;
  let failures = 0;
  for (const account of genesis.accounts) {
    const addr = account.address.toLowerCase();
    const result = await ethCall(addr, SELECTOR.implementation);
    const target = addressFromWord(result.data);
    if (!target) continue;

    let isStoredPointer = false;
    for (const slot of Object.keys(account.storage ?? {})) {
      const live = await ethGetStorageAt(addr, slot);
      if (addressFromWord(live?.toLowerCase()) === target) {
        isStoredPointer = true;
        break;
      }
    }
    if (!isStoredPointer) continue;

    checked++;
    if (hasNoCode(await ethGetCode(target))) {
      console.error(
        `[TEST]   ✗ ${addr}.implementation() → ${target} has NO CODE — ` +
          `the genesis shipped the pointer without the contract`
      );
      failures++;
      continue;
    }
    console.log(`[TEST]   ✓ ${addr}.implementation() → ${target}`);
  }

  if (failures > 0) {
    console.error(
      `[TEST] FAIL: ${failures}/${checked} implementation pointers lead nowhere`
    );
    return false;
  }
  console.log(`[TEST] All ${checked} implementation pointers resolved`);
  return true;
}

/**
 * Store creation actually works through the beacons. The structural checks
 * above pass even when a beacon's implementation is missing; cloning a store
 * is what actually exercises the pointer. Both calls are dry runs (eth_call),
 * so nothing is written.
 */
async function checkStoreCreation(
  addresses: Record<string, string>
): Promise<boolean> {
  const storeFactory = addresses.StoreFactory;
  if (!storeFactory) {
    console.error("[TEST] FAIL: StoreFactory missing from dotns-addresses.json");
    return false;
  }

  const ownerResult = await ethCall(storeFactory, SELECTOR.owner);
  const owner = addressFromWord(ownerResult.data);
  if (!owner) {
    console.error(
      `[TEST] FAIL: StoreFactory.owner() returned ${JSON.stringify(ownerResult)}`
    );
    return false;
  }
  console.log(`[TEST] StoreFactory ${storeFactory}, owner ${owner}`);

  // claimUserStore is open to anyone, so run it from a funded dev account;
  // deployLabelStoreFor is owner-gated, so it has to come from the owner.
  const storeCalls: Array<{ label: string; data: string; from: string }> = [
    {
      label: "claimUserStore()",
      data: SELECTOR.claimUserStore,
      from: FUNDED_DEV_ACCOUNT,
    },
    {
      label: "deployLabelStoreFor(dev0)",
      data:
        SELECTOR.deployLabelStoreFor +
        FUNDED_DEV_ACCOUNT.slice(2).toLowerCase().padStart(64, "0"),
      from: owner,
    },
  ];

  let failures = 0;
  for (const { label, data, from } of storeCalls) {
    const result = await ethCall(storeFactory, data, from);
    const selector = revertSelector(result);
    const missingImpl = selector
      ? MISSING_IMPLEMENTATION_ERRORS[selector]
      : undefined;

    if (missingImpl) {
      console.error(
        `[TEST]   ✗ StoreFactory.${label} reverted with ${missingImpl} ` +
          `(${result.revertData}) — the beacon implementation is not deployed`
      );
      failures++;
      continue;
    }

    if (result.error) {
      // Any other revert is about this account's state (a store it already
      // owns, say), not about missing code — that is not what this checks.
      console.log(
        `[TEST]   ✓ StoreFactory.${label} reached the beacon (reverted with ` +
          `${result.revertData ?? result.error})`
      );
      continue;
    }
    console.log(`[TEST]   ✓ StoreFactory.${label} → ${result.data}`);
  }

  if (failures > 0) {
    console.error(
      `[TEST] FAIL: ${failures}/${storeCalls.length} store creations hit a missing implementation`
    );
    return false;
  }
  console.log("[TEST] Store creation reaches deployed beacon implementations");
  return true;
}

// =============================================================================
// Test runner
// =============================================================================

/**
 * Verify all DotNS contracts are deployed on Asset Hub via eth-rpc. Each step
 * is a function above; a step that fails stops the run.
 */
export async function run(
  nodeName: string,
  _networkInfo: NetworkInfo,
  _args: string[]
): Promise<number> {
  try {
    console.log(`[TEST] Starting DotNS contract verification on ${nodeName}`);

    console.log(`[TEST] Checking eth-rpc at ${ETH_RPC_URL}...`);
    const blockNumber = (await ethRpc("eth_blockNumber", [])) as string;
    console.log(`[TEST] eth-rpc reachable, block: ${blockNumber}`);

    const genesis = loadGenesis();
    const passed =
      (await checkBytecode(genesis)) &&
      (await checkProxySlots(genesis)) &&
      (await checkImplementationPointers(genesis)) &&
      (await checkStoreCreation(loadAddresses()));
    if (!passed) return FAILURE;

    console.log("[TEST] DotNS contract verification PASSED");
    return SUCCESS;
  } catch (error) {
    const err = error as Error;
    console.error(`[TEST] Test failed with error: ${err.message}`);
    console.error(err.stack);
    return FAILURE;
  }
}

// CommonJS export for Zombienet compatibility
export default { run };
