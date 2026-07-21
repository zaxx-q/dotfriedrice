# ~/.config/zsh/env.sh

export DOTFRIEDRICE_PATH="/home/zaxx/dotfriedrice"

# shellcheck disable=SC1091
. "${XDG_CONFIG_HOME:-"${HOME}/.config"}/zsh/.xdg.local"

# Add all local binaries to the system path and make sure they are first.
export PATH="${HOME}/.local/bin/local:${HOME}/.local/bin:${PATH}"

# Confiure Mise (programming language run-time manager).
export PATH="${XDG_DATA_HOME}/mise/shims:${PATH}"

# Additional paths.
export PATH="${HOME}/.cache/.bun/bin:${PATH}"

# Default programs to run.
export EDITOR="zed --wait"
export DIFFPROG="meld"

# Configure GPG.
export GNUPGHOME="${XDG_CONFIG_HOME}/gnupg"

# Configure pass, Docker Desktop on Linux uses this tool and while I have used
# it for years in the past, I've moved to using KeePassXC.
export PASSWORD_STORE_DIR="${XDG_CONFIG_HOME}/password-store"

# Setup Compose Key
export XCOMPOSEFILE="${XDG_CONFIG_HOME}/XCompose"
export GTK_IM_MODULE="simple"
export QT_IM_MODULE="xim"
# Alternative if some apps don't detect compose
# export GTK_IM_MODULE="xim"
# export GTK_IM_MODULE="gtk-im-context-simple"

# Fix Nvidia HW acceleration on browsers
export MOZ_DISABLE_RDD_SANDBOX=1
export MOZ_DRM_DEVICE=/dev/dri/renderD128
export NVD_BACKEND=direct
export LIBVA_DRIVER_NAME=nvidia
export CUDA_DISABLE_PERF_BOOST=1
