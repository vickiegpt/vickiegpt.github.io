import { promises as nodeFs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { clampTerminalSize, serverMessage } from './protocol.js';

const require = createRequire(import.meta.url);
const WORKSPACE_PREFIX = 'claude-session-';
const CREATE_ERROR = 'Unable to create session';
const CLEANUP_ERROR = 'Session cleanup failed';

const defaultPtyAdapter = {
  spawn(...args) {
    return require('node-pty').spawn(...args);
  },
};

const defaultTimers = {
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
};

function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function copyChildEnv(childEnv) {
  if (childEnv === undefined) return Object.create(null);
  if (childEnv === null || typeof childEnv !== 'object' || Array.isArray(childEnv)) {
    throw new TypeError('childEnv must be an object');
  }

  const copy = Object.create(null);
  for (const [key, value] of Object.entries(childEnv)) {
    if (typeof value !== 'string') {
      throw new TypeError('childEnv values must be strings');
    }
    copy[key] = value;
  }
  return copy;
}

function initialTerminalSize(terminalSize) {
  const cols = Number.isInteger(terminalSize?.cols) ? terminalSize.cols : 80;
  const rows = Number.isInteger(terminalSize?.rows) ? terminalSize.rows : 24;
  return clampTerminalSize(cols, rows);
}

function subscribe(pty, method, event, listener) {
  if (typeof pty[method] === 'function') return pty[method](listener);
  return subscribeEvent(pty, event, listener);
}

function subscribeEvent(emitter, event, listener) {
  if (typeof emitter.on !== 'function') throw new TypeError('Invalid event adapter');
  emitter.on(event, listener);
  return {
    dispose() {
      if (typeof emitter.off === 'function') emitter.off(event, listener);
      else if (typeof emitter.removeListener === 'function') emitter.removeListener(event, listener);
    },
  };
}

function consume(promise) {
  Promise.resolve(promise).catch(() => {});
}

function sameIdentity(stat, identity) {
  return stat.dev === identity.dev && stat.ino === identity.ino;
}

class Session {
  constructor(manager, socket, terminalSize) {
    this.manager = manager;
    this.socket = socket;
    this.terminalSize = initialTerminalSize(terminalSize);
    this.workspace = null;
    this.pty = null;
    this.ready = false;
    this.ptyExited = false;
    this.exitSent = false;
    this.stopRequested = false;
    this.closeRequested = false;
    this.startFinished = false;
    this.cleanupPromise = null;
    this.idleTimer = null;
    this.dataDisposable = null;
    this.exitDisposable = null;
    this.quarantineError = null;

    this.startDone = new Promise((resolve) => {
      this.resolveStartDone = resolve;
    });
    this.ptyExitPromise = new Promise((resolve) => {
      this.resolvePtyExit = resolve;
    });
    this.socketClosed = this.socket?.readyState === 3;
    this.socketClosePromise = new Promise((resolve) => {
      this.resolveSocketClose = resolve;
    });
    if (this.socketClosed) this.resolveSocketClose();

    this.socketErrorListener = () => this.requestStop('socket-error');
    this.socketCloseListener = () => {
      this.socketClosed = true;
      this.resolveSocketClose();
      if (this.cleanupPromise === null) this.requestStop('socket-close');
    };
    if (typeof this.socket?.on === 'function') {
      this.socket.on('error', this.socketErrorListener);
      this.socket.on('close', this.socketCloseListener);
    }
  }

  async start() {
    try {
      const root = await this.manager.ensureWorkspaceRoot();
      const created = await this.manager.fs.mkdtemp(path.join(root.path, WORKSPACE_PREFIX));
      const candidate = path.resolve(created);
      const candidateStat = await this.manager.fs.lstat(candidate);
      const canonical = path.resolve(await this.manager.fs.realpath(candidate));
      if (
        canonical !== candidate
        || path.dirname(canonical) !== root.path
        || !path.basename(canonical).startsWith(WORKSPACE_PREFIX)
        || candidateStat.isSymbolicLink()
        || !candidateStat.isDirectory()
      ) {
        throw new Error(CREATE_ERROR);
      }
      this.workspace = {
        path: canonical,
        dev: candidateStat.dev,
        ino: candidateStat.ino,
      };

      if (this.closeRequested || this.manager.closed) throw new Error(CREATE_ERROR);

      const env = {
        ...this.manager.childEnv,
        SESSION_WORKSPACE: this.workspace.path,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      };
      this.pty = await this.manager.pty.spawn(this.manager.launcher, [], {
        name: 'xterm-256color',
        cols: this.terminalSize.cols,
        rows: this.terminalSize.rows,
        cwd: this.workspace.path,
        env,
      });

      let exitSubscriptionError = null;
      try {
        this.exitDisposable = subscribe(
          this.pty,
          'onExit',
          'exit',
          (event) => this.handleExit(event),
        );
      } catch (error) {
        exitSubscriptionError = error;
        try {
          this.exitDisposable = subscribeEvent(
            this.pty,
            'exit',
            (event) => this.handleExit(event),
          );
        } catch {
          // Cleanup will fail closed if PTY exit cannot be observed.
        }
      }

      if (this.closeRequested || this.manager.closed) throw new Error(CREATE_ERROR);

      this.dataDisposable = subscribe(
        this.pty,
        'onData',
        'data',
        (data) => this.handleOutput(data),
      );
      if (exitSubscriptionError !== null) throw exitSubscriptionError;

      this.ready = true;
      this.resetIdleTimer();
      this.send('state', { state: 'ready' });
      return this;
    } finally {
      this.startFinished = true;
      this.resolveStartDone();
    }
  }

  write(data) {
    if (typeof data !== 'string') throw new TypeError('Terminal input must be a string');
    if (!this.canUsePty()) return false;
    try {
      this.pty.write(data);
    } catch {
      this.requestStop('pty-io-failure');
      return false;
    }
    this.resetIdleTimer();
    return true;
  }

  resize(cols, rows) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) {
      throw new TypeError('Terminal size must use integers');
    }
    if (!this.canUsePty()) return false;
    const size = clampTerminalSize(cols, rows);
    try {
      this.pty.resize(size.cols, size.rows);
    } catch {
      this.requestStop('pty-io-failure');
      return false;
    }
    this.resetIdleTimer();
    return true;
  }

  async close(reason = 'closed') {
    this.closeRequested = true;
    if (!this.startFinished) await this.startDone;
    return this.cleanup(reason);
  }

  canUsePty() {
    return this.cleanupPromise === null && this.pty !== null && !this.ptyExited;
  }

  handleOutput(data) {
    if (!this.canUsePty()) return;
    if (this.send('output', { data: String(data) })) this.resetIdleTimer();
  }

  handleExit(event = {}) {
    if (this.ptyExited) return;
    this.ptyExited = true;
    this.resolvePtyExit();
    if (this.ready && !this.exitSent) {
      this.exitSent = true;
      this.send('exit', {
        code: typeof event.exitCode === 'number' ? event.exitCode : null,
        signal: event.signal ?? null,
      });
    }
    consume(this.cleanup('pty-exit'));
  }

  resetIdleTimer() {
    if (!this.canUsePty()) return;
    if (this.idleTimer !== null) this.manager.timers.clearTimeout(this.idleTimer);
    this.idleTimer = this.manager.timers.setTimeout(() => {
      const closing = this.close('idle-timeout');
      consume(closing);
      return closing;
    }, this.manager.idleTimeoutMs);
    this.idleTimer?.unref?.();
  }

  isSocketOpen() {
    const openState = this.manager.socketOpenState ?? this.socket?.OPEN ?? 1;
    return this.socket?.readyState === openState;
  }

  send(type, fields) {
    if (!this.isSocketOpen()) return false;
    if (
      typeof this.socket.bufferedAmount === 'number'
      && this.socket.bufferedAmount > this.manager.maxBufferedBytes
    ) {
      this.requestStop('backpressure');
      return false;
    }

    const frame = serverMessage(type, fields);
    const callback = (error) => {
      if (error) this.requestStop('socket-send-failure');
    };
    try {
      const result = this.socket.send(frame, callback);
      if (result !== null && (typeof result === 'object' || typeof result === 'function')) {
        let then;
        try {
          then = result.then;
        } catch {
          this.requestStop('socket-send-failure');
          return false;
        }
        if (typeof then === 'function') {
          Promise.resolve(result).catch(() => this.requestStop('socket-send-failure'));
        }
      }
      return true;
    } catch {
      this.requestStop('socket-send-failure');
      return false;
    }
  }

  requestStop(reason) {
    if (this.stopRequested) return;
    this.stopRequested = true;
    consume(this.close(reason));
  }

  cleanup(reason) {
    if (this.cleanupPromise !== null) return this.cleanupPromise;
    if (this.quarantineError !== null && !this.ptyExited) {
      return Promise.reject(this.quarantineError);
    }
    let resolveCleanup;
    let rejectCleanup;
    this.cleanupPromise = new Promise((resolve, reject) => {
      resolveCleanup = resolve;
      rejectCleanup = reject;
    });
    this.performCleanup(reason).then(
      (value) => {
        this.quarantineError = null;
        resolveCleanup(value);
      },
      (error) => {
        if (error.exitUnconfirmed === true) {
          this.quarantineError = error;
          this.cleanupPromise = null;
        }
        rejectCleanup(error);
        if (error.exitUnconfirmed === true && this.ptyExited) {
          consume(this.cleanup('late-pty-exit'));
        }
      },
    );
    return this.cleanupPromise;
  }

  async performCleanup(reason) {
    const errors = [];
    if (this.idleTimer !== null) {
      this.manager.timers.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.disposeDataListener(errors);
    this.sendFinalFrame(reason);

    let exitConfirmed = this.pty === null || this.ptyExited;
    if (!exitConfirmed) {
      try {
        this.pty.kill('SIGTERM');
      } catch (error) {
        errors.push(error);
      }
      exitConfirmed = await this.waitFor(this.ptyExitPromise, this.manager.terminationGraceMs);
    }
    if (!exitConfirmed) {
      try {
        this.pty.kill('SIGKILL');
      } catch (error) {
        errors.push(error);
      }
      exitConfirmed = await this.waitFor(this.ptyExitPromise, this.manager.killGraceMs);
    }
    if (!exitConfirmed) errors.push(new Error('PTY exit was not confirmed'));

    if (exitConfirmed && this.workspace !== null) {
      try {
        await this.removeVerifiedWorkspace();
      } catch (error) {
        errors.push(error);
      }
    }

    if (reason !== 'socket-close') {
      try {
        await this.closeSocket(reason);
      } catch (error) {
        errors.push(error);
      }
    }

    if (exitConfirmed) this.disposeExitListener(errors);
    this.disposeSocketListener(errors);

    if (errors.length > 0) {
      this.send('error', { message: CLEANUP_ERROR });
      const failure = new AggregateError(errors, CLEANUP_ERROR);
      failure.exitUnconfirmed = !exitConfirmed;
      throw failure;
    }

    this.manager.release(this);
  }

  disposeDataListener(errors) {
    if (this.dataDisposable === null) return;
    try {
      this.dataDisposable.dispose?.();
    } catch (error) {
      errors.push(error);
    }
    this.dataDisposable = null;
  }

  disposeExitListener(errors) {
    if (this.exitDisposable === null) return;
    try {
      this.exitDisposable.dispose?.();
    } catch (error) {
      errors.push(error);
    }
    this.exitDisposable = null;
  }

  disposeSocketListener(errors) {
    try {
      if (typeof this.socket?.off === 'function') {
        this.socket.off('close', this.socketCloseListener);
        this.socket.off('error', this.socketErrorListener);
      } else if (typeof this.socket?.removeListener === 'function') {
        this.socket.removeListener('close', this.socketCloseListener);
        this.socket.removeListener('error', this.socketErrorListener);
      }
    } catch (error) {
      errors.push(error);
    }
  }

  sendFinalFrame(reason) {
    if (reason === 'startup-failure') {
      this.send('error', { message: CREATE_ERROR });
    } else if (reason === 'pty-exit') {
      this.send('state', { state: 'closed' });
    } else if (reason === 'idle-timeout') {
      this.send('state', { state: 'closing', reason: 'idle-timeout' });
    } else if (reason === 'shutdown') {
      this.send('state', { state: 'closing', reason: 'server-shutdown' });
    } else if (reason === 'backpressure') {
      this.send('error', { message: 'Session closed' });
    } else if (reason !== 'socket-close' && reason !== 'socket-send-failure') {
      this.send('state', { state: 'closing' });
    }
  }

  async closeSocket(reason) {
    if (this.socketClosed || this.socket?.readyState === 3) return;
    const errors = [];
    if (this.isSocketOpen()) {
      const closeDetails = reason === 'idle-timeout'
        ? [1001, 'Session timed out']
        : reason === 'shutdown'
          ? [1001, 'Server shutdown']
          : reason === 'backpressure'
            ? [1013, 'Client too slow']
            : [1011, 'Session closed'];
      try {
        if (typeof this.socket.close !== 'function') throw new Error('Socket cannot close');
        this.socket.close(...closeDetails);
      } catch (error) {
        errors.push(error);
      }
    }

    const closed = await this.waitFor(this.socketClosePromise, this.manager.socketCloseTimeoutMs);
    if (!closed && !this.socketClosed && this.socket?.readyState !== 3) {
      try {
        if (typeof this.socket.terminate !== 'function') throw new Error('Socket cannot terminate');
        this.socket.terminate();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Socket close failed');
  }

  async removeVerifiedWorkspace() {
    const root = await this.manager.ensureWorkspaceRoot();
    const rootStat = await this.manager.fs.lstat(root.path);
    const rootCanonical = path.resolve(await this.manager.fs.realpath(root.path));
    if (
      rootCanonical !== root.path
      || rootStat.isSymbolicLink()
      || !rootStat.isDirectory()
      || !sameIdentity(rootStat, root)
    ) {
      throw new Error('Workspace root identity changed');
    }

    const workspaceStat = await this.manager.fs.lstat(this.workspace.path);
    const workspaceCanonical = path.resolve(await this.manager.fs.realpath(this.workspace.path));
    if (
      workspaceCanonical !== this.workspace.path
      || path.dirname(workspaceCanonical) !== root.path
      || workspaceStat.isSymbolicLink()
      || !workspaceStat.isDirectory()
      || !sameIdentity(workspaceStat, this.workspace)
    ) {
      throw new Error('Workspace identity changed');
    }

    // fs.rm is path-based, so deployment must keep workspaceRoot's parent owned
    // by the server and non-writable by child or untrusted users to close TOCTOU.
    await this.manager.fs.rm(this.workspace.path, { recursive: true, force: true });
  }

  waitFor(promise, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      let timer;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        this.manager.timers.clearTimeout(timer);
        resolve(value);
      };
      timer = this.manager.timers.setTimeout(() => finish(false), timeoutMs);
      promise.then(() => finish(true), () => finish(false));
    });
  }
}

