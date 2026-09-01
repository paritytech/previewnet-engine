import type { NetworkInfo } from "./types/zombienet";
import { waitForDubReady } from "./dub-ready";

// Deliberately no import from ./utils: this test speaks HTTP only, and utils
// pulls in the papi descriptors, which need codegen against the runtime WASM.
// Keeping it dependency-free means it builds and runs even when the chain
// tooling is not set up. ./dub-ready is HTTP only, for the same reason.

const SUCCESS = 1 as const;
const FAILURE = 0 as const;

// Alice's sr25519 public key, as an independently known constant rather than
// derived from the same library the backend might use. This is the account
// scripts/increase-people-lite-attestation-allowance.sh grants allowance to.
const ALICE_PUBLIC_KEY =
  "0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d";

// One origin serving every surface: `dub --role all-in-one`. Backend v0.2.0 merges the
// HTTP services into one process with the route table compiled in, which is what replaced
// PPN's hand-written gateway. Probing here rather than per service is still the point — the
// route ownership is the thing most likely to break a real client, and now it is also the
// thing that changed.
const BACKEND_PORT = 8092;
const BASE = `http://127.0.0.1:${BACKEND_PORT}`;

// The services block on the People Chain connect and do not bind their HTTP
// port until it succeeds, so "connection refused" is the normal state while the
// parachain comes up rather than a failure.
const READY_TIMEOUT_MS = 300_000;
const POLL_INTERVAL_MS = 3_000;

interface Probe {
  name: string;
  path: string;
  expectStatus: number;
  /** Defaults to GET. The write surfaces are POST-only and answer GET with a method 404. */
  method?: "GET" | "POST";
  /** Optional assertion on the parsed JSON body. Return an error string to fail. */
  check?: (body: any) => string | null;
}

async function fetchJson(path: string, method: "GET" | "POST" = "GET"): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    ...(method === "POST"
      ? { headers: { "content-type": "application/json" }, body: "{}" }
      : {}),
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

export async function run(
  nodeName: string,
  _networkInfo: NetworkInfo,
  _args: string[]
): Promise<number> {
  try {
    console.log(`[TEST] DUB (all-in-one) at ${BASE} (from ${nodeName})`);

    const ready = await waitForDubReady({
      timeoutMs: READY_TIMEOUT_MS,
      pollMs: POLL_INTERVAL_MS,
      log: console.log,
    });
    if (!ready) return FAILURE;

    // Alice is the attester locally, and the account PPN grants attestation
    // allowance to. A mismatch means the wiring points at a different key than
    // the one the allowance was granted to, which fails silently at runtime.
    const aliceHex = ALICE_PUBLIC_KEY;

    const probes: Probe[] = [
      {
        name: "liveness",
        path: "/livez",
        expectStatus: 200,
      },
      {
        // Routed to device-attestation-api. Confirms the attester the API advertises is
        // the account the allowance script granted to.
        name: "attester matches Alice",
        path: "/api/v1/attester",
        expectStatus: 200,
        check: (b) =>
          typeof b?.attester === "string" &&
          b.attester.toLowerCase() === aliceHex.toLowerCase()
            ? null
            : `expected attester ${aliceHex}, got ${b?.attester}`,
      },
      {
        name: "JWKS has a signing key",
        path: "/.well-known/jwks.json",
        expectStatus: 200,
        check: (b) =>
          Array.isArray(b?.keys) && b.keys.length > 0
            ? null
            : `expected at least one JWK, got ${JSON.stringify(b)}`,
      },
      {
        // Owned by username-indexer, while device-attestation-api owns the rest of
        // /api/v1/usernames — the one prefix the merge splits by method and path. A 200
        // here is proof that split survived, the most likely thing to regress when
        // upstream changes route ownership.
        name: "username search reaches the indexer",
        path: "/api/v1/usernames/search?prefix=alice",
        expectStatus: 200,
        check: (b) =>
          Array.isArray(b?.usernames)
            ? null
            : `expected a usernames array, got ${JSON.stringify(b)}`,
      },
      // The surfaces PPN could not offer before all-in-one: turn credentials, invite claims
      // and push relay. Each is a write endpoint behind a Bearer token, so unauthenticated
      // gets 401 — and 401 rather than 404 is exactly the assertion worth making: it separates
      // "the role is mounted and enforcing auth" from "this path is not served at all", which
      // is what a dropped role looks like.
      //
      // dim-tickets was a fourth until v0.3.0 deleted the service and its /api/v1/dim-ticket
      // route; the shipping clients claim Game and ProofOfInk credentials through
      // invite-tickets instead, which is the row below.
      ...[
        { name: "turn-api", path: "/api/v1/turn/issue" },
        { name: "invite-tickets-api", path: "/api/v1/invitation-ticket/claim" },
        { name: "notify-relay", path: "/api/v1/notify" },
      ].map<Probe>(({ name, path }) => ({
        name: `${name} is mounted and requires a token`,
        path,
        method: "POST",
        expectStatus: 401,
      })),
      {
        // notify-relay speaks a different 404 dialect from its siblings: it registers no
        // fallback, so an unmatched path under its prefix answers axum's empty 404 while
        // everything else answers with the frozen body. That is the live contract for the
        // prefix, and a global fallback added upstream would silently replace it — visible
        // here as a body appearing where there was none.
        name: "the notify prefix keeps its own 404",
        path: "/api/v1/notify/no-such-thing",
        expectStatus: 404,
        check: (b) => (b === "" ? null : `expected an empty 404 body, got ${JSON.stringify(b)}`),
      },
    ];

    let failures = 0;
    for (const probe of probes) {
      const { status, body } = await fetchJson(probe.path, probe.method ?? "GET");
      if (status !== probe.expectStatus) {
        console.error(
          `[TEST] FAIL ${probe.name}: ${probe.path} → ${status}, expected ${probe.expectStatus}`
        );
        failures++;
        continue;
      }
      const problem = probe.check?.(body);
      if (problem) {
        console.error(`[TEST] FAIL ${probe.name}: ${problem}`);
        failures++;
        continue;
      }
      console.log(`[TEST] ok ${probe.name}`);
    }

    // /docs is a ServeDir over whatever GATEWAY_DOCS_ROOT points at, filled by `ppn fetch`
    // from the backend's own tree at the pinned tag. Reported but not fatal: it documents the
    // service, it is not part of the service working.
    const docs = await fetch(`${BASE}/docs`);
    if (docs.status === 200) {
      console.log("[TEST] ok API reference served at /docs");
    } else {
      console.log(
        `[TEST] note: /docs returned ${docs.status} — reference not fetched into bin/identity-docs`
      );
    }

    if (failures > 0) {
      console.error(`[TEST] ${failures} backend check(s) failed`);
      return FAILURE;
    }

    console.log("[TEST] All device-uniqueness-backend checks passed");
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
