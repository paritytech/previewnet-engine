# polkadot-test.substrate.dev

The one machine that runs the Polkadot fork, as a branch: `vm/polkadot-test` is main plus this
directory. Engine fixes land in main and get merged here; the machine picks them up with one
command. When preview-net-v1 grows a fork target this directory moves there and the branch dies.

```bash
deploy/polkadot-test/apply.sh                # pull, build, fetch, ports.env, nginx, unit, restart
deploy/polkadot-test/apply.sh --no-restart   # everything except touching the running network
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

Not done by apply, ever: the bite. That is a deliberate `make bite NETWORK=polkadot
UPGRADES="..."` (see `docs/POLKADOT-FORK.md`), followed by `apply.sh` or `systemctl start
ppn-polkadot`. And the certificate, once: `sudo certbot certonly --standalone -d <domain>`
while nginx is stopped; apply skips nginx until it exists and prints the command.