export class SessionManager {
  constructor(config, adapters = {}) {
    if (config === null || typeof config !== 'object') {
      throw new TypeError('config must be an object');
    }
    requireNonEmptyString(config.launcher, 'launcher');
    requireNonEmptyString(config.workspaceRoot, 'workspaceRoot');
    requirePositiveInteger(config.maxSessions, 'maxSessions');
    requirePositiveInteger(config.idleTimeoutMs, 'idleTimeoutMs');

    this.launcher = config.launcher;
    this.configuredWorkspaceRoot = path.resolve(config.workspaceRoot);
    this.childEnv = copyChildEnv(config.childEnv);
    this.maxSessions = config.maxSessions;
    this.idleTimeoutMs = config.idleTimeoutMs;
    this.terminationGraceMs = config.terminationGraceMs ?? 1_000;
    this.killGraceMs = config.killGraceMs ?? 1_000;
    this.socketCloseTimeoutMs = config.socketCloseTimeoutMs ?? 1_000;
    this.maxBufferedBytes = config.maxBufferedBytes ?? 1024 * 1024;
    requirePositiveInteger(this.terminationGraceMs, 'terminationGraceMs');
    requirePositiveInteger(this.killGraceMs, 'killGraceMs');
    requirePositiveInteger(this.socketCloseTimeoutMs, 'socketCloseTimeoutMs');
    requirePositiveInteger(this.maxBufferedBytes, 'maxBufferedBytes');

    this.fs = adapters.fs?.promises ?? adapters.fs ?? nodeFs;
    this.pty = adapters.pty ?? defaultPtyAdapter;
    this.timers = adapters.timers ?? defaultTimers;
    this.socketOpenState = adapters.socketOpenState;
    this.sessions = new Set();
    this.count = 0;
    this.closed = false;
    this.rootPromise = null;
    this.shutdownPromise = null;
  }

