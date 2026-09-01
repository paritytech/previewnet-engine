// Waiting for the backend to be ready, shared by both device-uniqueness tests.
//
// One copy, on purpose. There used to be two, and when the backend's `/readyz` changed
// shape — v0.2.0 merged six services into one process and made the response one entry per
// service instead of a single flat `{chain, db}` — only one copy was updated. The other spent
// its entire 300s budget polling a backend that was already serving, then reported "never
// became ready", which is a lie that points away from the actual change.
//
// Deliberately no import from ./utils: that pulls the papi descriptors, which need codegen
// against the runtime WASM. Readiness is HTTP only, so this stays dependency-free and both
// tests can use it without the chain tooling being set up.

/** Every HTTP surface of the backend, on one origin (`dub --role all-in-one`). */
export const DUB_BASE = "http://127.0.0.1:8092";

/**
 * Why a response is not ready yet, or null when it is.
 *
 * The aggregate shape is `{ "<service>": { chain?: "up", db?: "up" }, …, status: "ready" }`,
 * so a service is only asked about the dependencies it actually has — `invite-tickets-api`
 * reports `db` and no `chain`, `turn-api` reports neither. Reading it generically rather than
 * against a fixed list of services means a service added upstream is covered the day it
 * appears, and a dead dependency names itself instead of showing up later as one endpoint
 * mysteriously failing.
 */
export function notReady(body: any): string | null {
  if (body?.status !== "ready") return `status is ${JSON.stringify(body?.status)}`;
  const down = Object.entries(body as Record<string, any>)
    .filter(([, v]) => v && typeof v === "object")
    .flatMap(([service, deps]) =>
      Object.entries(deps as Record<string, string>)
        .filter(([, state]) => state !== "up")
        .map(([dep, state]) => `${service}.${dep}=${state}`)
    );
  return down.length ? down.join(", ") : null;
}

/**
 * Poll `/readyz` until every merged service reports its dependencies up.
 *
 * "Connection refused" is the normal state while People Chain comes up: the services block on
 * the chain connect and do not bind the HTTP port until it succeeds, so an unreachable port is
 * progress, not a fault.
 */
export async function waitForDubReady(opts: {
  timeoutMs: number;
  pollMs: number;
  log?: (message: string) => void;
}): Promise<boolean> {
  const deadline = Date.now() + opts.timeoutMs;
  let last = "never reached";

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${DUB_BASE}/readyz`);
      const body = await res.json();
      if (res.status === 200) {
        const problem = notReady(body);
        if (!problem) {
          opts.log?.(`[TEST] backend ready: ${JSON.stringify(body)}`);
          return true;
        }
        last = `not ready: ${problem}`;
      } else {
        last = `status ${res.status}, body ${JSON.stringify(body)}`;
      }
    } catch (err) {
      last = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, opts.pollMs));
  }

  console.error(`[TEST] backend never became ready: ${last}`);
  return false;
}
