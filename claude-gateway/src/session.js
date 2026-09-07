import { createRequire } from 'node:module';
import path from 'node:path';
import { promises as nodeFs } from 'node:fs';

import { clampTerminalSize, serverMessage } from './protocol.js';

const require = createRequire(import.meta.url);
const WORKSPACE_PREFIX = 'claude-session-';
const CREATE_ERROR = 'Unable to create session';

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
  if (typeof pty[method] === 'function') {
    return pty[method](listener);
  }
  if (typeof pty.on === 'function') {
    pty.on(event, listener);
    return {
      dispose() {
        if (typeof pty.off === 'function') pty.off(event, listener);
        else if (typeof pty.removeListener === 'function') pty.removeListener(event, listener);
      },
    };
  }
  throw new TypeError('Invalid PTY adapter');
}

class Session {
  constructor(manager, socket, terminalSize) {
    this.manager = manager;
    this.socket = socket;
    this.terminalSize = initialTerminalSize(terminalSize);
    this.workspace = null;
    this.pty = null;
    this.ptyExited = false;
    this.exitSent = false;
    this.killIssued = false;
    this.closeRequested = false;
    this.startFinished = false;
    this.cleanupPromise = null;
    this.idleTimer = null;
    this.listenerDisposables = [];

    this.startDone = new Promise((resolve) => {
      this.resolveStartDone = resolve;
    });

    this.socketCloseListener = () => this.close('socket-close');
    if (typeof this.socket?.on === 'function') {
      this.socket.on('close', this.socketCloseListener);
    }
  }

  async start() {
    try {
      const prefix = path.join(this.manager.workspaceRoot, WORKSPACE_PREFIX);
      const created = await this.manager.fs.mkdtemp(prefix);
      const candidate = path.resolve(created);

      if (!this.manager.isGeneratedWorkspace(candidate)) {
        throw new Error(CREATE_ERROR);
      }
      this.workspace = candidate;

      if (this.closeRequested || this.manager.closed) {
        throw new Error(CREATE_ERROR);
      }

      const env = {
        ...this.manager.childEnv,
        SESSION_WORKSPACE: this.workspace,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      };
      this.pty = await this.manager.pty.spawn(this.manager.launcher, [], {
        name: 'xterm-256color',
        cols: this.terminalSize.cols,
        rows: this.terminalSize.rows,
        cwd: this.workspace,
        env,
      });

      if (this.closeRequested || this.manager.closed) {
        throw new Error(CREATE_ERROR);
      }

      this.listenerDisposables.push(
        subscribe(this.pty, 'onData', 'data', (data) => this.handleOutput(data)),
      );
      this.listenerDisposables.push(
        subscribe(this.pty, 'onExit', 'exit', (event) => this.handleExit(event)),
      );
      this.resetIdleTimer();
      this.send('state', { state: 'ready' });
      return this;
    } finally {
      this.startFinished = true;
      this.resolveStartDone();
    }
  }

  write(data) {
    if (typeof data !== 'string') {
      throw new TypeError('Terminal input must be a string');
    }
    if (this.cleanupPromise !== null || this.pty === null || this.ptyExited) return false;

    this.pty.write(data);
    this.resetIdleTimer();
    return true;
  }

  resize(cols, rows) {
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) {
      throw new TypeError('Terminal size must use integers');
    }
    if (this.cleanupPromise !== null || this.pty === null || this.ptyExited) return false;

