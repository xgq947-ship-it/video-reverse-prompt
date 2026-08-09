#!/bin/zsh

set -u

SCRIPT_DIR="${0:A:h}"
PROJECT_DIR="${SCRIPT_DIR:h:h}"
RUNTIME_DIR="${PROJECT_DIR}/logs"
PID_FILE="${RUNTIME_DIR}/video-reverse-prompt-dev.pid"
LOG_FILE="${RUNTIME_DIR}/video-reverse-prompt-dev.log"
RUNNER="${SCRIPT_DIR}/run.sh"

USER_HOME="$(/usr/bin/dscl . -read "/Users/$(/usr/bin/id -un)" NFSHomeDirectory | /usr/bin/awk '{print $2}')"
export HOME="${USER_HOME}"
# Finder/AppleScript apps start with a minimal PATH and do not inherit the one
# configured by the user's interactive shell. Include common user-level Node
# locations before checking for npm so Hermes, Volta, asdf and fnm installs work.
export PATH="${USER_HOME}/.local/bin:${USER_HOME}/.hermes/node/bin:${USER_HOME}/.volta/bin:${USER_HOME}/.asdf/shims:${USER_HOME}/.fnm/aliases/default/bin:/opt/homebrew/bin:/usr/local/bin:${USER_HOME}/.cargo/bin:${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"

read_pid() {
  if [[ -f "${PID_FILE}" ]]; then
    /bin/cat "${PID_FILE}" 2>/dev/null
  fi
}

is_running() {
  local pid
  pid="$(read_pid)"
  [[ -n "${pid}" ]] && /bin/kill -0 "${pid}" 2>/dev/null
}

collect_descendants() {
  local parent_pid="$1"
  local child_pid
  local children

  children="$(/usr/bin/pgrep -P "${parent_pid}" 2>/dev/null || true)"
  for child_pid in ${(f)children}; do
    [[ -n "${child_pid}" ]] || continue
    collect_descendants "${child_pid}"
  done
  print -r -- "${parent_pid}"
}

start_project() {
  if is_running; then
    print -r -- "ALREADY_RUNNING $(read_pid)"
    return 0
  fi

  /bin/mkdir -p "${RUNTIME_DIR}"
  /bin/rm -f "${PID_FILE}"

  if [[ ! -d "${PROJECT_DIR}/node_modules" ]]; then
    print -r -- "NEEDS_INSTALL"
    return 2
  fi

  if ! command -v npm >/dev/null 2>&1; then
    print -r -- "MISSING_NPM"
    return 3
  fi

  if ! command -v cargo >/dev/null 2>&1; then
    print -r -- "MISSING_RUST"
    return 4
  fi

  # 完全脱离 AppleScript 启动器在后台运行。run.sh 会用 exec 让自己的 PID
  # 始终对应 npm/Tauri 进程树，因此无需 Terminal 窗口也能准确停止。
  /usr/bin/nohup /bin/zsh "${RUNNER}" </dev/null >/dev/null 2>&1 &

  local attempt
  for attempt in {1..20}; do
    if is_running; then
      print -r -- "STARTED $(read_pid)"
      return 0
    fi
    /bin/sleep 0.25
  done

  print -r -- "START_FAILED"
  return 6
}

stop_project() {
  local pid
  pid="$(read_pid)"

  if [[ -z "${pid}" ]] || ! /bin/kill -0 "${pid}" 2>/dev/null; then
    /bin/rm -f "${PID_FILE}"
    print -r -- "ALREADY_STOPPED"
    return 0
  fi

  local process_pid
  local process_ids
  process_ids="$(collect_descendants "${pid}")"
  for process_pid in ${(f)process_ids}; do
    [[ -n "${process_pid}" ]] && /bin/kill -TERM "${process_pid}" 2>/dev/null || true
  done

  local attempt
  for attempt in {1..20}; do
    /bin/kill -0 "${pid}" 2>/dev/null || break
    /bin/sleep 0.25
  done

  if /bin/kill -0 "${pid}" 2>/dev/null; then
    process_ids="$(collect_descendants "${pid}")"
    for process_pid in ${(f)process_ids}; do
      [[ -n "${process_pid}" ]] && /bin/kill -KILL "${process_pid}" 2>/dev/null || true
    done
  fi

  /bin/rm -f "${PID_FILE}"
  print -r -- "STOPPED"
}

case "${1:-status}" in
  start)
    start_project
    ;;
  stop)
    stop_project
    ;;
  restart)
    stop_project >/dev/null
    start_project
    ;;
  status)
    if is_running; then
      print -r -- "RUNNING $(read_pid)"
    else
      /bin/rm -f "${PID_FILE}"
      print -r -- "STOPPED"
    fi
    ;;
  log-path)
    print -r -- "${LOG_FILE}"
    ;;
  *)
    print -u2 -- "Usage: $0 {start|stop|restart|status|log-path}"
    exit 64
    ;;
esac
