// Device uniqueness backend wiring for the generated zombienet config.
//
// device-uniqueness-backend v0.2.0 replaced its ten binaries with one, selected by `--role`,
// and namespaced the per-service config keys. PPN runs the topology that release added for
// exactly this case: `--role all-in-one`, which serves every HTTP surface on one port with the
// route table compiled in, plus the single-instance workers, which are never merged because
// each owns a Postgres lease and a nonce lane. Upstream calls that pairing the small topology
// and is explicit that it is all-in-one PLUS the workers, never all-in-one alone.
//
// v0.3.0 renamed the binary to `dub` and the identity service to device-attestation — role
// names, `DEVICE_ATTESTATION_DATABASE_URL`, the lot — and deleted dim-tickets outright. Its
// role gate refuses a role it does not know, so a stale name here is a boot failure rather
// than a service quietly missing; and the pre-namespacing config keys it used to accept with a
// WARN now fail at boot too.
//
// That deleted a liability: PPN used to reconstruct the edge's route table by hand in
// scripts/dub/routes.mjs, mirroring upstream's Caddyfile, and ran two of six services so
// the rest of the API simply did not exist locally. all-in-one carries the real table and the
// whole surface, including /docs and an aggregate /readyz.
//
// See docs/DEVICE-UNIQUENESS-BACKEND.md. Everything non-secret is emitted into the TOML
// as custom_process `env`, so the values a service runs with are visible in a
// diff of zombienet-configs/local-dev.toml rather than buried in a shell
// default. Secrets deliberately do NOT appear here — scripts/dub/service.sh
// reads those from the secrets file at exec time, matching the boundary the
// deployable profile already draws: public identifiers at generate time,
// private keys at runtime only.

/** Well-known dev account. Also what PPN grants attestation allowance to. */
export const ALICE_SS58 = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';

/**
 * The inviter, and deliberately not the attester.
 *
 * Upstream's rule is "one inviter key = one nonce lane; never scale it". Running the ticket
 * writers on the same account as the chain writer breaks that rule across services
 * instead of across replicas, and the result is not subtle: invite-tickets-pool submits a
 * batch every ~30s for ever, so the writer's registration never wins a nonce. It retries
 * through `Transaction is outdated`, `priority too low` and `rendered invalid by another
 * extrinsic`, then gives up — and a username that was accepted with a 202 never lands.
 *
 * Bob gets its own lane. Kept equal to INVITER_ADDRESS so batches are signed directly rather
 * than wrapped in Proxy.proxy, which would need a proxy registration on People Chain.
 */
export const BOB_SS58 = '5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty';

export interface DubPorts {
  postgres: number;
  people: number;
  /** Asset Hub, for the DotNS gateway surface. */
  assetHub: number;
  /**
   * The one port the API is served on. Named `gateway` because that is the origin clients
   * already use (8092) — all-in-one replaced the gateway process without moving the address.
   */
  gateway: number;
}

export interface DubService {
  /** Process name in the zombienet config, and the log directory it gets. */
  name: string;
  /** The `--role` this process runs; one binary, eight roles plus all-in-one. */
  role: string;
  /** Non-secret environment, emitted into the TOML. */
  env: Record<string, string>;
}

/**
 * The databases the cluster must hold, one per service that owns state.
 *
 * v0.2.0 split a bare `DATABASE_URL` — read by eight call sites naming four different
 * Postgres instances — into namespaced keys, so a misrouted value can no longer silently hit
 * another service's data. v0.3.0 removed the fourth of them with the dim-tickets service.
 *
 * `identity` keeps its physical name while the config key that carries it becomes
 * `DEVICE_ATTESTATION_DATABASE_URL`. Nothing upstream requires the database be *named*
 * device_attestation — the URL is ours to build, and upstream's own runbook offers keeping the
 * old names as the no-downtime path — whereas renaming it would hand every existing cluster a
 * choice between an authentication failure and losing the rows already in it.
 */
export const DUB_DATABASES = ['identity', 'username_indexer', 'invite_tickets'] as const;

/**
 * Postgres connection string for one service's database.
 *
 * One cluster, a database per service. Upstream's compose file runs a separate
 * cluster each so they can deploy independently, which buys nothing locally.
 */
export function dubDatabaseUrl(database: string, postgresPort: number): string {
  return `postgres://identity@127.0.0.1:${postgresPort}/${database}`;
}

/**
 * The People Chain endpoint every backend service must be given.
 *
 * Never omit this. device-attestation-api and its chain writer do not fail when
 * PEOPLE_RPC_URL is unset — they silently default to the *public* Paseo endpoint
 * (identity-service/src/config.rs:215, chain/writer.rs:91), which would point a
 * signing writer at a network nobody intended. Only username-indexer treats it
 * as required.
 */
export function peopleRpcUrl(peoplePort: number): string {
  const url = `ws://127.0.0.1:${peoplePort}`;
  if (!url.startsWith('ws://127.0.0.1:')) {
    throw new Error(`dub: refusing non-loopback PEOPLE_RPC_URL: ${url}`);
  }
  return url;
}

/**
 * The four processes PPN runs, with their non-secret environment.
 *
 * Required-variable sets were derived by booting the real binary with an empty environment and
 * adding what it demanded, rather than read off the source — the crates phrase their errors
 * differently and `JWT_ED25519_SECRET` is required without being reported as missing.
 *
 * `attesterAccount` is an SS58 — public, the same class of value the deployable profile bakes
 * into genesis — so it belongs in the TOML. It stays equal to the writer's signing key on
 * purpose: the writer derives proxying from whether the two differ, and equal means it attests
 * directly, so People Chain needs no proxy registration.
 */
