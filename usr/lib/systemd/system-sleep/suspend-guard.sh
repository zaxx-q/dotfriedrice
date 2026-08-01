#!/bin/bash
# suspend-guard — closes GPU-holding apps before suspend so the NVIDIA
# driver's suspend routine doesn't hang.
#
# INSTALL PATH IS NOT OPTIONAL:
#   /usr/lib/systemd/system-sleep/suspend-guard.sh   (root:root, mode 755)
# This is the ONLY directory systemd-sleep scans. /etc/systemd/system-sleep/
# is not read.
#
# Config:  /etc/suspend-guard/apps.conf  (one process name per line, # comments)
#
# Test without an actual suspend:
#   sudo /usr/lib/systemd/system-sleep/suspend-guard.sh pre suspend
# Check what happened on a real cycle:
#   journalctl -t suspend-guard -e

CONFIG_FILE="/etc/suspend-guard/apps.conf"
GRACE_SECONDS=25   # max seconds to wait for graceful exit before force-killing
TAG="suspend-guard"

log() { logger -t "$TAG" -- "$1"; }

# systemd-sleep calls this as: script <pre|post> <suspend|hibernate|...>
[ "$1" = "pre" ] || exit 0
[ -f "$CONFIG_FILE" ] || exit 0

mapfile -t APPS < <(grep -vE '^\s*(#|$)' "$CONFIG_FILE")
[ "${#APPS[@]}" -eq 0 ] && exit 0

# Collect a PID and all its descendants (renderer/helper/language-server
# processes), used for the wait-and-verify / force-kill stages only.
collect_tree() {
  local pid=$1
  echo "$pid"
  local child
  for child in $(pgrep -P "$pid"); do
    collect_tree "$child"
  done
}

roots=()
all_pids=()
for app in "${APPS[@]}"; do
  matched=$(pgrep -x "$app")
  [ -z "$matched" ] && continue
  for pid in $matched; do
    ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    # A "root" is a matched process whose parent is NOT also a matched
    # process of the same name — i.e. the real top-level app, not one of
    # its own renderer/extension-host/GPU-helper children. We only want to
    # signal this one directly: killing a child out from under a still-
    # running parent is what caused VS Code's crash dialog instead of a
    # clean shutdown.
    is_child=0
    for other in $matched; do
      [ "$ppid" = "$other" ] && is_child=1 && break
    done
    [ "$is_child" -eq 0 ] && roots+=("$pid")
  done
done

[ "${#roots[@]}" -eq 0 ] && exit 0

for r in "${roots[@]}"; do
  while read -r p; do all_pids+=("$p"); done < <(collect_tree "$r")
done

log "closing before suspend: ${APPS[*]} (roots: ${roots[*]}, ${#all_pids[@]} total processes)"

# Ask nicely — signal only the root/main process of each app so it can
# shut its own children down in the correct order.
kill -TERM "${roots[@]}" 2>/dev/null

# Stage 1: wait for the actual app (the root process) to exit. This is
# where the app's own orderly shutdown happens — closing its own windows,
# saving hot-exit state, etc. We deliberately do NOT wait on the full
# descendant tree here: detached helper processes (e.g. Chromium/Electron's
# "dconf watch /system/proxy/" proxy-settings watcher) get orphaned rather
# than closed when the app quits, and will never exit on their own, so
# waiting on them here would just burn the whole grace period for nothing.
elapsed=0
while [ "$elapsed" -lt "$GRACE_SECONDS" ]; do
  alive=0
  still_here=""
  for r in "${roots[@]}"; do
    if kill -0 "$r" 2>/dev/null; then
      alive=1
      detail=$(ps -o pid,ppid,comm,args --no-headers -p "$r" 2>/dev/null)
      still_here+="  $detail"$'\n'
    fi
  done
  [ "$alive" -eq 0 ] && break
  if [ $((elapsed % 3)) -eq 0 ]; then
    log "still waiting after ${elapsed}s on:"$'\n'"$still_here"
    printf 'still waiting after %ss on:\n%s' "$elapsed" "$still_here" >&2
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done

for r in "${roots[@]}"; do
  if kill -0 "$r" 2>/dev/null; then
    log "force-killing root PID $r (didn't exit within ${GRACE_SECONDS}s)"
    kill -KILL "$r" 2>/dev/null
  fi
done

# Stage 2: the app itself is gone. Anything left over from its process
# tree at this point is a detached helper, not part of a live app window
# — safe to clean up quickly rather than waiting out another full grace
# period on something that was never going to exit by itself.
leftover=()
for p in "${all_pids[@]}"; do
  kill -0 "$p" 2>/dev/null && leftover+=("$p")
done

if [ "${#leftover[@]}" -gt 0 ]; then
  log "cleaning up leftover helper processes: ${leftover[*]}"
  kill -TERM "${leftover[@]}" 2>/dev/null
  sleep 2
  for p in "${leftover[@]}"; do
    if kill -0 "$p" 2>/dev/null; then
      log "force-killing leftover PID $p"
      kill -KILL "$p" 2>/dev/null
    fi
  done
fi

exit 0
