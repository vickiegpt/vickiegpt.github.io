#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
ARTIFACT_DIR=${ARTIFACT_DIR:-"$ROOT/about"}
MANIFEST_PATH=${MANIFEST_PATH:-"$ROOT/about/runtime-manifest.json"}
BUCKET=${R2_BUCKET:-asplos-claude-artifacts}
WEBC="$ARTIFACT_DIR/node-claude.webc"
WASM="$ARTIFACT_DIR/node.wasm"

if [[ -n ${WRANGLER_BIN:-} ]]; then
  WRANGLER=("$WRANGLER_BIN")
else
  WRANGLER=(env "PATH=/opt/node22/bin:$PATH" npx --prefix "$ROOT/claude-edge" wrangler)
fi

read -r WEBC_SHA NODE_SHA EXPECTED_SIZE < <(
  node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    console.log(value.sha256 || "-", value.nodeSha256 || "-", value.size || "-");
  ' "$MANIFEST_PATH"
)

if [[ ! $WEBC_SHA =~ ^[0-9a-f]{64}$ || ! $NODE_SHA =~ ^[0-9a-f]{64}$ ]]; then
  printf '%s\n' "Invalid runtime manifest hashes" >&2
  exit 1
fi

hash_file() {
  sha256sum -- "$1" | cut -d ' ' -f 1
}

[[ -f $WEBC && -f $WASM ]]
[[ $(hash_file "$WEBC") == "$WEBC_SHA" ]]
[[ $(hash_file "$WASM") == "$NODE_SHA" ]]
if [[ $EXPECTED_SIZE != - ]]; then
  [[ $(stat -c '%s' -- "$WEBC") == "$EXPECTED_SIZE" ]]
fi

WEBC_KEY="$BUCKET/artifacts/$WEBC_SHA/node-claude.webc"
WASM_KEY="$BUCKET/artifacts/$NODE_SHA/node.wasm"

"${WRANGLER[@]}" r2 object put "$WEBC_KEY" --file "$WEBC" --content-type application/octet-stream --remote
"${WRANGLER[@]}" r2 object put "$WASM_KEY" --file "$WASM" --content-type application/wasm --remote

VERIFY_DIR=$(mktemp -d)
trap 'rm -rf -- "$VERIFY_DIR"' EXIT
"${WRANGLER[@]}" r2 object get "$WEBC_KEY" --file "$VERIFY_DIR/node-claude.webc" --remote
"${WRANGLER[@]}" r2 object get "$WASM_KEY" --file "$VERIFY_DIR/node.wasm" --remote
[[ $(hash_file "$VERIFY_DIR/node-claude.webc") == "$WEBC_SHA" ]]
[[ $(hash_file "$VERIFY_DIR/node.wasm") == "$NODE_SHA" ]]

"${WRANGLER[@]}" r2 object put "$BUCKET/current/node-claude.webc" --file "$WEBC" --content-type application/octet-stream --remote
"${WRANGLER[@]}" r2 object put "$BUCKET/current/node.wasm" --file "$WASM" --content-type application/wasm --remote

printf '%s\n' "Published and verified runtime artifacts: $WEBC_SHA"