  get activeCount() {
    return this.count;
  }

  async create(socket, terminalSize) {
    if (this.closed || this.count >= this.maxSessions) throw new Error(CREATE_ERROR);

    const session = new Session(this, socket, terminalSize);
    this.sessions.add(session);
    this.count += 1;

    try {
      return await session.start();
    } catch {
      try {
        await session.close('startup-failure');
      } catch (cleanupError) {
        throw new AggregateError([cleanupError], CREATE_ERROR);
      }
      throw new Error(CREATE_ERROR);
    }
  }

  shutdown() {
    if (this.shutdownPromise !== null) return this.shutdownPromise;
    this.closed = true;
    this.shutdownPromise = Promise.allSettled(
      [...this.sessions].map((session) => session.close('shutdown')),
    ).then((results) => {
      const errors = results
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason);
      if (errors.length > 0) throw new AggregateError(errors, 'Session manager shutdown failed');
    });
    return this.shutdownPromise;
  }

  ensureWorkspaceRoot() {
    if (this.rootPromise === null) this.rootPromise = this.verifyWorkspaceRoot();
    return this.rootPromise;
  }

  async verifyWorkspaceRoot() {
    const canonical = path.resolve(await this.fs.realpath(this.configuredWorkspaceRoot));
    const stat = await this.fs.lstat(canonical);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Invalid workspace root');
    }
    return { path: canonical, dev: stat.dev, ino: stat.ino };
  }

  release(session) {
    if (!this.sessions.delete(session)) return;
    this.count -= 1;
  }
}
