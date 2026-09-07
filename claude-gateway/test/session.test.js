import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SessionManager } from '../src/session.js';

class FakeSocket extends EventEmitter {
  constructor({ readyState = 1, autoClose = true } = {}) {
    super();
    this.sent = [];
    this.readyState = readyState;
    this.bufferedAmount = 0;
    this.autoClose = autoClose;
    this.closeCalls = [];
    this.terminateCount = 0;
    this.sendBehavior = null;
  }

  send(frame, callback) {
    if (this.sendBehavior !== null) return this.sendBehavior(frame, callback);
    this.sent.push(JSON.parse(frame));
    callback?.();
    return undefined;
  }

  close(code, reason) {
    this.closeCalls.push({ code, reason });
    this.readyState = 2;
    if (this.autoClose) {
      queueMicrotask(() => {
        this.readyState = 3;
        this.emit('close');
      });
    }
  }

  terminate() {
    this.terminateCount += 1;
    this.readyState = 3;
    this.emit('close');
  }
}

class FakePty extends EventEmitter {
  constructor({ autoExit = true } = {}) {
    super();
    this.writes = [];
    this.resizes = [];
    this.killCount = 0;
    this.killSignals = [];
    this.autoExit = autoExit;
    this.dataListeners = new Set();
    this.exitListeners = new Set();
  }

  write(data) {
    this.writes.push(data);
  }

  resize(cols, rows) {
    this.resizes.push([cols, rows]);
  }

