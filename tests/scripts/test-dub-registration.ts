import type { NetworkInfo } from "./types/zombienet";
import * as path from "node:path";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { entropyToMiniSecret } from "@polkadot-labs/hdkd-helpers";
import { blake2b } from "@noble/hashes/blake2.js";
import { AccountId } from "polkadot-api";
import { createHash, randomBytes } from "node:crypto";
import { waitForDubReady } from "./dub-ready";

// Registers a brand-new person end to end and waits for the username to land on
// People Chain and appear in the indexer's projection.
//
// Mode-agnostic on purpose: it registers a fresh random account every run, so it
// behaves identically against a genesis chain (no prior usernames) and a fork
// (a few hundred inherited from production).
//
// Deliberately no import from ./utils — that pulls the papi descriptors, which
// need codegen against the runtime WASM. Everything here is HTTP plus crypto.

const SUCCESS = 1 as const;
const FAILURE = 0 as const;

interface Verifiable {
  member_from_entropy(entropy: Uint8Array): Uint8Array;
  sign(entropy: Uint8Array, message: Uint8Array): Uint8Array;
}

/**
 * Load the ring-VRF wasm.
 *
 * verifiablejs's `./nodejs` subpath declares only an `import` condition even
 * though the build it points at is CommonJS (`module.exports`), so a bare
 * `require("verifiablejs/nodejs")` is rejected by the exports map while these
 * bundles are CJS. An exports map constrains bare specifiers only, so resolving
 * the file by path loads the very same module. Try the bare specifier first, so
 * this falls away on its own if upstream adds a `require` condition.
 */
function loadVerifiable(): Verifiable {
  try {
    return require("verifiablejs/nodejs") as Verifiable;
  } catch {
    return require(
      path.join(__dirname, "..", "node_modules", "verifiablejs", "pkg-nodejs", "verifiablejs.js")
    ) as Verifiable;
  }
}

const GATEWAY_PORT = 8092;
const BASE = `http://127.0.0.1:${GATEWAY_PORT}`;

// The message prefix pallet people-lite signs over, from its MSG_PREFIX const.
const MSG_PREFIX = new TextEncoder().encode("pop:people-lite:register using");

// The host SDK derives the lite-person account at this path; matching it means
// the account we attest is the one a real user would have.
const LITE_PERSON_DERIVATION = "//wallet//sso";

const READY_TIMEOUT_MS = 300_000;
// Long, and deliberately so: this waits for the *read model*, not the chain. Acceptance and
// the on-chain write both finish quickly; what follows is username-indexer picking the record
// up on its own schedule and the search endpoint serving it.
//
// Raised from 240s while chasing failures with accounts_upserted=0 across the whole window.
// Time was indeed never the problem: the backend's Postgres cluster outlived the chain, so the indexer
// began each fresh genesis network with a checkpoint past that chain's finalized head and
// resynced an empty range for ever. Fixed where it belongs — the cluster now follows the
// chain's own durability (run-tests.sh gives each run its own, `ppn start` puts it under the
// data directory it wipes) rather than here.
//
// The budget stays generous anyway, and this part is a real wait: the writer's own retry
// backoff can spend ~90s losing nonce races to the sudo grants that run at startup before it
// wins one. It only elapses in full when something is actually broken.
const LANDING_TIMEOUT_MS = 420_000;
const POLL_MS = 5_000;

const accountId = AccountId();
const b64 = (u8: Uint8Array) => Buffer.from(u8).toString("base64");
const toHex = (u8: Uint8Array) => "0x" + Buffer.from(u8).toString("hex");
const sha256 = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());
const blake2b256 = (b: Uint8Array) => blake2b(b, { dkLen: 32 });
const cat = (...arrs: Uint8Array[]) => new Uint8Array(Buffer.concat(arrs.map(Buffer.from)));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const waitForReady = () =>
  waitForDubReady({ timeoutMs: READY_TIMEOUT_MS, pollMs: POLL_MS, log: console.log });

