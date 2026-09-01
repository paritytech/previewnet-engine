# Architecture

## The rule

**A workflow is a program, not a shell script that asks a program questions.**

Bringing up a network involves four workflows: fetch the artifacts, build the genesis
chain specs, capture a live network into a bundle, spawn. Each one loads the network
descriptor, decides things, and drives external tools. They live in
`packages/cli/src/commands/`, in one language, with tests.

Shell survives in one place, for a real reason: **zombienet's `custom_processes` contract**
spawns a command path, so each service needs a file on disk. Those files are one-line
launchers. Everything else that used to be shell is a `ppn` subcommand.

(Deployment is also shell work — systemd, nginx, a box where Node is not yet guaranteed — but
that lives in whatever repo owns the deployment, not here.)

## Why it was worth changing

The shape before this was inside-out. `fetch.sh` (470 lines) was a package manager,
`generate.sh` (170) a build pipeline, `bite.sh` (200) a parallel process orchestrator —
all in bash, all untested, each asking a JavaScript library for values through a text
protocol. Knowledge sat on one side of that boundary and decisions on the other, so any
rule needing both got split. The clearest example: "refuse to bite a network whose
sources nobody has confirmed" was implemented in `bite.sh`, which called
`ppn network todos` to get the facts. The rule and the data were a process boundary
apart, and neither file could be understood alone.

### Two kinds of `ppn` command

Some commands **do a job** — `ppn generate` builds the chain specs. Others only **look
something up and print it** — `ppn binaries` prints a list of files to download.

The look-up commands exist because a shell script is still doing the work and needs the
value handed to it:

```bash
# scripts/fetch.sh, before it moved
while read -r name repo tag archive; do
    curl ... "$name"
done < <(ppn binaries)          # asks the program for the list
```

When downloading moves into the program, that becomes a loop over `networkBinaries(net)`
in-process — no list printed, no shell in the middle — and nothing calls `ppn binaries`
any more, so it is deleted.

So the look-up commands are temporary plumbing, not API. They are registered hidden in
`packages/cli/src/cli.ts` for that reason, and **the count is the scoreboard**:

| after | remaining | deleted by that step |
| --- | --- | --- |
| start | 10 | — |
| `ppn generate` | 9 | `genesis-env` |
| `ppn fetch` | 6 | `binaries`, `runtimes`, `service-declared`, `network genesis` |
| `ppn bite` | 3 | `chains`, `spec-sources`, `doppelganger` |
| `ppn service assign-cores` | 2 | `para-id` |
| the remaining services | **0** | `network <field>`, `genesis-specs` |

**None left.** Every `ppn` command is now a verb. If a look-up command reappears, a
decision has leaked back into the shell.

## Layout

```
networks/<name>.json          what a network is made of — the one source (networks/README.md)
bin/ppn.mjs                   launcher; finds the build and hands off. The only entry point.

packages/network-config/      @parity/ppn-network-config — the shared layer. No network I/O.
  src/networks.ts             loads and validates a descriptor; its types live with it
  src/bundle.ts               the fork-bundle format
  src/toml-generator.ts       the zombienet config for a genesis network
  src/fork-toml.ts            the same for a fork
  src/genesis-patch.ts        reading, patching and writing a chain spec
  src/index.ts                the public surface — the only path consumers may import

packages/cli/                 @parity/ppn — every workflow, plus the `ppn` entry point
  src/cli.ts                  the command table
  src/commands/               one module per workflow
  src/fork/                   bite logic: RPC, SCALE codec, overrides, verify
  src/upgrade/                runtime upgrade of a running chain

scripts/                      launchers zombienet must exec, and nothing else
```

Three packages, not eight. The test applied to every proposed split was *would these ever
be released separately, or owned by different people?* By that test the descriptor and the
generators stay together — they change in lockstep. The library is published on its own
because a consumer can legitimately want the generators without the tool.

