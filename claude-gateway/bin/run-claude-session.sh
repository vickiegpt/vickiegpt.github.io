#!/bin/sh

set -eu
umask 077

fail() {
  printf '%s\n' "Invalid launcher configuration: $1" >&2
  exit 64
}

if [ "$#" -ne 0 ]; then
  fail 'launcher arguments are not accepted'
fi

[ -n "${SESSION_WORKSPACE:-}" ] || fail 'SESSION_WORKSPACE'
[ -n "${NODE_WASMU:-}" ] || fail 'NODE_WASMU'
[ -n "${NODE_WASM_ROOT:-}" ] || fail 'NODE_WASM_ROOT'
[ -n "${CLAUDE_CLI:-}" ] || fail 'CLAUDE_CLI'
[ -n "${ANTHROPIC_BASE_URL:-}" ] || fail 'ANTHROPIC_BASE_URL'
[ -n "${ANTHROPIC_AUTH_TOKEN:-}" ] || fail 'ANTHROPIC_AUTH_TOKEN'

carriage_return=$(printf '\r')

validate_path_text() {
  label=$1
  value=$2
  case "$value" in
    /*) ;;
    *) fail "$label" ;;
  esac
  case "$value" in
    *:*) fail "$label" ;;
  esac
  case "$value" in
    *'
'*|*"$carriage_return"*) fail "$label" ;;
  esac
}

canonical_directory() {
  label=$1
  value=$2
  validate_path_text "$label" "$value"
  canonical=$(realpath -- "$value" 2>/dev/null) || fail "$label"
  [ "$canonical" != / ] || fail "$label"
  [ -d "$canonical" ] && [ -r "$canonical" ] || fail "$label"
  printf '%s\n' "$canonical"
}

canonical_file() {
  label=$1
  value=$2
  validate_path_text "$label" "$value"
  canonical=$(realpath -- "$value" 2>/dev/null) || fail "$label"
  [ -f "$canonical" ] && [ -r "$canonical" ] || fail "$label"
  printf '%s\n' "$canonical"
}

SESSION_WORKSPACE=$(canonical_directory SESSION_WORKSPACE "$SESSION_WORKSPACE")
NODE_WASM_ROOT=$(canonical_directory NODE_WASM_ROOT "$NODE_WASM_ROOT")
NODE_WASMU=$(canonical_file NODE_WASMU "$NODE_WASMU")
CLAUDE_CLI=$(canonical_file CLAUDE_CLI "$CLAUDE_CLI")

case "$NODE_WASMU" in
  "$NODE_WASM_ROOT"/*) ;;
  *) fail 'NODE_WASMU' ;;
esac
case "$CLAUDE_CLI" in
  "$NODE_WASM_ROOT"/*) ;;
  *) fail 'CLAUDE_CLI' ;;
esac
case "$SESSION_WORKSPACE/" in
  "$NODE_WASM_ROOT/"*) fail 'SESSION_WORKSPACE' ;;
esac
case "$NODE_WASM_ROOT/" in
  "$SESSION_WORKSPACE/"*) fail 'NODE_WASM_ROOT' ;;
esac

case "$ANTHROPIC_BASE_URL" in
  https://?*) ;;
  *) fail 'ANTHROPIC_BASE_URL' ;;
esac
case "$ANTHROPIC_BASE_URL" in
  *[[:space:]]*) fail 'ANTHROPIC_BASE_URL' ;;
esac
case "$ANTHROPIC_AUTH_TOKEN" in
  *'
'*|*"$carriage_return"*) fail 'ANTHROPIC_AUTH_TOKEN' ;;
esac

command -v wasmer >/dev/null 2>&1 || fail 'wasmer executable'

HOME=$SESSION_WORKSPACE
TERM=xterm-256color
COLORTERM=truecolor
export HOME TERM COLORTERM

exec wasmer run \
  --stack-size 8388608 \
  --net \
  --mapdir "/workspace:$SESSION_WORKSPACE" \
  --dir "$NODE_WASM_ROOT" \
  --env 'HOME=/workspace' \
  --env "ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL" \
  --env "ANTHROPIC_AUTH_TOKEN=$ANTHROPIC_AUTH_TOKEN" \
  --env 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1' \
  --env 'TERM=xterm-256color' \
  --env 'COLORTERM=truecolor' \
  "$NODE_WASMU" \
  -- \
  "$CLAUDE_CLI"