export async function run(
  nodeName: string,
  _networkInfo: NetworkInfo,
  _args: string[]
): Promise<number> {
  try {
    console.log(`[TEST] DUB username registration via ${BASE} (from ${nodeName})`);
    if (!(await waitForReady())) return FAILURE;

    // --- credentials -------------------------------------------------------
    const entropy = new Uint8Array(randomBytes(32));
    const keyPair = sr25519CreateDerive(entropyToMiniSecret(entropy))(LITE_PERSON_DERIVATION);
    const publicKey = keyPair.publicKey;
    const address = accountId.dec(publicKey);

    // The ring VRF key is Bandersnatch (BandersnatchVrfVerifiable in the
    // next-people-paseo runtime), so it cannot be produced with sr25519 tooling
    // — verifiablejs is the wasm build of the same `verifiable` crate the
    // runtime verifies with.
    const verifiable = loadVerifiable();
    const verifiableEntropy = blake2b256(entropy);
    const ringVrfKey = verifiable.member_from_entropy(verifiableEntropy);

    // Both signatures are over the same message the pallet reconstructs:
    // MSG_PREFIX || candidate || ring_vrf_key (people-lite/src/lib.rs).
    const message = cat(MSG_PREFIX, publicKey, ringVrfKey);
    const candidateSignature = keyPair.sign(message);
    const proofOfOwnership = verifiable.sign(verifiableEntropy, message);

    // 65 bytes. The leading byte must be 0: the indexer's search excludes
    // pre-RFC-0004 keys with `get_byte(identifier_key, 0) = 0`, so a 0x04-style
    // key registers and indexes fine but never appears in search results.
    const idKp = sr25519CreateDerive(
      entropyToMiniSecret(blake2b256(cat(entropy, Uint8Array.from([1]))))
    )("");
    const identifierKey = new Uint8Array(65);
    identifierKey[0] = 0x00;
    identifierKey.set(idKp.publicKey.slice(0, 32), 1);
    identifierKey.set(idKp.publicKey.slice(0, 32), 33);

    // Must match /^([a-z]{6,})$/ — lowercase letters only, no digits.
    const alphabet = "abcdefghijklmnopqrstuvwxyz";
    let suffix = "";
    for (let i = 0; i < 9; i++) suffix += alphabet[Math.floor(Math.random() * 26)];
    const username = `ppn${suffix}`;
    console.log(`[TEST] candidate ${address} username ${username}`);

    // --- auth: challenge -> signed proof -> JWT ----------------------------
    const chRes = await fetch(`${BASE}/api/v1/auth/challenges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const { challenge } = (await chRes.json()) as { challenge: string };

    // proof = sr25519(SHA256(challenge || clientId || SHA256(body)))
    const clientProof = keyPair.sign(
      sha256(cat(new Uint8Array(Buffer.from(challenge, "base64")), publicKey, sha256(new Uint8Array(Buffer.from("{}")))))
    );
    const tokenRes = await fetch(`${BASE}/api/v1/auth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Auth-ClientId": b64(publicKey),
        "Auth-Challenge": challenge,
        "Auth-ClientProof": b64(clientProof),
        "Auth-Attestation-Type": "none",
      },
      body: "{}",
    });
    if (tokenRes.status !== 200) {
      console.error(`[TEST] FAIL auth token: ${tokenRes.status} ${await tokenRes.text()}`);
      return FAILURE;
    }
    const { token } = (await tokenRes.json()) as { token: string };
    const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    console.log("[TEST] ok JWT issued");

    // --- consumer registration signature -----------------------------------
    const attRes = await fetch(`${BASE}/api/v1/attester`, { headers: auth });
    const { attester } = (await attRes.json()) as { attester: string };
    const usernameBytes = new TextEncoder().encode(username);
    const consumerPayload = cat(
      publicKey,
      new Uint8Array(Buffer.from(attester.replace(/^0x/, ""), "hex")),
      identifierKey,
      Uint8Array.from([usernameBytes.length * 4]), // SCALE compact length
      usernameBytes,
      Uint8Array.from([0]) // Option::None reserved_username
    );
    const consumerRegistrationSignature = keyPair.sign(consumerPayload);

    // --- register ----------------------------------------------------------
    const regRes = await fetch(`${BASE}/api/v1/usernames`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        candidateAccountId: address,
        username,
        candidateSignature: toHex(candidateSignature),
        ringVrfKey: toHex(ringVrfKey),
        proofOfOwnership: toHex(proofOfOwnership),
        consumerRegistrationSignature: toHex(consumerRegistrationSignature),
        identifierKey: toHex(identifierKey),
      }),
    });
    if (regRes.status !== 202) {
      console.error(`[TEST] FAIL register: ${regRes.status} ${await regRes.text()}`);
      return FAILURE;
    }
    const assigned = (await regRes.json()) as { username: string };
    console.log(`[TEST] ok accepted as ${assigned.username}`);

    // --- wait for it to land on chain and reach the projection -------------
    //
    // Registration is asynchronous: device-attestation-api only writes an outbox row, and
    // device-attestation-chain-writer submits PeopleLite.attest from there. Search going
    // green proves the whole chain — writer lease, attestation allowance,
    // signing, submission, finalization, and the indexer projection.
    const deadline = Date.now() + LANDING_TIMEOUT_MS;
    // Kept for the failure path: what search last said, verbatim. Without it a mismatch and an
    // empty result look identical from the outside, which is how a rendering bug spent two days
    // being read as indexer lag.
    let lastStatus = 0;
    let lastBody = "";
    while (Date.now() < deadline) {
      const res = await fetch(
        `${BASE}/api/v1/usernames/search?prefix=${encodeURIComponent(username)}`
      );
      lastStatus = res.status;
      lastBody = await res.text();
      let body: { usernames?: Array<{ username: string; accountId: string }> } = {};
      try {
        body = JSON.parse(lastBody);
      } catch {
        /* reported below if we never land */
      }
      // String equality, because v0.3.0 serves the stored `display_username` verbatim. Until
      // then search rebuilt the name from a NUMERIC column and returned `alice.06` as
      // `alice.6`, so this comparison failed for exactly the discriminators `.00`–`.09` — a
      // tenth of registrations, and so a 10% flake that read as indexer lag
      // (device-uniqueness-backend#44).
      const hit = body.usernames?.find((u) => u.username === assigned.username);
      if (hit) {
        if (hit.accountId !== address) {
          console.error(`[TEST] FAIL account mismatch: ${hit.accountId} != ${address}`);
          return FAILURE;
        }
        console.log(`[TEST] ok on chain and indexed: ${hit.username} -> ${hit.accountId}`);
        console.log("[TEST] Registration end-to-end passed");
        return SUCCESS;
      }
      await sleep(POLL_MS);
    }

    // Name the two halves separately: the writer may never have dispatched, or it dispatched and
    // the read model never served it. The service logs tell them apart —
    // device-attestation-chain-writer logs `registration assigned on-chain`, and
    // username-indexer logs `accounts_upserted`.
    console.error(
      `[TEST] FAIL ${assigned.username} never reached search within ${
        LANDING_TIMEOUT_MS / 1000
      }s — last response ${lastStatus}: ${lastBody.slice(0, 500)}`
    );
    console.error(
      "[TEST] check device-attestation-chain-writer's log for the dispatch, then username-indexer's for the projection"
    );
    return FAILURE;
  } catch (error) {
    const err = error as Error;
    console.error(`[TEST] Test failed with error: ${err.message}`);
    console.error(err.stack);
    return FAILURE;
  }
}

// CommonJS export for Zombienet compatibility
export default { run };