export function dubServices(
  ports: DubPorts,
  attesterAccount: string = ALICE_SS58,
  inviterAccount: string = BOB_SS58
): DubService[] {
  const rpc = peopleRpcUrl(ports.people);
  const db = (name: (typeof DUB_DATABASES)[number]) => dubDatabaseUrl(name, ports.postgres);

  // Every role reads its own database key, and all-in-one reads all of them, so the whole set
  // is given to every process. Cheaper than three near-identical env blocks, and it means
  // adding a role later needs no thought about which key it happens to want.
  //
  // `DEVICE_ATTESTATION_DATABASE_URL` was `IDENTITY_DATABASE_URL` until v0.3.0, which dropped
  // the old name — along with the bare `DATABASE_URL` before it — from a deprecation WARN to a
  // boot failure that names the key it wanted.
  const databases = {
    DEVICE_ATTESTATION_DATABASE_URL: db('identity'),
    INDEXER_DATABASE_URL: db('username_indexer'),
    INVITE_TICKETS_DATABASE_URL: db('invite_tickets'),
  };

  // The Prometheus exporter binds before config validation, so leaving it on means five
  // processes fight for 9090 and a role crash-looping on bad config still holds it. Nothing
  // scrapes them locally.
  const common = {
    ...databases,
    METRICS_ENABLED: 'false',
    RUST_LOG: 'info',
    PEOPLE_RPC_URL: rpc,
    // westend2 | paseo | polkadot. PPN's relay is paseo, and the value is required rather
    // than defaulted — a wrong one would have the ticket services address another network.
    PEOPLE_NETWORK: 'paseo',
    ATTESTER_ACCOUNT: attesterAccount,
    // Public counterpart of INVITER_SIGNER_SURI, which service.sh supplies. Equal to that
    // signing key's own account on purpose: the ticket services wrap a batch in
    // Proxy.proxy(real = INVITER_ADDRESS) only when the two differ. See BOB_SS58 for why it
    // is not the attester.
    INVITER_ADDRESS: inviterAccount,
  };

  return [
    {
      // All five HTTP surfaces on one port: device-attestation-api, username-indexer,
      // invite-tickets-api, turn-api and notify-relay, plus /docs and an aggregate /readyz.
      // (Six until v0.3.0 deleted dim-tickets-api.) Upstream calls this "not a deployable
      // workload" because it holds every secret in one address space — which is exactly right
      // for a local development network and is the case the release added it for.
      name: 'dub-api',
      role: 'all-in-one',
      env: {
        ...common,
        BIND_ADDR: `127.0.0.1:${ports.gateway}`,
        ASSET_HUB_RPC_URL: `ws://127.0.0.1:${ports.assetHub}`,
        // turn-api requires a realm and has no default. Public, so it belongs here; the
        // signing secret it pairs with comes from service.sh.
        TURN_REALM: 'previewnet.local',
      },
    },
    {
      name: 'device-attestation-chain-writer',
      role: 'device-attestation-chain-writer',
      env: { ...common },
    },
    {
      // Idles unless QUEUE_ENABLED=true. Run anyway so the local topology matches production
      // and the flag is simply flippable.
      name: 'registration-queue',
      role: 'registration-queue',
      env: { ...common },
    },
    { name: 'invite-tickets-pool', role: 'invite-tickets-pool', env: { ...common } },
  ];
}

function tomlEnv(env: Record<string, string>): string {
  const entries = Object.entries(env).map(
    ([name, value]) => `  { name = "${name}", value = "${value}" },`
  );
  return `env = [\n${entries.join('\n')}\n]`;
}

/**
 * The `[[custom_processes]]` blocks for Postgres and the backend services.
 *
 * Every service goes through service.sh rather than naming its binary directly.
 * They do not crash: each one connects to Postgres and applies its migrations
 * before anything else, and exits non-zero when that connection is not available
 * ("pool timed out while waiting for an open connection"). Since
 * custom_processes have no ordering, a service can reach that point before
 * dub-postgres is accepting connections, so something has to wait for the
 * database and start it again afterwards.
 *
 * zombienet has no restart policy to lean on here — the custom_process schema is
 * name/command/image/args/env — which is why ipfs-daemon.sh hand-rolls the same
 * loop. If zombienet grew one (a restart/backoff field, or a readiness gate
 * between processes), the loop in service.sh could go, leaving it to do only
 * what stays outside the config: read the deploy-time secrets.
 */
export function dubCustomProcesses(
  ports: DubPorts,
  attesterAccount?: string,
  // Genesis mode emits the {{SCRIPTS}} placeholder that zombie-compat expands;
  // fork mode writes a standalone TOML with absolute paths already resolved.
  scriptsDir: string = '{{SCRIPTS}}'
): string {
  const wait = `127.0.0.1:${ports.postgres}`;

  // zombienet validates custom_process args as CLI arguments — each must parse
  // as a flag or --key=value, so bare positionals are rejected outright.
  const blocks = dubServices(ports, attesterAccount).map(
    (svc) => `
[[custom_processes]]
name = "${svc.name}"
command = "${scriptsDir}/dub/service.sh"
args = ["--role=${svc.role}", "--wait-for=${wait}"]
${tomlEnv(svc.env)}
`
  );

  return `
[[custom_processes]]
name = "dub-postgres"
command = "${scriptsDir}/dub/postgres.sh"
${blocks.join('')}`;
}
