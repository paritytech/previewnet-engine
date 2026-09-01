# PPN profiles

PPN's chain specs and operational scripts run under one of two profiles, selected by `PPN_PROFILE`:

| Profile | Default | Funded accounts | Sudo | Signing key for operational scripts |
|---|---|---|---|---|
| `local` | yes | `//Alice`..`//Ferdie` (+ stash variants) via runtime preset, plus the 7 EVM-mapped dev accounts on Asset Hub | `//Alice` | `//Alice` (built into `dot`) |
| `deployable` | no | only `PPN_SUDO_SS58` + `PPN_FAUCET_SS58`, plus `//Alice` on web3-storage | `PPN_SUDO_SS58` | `PPN_SUDO_URI` from secrets file |

`local` is the default and is bit-for-bit identical to pre-profile behavior: `make start` on a developer laptop or in `zombienet-tests.yml` CI keeps Alice as a fully-funded sudo. Switch to `deployable` only on long-lived networks where having `//Alice` as a powerful key with on-chain funds is unacceptable.

**Which profile a host runs is a property of that host**, not a per-run choice: it comes
from `PPN_PROFILE` in the environment (or `/etc/ppn/secrets.env`, below), so it cannot flip
with whoever triggered a deploy. How your deployment sets it is up to you — see
[DEPLOYING-YOUR-OWN.md](DEPLOYING-YOUR-OWN.md).

## How the switch is plumbed

The profile is sourced from a single file, `/etc/ppn/secrets.env`, on the host running PPN. Four independent consumers read it directly:

```
                  /etc/ppn/secrets.env
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

The reason every consumer reads the file directly is that `zombie-cli` does not forward env vars from its parent to `custom_process` children. So loading the file into `ppn.service`'s env via `EnvironmentFile=` covers `make generate` but does *not* reach the operational scripts that run during network boot — they have to read the file themselves.

If `/etc/ppn/secrets.env` is absent, every consumer falls back to `local` profile silently. This is the developer ergonomic.

## What deployable mode does NOT change

- The names of nodes (`alice-paseo-validator`, `bob-paseo-validator`, ...) are zombienet identifiers, unrelated to the sudo/dev account names. They keep their session keys and validate normally on the relay.
- Tests under `tests/` and `tests/scripts/` always run against `local` profile. There is no test-suite coverage of deployable behavior beyond the `patch-genesis-smoke` CI job, which runs `lib/genesis-patch.mjs` against small JSON fixtures rather than real chain specs, and checks that the attestation-allowance script refuses to fall back to Alice. The `integration-tests` job does generate the chain specs and boot a network, but always in local profile, since no runner has `/etc/ppn/secrets.env`.
- Spawner-launched VMs (`spawner/cloud-init.sh.template`) deliberately stay on `local` profile — they exist for `__TTL_MINUTES__` minutes at a time, and Alice-as-sudo on a sandbox you can throw away is fine. If a specific spawner use-case needs deployable mode, the cloud-init template can be extended to write `/etc/ppn/secrets.env` before the VM's first boot.

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
