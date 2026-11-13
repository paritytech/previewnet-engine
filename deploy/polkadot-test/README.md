# polkadot-test.substrate.dev

The one machine that runs the Polkadot fork, from its own branch: main plus this directory and the
fork's engine changes, rebased onto main. The machine picks them up with one command. When
preview-net-v1 grows a fork target this directory moves there and the branch dies.

```bash
deploy/polkadot-test/apply.sh                # pull, build, fetch, ports.env, nginx, unit, restart
deploy/polkadot-test/apply.sh --no-restart   # everything except touching the running network
```

The fetch rewrites `polkadot-parachain` in place, so it puts the stock build back, and it fails
(ETXTBSY) while the collators are running the patched one. The collators need the build with the
fork-id fix (`docs/FORK.md`), so stop the network around an apply:

```bash
sudo systemctl stop ppn-polkadot
deploy/polkadot-test/apply.sh --no-restart
# reinstall the build with the fork-id fix
sudo systemctl start ppn-polkadot
```

What is where:

| File | Role |
| --- | --- |
| `vm.env` | Domain, public IP, run user, start flags. Committed. |
| `local.env` | The dashboard actions token. Gitignored; created on first apply. |
| `apply.sh` | The command. Idempotent; installs missing packages on a fresh box. |
| `start.sh` | What the unit runs: `ppn start polkadot --fork $START_FLAGS`. |
| `ppn-polkadot.service` | systemd unit template; `__ROOT__`/`__USER__` filled by apply. |
| `nginx/` | v1's template and websocket snippet, ours to patch here. |
| `/etc/ppn/secrets.env` | Created by apply on a fresh box with `TURN_SECRET`, `JWT_ED25519_SECRET` and `PPN_PROFILE=local`, and never rotated. Optional keys from `config/secrets.env.example`, such as push notifications, are added by hand. `ports.env` names it as `PPN_SECRETS_FILE`. |

Not done by apply, ever: the bite. That is a deliberate `make bite NETWORK=polkadot` (plus
`UPGRADES=...` for a runtime under test; see `docs/POLKADOT-FORK.md`), followed by `apply.sh` or
`systemctl start ppn-polkadot`.

And the certificate, once: `sudo certbot certonly --standalone -d <domain>` while nginx is
stopped; apply skips nginx until it exists and prints the command.