The dependency rule is enforced, not documented: `.dependency-cruiser.json` fails the build
on a `network-config → cli` import, on any cross-package import that reaches past
`index.ts`, and on any cycle. `pnpm lint:boundaries` runs it.

One language, one build, one test suite. An earlier attempt kept the descriptor loader as
plain JavaScript so it would run with no build step — but making TypeScript able to import
it needed a hand-written declaration file, which is the same "two places over one thing"
problem in a different outfit. The types now live next to the code that enforces them, and
`make fetch` builds first. That costs ten seconds on a fresh checkout, in the one place
where you are already installing things.

## Finding the repo root

Use `repoRoot()` from `@parity/ppn-network-config`. Never count `..` from `import.meta.dirname`.

The count is wrong twice over: it differs between running from `src/` under `tsx` and from
`dist/` after a build, and it differs again between packages nested at different depths. The
split into packages moved every file, and two of the six places that counted were left one
level short. One pointed zombienet at `packages/bin/polkadot`, so no fork could spawn. The
other made `ppn generate` default its output to `packages/bin/` — invisible locally, because
`make generate` passes the directory explicitly, and reachable only through a deployment
calling `ppn generate` directly. It would have failed first on a server.

`repoRoot()` walks up looking for `networks/` and `config/ports.env` together, and throws
rather than guessing. Both markers ship in the dist tarball, so a deployed release resolves
the same way a checkout does.

## Shipping it

`@parity/ppn` is the CLI, `@parity/ppn-network-config` the library behind it. Published through
`paritytech/npm_publish_automation` — this repo builds, proves the tarballs, packs and dispatches;
the npm token never lives here. Triggered by a `npm-v*` tag, not by the nightly network release,
whose timestamped tags are not semver.

```bash
npx @parity/ppn start                # one-off
pnpm add -D @parity/ppn              # pinned, in a consumer repo
```

Two rules make that possible, and both are enforced by tests that pack the tarballs and read
what came out:

- **Importing the library does no work.** It used to load previewnet's descriptor and
  `config/ports.env` at module scope, so `import '@parity/ppn-network-config'` threw during
  module evaluation unless a workspace happened to be present. A consumer that wants the types,
  or the chain→binary mapping, must be able to import it anywhere.
- **The library carries no descriptors.** `@parity/ppn-network-config` is a config reader,
  and a consumer of it brings its own network files. The CLI is the opposite case: an engine
  with no descriptor cannot run anything, so `networks/` deliberately ships in the
  `@parity/ppn` tarball — the hosts it names are preview networks, not secrets. The guard
  greps the packed files rather than trusting the `files` field.

The launchers and `config/` live at the repo root, where every workflow reads them, and npm's
`files` is package-relative — so `prepack` stages them in and `postpack` removes them. If that
ever silently stops working the package still publishes, just uselessly, which is why the test
asserts specific launchers are present rather than counting files.

The old front door, `curl … install.sh | bash` in `paritytech/ppn-proxy`, clones this repo and
hands over a Makefile. Nothing wrong with `curl | bash` — rustup does it — but you cannot pin
that, import it, or upgrade it separately from your chain data. It reduces to a wrapper around
`npx` once the packages are published.

## Command surface

Verbs, not getters:

| Command | Replaces |
| --- | --- |
| `ppn show [network]` | `scripts/show-network.js` |
| `ppn generate [binDir]` | `scripts/generate.sh`, `scripts/patch-genesis.js` |
| `ppn genesis-toml` | `scripts/generate-toml.js` |
| `ppn fork <command>` | `scripts/fork/cli.js` |
| `ppn fetch [binDir]` | `scripts/fetch.sh` |
| `ppn bite [outDir]` | `scripts/fork/bite.sh` |
| `ppn fork fetch-bundle` | `scripts/fork/fetch-bundle.sh` |
| `ppn fork fetch-doppelganger` | `scripts/fork/fetch-doppelganger.sh` |
| `ppn upgrade <chain> <wasm>` | `scripts/runtime-upgrade.js` |
| `ppn service <name>` | the `custom_process` wrappers' bodies |

