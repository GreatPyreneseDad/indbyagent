# source ./env.sh — everything for this build stays inside this folder
export PARTY_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
unset NPM_CONFIG_PREFIX; export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" && nvm use --silent 22 >/dev/null
export NPM_CONFIG_PREFIX="$PARTY_ROOT/.tooling"          # "npm -g" lands here, not system-wide
export PATH="$PARTY_ROOT/.tooling/bin:$PARTY_ROOT/node_modules/.bin:$PATH"
export XDG_CONFIG_HOME="$PARTY_ROOT/.sandbox/config"      # CLI configs/state stay local
export XDG_DATA_HOME="$PARTY_ROOT/.sandbox/data"
export XDG_CACHE_HOME="$PARTY_ROOT/.sandbox/cache"
[ -f "$PARTY_ROOT/.env" ] && set -a && . "$PARTY_ROOT/.env" && set +a
# Executor keeps its state in $HOME/.executor — point it at the sandbox instead
executor() { HOME="$PARTY_ROOT/.sandbox/home" command "$PARTY_ROOT/.tooling/bin/executor" "$@"; }
