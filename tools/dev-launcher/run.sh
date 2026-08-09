#!/bin/zsh

set -u

SCRIPT_DIR="${0:A:h}"
PROJECT_DIR="${SCRIPT_DIR:h:h}"
LOG_FILE="${PROJECT_DIR}/logs/video-reverse-prompt-dev.log"
PID_FILE="${PROJECT_DIR}/logs/video-reverse-prompt-dev.pid"

USER_HOME="$(/usr/bin/dscl . -read "/Users/$(/usr/bin/id -un)" NFSHomeDirectory | /usr/bin/awk '{print $2}')"
export HOME="${USER_HOME}"
export PATH="/usr/local/bin:/opt/homebrew/bin:${USER_HOME}/.cargo/bin:${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"

/bin/mkdir -p "${PROJECT_DIR}/logs"
print -r -- "$$" > "${PID_FILE}"

{
  print -r -- ""
  print -r -- "===== $(/bin/date '+%Y-%m-%d %H:%M:%S') 启动 ====="
} >> "${LOG_FILE}"

cd "${PROJECT_DIR}" || exit 1
# 用当前受 nohup 保护的进程直接承载 npm，PID 始终对应整棵开发进程树。
# control.sh 因此可以准确判断状态，并在关闭时回收 Vite、Cargo 与 Tauri。
exec npm run tauri dev >> "${LOG_FILE}" 2>&1
