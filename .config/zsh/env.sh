# ~/.config/zsh/env.sh

export DOTFRIEDRICE_PATH="/home/zaxx/dotfriedrice"

# shellcheck disable=SC1091
. "${XDG_CONFIG_HOME:-"${HOME}/.config"}/zsh/.xdg.local"

# Add Mise shims first so runtime versions take precedence, then local binaries, cargo, and bun.
export PATH="${XDG_DATA_HOME}/mise/shims:${HOME}/.local/bin/local:${HOME}/.local/bin:${HOME}/.cargo/bin:${PATH}:${XDG_CACHE_HOME}/.bun/bin"

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
export LIBVA_DRIVER_NAME=radeonsi
export VDPAU_DRIVER=va_gl
# export NVD_BACKEND=direct
# export LIBVA_DRIVER_NAME=nvidia
# export CUDA_DISABLE_PERF_BOOST=1

# Redirect Android preference/emulator files away from home root
export ANDROID_USER_HOME="$HOME/.local/share/android"

# Redirect Gradle caches away from home root
export GRADLE_USER_HOME="$HOME/.local/share/gradle"

# Optional: Tell your system CLI where you chose to download the SDK tools in Step 1
export ANDROID_HOME="$HOME/.local/share/Android/Sdk"
export PATH=$PATH:$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools
