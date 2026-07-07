# shellcheck shell=bash

# Load colors so we can access $fg and more.
autoload -U colors && colors

# Disable CTRL-s from freezing your terminal's output.
stty stop undef

# Enable comments when working in an interactive shell.
setopt interactive_comments

# Prompt is managed by pure prompt (initialized below after plug-ins are loaded).

# History settings.
export HISTFILE="${DOTFRIEDRICE_PATH}/.config/zsh/.zsh_history"
export HISTSIZE=50000          # History lines stored in memory.
export SAVEHIST=50000          # History lines stored on disk.
setopt EXTENDED_HISTORY        # Save history with timestamps.
setopt INC_APPEND_HISTORY_TIME # Immediately append commands and track duration.
setopt HIST_IGNORE_ALL_DUPS    # Never add duplicate entries.
setopt HIST_IGNORE_SPACE       # Ignore commands that start with a space.
setopt HIST_REDUCE_BLANKS      # Remove unnecessary blank lines.

# Use modern completion system. Other than enabling globdots for showing
# hidden files, these ares values in the default generated zsh config.
autoload -U compinit
compinit
_comp_options+=(globdots)

# Initialize zoxide (smarter cd command).
if command -v zoxide >/dev/null 2>&1; then
  eval "$(zoxide init zsh)"
fi

zstyle ":completion:*" menu select=2
zstyle ":completion:*" auto-description "specify: %d"
zstyle ":completion:*" completer _expand _complete _correct _approximate
zstyle ":completion:*" format "Completing %d"
zstyle ":completion:*" group-name ""

# dircolors is a GNU utility that's not on macOS by default. With this not
# being used on macOS it means zsh's complete menu won't have colors.
command -v dircolors >/dev/null 2>&1 && eval "$(dircolors -b)"

# shellcheck disable=SC2016,SC2296
zstyle ":completion:*:default" list-colors '${(s.:.)LS_COLORS}'
zstyle ":completion:*" list-colors ""
zstyle ":completion:*" list-prompt %SAt %p: Hit TAB for more, or the character to insert%s
zstyle ":completion:*" matcher-list "" "m:{a-z}={A-Z}" "m:{a-zA-Z}={A-Za-z}" "r:|[._-]=* r:|=* l:|=*"
zstyle ':completion:*' select-prompt %SScrolling active: current selection at %p%s
zstyle ":completion:*" use-compctl false
zstyle ":completion:*" verbose true

# Use Vim key binds.
# bindkey -v

# Ensure home / end keys continue to work.
bindkey "\e[1~" beginning-of-line
bindkey "\e[H" beginning-of-line
bindkey "\e[7~" beginning-of-line
bindkey "\e[4~" end-of-line
bindkey "\e[F" end-of-line
bindkey "\e[8~" end-of-line
bindkey "\e[3~" delete-char

# Allows your gpg passphrase prompt to spawn (useful for signing commits).
GPG_TTY="$(tty)"
export GPG_TTY

# shellcheck disable=SC1090
if command -v fzf >/dev/null 2>&1; then
  . <(fzf --zsh)
fi

# Configure fzf.
# shellcheck disable=SC1091
if [ -f "${XDG_CONFIG_HOME}/fzf/config.sh" ]; then
  . "${XDG_CONFIG_HOME}/fzf/config.sh"
fi

# zsh-autosuggestions settings.
export ZSH_AUTOSUGGEST_BUFFER_MAX_SIZE=20

# Set the root name of the plugins files (.txt and .zsh) antidote will use.
zsh_plugins="${ZDOTDIR:-"${HOME}/.config/zsh"}/.zsh_plugins"

# Locate an installed antidote and, if found, (re)generate the static
# plugins file whenever .zsh_plugins.txt is updated.
_dotfriedrice_load_antidote() {
  local -a antidote_dirs=(
    "${XDG_DATA_HOME:-"${HOME}/.local/share"}/antidote"
    "/opt/homebrew/share/antidote"
  )
  local antidote_dir dir
  for dir in "${antidote_dirs[@]}"; do
    if [[ -d "${dir}/functions" ]]; then
      antidote_dir="${dir}"
      break
    elif [[ -f "${dir}/antidote.zsh" ]]; then
      antidote_dir="${dir}"
      break
    fi
  done

  if [[ -n "${antidote_dir}" ]]; then
    if [[ -d "${antidote_dir}/functions" ]]; then
      fpath=("${antidote_dir}/functions" "${fpath[@]}")
      autoload -Uz antidote
    else
      # shellcheck disable=SC1091
      source "${antidote_dir}/antidote.zsh"
    fi
    antidote bundle < "${zsh_plugins}.txt" >| "${zsh_plugins}.zsh"
  else
    echo "DotFriedRice warning: Antidote plugin manager not found."
  fi
}

if [[ ! -f "${zsh_plugins}.txt" ]]; then
  : # Nothing to bundle yet; skip silently.
elif [[ ! "${zsh_plugins}.zsh" -nt "${zsh_plugins}.txt" ]]; then
  _dotfriedrice_load_antidote
fi
unfunction _dotfriedrice_load_antidote 2>/dev/null

# Source your static plugins file.
if [[ -f "${zsh_plugins}.zsh" ]]; then
  # shellcheck disable=SC1090
  source "${zsh_plugins}.zsh"
fi

# Initialize the prompt system and choose pure.
autoload -Uz promptinit && promptinit
prompt pure

# Ensure colors match by using FZF_DEFAULT_OPTS.
zstyle ":fzf-tab:*" use-fzf-default-opts yes

# Preview file contents when tab completing directories.
zstyle ":fzf-tab:complete:cd:*" fzf-preview "ls --color=always \${realpath}"

# Load aliases if they exist.
# shellcheck disable=SC1091
[ -f "${XDG_CONFIG_HOME}/zsh/.aliases" ] && . "${XDG_CONFIG_HOME}/zsh/.aliases"


