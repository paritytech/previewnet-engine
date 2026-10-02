#!/usr/bin/env bash
# Refuse to go on while anything listens on the given TCP port(s). Never kills it: the holder may
# be a previous run of this network, another checkout's network or a service that has nothing to
# do with PPN, and a signal cannot tell them apart. `ppn kill` stops a previous run of this
# workspace. Listeners only: a bare `lsof -i :port` also matches every client whose connection
# has that port at the other end.
# Usage: require-free-ports.sh 8080 5001 4001
set -uo pipefail

status=0
for port in "$@"; do
    [[ -n "$port" ]] || continue
    holders="" pid=""
    # lsof -F pc: a `p<pid>` line, then its `c<command>` line. The name shown is argv[0]'s basename
    # (`ps -o args=`): lsof's COMMAND is the kernel's name, on Linux the main thread's (`MainThread`
    # for Node). lsof's COMMAND only when `ps` gives nothing.
    while IFS= read -r line; do
        case "$line" in
            p*) pid=${line#p} ;;
            c*)
                name=$(ps -o args= -p "$pid" 2>/dev/null | awk 'NR == 1 { print $1 }')
                name=${name##*/}
                holders+="${holders:+, }${name:-${line#c}}($pid)"
                ;;
        esac
    done < <(lsof -nP -iTCP:"$port" -sTCP:LISTEN -F pc 2>/dev/null)
    if [[ -n "$holders" ]]; then
        echo "port $port is in use by $holders; nothing was stopped (\`ppn kill\` stops a previous run of this workspace)" >&2
        status=1
    fi
done
exit "$status"
