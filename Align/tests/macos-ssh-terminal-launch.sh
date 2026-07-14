#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
L="$ROOT/packaging/templates/brainana-align-launcher.in"
grep -q 'run-ssh-auth.command' "$L"
grep -q '/usr/bin/open -a Terminal "$helper"' "$L"
grep -q 'SSH authentication helper acknowledged startup' "$L"
grep -q 'STARTED_FILE=%q' "$L"
grep -q 'printf "started' "$L"
! grep -q '/usr/bin/osascript - "$helper"' "$L"
grep -q 'if \[\[ "$rc" == "0" \]\]' "$L"
echo 'macOS SSH Terminal launch checks passed'

# Regression: generating the helper under `set -u` must not expand the helper's
# future rc variable in the parent launcher. This exact bug aborted the launcher
# before Terminal could open.
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT
helper="$tmpdir/run-ssh-auth.command"
status_file="$tmpdir/status"
pid_file="$tmpdir/helper.pid"
started_file="$tmpdir/started"
socket="$tmpdir/socket"
target='user@example.invalid'
(
  set -u
  {
    printf '#!/bin/bash\n'
    printf 'set +e\n'
    printf 'STATUS_FILE=%q\n' "$status_file"
    printf 'PID_FILE=%q\n' "$pid_file"
    printf 'STARTED_FILE=%q\n' "$started_file"
    printf 'write_status() { local rc="$1"; local tmp="${STATUS_FILE}.tmp.$$"; [[ -e "$STATUS_FILE" ]] || { printf "%%s\\n" "$rc" > "$tmp" && /bin/mv -f "$tmp" "$STATUS_FILE"; }; }\n'
    printf 'cancelled() { write_status 130; exit 130; }\n'
    printf 'trap cancelled HUP INT TERM\n'
    printf '%s\n' "trap 'rc=\$?; write_status \"\$rc\"' EXIT"
    printf 'printf "%%s\\n" "$$" > "$PID_FILE"\n'
    printf 'printf "started\\n" > "$STARTED_FILE"\n'
    printf '/usr/bin/ssh -M -S %q -o ControlPersist=600 -o ExitOnForwardFailure=yes -NT %q\n' "$socket" "$target"
    printf 'rc=$?\nwrite_status "$rc"\nexit "$rc"\n'
  } > "$helper"
)
/bin/bash -n "$helper"
grep -Fq 'trap '\''rc=$?; write_status "$rc"'\'' EXIT' "$helper"

echo 'macOS SSH helper generation under nounset passed'