  kill(signal) {
    this.killCount += 1;
    this.killSignals.push(signal);
    if (this.autoExit) {
      queueMicrotask(() => this.emitExit({ exitCode: null, signal: signal ?? null }));
    }
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
    this.emit('exit', event);
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
  let nextInode = 100;
  const nodes = new Map([
    ['/srv/claude-workspaces', { dev: 1, ino: 1, directory: true, symlink: false }],
  ]);
  const fsOverrides = overrides.fs ?? {};
  const fs = {
    async mkdtemp(prefix) {
      const workspace = fsOverrides.mkdtemp === undefined
        ? `${prefix}${++workspaceNumber}`
        : await fsOverrides.mkdtemp(prefix);
      if (!nodes.has(workspace)) {
        nodes.set(workspace, { dev: 1, ino: nextInode++, directory: true, symlink: false });
      }
      return workspace;
    },
    async realpath(target) {
      if (fsOverrides.realpath !== undefined) return fsOverrides.realpath(target);
      if (!nodes.has(target)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return target;
    },
    async lstat(target) {
      if (fsOverrides.lstat !== undefined) return fsOverrides.lstat(target);
      const node = nodes.get(target);
      if (node === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return {
        dev: node.dev,
        ino: node.ino,
        isDirectory: () => node.directory,
        isSymbolicLink: () => node.symlink,
      };
    },
    async rm(workspace, options) {
      removed.push({ workspace, options });
      if (fsOverrides.rm !== undefined) await fsOverrides.rm(workspace, options);
      nodes.delete(workspace);
    },
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
    terminationGraceMs: 20,
    killGraceMs: 20,
    socketCloseTimeoutMs: 20,
    maxBufferedBytes: 1024 * 1024,
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

test('waits for asynchronous PTY exit before removing the workspace', async () => {
  const pty = new FakePty({ autoExit: false });
  const harness = createHarness({ pty: { spawn: () => pty } });
  const session = await harness.manager.create(new FakeSocket(), { cols: 80, rows: 24 });

  const closing = session.close();
  await Promise.resolve();
  assert.equal(pty.killSignals[0], 'SIGTERM');
  assert.equal(harness.removed.length, 0);

  pty.emitExit({ exitCode: 0, signal: null });
  await closing;
  assert.equal(harness.removed.length, 1);
  assert.equal(harness.manager.activeCount, 0);
});

test('escalates from SIGTERM to SIGKILL when the PTY misses its grace period', async () => {
  const pty = new FakePty({ autoExit: false });
  pty.kill = (signal) => {
    pty.killCount += 1;
    pty.killSignals.push(signal);
    if (signal === 'SIGKILL') queueMicrotask(() => pty.emitExit({ exitCode: null, signal: 9 }));
  };
  const harness = createHarness({
    config: { terminationGraceMs: 1 },
    pty: { spawn: () => pty },
    adapters: { timers: { setTimeout, clearTimeout } },
  });
  const session = await harness.manager.create(new FakeSocket(), { cols: 80, rows: 24 });

  await session.close();

  assert.deepEqual(pty.killSignals, ['SIGTERM', 'SIGKILL']);
  assert.equal(harness.removed.length, 1);
  assert.equal(harness.manager.activeCount, 0);
});

test('rejects cleanup and retains capacity when PTY exit cannot be confirmed', async () => {
  const pty = new FakePty({ autoExit: false });
  const harness = createHarness({
    config: { maxSessions: 1, terminationGraceMs: 1, killGraceMs: 1 },
    pty: { spawn: () => pty },
    adapters: { timers: { setTimeout, clearTimeout } },
  });
  const session = await harness.manager.create(new FakeSocket(), { cols: 80, rows: 24 });

  await assert.rejects(session.close(), /cleanup failed/i);

  assert.deepEqual(pty.killSignals, ['SIGTERM', 'SIGKILL']);
  assert.equal(harness.removed.length, 0);
  assert.equal(harness.manager.activeCount, 1);
});

test('propagates kill failures without deleting the workspace or releasing capacity', async () => {
  const pty = new FakePty({ autoExit: false });
  pty.kill = (signal) => {
    pty.killCount += 1;
    pty.killSignals.push(signal);
    throw new Error('kill failed');
  };
  const harness = createHarness({
    config: { maxSessions: 1, terminationGraceMs: 1, killGraceMs: 1 },
    pty: { spawn: () => pty },
    adapters: { timers: { setTimeout, clearTimeout } },
  });
  const session = await harness.manager.create(new FakeSocket(), { cols: 80, rows: 24 });

  await assert.rejects(session.close(), /cleanup failed/i);

  assert.deepEqual(pty.killSignals, ['SIGTERM', 'SIGKILL']);
  assert.equal(harness.removed.length, 0);
  assert.equal(harness.manager.activeCount, 1);
});

test('propagates workspace removal failure and retains capacity', async () => {
  const harness = createHarness({
    config: { maxSessions: 1 },
    fs: { rm: async () => { throw new Error('rm failed'); } },
  });
  const session = await harness.manager.create(new FakeSocket(), { cols: 80, rows: 24 });

  await assert.rejects(session.close(), /cleanup failed/i);

  assert.equal(harness.removed.length, 1);
  assert.equal(harness.manager.activeCount, 1);
});

test('shutdown aggregates cleanup failures and keeps failed sessions reserved', async () => {
  const pty = new FakePty({ autoExit: false });
  const harness = createHarness({
    config: { maxSessions: 1, terminationGraceMs: 1, killGraceMs: 1 },
    pty: { spawn: () => pty },
    adapters: { timers: { setTimeout, clearTimeout } },
  });
  await harness.manager.create(new FakeSocket(), { cols: 80, rows: 24 });

  await assert.rejects(harness.manager.shutdown(), AggregateError);
  assert.equal(harness.manager.activeCount, 1);
  await assert.rejects(
    harness.manager.create(new FakeSocket(), { cols: 80, rows: 24 }),
    /Unable to create session/,
  );
});

test('does not send on an already-closed socket', async () => {
  const harness = createHarness();
  const socket = new FakeSocket({ readyState: 3 });
  const session = await harness.manager.create(socket, { cols: 80, rows: 24 });

  harness.ptys[0].emitData('must not be sent');
  harness.ptys[0].emitExit({ exitCode: 0, signal: null });
  await session.close();

  assert.deepEqual(socket.sent, []);
  assert.deepEqual(socket.closeCalls, []);
});

test('backpressure closes one noisy session without sending more output', async () => {
  const harness = createHarness({ config: { maxBufferedBytes: 8 } });
  const socket = new FakeSocket();
  const session = await harness.manager.create(socket, { cols: 80, rows: 24 });
  socket.sent.length = 0;
  socket.bufferedAmount = 9;

  for (let index = 0; index < 100; index += 1) harness.ptys[0].emitData('noise');
  await session.close();

  assert.equal(socket.sent.filter((frame) => frame.type === 'output').length, 0);
  assert.equal(socket.closeCalls.length, 1);
  assert.equal(harness.ptys[0].killCount, 1);
  assert.equal(harness.removed.length, 1);
});

test('synchronous socket send failure triggers one cleanup cascade', async () => {
  const harness = createHarness();
  const socket = new FakeSocket();
  const session = await harness.manager.create(socket, { cols: 80, rows: 24 });
  socket.sendBehavior = () => { throw new Error('/host/private/socket failed'); };

  harness.ptys[0].emitData('output');
  await session.close();

  assert.equal(socket.closeCalls.length, 1);
  assert.equal(harness.ptys[0].killCount, 1);
  assert.equal(harness.removed.length, 1);
  assert.equal(JSON.stringify(socket.closeCalls).includes('/host/private'), false);
});

test('synchronous final-state send failure cannot re-enter cleanup', async () => {
  const harness = createHarness();
  const socket = new FakeSocket();
  const session = await harness.manager.create(socket, { cols: 80, rows: 24 });
  socket.sendBehavior = () => { throw new Error('final state failed'); };

  await session.close();

  assert.equal(socket.closeCalls.length, 1);
  assert.equal(harness.ptys[0].killCount, 1);
  assert.equal(harness.removed.length, 1);
  assert.equal(harness.manager.activeCount, 0);
});

test('socket send callback error triggers cleanup without duplication', async () => {
  const harness = createHarness();
  const socket = new FakeSocket();
  const session = await harness.manager.create(socket, { cols: 80, rows: 24 });
  socket.sendBehavior = (_frame, callback) => callback(new Error('callback failed'));

  harness.ptys[0].emitData('output');
  await session.close();

  assert.equal(socket.closeCalls.length, 1);
  assert.equal(harness.ptys[0].killCount, 1);
  assert.equal(harness.manager.activeCount, 0);
});

test('rejected thenable from socket send triggers cleanup without unhandled rejection', async () => {
  const harness = createHarness();
  const socket = new FakeSocket();
  const session = await harness.manager.create(socket, { cols: 80, rows: 24 });
  socket.sendBehavior = () => Promise.reject(new Error('async send failed'));

  harness.ptys[0].emitData('output');
  await Promise.resolve();
  await session.close();

  assert.equal(socket.closeCalls.length, 1);
  assert.equal(harness.ptys[0].killCount, 1);
  assert.equal(harness.manager.activeCount, 0);
});

test('terminates a socket that does not complete the close handshake', async () => {
  const harness = createHarness({
    config: { socketCloseTimeoutMs: 2 },
    adapters: { timers: { setTimeout, clearTimeout } },
  });
  const socket = new FakeSocket({ autoClose: false });
  const session = await harness.manager.create(socket, { cols: 80, rows: 24 });

  await session.close();

  assert.equal(socket.closeCalls.length, 1);
  assert.equal(socket.terminateCount, 1);
});

test('supports an injected socket OPEN constant', async () => {
  const harness = createHarness({ adapters: { socketOpenState: 7 } });
  const socket = new FakeSocket({ readyState: 7 });
  const session = await harness.manager.create(socket, { cols: 80, rows: 24 });

  harness.ptys[0].emitData('visible');
  await session.close();

  assert.equal(socket.sent.some((frame) => frame.type === 'output' && frame.data === 'visible'), true);
});

test('rejects a workspace root that is not a directory before spawning', async () => {
  const harness = createHarness({
    fs: {
      lstat: async () => ({
        dev: 1,
        ino: 1,
        isDirectory: () => false,
        isSymbolicLink: () => false,
      }),
    },
  });

  await assert.rejects(
    harness.manager.create(new FakeSocket(), { cols: 80, rows: 24 }),
    /Unable to create session/,
  );

  assert.equal(harness.spawnCalls.length, 0);
  assert.equal(harness.manager.activeCount, 0);
});

test('refuses to remove a replacement directory at the original workspace path', async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'claude-session-test-'));
  const pty = new FakePty();
  let workspace;
  const manager = new SessionManager({
    workspaceRoot: root,
    launcher: '/opt/claude/bin/claude',
    childEnv: {},
    maxSessions: 1,
    idleTimeoutMs: 30_000,
    terminationGraceMs: 20,
    killGraceMs: 20,
    socketCloseTimeoutMs: 20,
    maxBufferedBytes: 1024,
  }, {
    pty: { spawn: (_executable, _argv, options) => { workspace = options.cwd; return pty; } },
  });

  try {
    const session = await manager.create(new FakeSocket(), { cols: 80, rows: 24 });
    await fsPromises.rename(workspace, `${workspace}.original`);
    await fsPromises.mkdir(workspace);
    await fsPromises.writeFile(path.join(workspace, 'replacement.txt'), 'preserve me');

    await assert.rejects(session.close(), /cleanup failed/i);

    assert.equal(await fsPromises.readFile(path.join(workspace, 'replacement.txt'), 'utf8'), 'preserve me');
    assert.equal(manager.activeCount, 1);
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});

test('refuses to follow a symlink substituted for the workspace', async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'claude-session-test-'));
  const pty = new FakePty();
  let workspace;
  const manager = new SessionManager({
    workspaceRoot: root,
    launcher: '/opt/claude/bin/claude',
    childEnv: {},
    maxSessions: 1,
    idleTimeoutMs: 30_000,
    terminationGraceMs: 20,
    killGraceMs: 20,
    socketCloseTimeoutMs: 20,
    maxBufferedBytes: 1024,
  }, {
    pty: { spawn: (_executable, _argv, options) => { workspace = options.cwd; return pty; } },
  });

  try {
    const session = await manager.create(new FakeSocket(), { cols: 80, rows: 24 });
    const original = `${workspace}.original`;
    const target = path.join(root, 'replacement-target');
    await fsPromises.rename(workspace, original);
    await fsPromises.mkdir(target);
    await fsPromises.writeFile(path.join(target, 'target.txt'), 'preserve target');
    await fsPromises.symlink(target, workspace, 'dir');

    await assert.rejects(session.close(), /cleanup failed/i);

    assert.equal(await fsPromises.readFile(path.join(target, 'target.txt'), 'utf8'), 'preserve target');
    assert.equal(manager.activeCount, 1);
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});

test('socket error is handled and triggers idempotent session cleanup', async () => {
  const harness = createHarness();
  const socket = new FakeSocket();
  const session = await harness.manager.create(socket, { cols: 80, rows: 24 });

  assert.doesNotThrow(() => socket.emit('error', new Error('/host/private/transport failed')));
  socket.emit('error', new Error('duplicate transport failure'));
  await session.close();

  assert.equal(harness.ptys[0].killCount, 1);
  assert.equal(harness.removed.length, 1);
  assert.equal(socket.closeCalls.length, 1);
  assert.equal(socket.listenerCount('error'), 0);
  assert.equal(harness.manager.activeCount, 0);
  assert.equal(JSON.stringify(socket.sent).includes('/host/private'), false);
});

test('synchronous PTY write failure initiates cleanup without escaping', async () => {
  const pty = new FakePty();
  pty.write = () => { throw new Error('/host/private/write failed'); };
  const harness = createHarness({ pty: { spawn: () => pty } });
  const socket = new FakeSocket();
  const session = await harness.manager.create(socket, { cols: 80, rows: 24 });

  assert.equal(session.write('input'), false);
  await session.close();

  assert.equal(pty.killCount, 1);
  assert.equal(harness.removed.length, 1);
  assert.equal(socket.closeCalls.length, 1);
  assert.equal(harness.manager.activeCount, 0);
  assert.equal(JSON.stringify(socket.sent).includes('/host/private'), false);
});

test('synchronous PTY resize failure initiates cleanup without escaping', async () => {
  const pty = new FakePty();
  pty.resize = () => { throw new Error('/host/private/resize failed'); };
  const harness = createHarness({ pty: { spawn: () => pty } });
  const socket = new FakeSocket();
  const session = await harness.manager.create(socket, { cols: 80, rows: 24 });

  assert.equal(session.resize(100, 40), false);
  await session.close();

  assert.equal(pty.killCount, 1);
  assert.equal(harness.removed.length, 1);
  assert.equal(socket.closeCalls.length, 1);
  assert.equal(harness.manager.activeCount, 0);
  assert.equal(JSON.stringify(socket.sent).includes('/host/private'), false);
});

test('close during asynchronous spawn installs exit observation before cleanup', async () => {
  const spawned = deferred();
  const spawnStarted = deferred();
  const pty = new FakePty();
  const harness = createHarness({
    pty: {
      spawn() {
        spawnStarted.resolve();
        return spawned.promise;
      },
    },
  });
  const socket = new FakeSocket();
  const creating = harness.manager.create(socket, { cols: 80, rows: 24 });
  await spawnStarted.promise;

  socket.emit('close');
  spawned.resolve(pty);
  await assert.rejects(creating, /Unable to create session/);

  assert.deepEqual(pty.killSignals, ['SIGTERM']);
  assert.equal(pty.exitListeners.size, 0);
  assert.equal(harness.removed.length, 1);
  assert.equal(harness.manager.activeCount, 0);
});

test('throwing socket close still waits, terminates, and completes PTY cleanup', async () => {
  const harness = createHarness({
    config: { socketCloseTimeoutMs: 2 },
    adapters: { timers: { setTimeout, clearTimeout } },
  });
  const socket = new FakeSocket({ autoClose: false });
  socket.close = () => { throw new Error('/host/private/close failed'); };
  const session = await harness.manager.create(socket, { cols: 80, rows: 24 });

  await assert.rejects(session.close(), /cleanup failed/i);

  assert.equal(socket.terminateCount, 1);
  assert.equal(harness.ptys[0].killCount, 1);
  assert.equal(harness.removed.length, 1);
  assert.equal(harness.manager.activeCount, 1);
  assert.equal(JSON.stringify(socket.sent).includes('/host/private'), false);
});

test('late PTY exit resumes quarantined cleanup and releases capacity', async () => {
  const pty = new FakePty({ autoExit: false });
  const harness = createHarness({
    config: { maxSessions: 1, terminationGraceMs: 1, killGraceMs: 1 },
    pty: { spawn: () => pty },
    adapters: { timers: { setTimeout, clearTimeout } },
  });
  const session = await harness.manager.create(new FakeSocket(), { cols: 80, rows: 24 });

  await assert.rejects(session.close(), /cleanup failed/i);
  assert.deepEqual(pty.killSignals, ['SIGTERM', 'SIGKILL']);
  assert.equal(pty.exitListeners.size, 1);
  assert.equal(harness.removed.length, 0);
  assert.equal(harness.manager.activeCount, 1);

  pty.emitExit({ exitCode: null, signal: 9 });
  await session.close();

  assert.deepEqual(pty.killSignals, ['SIGTERM', 'SIGKILL']);
  assert.equal(pty.exitListeners.size, 0);
  assert.equal(harness.removed.length, 1);
  assert.equal(harness.manager.activeCount, 0);
});
