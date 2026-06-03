#!/usr/bin/env bash
# run_with_thinking.sh — launch Windsurf/Devin through a transparent
# mitmproxy that decodes chain-of-thought tokens into NDJSON.
#
# Usage:
#   run_with_thinking.sh <model> <prompt>
#
# Example:
#   run_with_thinking.sh claude-sonnet-4-6-thinking "What is 12 times 15? Think step by step."
#
# Output: the decoded thinking+answer stream printed to stdout after devin exits.
# Raw NDJSON also saved at $WINDSURF_THINKING_SINK (default /tmp/windsurf_thinking_stream.jsonl).

set -euo pipefail

MODEL="${1:?Usage: $0 <model> <prompt>}"
PROMPT="${2:?Usage: $0 <model> <prompt>}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SINK="${WINDSURF_THINKING_SINK:-/tmp/windsurf_thinking_stream.jsonl}"
PROXY_PORT=8080
PROXY_ADDR="http://localhost:${PROXY_PORT}"
MITM_CA_SRC="${HOME}/.mitmproxy/mitmproxy-ca-cert.pem"
MITM_CA_DST="/tmp/mitm-ca.pem"

# ------------------------------------------------------------------
# 1. Ensure mitmproxy CA cert is available for devin
# ------------------------------------------------------------------
if [[ ! -f "${MITM_CA_DST}" ]]; then
    if [[ -f "${MITM_CA_SRC}" ]]; then
        cp "${MITM_CA_SRC}" "${MITM_CA_DST}"
        echo "[run_with_thinking] copied mitmproxy CA cert to ${MITM_CA_DST}"
    else
        echo "[run_with_thinking] WARNING: mitmproxy CA cert not found at ${MITM_CA_SRC}" >&2
        echo "[run_with_thinking] HTTPS interception may fail" >&2
    fi
fi

# ------------------------------------------------------------------
# 2. Truncate sink file
# ------------------------------------------------------------------
: > "${SINK}"

# ------------------------------------------------------------------
# 3. Start mitmdump in the background (quiet mode)
# ------------------------------------------------------------------
echo "[run_with_thinking] starting mitmdump on port ${PROXY_PORT}..."
mitmdump -q -p "${PROXY_PORT}" -s "${SCRIPT_DIR}/thinking_proxy.py" &
MITM_PID=$!

# Cleanup handler: kill mitmdump on script exit
cleanup() {
    if kill -0 "${MITM_PID}" 2>/dev/null; then
        kill "${MITM_PID}" 2>/dev/null || true
        wait "${MITM_PID}" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

# ------------------------------------------------------------------
# 4. Wait for proxy port to be listening
# ------------------------------------------------------------------
echo "[run_with_thinking] waiting for proxy port ${PROXY_PORT}..."
for i in $(seq 1 30); do
    if nc -z localhost "${PROXY_PORT}" 2>/dev/null; then
        echo "[run_with_thinking] proxy is listening"
        break
    fi
    if ! kill -0 "${MITM_PID}" 2>/dev/null; then
        echo "[run_with_thinking] ERROR: mitmdump died unexpectedly" >&2
        exit 1
    fi
    sleep 0.5
done

if ! nc -z localhost "${PROXY_PORT}" 2>/dev/null; then
    echo "[run_with_thinking] ERROR: proxy did not start within 15s" >&2
    exit 1
fi

# ------------------------------------------------------------------
# 5. Run devin through the proxy
# ------------------------------------------------------------------
echo "[run_with_thinking] running: devin -p --permission-mode bypass --model '${MODEL}' -- '${PROMPT}'"
echo "---"

HTTPS_PROXY="${PROXY_ADDR}" \
HTTP_PROXY="${PROXY_ADDR}" \
SSL_CERT_FILE="${MITM_CA_DST}" \
~/.local/bin/devin -p --permission-mode bypass --model "${MODEL}" -- "${PROMPT}"

DEVIN_EXIT=$?
echo "---"
echo "[run_with_thinking] devin exited with code ${DEVIN_EXIT}"

# ------------------------------------------------------------------
# 6. Kill mitmdump (the trap will handle it, but be explicit)
# ------------------------------------------------------------------
cleanup

# ------------------------------------------------------------------
# 7. Print the decoded stream
# ------------------------------------------------------------------
if [[ -f "${SINK}" && -s "${SINK}" ]]; then
    echo "[run_with_thinking] decoded stream (${SINK}):"
    echo "==="
    cat "${SINK}"
    echo "==="
else
    echo "[run_with_thinking] sink file is empty or missing — no events captured"
    echo "[run_with_thinking] (this is normal if devin failed or the proxy didn't intercept)"
fi
