import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const publisher = join(root, "tools/node-claude/publish-r2.sh");

async function fixture({ corruptDownload = false } = {}) {
  const temp = await mkdtemp(join(tmpdir(), "claude-r2-"));
  const artifacts = join(temp, "artifacts with spaces;not-a-command");
  await mkdir(artifacts);
  const webc = join(artifacts, "node-claude.webc");
  const wasm = join(artifacts, "node.wasm");
  await writeFile(webc, "webc-fixture");
  await writeFile(wasm, "wasm-fixture");
  const webcSha = execFileSync("sha256sum", [webc], { encoding: "utf8" }).split(" ")[0];
  const nodeSha = execFileSync("sha256sum", [wasm], { encoding: "utf8" }).split(" ")[0];
  const manifest = join(temp, "manifest.json");
  await writeFile(manifest, JSON.stringify({ sha256: webcSha, nodeSha256: nodeSha }));
  const log = join(temp, "calls.log");
  const fake = join(temp, "wrangler");
  await writeFile(fake, `#!/usr/bin/env bash
set -euo pipefail
printf '%q ' "$@" >> "$FAKE_LOG"
printf '\\n' >> "$FAKE_LOG"
if [[ "$1 $2 $3" == "r2 object get" ]]; then
  output=""
  for ((i=1; i<=$#; i++)); do
    if [[ "\${!i}" == "--file" ]]; then j=$((i+1)); output="\${!j}"; fi
  done
  if [[ "$4" == *node-claude.webc ]]; then cp "$FAKE_WEBC" "$output"; else cp "$FAKE_WASM" "$output"; fi
  if [[ "\${FAKE_CORRUPT:-0}" == 1 ]]; then printf x >> "$output"; fi
fi
`);
  execFileSync("chmod", ["+x", fake]);
  return { temp, artifacts, manifest, log, fake, webc, wasm, corruptDownload };
}

function run(item) {
  return spawnSync("bash", [publisher], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      WRANGLER_BIN: item.fake,
      ARTIFACT_DIR: item.artifacts,
      MANIFEST_PATH: item.manifest,
      FAKE_LOG: item.log,
      FAKE_WEBC: item.webc,
      FAKE_WASM: item.wasm,
      FAKE_CORRUPT: item.corruptDownload ? "1" : "0",
    },
  });
}

describe("R2 artifact publisher", () => {
  it("verifies immutable uploads before updating current aliases", async () => {
    const item = await fixture();
    const result = run(item);
    assert.equal(result.status, 0, result.stderr);
    const calls = (await readFile(item.log, "utf8")).trim().split("\n");
    assert.equal(calls.length, 6);
    assert.match(calls[0], /artifacts\/.+\/node-claude\.webc/);
    assert.match(calls[1], /artifacts\/.+\/node\.wasm/);
    assert.match(calls[2], /object get/);
    assert.match(calls[3], /object get/);
    assert.match(calls[4], /current\/node-claude\.webc/);
    assert.match(calls[5], /current\/node\.wasm/);
    assert.doesNotMatch(result.stdout + result.stderr, /secret|token|api.?key/i);
  });

  it("never updates aliases after a downloaded hash mismatch", async () => {
    const item = await fixture({ corruptDownload: true });
    const result = run(item);
    assert.notEqual(result.status, 0);
    const log = await readFile(item.log, "utf8");
    assert.doesNotMatch(log, /current\//);
  });
});
