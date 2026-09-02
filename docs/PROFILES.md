# PPN profiles

PPN's chain specs and operational scripts run under one of two profiles, selected by `PPN_PROFILE`:

| Profile | Default | Funded accounts | Sudo | Signing key for operational scripts |
|---|---|---|---|---|
| `local` | yes | `//Alice`..`//Ferdie` (+ stash variants) via runtime preset, plus the 7 EVM-mapped dev accounts on Asset Hub | `//Alice` | `//Alice` (built into `dot`) |
| `deployable` | no | only `PPN_SUDO_SS58` + `PPN_FAUCET_SS58`, plus `//Alice` on web3-storage | `PPN_SUDO_SS58` | `PPN_SUDO_URI` from secrets file |

`local` is the default and is bit-for-bit identical to pre-profile behavior: `make start` on a developer laptop or in `zombienet-tests.yml` CI keeps Alice as a fully-funded sudo. Switch to `deployable` only on long-lived networks where having `//Alice` as a powerful key with on-chain funds is unacceptable.

**Which profile a host runs is a property of that host**, not a per-run choice: it comes
from `PPN_PROFILE` in the environment or from the secrets file below, so it cannot flip
with whoever triggered a deploy. How your deployment sets it is up to you — see
[DEPLOYING-YOUR-OWN.md](DEPLOYING-YOUR-OWN.md).

## How the switch is plumbed

The profile is sourced from one file, named by **`PPN_SECRETS_FILE`**. There is no default
path: a path baked in here would be a guess about your host, and a wrong guess looks exactly
like "no secrets", which is `local` and the dev keys. Unset it and you get `local`; point it
at a file that is not there and PPN refuses to start rather than quietly downgrading.

Four independent consumers read it directly:

```
                  $PPN_SECRETS_FILE
                  ├─ PPN_PROFILE=deployable
                  ├─ PPN_SUDO_SS58=5...
                  ├─ PPN_FAUCET_SS58=5...
                  ├─ PPN_ALLOWANCE_SS58=5...
                  └─ PPN_SUDO_URI=<mnemonic or 0x-hex seed>
                          │
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
 `ppn generate`      your process     scripts/{assign-cores,force-open-hrmp}.js
 (sources at top)    supervisor       (inline KEY=value loader)
                     (EnvironmentFile) scripts/{set-dispatcher-address,
                                        increase-people-lite-attestation-allowance}.sh
                                       (sources directly)
```

The reason every consumer reads the file directly is that `zombie-cli` does not forward env vars from its parent to `custom_process` children. So loading the file into the supervisor's environment covers `make generate` but does *not* reach the operational scripts that run during network boot — they have to read the file themselves.

With `PPN_SECRETS_FILE` unset, every consumer runs `local`. That is the developer ergonomic, and it is safe precisely because it is the *stated* absence of a deployment rather than a failed lookup. Anything that must not be guessed is gated on this instead of on a filesystem probe: the dashboard's sudo actions key off what the socket is bound to (see [DASHBOARD.md](DASHBOARD.md)), and the identity backend refuses to start on the public dev JWT seed once a secrets file is named.

## What deployable mode does NOT change

- The names of nodes (`alice-paseo-validator`, `bob-paseo-validator`, ...) are zombienet identifiers, unrelated to the sudo/dev account names. They keep their session keys and validate normally on the relay.
- Tests under `tests/` and `tests/scripts/` always run against `local` profile. There is no test-suite coverage of deployable behavior beyond the unit tests over the genesis patcher and the checks that the attestation-allowance script refuses to fall back to Alice. The `integration-tests` job does generate the chain specs and boot a network, but always in local profile, since no runner sets `PPN_SECRETS_FILE`.
- Short-lived sandbox VMs are reasonably left on `local`: Alice-as-sudo on something you throw away in an hour is fine. Anything long-lived, or reachable by someone else, is not.

## Reading the diff between profiles

After `make generate`, the easiest sanity check is to grep:

```bash
# In local profile, Alice (5Grw...) has a balance entry on every chain.
jq '.genesis.runtimeGenesis.patch.balances.balances[] | select(.[0] == "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY")' bin/asset_hub.json

# In deployable profile, the only entries should be PPN_SUDO_SS58 + PPN_FAUCET_SS58
# (plus whatever a future operator added to the runtime preset).
jq '.genesis.runtimeGenesis.patch.balances.balances' bin/asset_hub.json
jq '.genesis.runtimeGenesis.patch.sudo.key' bin/asset_hub.json
```
