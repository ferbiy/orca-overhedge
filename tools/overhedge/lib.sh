# shellcheck shell=bash
# Shared helpers for the overhedge update tooling. Sourced, not executed.
# Paths can be overridden from the environment (tests use a scratch OVH_HOME).

OVH_HOME=${OVH_HOME:-$HOME/overhedge-build}
OVH_SCRIPTS=${OVH_SCRIPTS:-$OVH_HOME/scripts}
OVH_ARTIFACTS=${OVH_ARTIFACTS:-$OVH_HOME/artifacts}
OVH_LOGS=${OVH_LOGS:-$OVH_HOME/logs}
OVH_STATE=${OVH_STATE:-$OVH_HOME/state}
OVH_CONF=${OVH_CONF:-$OVH_HOME/update.conf}
OVH_UPDATE_LOG=${OVH_UPDATE_LOG:-$OVH_HOME/update-log.md}
OVH_FORK_REPO=${OVH_FORK_REPO:-ferbiy/orca-overhedge}
OVH_UPSTREAM_REPO=${OVH_UPSTREAM_REPO:-stablyai/orca}
OVH_SERVICE=${OVH_SERVICE:-orca-serve}
OVH_PORT=${OVH_PORT:-6768}
OVH_PKG=${OVH_PKG:-orca-ide}
# Branch layout (see UPDATE-RUNBOOK.md section 1). The permanent branch cannot be called plain
# `overhedge`: git refuses a ref `overhedge` next to refs under `overhedge/` (overhedge/ci).
OVH_MAIN_BRANCH=${OVH_MAIN_BRANCH:-overhedge/main}   # the patched Orca; default branch; releases
OVH_CI_BRANCH=${OVH_CI_BRANCH:-overhedge/ci}         # workflows + this tooling
OVH_PORT_TAG_PREFIX=overhedge-port/v                  # overhedge-port/v1.4.278 = the port's head

# Defaults; update.conf overrides them.
DEPLOY_POLICY=${DEPLOY_POLICY:-night-idle}   # confirm | night-idle | always | off
DEPLOY_WINDOW_START=${DEPLOY_WINDOW_START:-02:00}
DEPLOY_WINDOW_END=${DEPLOY_WINDOW_END:-06:00}
DEPLOY_TZ=${DEPLOY_TZ:-Europe/Berlin}
DEPLOY_RETRY_MINUTES=${DEPLOY_RETRY_MINUTES:-15}
KEEP_BUILDS=${KEEP_BUILDS:-3}
KEEP_BACKUPS=${KEEP_BACKUPS:-3}
KEEP_PORT_TREES=${KEEP_PORT_TREES:-2}
MIN_FREE_GB=${MIN_FREE_GB:-60}
NOTIFY_CMD=${NOTIFY_CMD:-}
CLAUDE_CONFIG_DIR_FOR_UPDATES=${CLAUDE_CONFIG_DIR_FOR_UPDATES:-$HOME/.claude-team}
CLAUDE_MODEL=${CLAUDE_MODEL:-opus}
CLAUDE_MAX_HOURS=${CLAUDE_MAX_HOURS:-10}

ovh_load_conf() {
  # shellcheck disable=SC1090
  [ -f "$OVH_CONF" ] && . "$OVH_CONF"
  return 0
}

ovh_ts() { date +%Y%m%d-%H%M%S; }
ovh_now() { date '+%Y-%m-%d %H:%M:%S %Z'; }

# Strip anything that looks like an email, a bearer/API token or a pairing code.
ovh_redact() {
  sed -E \
    -e 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/<email>/g' \
    -e 's/(gh[opsu]_|github_pat_)[A-Za-z0-9_]+/<token>/g' \
    -e 's/sk-ant-[A-Za-z0-9_-]+/<token>/g' \
    -e 's/([Tt]oken|[Aa]uthorization|[Bb]earer|password|secret)([" :=]+)[^ ",}]+/\1\2<redacted>/g' \
    -e 's#orca://pair\?[^ "]+#orca://pair?<redacted>#g'
}

# log <msg...>: timestamped line to stderr and, when OVH_LOG_FILE is set, to that file.
log() {
  local line
  line="[$(date '+%F %T')] $*"
  line=$(printf '%s\n' "$line" | ovh_redact)
  printf '%s\n' "$line" >&2
  if [ -n "${OVH_LOG_FILE:-}" ]; then printf '%s\n' "$line" >> "$OVH_LOG_FILE"; fi
}
die() { log "ERROR: $*"; exit "${OVH_DIE_CODE:-1}"; }

# Append a markdown block (stdin) to the human update log.
ovh_update_log() {
  mkdir -p "$(dirname "$OVH_UPDATE_LOG")"
  { ovh_redact; echo; } >> "$OVH_UPDATE_LOG"
}

# notify <subject> : body on stdin. Runs NOTIFY_CMD (subject as $1, body on stdin) if configured.
ovh_notify() {
  local subject=$1 body
  body=$(ovh_redact)
  if [ -n "${NOTIFY_CMD:-}" ]; then
    printf '%s\n' "$body" | timeout 60 bash -c "$NOTIFY_CMD" notify "$subject" >/dev/null 2>&1 \
      || log "notify command failed (ignored)"
  fi
  return 0
}

ovh_free_gb() { df -P -BG "${1:-$OVH_HOME}" | awk 'NR==2 {gsub("G","",$4); print $4}'; }

# Version helpers. 1.4.273 -> release id 273; anything not 1.4.x keeps the full version.
ovh_release_id() {
  case "$1" in
    1.4.*) echo "${1##*.}" ;;
    *) echo "$1" ;;
  esac
}
ovh_installed_version() { dpkg-query -W -f='${Version}' "$OVH_PKG" 2>/dev/null || true; }
# 1.4.273+overhedge.18.ge5c6fe334d -> 1.4.273
ovh_base_version() { echo "${1%%+*}"; }

# Port and release names. Port branch (transient, deleted once the port tag exists):
# <prefix>/port-<id>; port tag: overhedge-port/v<ver>; release tag: v<ver>-overhedge.<n>, where
# <n> is the deb's build number (+overhedge.<n>. in its version).
ovh_port_tag() { echo "${OVH_PORT_TAG_PREFIX}$1"; }
ovh_release_tag() { echo "v$1-overhedge.$2"; }
# ovh_fetch_port_tags <clone>: origin's overhedge-port/* tags (they may point outside the fetched
# branches, so tag auto-following does not cover them).
ovh_fetch_port_tags() {
  git -C "$1" fetch -q origin "+refs/tags/${OVH_PORT_TAG_PREFIX%v}*:refs/tags/${OVH_PORT_TAG_PREFIX%v}*"
}
# ovh_port_versions <clone>: versions with a port tag, oldest first (needs ovh_fetch_port_tags).
ovh_port_versions() {
  git -C "$1" tag -l "${OVH_PORT_TAG_PREFIX}*" | sed "s#^${OVH_PORT_TAG_PREFIX}##" | sort -V
}

# Hosts to deploy to: "<name> <ssh-target|local> <transfer>" per line from hosts.conf
# (comments and blank lines skipped). Without the file: this host only.
OVH_HOSTS_CONF=${OVH_HOSTS_CONF:-$OVH_HOME/hosts.conf}
ovh_hosts() {
  if [ -f "$OVH_HOSTS_CONF" ]; then
    sed -e 's/#.*//' -e '/^[[:space:]]*$/d' "$OVH_HOSTS_CONF"
  else
    echo "orca-ide local local"
  fi
}