`make` stays as the memorable front door (`make start`, `make bite`), one line per target.

Arguments are parsed by commander: real `--help` per command, validated choices, and
options that fall back to an environment variable so `make` keeps working
(`--profile`/`PPN_PROFILE`, `--parachains`/`PPN_PARACHAINS`, `--no-enable-hop`/`ENABLE_HOP`).
`PPN_NETWORK` stays environment-only — shell scripts read it, and zombienet's
`custom_processes` cannot be passed flags at all.

## Migration status

| Step | State |
| --- | --- |
| One entry point, one language, one build — descriptor and its types in TypeScript | done |
| `show-network.js`, `generate-toml.js`, `fork/cli.js`, `patch-genesis.js` folded in | done |
| `ppn generate` — genesis chain specs (replaced `scripts/generate.sh`) | done |
| Arguments parsed by commander; env-var switches became flags | done |
| `ppn fetch` — artifact download (replaced `scripts/fetch.sh`, 470 lines) | done |
| `ppn bite` — capture a live network (replaced `scripts/fork/bite.sh`) | done |
| `ppn service <name>` — all eight custom-process bodies | done |
| `ppn upgrade`, `ppn zombie-compat` — the last two script shims | done |
| `ppn dist` + artifact-based deployment (no more `git reset --hard origin/main`) | done |
| Delete the accessors | done — none left |

### The shell that still holds a workflow

Each of these decided something, so each became a `ppn service`. The file that stays behind
is a one-line launcher, because zombienet spawns a command path.

All seven have moved. What is left under `scripts/` is launchers — four lines each, of the
shape zombienet's `custom_processes` contract requires:

```bash
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/bin/ppn.mjs" service patch-bootnodes
```

`eth-rpc.sh`, `ipfs-daemon.sh`, `ipfs-swarm.sh`, `omni-node.sh` and `identity/*.sh` are
genuinely just launching a binary with arguments, and stay shell.

One thing improved on the way through: `force-open-hrmp` used to parse the *generated*
zombienet TOML to rediscover which channels to open. The topology now has one home,
`hrmpChannels()` in `@parity/ppn-network-config`, which both the genesis config and the service
read.

Order: `generate` went first because it is smallest and its output is verifiable
command-for-command. `fetch` next, being pure I/O. `bite` last — its parallel process
supervision is where the existing bash is genuinely load-bearing, and a mistake there
produces a network that comes up subtly wrong rather than an error.

## Deployment

The server installs a **pinned build**, not a branch. `release.yml` packages one with
`ppn dist` — the compiled packages, the launchers, and the configuration, with a manifest
recording the version and commit — and attaches it to the release. A deploy unpacks it to
`/opt/ppn/releases/<tag>`, installs production dependencies from the committed lockfile,
and repoints `/opt/ppn/current` at it. Every systemd unit path goes through `current`, so
**a rollback is repointing that symlink** rather than reverting commits and redeploying.

Before this, the server ran `git reset --hard origin/main` for its *code* while taking its
*artifacts* from a pinned release tag — so a deploy could pair one version's code with
another's binaries, and nothing recorded the combination.

Each release fetches its own artifacts into its own `bin/`. Sharing one across releases
would be faster, but a release that bumps a binary pin could then keep running the previous
one, which is the class of bug this whole layout exists to prevent.

## Verifying a step

Each workflow that moves must produce the same result as the script it replaces:

- **generate** — run against a stub `chain-spec-builder` that records its arguments; the
  recorded invocations must match the bash version's, argument for argument.
- **config** — `zombienet-configs/local-dev.toml` must regenerate byte-identical.
- **fetch** — the set of files landing in `bin/`, and which release each came from, must
  match.
- **bite** — a bundle must spawn and pass `ppn fork verify`.
