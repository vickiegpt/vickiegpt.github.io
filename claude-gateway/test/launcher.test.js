import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { constants as fsConstants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const LAUNCHER = fileURLToPath(
  new URL('../bin/run-claude-session.sh', import.meta.url),
);

async function createFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude launcher test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const workspace = path.join(root, "workspace ; $dollar [glob] 'quote'");
  const runtimeRoot = path.join(root, "runtime ; $dollar [glob] 'quote'");
  const nodeWasmu = path.join(runtimeRoot, "out Release", 'node.wasmu');
  const claudeCli = path.join(
    runtimeRoot,
    "claude package ; $dollar",
    'node_modules',
    '@anthropic-ai',
    'claude-code',
    'cli.js',
  );
  const fakeBin = path.join(root, 'fake bin');
  const capturePath = path.join(root, 'wasmer capture.json');

  await Promise.all([
    fs.mkdir(workspace, { recursive: true }),
    fs.mkdir(path.dirname(nodeWasmu), { recursive: true }),
    fs.mkdir(path.dirname(claudeCli), { recursive: true }),
    fs.mkdir(fakeBin, { recursive: true }),
  ]);
  await Promise.all([
    fs.writeFile(nodeWasmu, 'precompiled artifact fixture'),
    fs.writeFile(claudeCli, 'cli fixture'),
    fs.writeFile(path.join(fakeBin, 'wasmer'), `#!/opt/node22/bin/node
const fs = require('node:fs');

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  const keys = [
    'HOME',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
    'TERM',
    'COLORTERM',
  ];
  const env = Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null]));
  fs.writeFileSync(
    process.env.CAPTURE_PATH,
    JSON.stringify({ argv: process.argv.slice(2), env, stdin }),
  );
  if (process.env.FAKE_WASMER_STDOUT) process.stdout.write(process.env.FAKE_WASMER_STDOUT);
  if (process.env.FAKE_WASMER_STDERR) process.stderr.write(process.env.FAKE_WASMER_STDERR);
  process.exit(Number(process.env.FAKE_WASMER_EXIT ?? 0));
});
`),
  ]);
  await fs.chmod(path.join(fakeBin, 'wasmer'), 0o755);

  return {
    root,
    workspace,
    runtimeRoot,
    nodeWasmu,
    claudeCli,
    capturePath,
    env: {
      PATH: `${fakeBin}:/usr/bin:/bin`,
      SESSION_WORKSPACE: workspace,
      NODE_WASMU: nodeWasmu,
      NODE_WASM_ROOT: runtimeRoot,
      CLAUDE_CLI: claudeCli,
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic?mode=$fixed;safe',
      ANTHROPIC_AUTH_TOKEN: "secret ; $token [glob] 'quote'",
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      CAPTURE_PATH: capturePath,
    },
  };
}