    const size = clampTerminalSize(cols, rows);
    this.pty.resize(size.cols, size.rows);
    this.resetIdleTimer();
    return true;
  }

  async close(_reason = 'closed') {
    this.closeRequested = true;
    if (!this.startFinished) await this.startDone;
    return this.cleanup(!this.ptyExited);
  }

  handleOutput(data) {
    if (this.cleanupPromise !== null || this.ptyExited) return;
    this.send('output', { data: String(data) });
    this.resetIdleTimer();
  }

  handleExit(event = {}) {
    if (this.exitSent) return;
    this.ptyExited = true;
    this.exitSent = true;
    this.send('exit', {
      code: typeof event.exitCode === 'number' ? event.exitCode : null,
      signal: event.signal ?? null,
    });
    void this.cleanup(false);
  }

  resetIdleTimer() {
    if (this.cleanupPromise !== null || this.ptyExited) return;
    if (this.idleTimer !== null) {
      this.manager.timers.clearTimeout(this.idleTimer);
    }
    this.idleTimer = this.manager.timers.setTimeout(
      () => this.close('idle-timeout'),
      this.manager.idleTimeoutMs,
    );
    this.idleTimer?.unref?.();
  }

  send(type, fields) {
    try {
      this.socket?.send?.(serverMessage(type, fields));
    } catch {
      // Socket failure is handled by its close event or normal cleanup.
    }
  }

  cleanup(shouldKill) {
    if (this.cleanupPromise !== null) return this.cleanupPromise;
    this.cleanupPromise = this.performCleanup(shouldKill);
    return this.cleanupPromise;
  }

  async performCleanup(shouldKill) {
    let cleanupFailed = false;
    try {
      if (this.idleTimer !== null) {
        this.manager.timers.clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }

      for (const disposable of this.listenerDisposables.splice(0)) {
        try {
          disposable?.dispose?.();
        } catch {
          cleanupFailed = true;
        }
      }

      if (typeof this.socket?.off === 'function') {
        this.socket.off('close', this.socketCloseListener);
      } else if (typeof this.socket?.removeListener === 'function') {
        this.socket.removeListener('close', this.socketCloseListener);
      }

      if (shouldKill && this.pty !== null && !this.ptyExited && !this.killIssued) {
        this.killIssued = true;
        try {
          this.pty.kill();
        } catch {
          cleanupFailed = true;
        }
      }

      if (this.workspace !== null) {
        try {
          await this.manager.fs.rm(this.workspace, { recursive: true, force: true });
        } catch {
          cleanupFailed = true;
        }
      }

      if (cleanupFailed) {
        this.send('error', { message: 'Session cleanup failed' });
      }
    } finally {
      this.manager.release(this);
    }
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
    this.workspaceRoot = path.resolve(config.workspaceRoot);
    this.childEnv = copyChildEnv(config.childEnv);
    this.maxSessions = config.maxSessions;
    this.idleTimeoutMs = config.idleTimeoutMs;
    this.fs = adapters.fs?.promises ?? adapters.fs ?? nodeFs;
    this.pty = adapters.pty ?? defaultPtyAdapter;
    this.timers = adapters.timers ?? defaultTimers;
    this.sessions = new Set();
    this.count = 0;
    this.closed = false;
    this.shutdownPromise = null;
  }

  get activeCount() {
    return this.count;
  }

  async create(socket, terminalSize) {
    if (this.closed || this.count >= this.maxSessions) {
      throw new Error(CREATE_ERROR);
    }

    const session = new Session(this, socket, terminalSize);
    this.sessions.add(session);
    this.count += 1;

    try {
      return await session.start();
    } catch {
      if (!session.closeRequested) {
        session.send('error', { message: CREATE_ERROR });
      }
      await session.close('startup-failure');
      throw new Error(CREATE_ERROR);
    }
  }

  shutdown() {
    if (this.shutdownPromise !== null) return this.shutdownPromise;
    this.closed = true;
    const sessions = [...this.sessions];
    this.shutdownPromise = Promise.all(
      sessions.map((session) => session.close('shutdown')),
    ).then(() => undefined);
    return this.shutdownPromise;
  }

  isGeneratedWorkspace(candidate) {
    const relative = path.relative(this.workspaceRoot, candidate);
    return relative !== ''
      && !relative.startsWith(`..${path.sep}`)
      && relative !== '..'
      && !path.isAbsolute(relative)
      && path.dirname(candidate) === this.workspaceRoot
      && path.basename(candidate).startsWith(WORKSPACE_PREFIX);
  }

  release(session) {
    if (!this.sessions.delete(session)) return;
    this.count -= 1;
  }
}
