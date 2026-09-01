# Deploying your own preview network

This repo is the **engine**: the CLI, the network descriptors, the launchers zombienet execs,
and the release artifacts a deployment installs. It deliberately contains no deployment tooling
— no server scripts, no nginx templates, no systemd units, no deploy workflow. Parity's own
preview network is deployed from a separate private repo that consumes this one.

So there is no "fork this repo and press deploy" path. What this repo gives you instead is a
small, stable contract to build a deployment against.

## What you install

Either channel works; they resolve to the same code.

| Channel | Get it with | Best for |
| --- | --- | --- |
| npm | `npm i -g @parity/ppn` | laptops, CI, containers |
| dist tarball | `ppn-dist-<version>.tar.gz` from a [release](../../releases) | servers pinning an exact build |

The tarball unpacks to a self-contained tree — `bin/ppn.mjs`, the compiled packages,
`scripts/`, `config/`, `networks/`, `zombienet-configs/` — plus a lockfile, so
`pnpm install --prod --frozen-lockfile` inside it is reproducible. Nothing in it assumes a
git checkout.

## The contract your deployment targets

Four things, and they are the whole interface:

**1. `PPN_HOME`** — the writable workspace: fetched binaries under `bin/`, chain data,
fork bundles, generated specs. The engine never writes inside its own install. Point it at
persistent storage and the same install serves every network.

**2. Environment variables** — the engine reads its configuration from the environment, because
zombienet forwards nothing to custom processes. The authoritative list of keys a spawn needs is
exported by the package itself:

```js
import { spawnEnvKeys, localEnvKeys, childEnvKeys } from '@parity/ppn/spawn-env';
```

`spawnEnvKeys()` is the union; `localEnvKeys()` are the ones a machine states about itself
(domain, public URL, data dirs) and `childEnvKeys()` the ones the launchers receive.

A deployment that sets those keys and nothing else is complete. Diff your own scripts against
that export in CI and a renamed key fails your build instead of your next deploy.

**3. `config/ports.env`** — every port and data-directory the launchers use. Override values
through the environment rather than editing the shipped file, so an engine upgrade cannot
silently revert your changes.

**4. The verbs** — `ppn fetch` (download the pinned artifacts), `ppn generate` (write chain
specs), `ppn start`, `ppn nginx-conf` (emit chain routes into your own reverse-proxy template),
`ppn stamp-spawn`. A deployment is a script that calls these in order and manages processes;
`ppn nginx-conf` in particular exists so you can keep your own template and let the engine fill
in the routes.

## Your own network

Copy a descriptor in `networks/` and edit it — see [networks/README.md](../networks/README.md)
for the schema. `make show-network NETWORK=<name>` prints what a descriptor resolves to before
you spawn anything. Descriptors are workspace data: they ship in the npm package as examples,
and yours can live in your `PPN_HOME` instead.

If you point a fork-mode network at your own chain, `bite.source` is the only field that has to
change; `FRESH_BITE=1` bites it directly rather than downloading a published bundle.

## Profiles

Run `PPN_PROFILE=deployable` on anything long-lived: it strips the well-known dev keys and
requires you to supply sudo and faucet accounts. `local` (the default) keeps `//Alice` as a
funded sudo and is right for laptops and CI only. See [PROFILES.md](PROFILES.md).

## What you still have to build

Honestly: the boring parts. Process supervision, TLS, a reverse proxy, log shipping, backups,
and secret delivery are all outside this repo. The engine's job ends at "a network is running
and these are its ports".
