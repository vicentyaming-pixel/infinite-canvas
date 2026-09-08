#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${INFINITE_CANVAS_ENV_FILE:-${PROJECT_DIR}/.env.rainyun.local}"
RUNTIME_DIR="${INFINITE_CANVAS_RUNTIME_DIR:-${PROJECT_DIR}/.local-run}"
APP_PID_FILE="${RUNTIME_DIR}/app.pid"
PROXY_PID_FILE="${RUNTIME_DIR}/proxy.pid"
APP_LOG_FILE="${RUNTIME_DIR}/app.log"
PROXY_LOG_FILE="${RUNTIME_DIR}/proxy.log"
APP_URL="http://127.0.0.1:3000"
MODE="${1:-start}"

die() {
    printf 'Error: %s\n' "$1" >&2
    exit 1
}

pid_is_running() {
    kill -0 "$1" 2>/dev/null
}

process_belongs_to_project() {
    local pid="$1"
    local process_dir
    process_dir="$(lsof -a -p "${pid}" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
    case "${process_dir}" in
        "${PROJECT_DIR}"|"${PROJECT_DIR}"/*) return 0 ;;
        *) return 1 ;;
    esac
}

stop_pid_file() {
    local pid_file="$1"
    local label="$2"
    [[ -f "${pid_file}" ]] || return 0

    local pid
    pid="$(tr -dc '0-9' < "${pid_file}")"
    if [[ -n "${pid}" ]] && pid_is_running "${pid}"; then
        if ! process_belongs_to_project "${pid}"; then
            printf 'Ignoring stale %s PID file; PID %s belongs to another process.\n' "${label}" "${pid}" >&2
            rm -f "${pid_file}"
            return 0
        fi
        printf 'Stopping %s (PID %s)...\n' "${label}" "${pid}"
        kill "${pid}"
        for _ in {1..40}; do
            pid_is_running "${pid}" || break
            sleep 0.1
        done
        pid_is_running "${pid}" && die "${label} did not stop; inspect ${RUNTIME_DIR}."
    fi
    rm -f "${pid_file}"
}

wait_for_http() {
    local url="$1"
    for _ in {1..80}; do
        curl -fsS --max-time 2 "${url}" >/dev/null 2>&1 && return 0
        sleep 0.25
    done
    return 1
}

show_status() {
    local health
    if health="$(curl -fsS --max-time 3 "${APP_URL}/healthz" 2>/dev/null)" &&
        node -e 'const h=JSON.parse(process.argv[1]); process.exit(h.ok && h.storageConfigured ? 0 : 1)' "${health}"; then
        printf 'App/WebDAV: running and Rainyun configured (%s)\n' "${APP_URL}"
    else
        printf 'App/WebDAV: not ready\n'
    fi

    if lsof -tiTCP:23210 -sTCP:LISTEN >/dev/null 2>&1; then
        printf 'ReAPI proxy: running (http://127.0.0.1:23210)\n'
    else
        printf 'ReAPI proxy: not running\n'
    fi
}

case "${MODE}" in
    stop)
        stop_pid_file "${PROXY_PID_FILE}" "ReAPI proxy"
        stop_pid_file "${APP_PID_FILE}" "Infinite Canvas"
        show_status
        exit 0
        ;;
    status)
        show_status
        exit 0
        ;;
    start)
        ;;
    *)
        die "usage: $0 [start|stop|status]"
        ;;
esac

command -v node >/dev/null || die "Node.js is required."
command -v npm >/dev/null || die "npm is required."
command -v curl >/dev/null || die "curl is required."
command -v lsof >/dev/null || die "lsof is required."
[[ -f "${ENV_FILE}" ]] || die "missing ${ENV_FILE}; copy scripts/rainyun.env.example and fill it first."

if [[ "$(uname -s)" == "Darwin" ]]; then
    config_mode="$(stat -f '%Lp' "${ENV_FILE}")"
else
    config_mode="$(stat -c '%a' "${ENV_FILE}")"
fi
[[ "${config_mode}" == "600" ]] || die "${ENV_FILE} must use permission 600 (run: chmod 600 '${ENV_FILE}')."

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

for required_name in S3_ENDPOINT S3_REGION S3_BUCKET S3_ACCESS_KEY S3_SECRET_KEY STORAGE_API_TOKEN; do
    [[ -n "${!required_name:-}" ]] || die "${required_name} is missing in ${ENV_FILE}."
done

mkdir -p "${RUNTIME_DIR}"
chmod 700 "${RUNTIME_DIR}"

if [[ ! -d "${PROJECT_DIR}/web/node_modules" ]]; then
    npm --prefix "${PROJECT_DIR}/web" install
fi
if [[ ! -d "${PROJECT_DIR}/server/node_modules" ]]; then
    npm --prefix "${PROJECT_DIR}/server" install
fi

printf 'Building the web app...\n'
npm --prefix "${PROJECT_DIR}/web" run build

stop_pid_file "${APP_PID_FILE}" "Infinite Canvas"
existing_pid="$(lsof -tiTCP:3000 -sTCP:LISTEN 2>/dev/null | head -n 1 || true)"
if [[ -n "${existing_pid}" ]]; then
    process_belongs_to_project "${existing_pid}" || die "port 3000 is occupied by PID ${existing_pid} outside ${PROJECT_DIR}."
    printf 'Stopping this project process on port 3000 (PID %s)...\n' "${existing_pid}"
    kill "${existing_pid}"
    for _ in {1..40}; do
        pid_is_running "${existing_pid}" || break
        sleep 0.1
    done
    pid_is_running "${existing_pid}" && die "the existing project process on port 3000 did not stop."
fi

printf 'Starting Infinite Canvas with the Rainyun WebDAV gateway...\n'
(
    cd "${PROJECT_DIR}"
    PORT=3000 nohup node server/index.mjs >>"${APP_LOG_FILE}" 2>&1 &
    printf '%s\n' "$!" >"${APP_PID_FILE}"
)

wait_for_http "${APP_URL}/healthz" || die "the app did not become ready; inspect ${APP_LOG_FILE}."
health="$(curl -fsS --max-time 3 "${APP_URL}/healthz")"
node -e 'const h=JSON.parse(process.argv[1]); if (!h.storageConfigured) process.exit(1)' "${health}" || die "the app started without Rainyun storage; inspect ${ENV_FILE}."

if ! lsof -tiTCP:23210 -sTCP:LISTEN >/dev/null 2>&1; then
    printf 'Starting the ReAPI local proxy...\n'
    (
        cd "${PROJECT_DIR}"
        nohup npx --yes @basketikun/canvas-proxy@latest >>"${PROXY_LOG_FILE}" 2>&1 &
        printf '%s\n' "$!" >"${PROXY_PID_FILE}"
    )
    for _ in {1..80}; do
        lsof -tiTCP:23210 -sTCP:LISTEN >/dev/null 2>&1 && break
        sleep 0.25
    done
fi

show_status
printf '\nWebDAV settings for every browser profile:\n'
printf '  URL: %s/api/webdav\n' "${APP_URL}"
printf '  Username: canvas\n'
printf '  Password: STORAGE_API_TOKEN from .env.rainyun.local\n'
printf '  Directory: infinite-canvas\n'
printf '\nLogs: %s\n' "${RUNTIME_DIR}"

if [[ "${INFINITE_CANVAS_NO_OPEN:-0}" != "1" ]]; then
    if [[ "$(uname -s)" == "Darwin" ]]; then
        open -a "Google Chrome" "${APP_URL}/config" 2>/dev/null || open "${APP_URL}/config"
    fi
fi
