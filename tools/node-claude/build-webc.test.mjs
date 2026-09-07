import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  build,
  loadDefaultConfig,
  sha256File,
  validateInputs,
} from "./build-webc.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "node-claude-test-"));
  await mkdir(path.join(root, "about"));
  const nodeSource = path.join(root, "about/node.wasm");
  const claudeSource = path.join(root, "claude.js");
  const output = path.join(root, "node-claude.webc");
  const manifest = path.join(root, "runtime-manifest.json");
  await writeFile(nodeSource, Buffer.from([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
  await writeFile(claudeSource, "console.log('fixture')\n");
  return {
    root,
    nodeSource,
    claudeSource,
    output,
    manifest,
    config: {
      wasmerVersion: "6.1.0",
      sdkVersion: "0.11.0",
      claudeVersion: "2.0.0",
      nodeSource,
      claudeSource,
      webcOutput: output,
      manifestOutput: manifest,
      command: "node",
    },
  };
}

test("rejects a source without WebAssembly magic", async () => {
  const value = await fixture();
  await writeFile(value.nodeSource, "not wasm");
  await assert.rejects(
    validateInputs(value.config, { repositoryRoot: value.root }),
    /not a WebAssembly binary/,
  );
});

test("rejects symbolic-link build inputs", async () => {
  const value = await fixture();
  const link = path.join(value.root, "node-link.wasm");
  const { symlink } = await import("node:fs/promises");
  await symlink(value.nodeSource, link);
  await assert.rejects(
    validateInputs(
      { ...value.config, nodeSource: link },
      { repositoryRoot: value.root },
    ),
    /must not be a symbolic link/,
  );
});

test("builds metadata only after package inspection", async () => {
  const value = await fixture();
  const invocations = [];
  const run = async (_command, args) => {
    invocations.push(args);
    if (args[0] === "--version") return { stdout: "wasmer 6.1.0\n", stderr: "" };
    if (args[1] === "build") {
      await writeFile(args[args.indexOf("--out") + 1], "fake webc bytes");
      return { stdout: "", stderr: "" };
    }
    const destination = args[args.indexOf("--out-dir") + 1];
    await mkdir(path.join(destination, "app"), { recursive: true });
    await writeFile(path.join(destination, "node"), "atom");
    await writeFile(path.join(destination, "app/claude-debug.mjs"), "cli");
    await writeFile(
      path.join(destination, "manifest.json"),
      JSON.stringify({ entrypoint: "node", commands: { node: {} } }),
    );
    return { stdout: "", stderr: "" };
  };

  const result = await build(value.config, {
    run,
    repositoryRoot: value.root,
  });
  assert.equal(result.sha256, await sha256File(value.output));
  assert.equal(result.size, (await stat(value.output)).size);
  assert.deepEqual(result.args, ["/app/claude-debug.mjs"]);
  assert.equal(JSON.parse(await readFile(value.manifest, "utf8")).sha256, result.sha256);
  assert.equal(invocations.filter((args) => args[1] === "build").length, 1);
  assert.equal(invocations.filter((args) => args[1] === "unpack").length, 1);
});

test("rejects an incompatible Wasmer version before building", async () => {
  const value = await fixture();
  await assert.rejects(
    build(value.config, {
      repositoryRoot: value.root,
      run: async () => ({ stdout: "wasmer 7.0.0\n" }),
    }),
    /Wasmer 6\.1\.0 is required/,
  );
});

test("real package matches its runtime manifest", async (t) => {
  if (process.env.RUN_REAL_WEBC !== "1") {
    t.skip("set RUN_REAL_WEBC=1 to build the full package");
    return;
  }
  const result = await build(await loadDefaultConfig());
  assert.equal(result.sha256, await sha256File(result.output));
  assert.equal(result.size, (await stat(result.output)).size);
  assert.equal(result.url, "/about/node-claude.webc");
});
