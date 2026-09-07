import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { SessionManager } from '../src/session.js';

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
  }

  send(frame) {
    this.sent.push(JSON.parse(frame));
  }
}

class FakePty {
  constructor() {
    this.writes = [];
    this.resizes = [];
    this.killCount = 0;
    this.dataListeners = new Set();
    this.exitListeners = new Set();
  }

  write(data) {
    this.writes.push(data);
  }

  resize(cols, rows) {
    this.resizes.push([cols, rows]);
  }

  kill() {
    this.killCount += 1;
  }

  onData(listener) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener) {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  emitData(data) {
    for (const listener of [...this.dataListeners]) listener(data);
  }

  emitExit(event) {
    for (const listener of [...this.exitListeners]) listener(event);
  }
}

class FakeTimers {
  constructor() {
    this.nextId = 1;
    this.callbacks = new Map();
    this.cleared = [];
  }

  setTimeout(callback, delay) {
    const id = this.nextId++;
    this.callbacks.set(id, { callback, delay });
    return id;
  }

  clearTimeout(id) {
    this.cleared.push(id);
    this.callbacks.delete(id);
  }

  latestId() {
    return this.nextId - 1;
  }

  async fire(id) {
    const entry = this.callbacks.get(id);
    if (entry === undefined) return;
    this.callbacks.delete(id);
    await entry.callback();
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness(overrides = {}) {
  const ptys = [];
  const spawnCalls = [];
  const removed = [];
  const timers = new FakeTimers();
  let workspaceNumber = 0;
  const fs = {
    async mkdtemp(prefix) {
      workspaceNumber += 1;
      return `${prefix}${workspaceNumber}`;
    },
    async rm(workspace, options) {
      removed.push({ workspace, options });
    },
    ...overrides.fs,
  };
  const pty = {
    spawn(executable, argv, options) {
      const instance = new FakePty();
      ptys.push(instance);
      spawnCalls.push({ executable, argv, options });
      return instance;
    },
    ...overrides.pty,
  };
  const config = {
    workspaceRoot: '/srv/claude-workspaces',
    launcher: '/opt/claude/bin/claude',
    childEnv: { HOME: '/non-host-home', LANG: 'C.UTF-8' },
    maxSessions: 2,
    idleTimeoutMs: 30_000,
    ...overrides.config,
  };
  const manager = new SessionManager(config, {
    fs,
    pty,
    timers,
    ...overrides.adapters,
  });
  return { manager, fs, pty, ptys, spawnCalls, removed, timers, config };
}

test('creates a unique verified workspace beneath workspaceRoot for each session', async () => {
  const harness = createHarness();
  const first = await harness.manager.create(new FakeSocket(), { cols: 80, rows: 24 });
  const second = await harness.manager.create(new FakeSocket(), { cols: 80, rows: 24 });

  const workspaces = harness.spawnCalls.map((call) => call.options.cwd);
  assert.equal(new Set(workspaces).size, 2);
  assert.equal(workspaces.every((workspace) => workspace.startsWith('/srv/claude-workspaces/')), true);

  await Promise.all([first.close(), second.close()]);
});

test('spawns only the configured launcher with empty argv and an explicit child environment', async () => {
  const harness = createHarness();
  const socket = new FakeSocket();
  socket.launcher = '/tmp/client-launcher';
  socket.argv = ['--client-controlled'];
  socket.env = { PATH: '/tmp/client-path' };

  const session = await harness.manager.create(socket, {
    cols: 90,
    rows: 30,
    launcher: '/tmp/size-launcher',
    argv: ['--size-controlled'],
    env: { SECRET: 'client-value' },
  });

  assert.deepEqual(harness.spawnCalls[0], {
    executable: '/opt/claude/bin/claude',
    argv: [],
    options: {
      name: 'xterm-256color',
      cols: 90,
      rows: 30,
      cwd: '/srv/claude-workspaces/claude-session-1',
      env: {
        HOME: '/non-host-home',
        LANG: 'C.UTF-8',
        SESSION_WORKSPACE: '/srv/claude-workspaces/claude-session-1',
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
    },
  });

  await session.close();
});

test('writes terminal input only through the explicit session input method', async () => {
  const harness = createHarness();
  const socket = new FakeSocket();
  const session = await harness.manager.create(socket, { cols: 80, rows: 24 });

  socket.emit('message', JSON.stringify({ type: 'input', data: 'untrusted\n' }));
  assert.deepEqual(harness.ptys[0].writes, []);

  session.write('trusted\n');
  assert.deepEqual(harness.ptys[0].writes, ['trusted\n']);

  await session.close();
});

test('clamps initial and later terminal sizes before invoking the PTY', async () => {
  const harness = createHarness();
  const session = await harness.manager.create(new FakeSocket(), { cols: 999, rows: 1 });

  assert.deepEqual(
    { cols: harness.spawnCalls[0].options.cols, rows: harness.spawnCalls[0].options.rows },
    { cols: 240, rows: 5 },
  );
  session.resize(2, 999);
  assert.deepEqual(harness.ptys[0].resizes, [[20, 100]]);

  await session.close();
});

test('terminal activity resets the idle timeout and the current timeout kills the PTY', async () => {
  const harness = createHarness();
  const session = await harness.manager.create(new FakeSocket(), { cols: 80, rows: 24 });
  const initialTimer = harness.timers.latestId();

  session.write('activity');
  const resetTimer = harness.timers.latestId();
  assert.notEqual(resetTimer, initialTimer);
  assert.equal(harness.timers.cleared.includes(initialTimer), true);

  await harness.timers.fire(initialTimer);
  assert.equal(harness.ptys[0].killCount, 0);
  await harness.timers.fire(resetTimer);
  assert.equal(harness.ptys[0].killCount, 1);
  assert.equal(harness.manager.activeCount, 0);
});

test('PTY output resets the idle timeout', async () => {
  const harness = createHarness();
  const session = await harness.manager.create(new FakeSocket(), { cols: 80, rows: 24 });
  const initialTimer = harness.timers.latestId();

  harness.ptys[0].emitData('output activity');
  const resetTimer = harness.timers.latestId();
  assert.notEqual(resetTimer, initialTimer);
  assert.equal(harness.timers.cleared.includes(initialTimer), true);

  await harness.timers.fire(initialTimer);
  assert.equal(harness.ptys[0].killCount, 0);
  await harness.timers.fire(resetTimer);
  assert.equal(harness.ptys[0].killCount, 1);
  assert.equal(harness.manager.activeCount, 0);
  await session.close();
});

test('terminal resize resets the idle timeout', async () => {
  const harness = createHarness();
  const session = await harness.manager.create(new FakeSocket(), { cols: 80, rows: 24 });
  const initialTimer = harness.timers.latestId();

  session.resize(100, 40);
  const resetTimer = harness.timers.latestId();
  assert.notEqual(resetTimer, initialTimer);
  assert.equal(harness.timers.cleared.includes(initialTimer), true);

  await harness.timers.fire(initialTimer);
  assert.equal(harness.ptys[0].killCount, 0);
  await harness.timers.fire(resetTimer);
  assert.equal(harness.ptys[0].killCount, 1);
  assert.equal(harness.manager.activeCount, 0);
});

test('socket close kills the PTY and recursively removes its workspace', async () => {
  const harness = createHarness();
  const socket = new FakeSocket();
  const session = await harness.manager.create(socket, { cols: 80, rows: 24 });

  socket.emit('close');
  await session.close();

  assert.equal(harness.ptys[0].killCount, 1);
  assert.deepEqual(harness.removed, [{
    workspace: '/srv/claude-workspaces/claude-session-1',
    options: { recursive: true, force: true },
  }]);
  assert.equal(harness.manager.activeCount, 0);
});

test('relays PTY output and emits one normalized exit frame before releasing capacity', async () => {
  const harness = createHarness({ config: { maxSessions: 1 } });
  const socket = new FakeSocket();
  const session = await harness.manager.create(socket, { cols: 80, rows: 24 });

  harness.ptys[0].emitData('hello');
  harness.ptys[0].emitExit({ exitCode: 7, signal: 15 });
  harness.ptys[0].emitExit({ exitCode: 8, signal: 9 });
  await session.close();

  assert.deepEqual(socket.sent.filter((frame) => frame.type === 'output'), [
    { type: 'output', data: 'hello' },
  ]);
  assert.deepEqual(socket.sent.filter((frame) => frame.type === 'exit'), [
    { type: 'exit', code: 7, signal: 15 },
  ]);
  assert.equal(harness.ptys[0].killCount, 0);
  assert.equal(harness.manager.activeCount, 0);
});

test('normalizes absent PTY exit details to null', async () => {
  const harness = createHarness();
  const socket = new FakeSocket();
  const session = await harness.manager.create(socket, { cols: 80, rows: 24 });

  harness.ptys[0].emitExit({});
  await session.close();

  assert.deepEqual(socket.sent.find((frame) => frame.type === 'exit'), {
    type: 'exit',
    code: null,
    signal: null,
  });
});

test('close, exit, and timeout races clean resources and capacity exactly once', async () => {
  const harness = createHarness();
  const socket = new FakeSocket();
  const session = await harness.manager.create(socket, { cols: 80, rows: 24 });
  const timer = harness.timers.latestId();

  const timeout = harness.timers.fire(timer);
  socket.emit('close');
  harness.ptys[0].emitExit({ exitCode: 0, signal: null });
  await Promise.all([timeout, session.close(), session.close()]);

  assert.equal(harness.ptys[0].killCount, 1);
  assert.equal(harness.removed.length, 1);
  assert.equal(harness.manager.activeCount, 0);
  assert.equal(socket.sent.filter((frame) => frame.type === 'exit').length <= 1, true);
});

test('reserves capacity before asynchronous workspace creation completes', async () => {
  const workspace = deferred();
  const harness = createHarness({
    config: { maxSessions: 1 },
    fs: { mkdtemp: () => workspace.promise },
  });

  const firstCreate = harness.manager.create(new FakeSocket(), { cols: 80, rows: 24 });
  assert.equal(harness.manager.activeCount, 1);
  await assert.rejects(
    harness.manager.create(new FakeSocket(), { cols: 80, rows: 24 }),
    /Unable to create session/,
  );

  workspace.resolve('/srv/claude-workspaces/claude-session-deferred');
  const session = await firstCreate;
  await session.close();
});

test('workspace creation failure releases reserved capacity without leaking host paths', async () => {
  const socket = new FakeSocket();
  const harness = createHarness({
    config: { maxSessions: 1 },
    fs: { mkdtemp: async () => { throw new Error('/host/private/workspace denied'); } },
  });

  await assert.rejects(
    harness.manager.create(socket, { cols: 80, rows: 24 }),
    (error) => error.message === 'Unable to create session',
  );
  assert.equal(harness.manager.activeCount, 0);
  assert.deepEqual(harness.removed, []);
  assert.equal(JSON.stringify(socket.sent).includes('/host/private'), false);
});

test('spawn failure releases capacity and removes the verified workspace', async () => {
  const socket = new FakeSocket();
  const harness = createHarness({
    config: { maxSessions: 1 },
    pty: { spawn: () => { throw new Error('/host/private/launcher failed'); } },
  });

  await assert.rejects(
    harness.manager.create(socket, { cols: 80, rows: 24 }),
    (error) => error.message === 'Unable to create session',
  );
  assert.equal(harness.manager.activeCount, 0);
  assert.deepEqual(harness.removed.map((entry) => entry.workspace), [
    '/srv/claude-workspaces/claude-session-1',
  ]);
  assert.equal(JSON.stringify(socket.sent).includes('/host/private'), false);
});

test('partial PTY subscription failure disposes listeners and cleans startup resources', async () => {
  const partialPty = new FakePty();
  let dataListenerDisposed = false;
  partialPty.onData = (listener) => {
    partialPty.dataListeners.add(listener);
    return {
      dispose() {
        dataListenerDisposed = true;
        partialPty.dataListeners.delete(listener);
      },
    };
  };
  partialPty.onExit = () => {
    throw new Error('exit subscription failed');
  };
  const harness = createHarness({
    config: { maxSessions: 1 },
    pty: { spawn: () => partialPty },
  });

  await assert.rejects(
    harness.manager.create(new FakeSocket(), { cols: 80, rows: 24 }),
    /Unable to create session/,
  );

  assert.equal(dataListenerDisposed, true);
  assert.equal(partialPty.dataListeners.size, 0);
  assert.equal(partialPty.killCount, 1);
  assert.deepEqual(harness.removed.map((entry) => entry.workspace), [
    '/srv/claude-workspaces/claude-session-1',
  ]);
  assert.equal(harness.manager.activeCount, 0);
});

test('never removes an unverified workspace returned outside workspaceRoot', async () => {
  const harness = createHarness({
    fs: { mkdtemp: async () => '/srv/claude-workspaces-escape/session-1' },
  });

  await assert.rejects(
    harness.manager.create(new FakeSocket(), { cols: 80, rows: 24 }),
    /Unable to create session/,
  );
  assert.deepEqual(harness.removed, []);
  assert.equal(harness.manager.activeCount, 0);
});

test('shutdown terminates active and starting sessions and rejects later creates', async () => {
  const workspace = deferred();
  let mkdtempCalls = 0;
  const harness = createHarness({
    config: { maxSessions: 2 },
    fs: {
      mkdtemp(prefix) {
        mkdtempCalls += 1;
        return mkdtempCalls === 1 ? `${prefix}active` : workspace.promise;
      },
    },
  });
  const active = await harness.manager.create(new FakeSocket(), { cols: 80, rows: 24 });
  const startingCreate = harness.manager.create(new FakeSocket(), { cols: 80, rows: 24 });

  const shutdown = harness.manager.shutdown();
  workspace.resolve('/srv/claude-workspaces/claude-session-starting');
  await shutdown;
  await assert.rejects(startingCreate, /Unable to create session/);

  assert.equal(harness.ptys[0].killCount, 1);
  assert.equal(harness.removed.length, 2);
  assert.equal(harness.manager.activeCount, 0);
  await assert.rejects(
    harness.manager.create(new FakeSocket(), { cols: 80, rows: 24 }),
    /Unable to create session/,
  );
  await active.close();
});

test('requires positive integer session and idle timeout limits', () => {
  for (const [key, value] of [
    ['maxSessions', 0],
    ['maxSessions', 1.5],
    ['idleTimeoutMs', -1],
    ['idleTimeoutMs', Number.POSITIVE_INFINITY],
  ]) {
    assert.throws(
      () => createHarness({ config: { [key]: value } }),
      /positive integer/,
    );
  }
});
