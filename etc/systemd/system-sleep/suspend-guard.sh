#!/bin/bash
# suspend-guard: closes GPU-holding apps before suspend so the NVIDIA
# driver's suspend routine doesn't hang.
#
# Install to:  /etc/systemd/system-sleep/suspend-guard.sh   (mode 755)
# Config at:   /etc/suspend-guard/apps.conf
#
# Edit the app list in apps.conf — one process name per line (as shown by
# `pgrep -l <name>` or `ps -C <name>`), '#' for comments.
#
# Test without actually suspending:
#   sudo /etc/systemd/system-sleep/suspend-guard.sh pre suspend
#
# Check what it did on a real run:
#   journalctl -t suspend-guard -e

CONFIG_FILE="/etc/suspend-guard/apps.conf"
GRACE_SECONDS=25   # max seconds to wait for graceful exit before force-killing
TAG="suspend-guard"

log() { logger -t "$TAG" -- "$1"; }

# systemd-sleep calls this script as: script <pre|post> <suspend|hibernate|...>
# We only act before sleep; do nothing on resume.
[ "$1" = "pre" ] || exit 0
[ -f "$CONFIG_FILE" ] || exit 0

mapfile -t APPS < <(grep -vE '^\s*(#|$)' "$CONFIG_FILE")
[ "${#APPS[@]}" -eq 0 ] && exit 0

# Collect a PID and all of its descendants. This matters because apps like
# VS Code spawn helper processes (extension host, language servers, GPU
# process) that don't share the parent's process name and would otherwise
# be missed, leaving something still holding a GPU handle.
collect_tree() {
  local pid=$1
  echo "$pid"
  local child
  for child in $(pgrep -P "$pid"); do
    collect_tree "$child"
  done
}

pids=()
for app in "${APPS[@]}"; do
  top_pids=$(pgrep -x "$app")
  for top in $top_pids; do
    while read -r p; do
      pids+=("$p")
    done < <(collect_tree "$top")
  done
done

[ "${#pids[@]}" -eq 0 ] && exit 0
log "closing before suspend: ${APPS[*]} (${#pids[@]} processes)"

# Ask nicely first.
kill -TERM "${pids[@]}" 2>/dev/null

# Wait for them to actually exit — don't just fire-and-forget, since the
# whole point is to guarantee nothing is still holding the GPU when
# suspend actually happens.
elapsed=0
while [ "$elapsed" -lt "$GRACE_SECONDS" ]; do
  alive=0
  for p in "${pids[@]}"; do
    kill -0 "$p" 2>/dev/null && alive=1
  done
  [ "$alive" -eq 0 ] && break
  sleep 1
  elapsed=$((elapsed + 1))
done

# Anything still alive after the grace period gets force-killed so suspend
# isn't blocked indefinitely by one stuck process.
for p in "${pids[@]}"; do
  if kill -0 "$p" 2>/dev/null; then
    log "force-killing PID $p (didn't exit within ${GRACE_SECONDS}s)"
    kill -KILL "$p" 2>/dev/null
  fi
done

exit 0