function runLauncher(env, { args = [], input = '' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(LAUNCHER, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') reject(error);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function wasmerWasNotInvoked(capturePath) {
  await assert.rejects(fs.access(capturePath, fsConstants.F_OK), { code: 'ENOENT' });
}

test('rejects launcher arguments without invoking Wasmer', async (t) => {
  const fixture = await createFixture(t);
  const result = await runLauncher(fixture.env, {
    args: ['--model', 'browser-controlled'],
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /arguments/i);
  await wasmerWasNotInvoked(fixture.capturePath);
});

test('fails closed when required configuration is missing', async (t) => {
  const fixture = await createFixture(t);
  const required = [
    'SESSION_WORKSPACE',
    'NODE_WASMU',
    'NODE_WASM_ROOT',
    'CLAUDE_CLI',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
  ];

  for (const key of required) {
    const env = { ...fixture.env };
    delete env[key];
    const result = await runLauncher(env);
    assert.notEqual(result.code, 0, key);
    assert.equal(result.stdout, '', key);
    assert.equal(result.stderr.includes(fixture.env.ANTHROPIC_AUTH_TOKEN), false, key);
  }
  await wasmerWasNotInvoked(fixture.capturePath);
});

test('rejects missing, non-absolute, and unsafe configured paths', async (t) => {
  const fixture = await createFixture(t);
  const plainFile = path.join(fixture.root, 'not a directory');
  const outsideWasmu = path.join(fixture.root, 'outside.wasmu');
  const outsideCli = path.join(fixture.root, 'outside-cli.js');
  await Promise.all([
    fs.writeFile(plainFile, 'file'),
    fs.writeFile(outsideWasmu, 'wasmu'),
    fs.writeFile(outsideCli, 'cli'),
  ]);

  const invalid = [
    { SESSION_WORKSPACE: plainFile },
    { SESSION_WORKSPACE: 'relative-workspace' },
    { SESSION_WORKSPACE: `${fixture.workspace}:alias` },
    { NODE_WASM_ROOT: plainFile },
    { NODE_WASM_ROOT: 'relative-runtime' },
    { NODE_WASMU: path.join(fixture.root, 'missing.wasmu') },
    { NODE_WASMU: 'relative.wasmu' },
    { NODE_WASMU: outsideWasmu },
    { CLAUDE_CLI: path.join(fixture.root, 'missing-cli.js') },
    { CLAUDE_CLI: 'relative-cli.js' },
    { CLAUDE_CLI: outsideCli },
    { SESSION_WORKSPACE: fixture.runtimeRoot },
  ];

  for (const overrides of invalid) {
    const result = await runLauncher({ ...fixture.env, ...overrides });
    assert.notEqual(result.code, 0, JSON.stringify(Object.keys(overrides)));
    assert.equal(result.stdout, '');
    assert.equal(result.stderr.includes(fixture.env.ANTHROPIC_AUTH_TOKEN), false);
  }
  await wasmerWasNotInvoked(fixture.capturePath);
});

test('uses one exact fixed Wasmer argv with metacharacter-safe paths and secrets', async (t) => {
  const fixture = await createFixture(t);
  const result = await runLauncher(fixture.env);

  assert.equal(result.code, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
  const capture = JSON.parse(await fs.readFile(fixture.capturePath, 'utf8'));
  assert.deepEqual(capture.argv, [
    'run',
    '--stack-size',
    '8388608',
    '--net',
    '--mapdir',
    `/workspace:${fixture.workspace}`,
    '--dir',
    fixture.runtimeRoot,
    '--env',
    'HOME=/workspace',
    '--env',
    `ANTHROPIC_BASE_URL=${fixture.env.ANTHROPIC_BASE_URL}`,
    '--env',
    `ANTHROPIC_AUTH_TOKEN=${fixture.env.ANTHROPIC_AUTH_TOKEN}`,
    '--env',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
    '--env',
    'TERM=xterm-256color',
    '--env',
    'COLORTERM=truecolor',
    fixture.nodeWasmu,
    '--',
    fixture.claudeCli,
  ]);
  assert.deepEqual(capture.env, {
    HOME: fixture.workspace,
    ANTHROPIC_BASE_URL: fixture.env.ANTHROPIC_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: fixture.env.ANTHROPIC_AUTH_TOKEN,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: null,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  });
});

test('configuration failures never print secrets or configured paths', async (t) => {
  const fixture = await createFixture(t);
  const result = await runLauncher({
    ...fixture.env,
    CLAUDE_CLI: path.join(fixture.root, 'missing secret cli.js'),
  });
  const output = `${result.stdout}${result.stderr}`;

  assert.notEqual(result.code, 0);
  for (const sensitive of [
    fixture.env.ANTHROPIC_AUTH_TOKEN,
    fixture.env.ANTHROPIC_BASE_URL,
    fixture.workspace,
    fixture.runtimeRoot,
    fixture.nodeWasmu,
    fixture.claudeCli,
  ]) {
    assert.equal(output.includes(sensitive), false);
  }
  await wasmerWasNotInvoked(fixture.capturePath);
});

test('preserves terminal streams and propagates the Wasmer exit status', async (t) => {
  const fixture = await createFixture(t);
  const result = await runLauncher({
    ...fixture.env,
    FAKE_WASMER_STDOUT: 'terminal stdout\n',
    FAKE_WASMER_STDERR: 'terminal stderr\n',
    FAKE_WASMER_EXIT: '37',
  }, { input: 'terminal stdin\n' });

  assert.equal(result.code, 37);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, 'terminal stdout\n');
  assert.equal(result.stderr, 'terminal stderr\n');
  const capture = JSON.parse(await fs.readFile(fixture.capturePath, 'utf8'));
  assert.equal(capture.stdin, 'terminal stdin\n');
});
