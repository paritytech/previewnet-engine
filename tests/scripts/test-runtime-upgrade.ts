import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { blake2b256 } from "@polkadot-labs/hdkd-helpers";
import type { NetworkInfo } from "./types/zombienet";
import { runtimeUpgrade, httpFromWs } from "../../packages/cli/src/upgrade/upgrade";
import { wsProvider } from "../../packages/cli/src/upgrade/provider-node";
import { signerFromUri } from "../../packages/cli/src/upgrade/signer";

const SUCCESS = 1;
const FAILURE = 0;

/**
 * End-to-end test of `make runtime-upgrade` (packages/cli/src/upgrade/) against the
 * network's own Asset Hub, covering:
 *
 *   1. a non-sudo signer is refused before anything is submitted
 *   2. if a stale chain spec left the chain behind the bin/ wasm, a REAL upgrade
 *      through the full pipeline — authorize, apply, relay PVF pre-check, go-ahead,
 *      enactment, finality — brings it up to date
 *   3. a byte-identical blob is a no-op (submitting it would wedge the parachain —
 *      the relay never go-aheads a PVF identical to the current one)
 *   4. optional: when bin/ carries an alternate blob (see ALT below), a real upgrade
 *      to it and back, exercising the full pipeline in both directions
 *
 * Steps 1–3 are fully deterministic. Step 4 needs a second valid runtime with
 * different bytes, which cannot be conjured deterministically (mutated blobs are
 * unreliable: the relay has been observed to silently abort artificially padded
 * code) — so it runs only when something provides one, e.g. CI dropping a previous
 * release's runtime at the ALT path. Byte-identical alt blobs are skipped.
 */

const WASM = "../../../bin/next_asset_hub_paseo_runtime.wasm";
const ALT = "../../../bin/next_asset_hub_paseo_runtime.alt.wasm";

const toHex = (b: Uint8Array) =>
  "0x" + Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

async function onChainCodeHash(httpUrl: string): Promise<string> {
  const r = await fetch(httpUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "state_getStorageHash",
      params: ["0x3a636f6465"],
    }),
  });
  const j = (await r.json()) as { result?: string; error?: unknown };
  if (j.error) throw new Error(JSON.stringify(j.error));
  return j.result!;
}

export async function run(
  nodeName: string,
  networkInfo: NetworkInfo,
  _args: string[]
): Promise<number> {
  try {
    const nodeInfo = networkInfo.nodesByName[nodeName];
    if (!nodeInfo) {
      console.error(`[TEST] Node ${nodeName} not found in network info`);
      return FAILURE;
    }
    const { wsUri } = nodeInfo;
    const httpUrl = httpFromWs(wsUri);
    const log = (m: string) => console.log(`[TEST] ${m}`);

    // From dist/test-runtime-upgrade.js (post-bundle): __dirname = tests/scripts/dist
    const wasm = new Uint8Array(readFileSync(resolve(__dirname, WASM)));
    const upgrade = (blob: Uint8Array, extra: object = {}) =>
      runtimeUpgrade({ provider: wsProvider(wsUri), wsUrl: wsUri, wasm: blob, log, ...extra });

    // 1. A non-sudo signer must be refused before anything is submitted.
    try {
      await upgrade(wasm, { signer: signerFromUri("//Bob").signer });
      console.error("[TEST] FAIL: the //Bob signer was not rejected");
      return FAILURE;
    } catch (err) {
      if (!String(err).includes("not the sudo key")) throw err;
      log("non-sudo signer rejected: ok");
    }

    // 2. Bring the chain onto the bin/ wasm if it is not there already — chain specs
    //    can lag the fetched runtimes (a spec generated before a newer release was
    //    fetched), in which case this is itself a full-pipeline upgrade.
    if ((await onChainCodeHash(httpUrl)) !== toHex(blake2b256(wasm))) {
      log("chain is not running the bin/ wasm — syncing first (full-pipeline upgrade)");
      await upgrade(wasm, { allowSameSpec: true });
    }

    // 3. A byte-identical blob must be a no-op, not a submission.
    const noop = await upgrade(wasm);
    if (noop.strategy !== "already-installed") {
      console.error(`[TEST] FAIL: identical blob was not a no-op (${noop.strategy})`);
      return FAILURE;
    }
    log("byte-identical blob is a no-op: ok");

    // 4. Optional real upgrade there-and-back with an alternate runtime.
    const altPath = resolve(__dirname, ALT);
    if (!existsSync(altPath)) {
      log("no alternate runtime at bin/next_asset_hub_paseo_runtime.alt.wasm — pipeline");
      log("round-trip skipped (provide one, e.g. a previous release's blob, to enable)");
      return SUCCESS;
    }
    const alt = new Uint8Array(readFileSync(altPath));
    if (toHex(blake2b256(alt)) === toHex(blake2b256(wasm))) {
      log("alternate runtime is byte-identical to bin/ — pipeline round-trip skipped");
      return SUCCESS;
    }

    await upgrade(alt, { allowSameSpec: true });
    if ((await onChainCodeHash(httpUrl)) !== toHex(blake2b256(alt))) {
      console.error("[TEST] FAIL: :code does not match the alternate blob after upgrade");
      return FAILURE;
    }
    log("upgrade to the alternate runtime enacted: ok");

    await upgrade(wasm, { allowSameSpec: true });
    if ((await onChainCodeHash(httpUrl)) !== toHex(blake2b256(wasm))) {
      console.error("[TEST] FAIL: :code does not match bin/ after restore");
      return FAILURE;
    }
    log("original runtime restored: ok");

    return SUCCESS;
  } catch (err) {
    console.error(`[TEST] Runtime upgrade test failed: ${err}`);
    return FAILURE;
  }
}
