#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = path.resolve(scriptDirectory, "../..");
const defaultConfigPath = path.join(scriptDirectory, "artifact-config.json");
const packageManifestPath = path.join(
  repositoryRoot,
  "packaging/node-claude/wasmer.toml",
);

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function resolveFromRoot(value, root = repositoryRoot) {
  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
}

async function requireRegularFile(filePath, label) {
  let info;
  try {
    info = await stat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${label} must be a regular file`);
    }
    throw error;
  }
  if (!info.isFile()) throw new Error(`${label} must be a regular file`);
  return info;
}

async function canonicalExistingFile(value, label) {
  const requested = resolveFromRoot(value);
  const linkInfo = await lstat(requested);
  if (linkInfo.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link`);
  }
  const canonical = await realpath(requested);
  await requireRegularFile(canonical, label);
  return canonical;
}

export async function sha256File(filePath) {
  const handle = await open(filePath, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

export async function validateInputs(config, options = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Artifact config must be an object");
  }

  const root = options.repositoryRoot ?? repositoryRoot;
  const nodeSource = await canonicalExistingFile(
    resolveFromRoot(config.nodeSource, root),
    "Node source",
  );
  const claudeSource = await canonicalExistingFile(
    config.claudeSource,
    "Claude source",
  );
  const yogaSource = await canonicalExistingFile(
    config.yogaSource,
    "Yoga source",
  );
  const canonicalRoot = await realpath(root);
  if (!isInside(canonicalRoot, nodeSource)) {
    throw new Error("Node source must stay inside the repository");
  }

  const magic = Buffer.alloc(4);
  const handle = await open(nodeSource, "r");
  try {
    const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
    if (bytesRead !== 4 || !magic.equals(Buffer.from([0x00, 0x61, 0x73, 0x6d]))) {
      throw new Error("Node source is not a WebAssembly binary");
    }
  } finally {
    await handle.close();
  }

  const webcOutput = resolveFromRoot(config.webcOutput, root);
  const manifestOutput = resolveFromRoot(config.manifestOutput, root);
  for (const [value, label] of [
    [webcOutput, "WEBC output"],
    [manifestOutput, "Runtime manifest output"],
  ]) {
    if (!isInside(canonicalRoot, value)) {
      throw new Error(`${label} must stay inside the repository`);
    }
  }

  return { nodeSource, claudeSource, yogaSource, webcOutput, manifestOutput };
}

async function productionRun(command, args) {
  return execFile(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function inspectPackage(run, wasmer, webcPath, inspectionDirectory) {
  await mkdir(inspectionDirectory, { recursive: false });
  await run(wasmer, [
    "package",
    "unpack",
    webcPath,
    "--out-dir",
    inspectionDirectory,
    "--format",
    "webc",
    "--quiet",
  ]);

  const manifest = JSON.parse(
    await readFile(path.join(inspectionDirectory, "manifest.json"), "utf8"),
  );
  if (manifest.entrypoint !== "node" || !manifest.commands?.node) {
    throw new Error("WEBC package does not expose the node command");
  }
  await requireRegularFile(path.join(inspectionDirectory, "node"), "Node atom");
  await requireRegularFile(
    path.join(inspectionDirectory, "app/claude-debug.mjs"),
    "Packaged Claude script",
  );
  await requireRegularFile(
    path.join(inspectionDirectory, "app/yoga.wasm"),
    "Packaged Yoga runtime",
  );
}

export async function build(config, adapters = {}) {
  const run = adapters.run ?? productionRun;
  const wasmer = adapters.wasmer ?? "wasmer";
  const makeTemporaryDirectory = adapters.mkdtemp ?? mkdtemp;
  const root = adapters.repositoryRoot ?? repositoryRoot;
  const validated = await validateInputs(config, { repositoryRoot: root });
  const versionResult = await run(wasmer, ["--version"]);
  if (String(versionResult.stdout ?? "").trim() !== `wasmer ${config.wasmerVersion}`) {
    throw new Error(`Wasmer ${config.wasmerVersion} is required`);
  }

  await mkdir(path.dirname(validated.webcOutput), { recursive: true });
  await mkdir(path.dirname(validated.manifestOutput), { recursive: true });
  const stage = await makeTemporaryDirectory(path.join(tmpdir(), "node-claude-webc-"));
  const appDirectory = path.join(stage, "app");
  const inspectionDirectory = path.join(stage, "inspection");
  const temporaryWebc = path.join(
    path.dirname(validated.webcOutput),
    `.${path.basename(validated.webcOutput)}.${process.pid}.tmp`,
  );
  const temporaryCli = path.join(
    path.dirname(validated.manifestOutput),
    `.claude-debug.mjs.${process.pid}.tmp`,
  );
  const publicCli = path.join(root, "about/claude-debug.mjs");
  const temporaryManifest = `${validated.manifestOutput}.${process.pid}.tmp`;

  try {
    await mkdir(path.dirname(publicCli), { recursive: true });
    await mkdir(appDirectory);
    await Promise.all([
      copyFile(packageManifestPath, path.join(stage, "wasmer.toml")),
      copyFile(validated.claudeSource, path.join(appDirectory, "claude-debug.mjs")),
      copyFile(validated.yogaSource, path.join(appDirectory, "yoga.wasm")),
      copyFile(validated.claudeSource, temporaryCli),
    ]);
    await run("wasm-strip", [
      validated.nodeSource,
      "-o",
      path.join(stage, "node.wasm"),
    ]);
    await requireRegularFile(path.join(stage, "node.wasm"), "Stripped Node atom");

    await run(wasmer, [
      "package",
      "build",
      stage,
      "--out",
      temporaryWebc,
      "--quiet",
    ]);
    await inspectPackage(run, wasmer, temporaryWebc, inspectionDirectory);

    const webcInfo = await requireRegularFile(temporaryWebc, "WEBC output");
    const [sha256, nodeSha256] = await Promise.all([
      sha256File(temporaryWebc),
      sha256File(validated.nodeSource),
    ]);
    const manifest = {
      schema: 1,
      url: "/about/node-claude.webc",
      size: webcInfo.size,
      sha256,
      nodeSha256,
      sdkVersion: config.sdkVersion,
      nodeVersion: "25.0.0-pre",
      claudeVersion: config.claudeVersion,
      command: config.command,
      args: ["/app/claude-debug.mjs"],
    };
    await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o644,
      flag: "wx",
    });
    await rename(temporaryWebc, validated.webcOutput);
    await rename(temporaryCli, publicCli);
    await rename(temporaryManifest, validated.manifestOutput);
    return { ...manifest, output: validated.webcOutput };
  } finally {
    await Promise.allSettled([
      rm(stage, { recursive: true, force: true }),
      rm(temporaryWebc, { force: true }),
      rm(temporaryCli, { force: true }),
      rm(temporaryManifest, { force: true }),
    ]);
  }
}

export async function loadDefaultConfig() {
  return JSON.parse(await readFile(defaultConfigPath, "utf8"));
}

async function main() {
  const config = await loadDefaultConfig();
  const result = await build(config);
  process.stdout.write(
    `Built ${path.relative(repositoryRoot, result.output)} (${result.size} bytes, sha256 ${result.sha256})\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`WEBC build failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
