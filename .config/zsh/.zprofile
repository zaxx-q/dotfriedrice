# shellcheck shell=bash
# shellcheck disable=SC1091

# This file runs once at login if something triggers it (like niri-session or in TTY)
. "${HOME}/.config/zsh/env.sh"

# Load local settings if they exist.
if [ -f "${HOME}/.config/zsh/.zprofile.local" ]; then . "${HOME}/.config/zsh/.zprofile.local"; fi
