import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("artifact inputs are pinned", () => {
  const config = JSON.parse(
    fs.readFileSync(new URL("./artifact-config.json", import.meta.url)),
  );

  assert.deepEqual(config, {
    wasmerVersion: "6.1.0",
    sdkVersion: "0.11.0",
    claudeVersion: "2.0.0",
    nodeSource: "about/node.wasm",
    claudeSource:
      "/home/out/claude-code-js-2.0.0/node_modules/@anthropic-ai/claude-code/cli.js",
    yogaSource:
      "/home/out/claude-code-js-2.0.0/node_modules/@anthropic-ai/claude-code/yoga.wasm",
    webcOutput: "about/node-claude.webc",
    manifestOutput: "about/runtime-manifest.json",
    command: "node",
  });
});

test("large artifacts use Git LFS", () => {
  const attributes = fs.readFileSync(
    new URL("../../.gitattributes", import.meta.url),
    "utf8",
  );

  assert.match(
    attributes,
    /^about\/node\.wasm filter=lfs diff=lfs merge=lfs -text$/m,
  );
  assert.match(
    attributes,
    /^about\/node-claude\.webc filter=lfs diff=lfs merge=lfs -text$/m,
  );
});
