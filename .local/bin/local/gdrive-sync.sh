#!/usr/bin/env bash
#
# Syncs LOCAL_DIR <-> Google Drive via rclone, but skips the run entirely
# if the currently active internet connection is metered (e.g. phone
# tethering / mobile hotspot).
#

set -euo pipefail

LOCAL_DIR="/drive/Docs/"
REMOTE="GDrive-azai:Docs"
LOGFILE="$HOME/.local/share/gdrive-sync.log"
LOCKFILE="/tmp/gdrive-sync.lock"

# List of exclusion patterns for rclone
EXCLUDES=(
    ".git/**"
    "no-sync/**"
    "/Misc/**"
)

mkdir -p "$(dirname "$LOGFILE")" "$LOCAL_DIR"

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') $*" | tee -a "$LOGFILE"
}

# Prevent overlapping runs (bisync can take a while on large folders)
exec 200>"$LOCKFILE"
if ! flock -n 200; then
    log "Another sync is already running, skipping this run"
    exit 0
fi

# Check power status: skip only when running on battery in Power Saver mode
is_on_battery() {
    if command -v upower >/dev/null 2>&1; then
        local on_bat
        on_bat=$(upower -d 2>/dev/null | awk '/on-battery:/ {print $2; exit}')
        if [ "$on_bat" = "yes" ]; then
            return 0
        elif [ "$on_bat" = "no" ]; then
            return 1
        fi
    fi

    if [ -d /sys/class/power_supply ]; then
        for supply in /sys/class/power_supply/*; do
            if [ -f "$supply/type" ] && [ -f "$supply/online" ]; then
                local type online
                type=$(cat "$supply/type" 2>/dev/null || true)
                online=$(cat "$supply/online" 2>/dev/null || true)
                if [ "$type" = "Mains" ] && [ "$online" = "1" ]; then
                    return 1
                fi
            fi
        done
    fi

    if [ -f /run/tlp/last_pwr ]; then
        local pwr_src
        pwr_src=$(awk '{print $2}' /run/tlp/last_pwr 2>/dev/null || true)
        if [ "$pwr_src" = "1" ]; then
            return 0
        elif [ "$pwr_src" = "0" ]; then
            return 1
        fi
    fi

    return 1
}

is_power_saver() {
    if [ -f /run/tlp/manual_mode ]; then
        local man_mode
        man_mode=$(cat /run/tlp/manual_mode 2>/dev/null || true)
        if [ "$man_mode" = "2" ]; then
            return 0
        fi
    fi

    if [ -f /run/tlp/last_pwr ]; then
        local prof
        prof=$(awk '{print $1}' /run/tlp/last_pwr 2>/dev/null || true)
        if [ "$prof" = "2" ]; then
            return 0
        elif [ "$prof" = "0" ] || [ "$prof" = "1" ]; then
            return 1
        fi
    fi

    if command -v tlp-stat >/dev/null 2>&1; then
        local tlp_prof
        tlp_prof=$(tlp-stat -s 2>/dev/null | awk -F'=' '/TLP profile/ {gsub(/ /, "", $2); print $2}')
        case "$tlp_prof" in
            *power-saver*|*SAV*)
                return 0
                ;;
            *performance*|*PRF*|*balanced*|*BAL*)
                return 1
                ;;
        esac
    fi

    if [ -f /sys/firmware/acpi/platform_profile ]; then
        local plat_prof
        plat_prof=$(cat /sys/firmware/acpi/platform_profile 2>/dev/null || true)
        case "$plat_prof" in
            low-power|quiet)
                return 0
                ;;
        esac
    fi

    return 1
}

if is_on_battery && is_power_saver; then
    log "Running on battery in Power Saver mode — skipping sync"
    exit 0
fi

# Find the interface actually carrying internet traffic right now
DEFAULT_IFACE=$(ip route show default 2>/dev/null | awk '/default/ {print $5; exit}')

if [ -z "$DEFAULT_IFACE" ]; then
    log "No default route (not online), skipping sync"
    exit 0
fi

# Ask NetworkManager whether that connection is metered
METERED=$(nmcli -g GENERAL.METERED device show "$DEFAULT_IFACE" 2>/dev/null || echo "unknown")

case "$METERED" in
    yes|guess-yes)
        log "Active connection ($DEFAULT_IFACE) is metered/tethered — skipping sync"
        exit 0
        ;;
esac

# Sanity check that we truly have connectivity, not just a captive portal
if ! curl -fsS --max-time 5 https://www.google.com -o /dev/null; then
    log "Default route present but internet unreachable, skipping sync"
    exit 0
fi

log "Starting sync on $DEFAULT_IFACE (metered=$METERED)"

EXCLUDE_FLAGS=()
for pattern in "${EXCLUDES[@]}"; do
    EXCLUDE_FLAGS+=(--exclude "$pattern")
done

if rclone bisync "$LOCAL_DIR" "$REMOTE" \
        "${EXCLUDE_FLAGS[@]}" \
        --create-empty-src-dirs \
        --resilient \
        --log-file "$LOGFILE" --log-level INFO; then
    log "Sync completed successfully"
else
    log "Sync FAILED (see log above for details)"
fi
