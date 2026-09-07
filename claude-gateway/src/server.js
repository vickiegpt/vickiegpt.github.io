import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WebSocketServer } from 'ws';

import {
  isAllowedOrigin,
  parseClientMessage,
  safeTokenEqual,
  serverMessage,
} from './protocol.js';
import { SessionCreateError, SessionManager } from './session.js';

const WEBSOCKET_PATH = '/ws/claude';
const DEFAULT_AUTH_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const DEFAULT_KILL_GRACE_MS = 1_000;
const DEFAULT_SOCKET_CLOSE_TIMEOUT_MS = 1_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_TERMINAL_SIZE = Object.freeze({ cols: 80, rows: 24 });
const MAX_PENDING_MESSAGES = 256;
const CHILD_ENV_KEYS = Object.freeze([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'NODE_WASMU',
  'NODE_WASM_ROOT',
  'CLAUDE_CLI',
  'PATH',
]);

function configurationError(name) {
  return new Error(`Invalid gateway configuration: ${name}`);
}

function requiredString(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.length === 0) throw configurationError(name);
  return value;
}

function parseInteger(env, name, { defaultValue, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env[name];
  if (raw === undefined && defaultValue !== undefined) return defaultValue;
  if (typeof raw !== 'string' || !/^[0-9]+$/.test(raw)) throw configurationError(name);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw configurationError(name);
  }
  return value;
}

function copyChildEnv(env) {
  const childEnv = Object.create(null);
  for (const key of CHILD_ENV_KEYS) {
    if (typeof env[key] === 'string') childEnv[key] = env[key];
  }
  return childEnv;
}

export function loadConfig(env = process.env) {
  if (env === null || typeof env !== 'object') throw configurationError('environment');

  const allowedOriginsValue = requiredString(env, 'CLAUDE_WEB_ALLOWED_ORIGINS');
  const allowedOrigins = allowedOriginsValue.split(',').map((origin) => origin.trim());
  if (
    allowedOrigins.some((origin) => origin.length === 0)
    || allowedOrigins.some((origin) => !isAllowedOrigin(origin, [origin]))
  ) {
    throw configurationError('CLAUDE_WEB_ALLOWED_ORIGINS');
  }

  return {
    accessToken: requiredString(env, 'CLAUDE_WEB_ACCESS_TOKEN'),
    allowedOrigins,
    launcher: requiredString(env, 'CLAUDE_WEB_LAUNCHER'),
    workspaceRoot: requiredString(env, 'CLAUDE_WEB_WORKSPACE_ROOT'),
    maxSessions: parseInteger(env, 'CLAUDE_WEB_MAX_SESSIONS'),
    idleTimeoutMs: parseInteger(env, 'CLAUDE_WEB_IDLE_TIMEOUT_MS', {
      maximum: MAX_TIMER_DELAY_MS,
    }),
    authTimeoutMs: parseInteger(env, 'CLAUDE_WEB_AUTH_TIMEOUT_MS', {
      defaultValue: DEFAULT_AUTH_TIMEOUT_MS,
      maximum: MAX_TIMER_DELAY_MS,
    }),
    maxBufferedBytes: parseInteger(env, 'CLAUDE_WEB_MAX_BUFFERED_BYTES', {
      defaultValue: DEFAULT_MAX_BUFFERED_BYTES,
    }),
    terminationGraceMs: parseInteger(env, 'CLAUDE_WEB_TERMINATION_GRACE_MS', {
      defaultValue: DEFAULT_TERMINATION_GRACE_MS,
      maximum: MAX_TIMER_DELAY_MS,
    }),
    killGraceMs: parseInteger(env, 'CLAUDE_WEB_KILL_GRACE_MS', {
      defaultValue: DEFAULT_KILL_GRACE_MS,
      maximum: MAX_TIMER_DELAY_MS,
    }),
    socketCloseTimeoutMs: parseInteger(env, 'CLAUDE_WEB_SOCKET_CLOSE_TIMEOUT_MS', {
      defaultValue: DEFAULT_SOCKET_CLOSE_TIMEOUT_MS,
      maximum: MAX_TIMER_DELAY_MS,
    }),
    port: parseInteger(env, 'PORT', { maximum: 65_535 }),
    host: requiredString(env, 'HOST'),
    childEnv: copyChildEnv(env),
  };
}

function validateConfig(config) {
  if (config === null || typeof config !== 'object') throw configurationError('config');
  for (const key of ['accessToken', 'launcher', 'workspaceRoot', 'host']) {
    if (typeof config[key] !== 'string' || config[key].length === 0) {
      throw configurationError(key);
    }
  }
  if (!Array.isArray(config.allowedOrigins) || config.allowedOrigins.length === 0) {
    throw configurationError('allowedOrigins');
  }
  if (config.allowedOrigins.some((origin) => !isAllowedOrigin(origin, [origin]))) {
    throw configurationError('allowedOrigins');
  }
  for (const key of ['maxSessions', 'maxBufferedBytes']) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw configurationError(key);
  }
  for (const key of [
    'idleTimeoutMs',
    'authTimeoutMs',
    'terminationGraceMs',
    'killGraceMs',
    'socketCloseTimeoutMs',
  ]) {
    if (
      !Number.isSafeInteger(config[key])
      || config[key] < 1
      || config[key] > MAX_TIMER_DELAY_MS
    ) {
      throw configurationError(key);
    }
  }
  if (!Number.isSafeInteger(config.port) || config.port < 0 || config.port > 65_535) {
    throw configurationError('port');
  }
}

function closeHttpServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export function createGatewayServer(config, adapters = {}) {
  validateConfig(config);

  const timers = adapters.timers ?? { setTimeout, clearTimeout };
  const SessionManagerClass = adapters.SessionManager ?? SessionManager;
  const sessionManager = adapters.sessionManager ?? new SessionManagerClass({
    launcher: config.launcher,
    workspaceRoot: config.workspaceRoot,
    childEnv: config.childEnv,
    maxSessions: config.maxSessions,
    idleTimeoutMs: config.idleTimeoutMs,
    maxBufferedBytes: config.maxBufferedBytes,
    terminationGraceMs: config.terminationGraceMs,
    killGraceMs: config.killGraceMs,
    socketCloseTimeoutMs: config.socketCloseTimeoutMs,
  }, adapters.sessionAdapters);
  const HttpServer = adapters.http ?? http;
  const WebSocketServerClass = adapters.WebSocketServer ?? WebSocketServer;
  const connections = new Set();
  const rawSockets = new Map();
  const webSocketClosePromises = new Set();
  const cleanupPromises = new Set();
  let shuttingDown = false;
  let degraded = false;
  let fatal = false;
  let listenPromise = null;
  let shutdownPromise = null;
  let resolveFatal;
  const fatalPromise = new Promise((resolve) => { resolveFatal = resolve; });

  const server = HttpServer.createServer((request, response) => {
    try {
      if (request.url === '/healthz' && request.method === 'GET') {
        const body = degraded ? '{"status":"degraded"}' : '{"status":"ok"}';
        response.writeHead(degraded ? 503 : 200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          'Cache-Control': 'no-store',
        });
        response.end(body);
        return;
      }

      const statusCode = request.url === '/healthz' ? 405 : 404;
      const headers = {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': '0',
        'Cache-Control': 'no-store',
      };
      if (statusCode === 405) headers.Allow = 'GET';
      response.writeHead(statusCode, headers);
      response.end();
    } catch {
      if (!response.headersSent) response.writeHead(500, { 'Content-Length': '0' });
      response.end();
    }
  });

  const webSocketServer = new WebSocketServerClass({ noServer: true, maxPayload: 65_536 });

  function finishRawSocket(record) {
    if (record.finished) return;
    record.finished = true;
    if (record.timer !== null) timers.clearTimeout(record.timer);
    record.socket.off?.('close', record.onClose);
    rawSockets.delete(record.socket);
    record.resolve();
  }

  function trackRawSocket(socket) {
    const existing = rawSockets.get(socket);
    if (existing !== undefined) return existing;
    let resolve;
    const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
    const record = {
      socket,
      promise,
      resolve,
      timer: null,
      finished: false,
      onClose: null,
    };
    record.onClose = () => finishRawSocket(record);
    rawSockets.set(socket, record);
    socket.once('close', record.onClose);
    return record;
  }

  function forceDestroyRawSocket(record) {
    try {
      record.socket.destroy();
    } catch {
      degraded = true;
    }
    finishRawSocket(record);
  }

  function releaseRawSocket(socket) {
    const record = rawSockets.get(socket);
    if (record !== undefined) finishRawSocket(record);
  }

  function rejectUpgrade(socket, statusCode, statusText) {
    const record = trackRawSocket(socket);
    if (socket.destroyed) {
      finishRawSocket(record);
      return;
    }
    record.timer = timers.setTimeout(
      () => forceDestroyRawSocket(record),
      config.socketCloseTimeoutMs,
    );
    try {
      socket.end(
        `HTTP/1.1 ${statusCode} ${statusText}\r\n`
        + 'Connection: close\r\n'
        + 'Content-Length: 0\r\n'
        + '\r\n',
      );
    } catch {
      forceDestroyRawSocket(record);
    }
  }

  function clearAuthTimer(context) {
    if (context.authTimer === null) return;
    timers.clearTimeout(context.authTimer);
    context.authTimer = null;
  }

  function closeSession(context, reason) {
    if (context.session === null || context.sessionClosePromise !== null) return;
    try {
      context.sessionClosePromise = Promise.resolve(context.session.close(reason)).catch(() => {
        degraded = true;
      });
    } catch {
      degraded = true;
      context.sessionClosePromise = Promise.resolve();
    }
    cleanupPromises.add(context.sessionClosePromise);
    context.sessionClosePromise.then(() => cleanupPromises.delete(context.sessionClosePromise));
  }

  function socketIsOpen(socket) {
    return socket.readyState === 1;
  }

  function endConnection(context, reason) {
    if (context.socketEnded) return;
    context.socketEnded = true;
    context.phase = 'closing';
    context.pending.length = 0;
    clearAuthTimer(context);
    connections.delete(context);
    closeSession(context, reason);
  }

  function finishWebSocketClose(context) {
    if (context.resolveSocketClose === null) return;
    if (context.socketCloseTimer !== null) timers.clearTimeout(context.socketCloseTimer);
    context.socketCloseTimer = null;
    const resolve = context.resolveSocketClose;
    context.resolveSocketClose = null;
    resolve();
  }

  function terminateWebSocket(context) {
    try {
      context.socket.terminate();
    } catch {
      degraded = true;
    }
    finishWebSocketClose(context);
  }

  function closeSocket(context, code, reason) {
    if (context.socketClosePromise !== null) return context.socketClosePromise;
    if (context.transportClosed || context.socket.readyState === 3) return Promise.resolve();

    context.socketClosePromise = new Promise((resolve) => {
      context.resolveSocketClose = resolve;
    });
    webSocketClosePromises.add(context.socketClosePromise);
    context.socketClosePromise.then(() => webSocketClosePromises.delete(context.socketClosePromise));
    context.socketCloseTimer = timers.setTimeout(
      () => terminateWebSocket(context),
      config.socketCloseTimeoutMs,
    );

    if (socketIsOpen(context.socket)) {
      try {
        const result = context.socket.close(code, reason);
        if (result && typeof result.then === 'function') {
          result.catch(() => terminateWebSocket(context));
        }
      } catch {
        terminateWebSocket(context);
      }
    }
    return context.socketClosePromise;
  }

  function failConnection(context, code, reason) {
    if (context.phase === 'closing') return;
    context.phase = 'closing';
    context.pending.length = 0;
    clearAuthTimer(context);
    closeSocket(context, code, reason);
    closeSession(context, 'gateway-error');
  }

  function sendState(context, state) {
    if (!socketIsOpen(context.socket)) return false;
    try {
      context.socket.send(serverMessage('state', { state }), (error) => {
        if (error) failConnection(context, 1011, 'Unavailable');
      });
      return true;
    } catch {
      failConnection(context, 1011, 'Unavailable');
      return false;
    }
  }

  function isAtCapacity() {
    return typeof sessionManager.activeCount === 'number'
      && sessionManager.activeCount >= config.maxSessions;
  }

  function creationFailed(context, error) {
    const startupCleanupFailed = error instanceof SessionCreateError && error.cleanupFailed;
    if (startupCleanupFailed) degraded = true;
    if (context.phase === 'closing' || context.socketEnded) return;
    if (startupCleanupFailed) {
      sendState(context, 'unavailable');
      failConnection(context, 1011, 'Unavailable');
    } else if (isAtCapacity()) {
      sendState(context, 'busy');
      failConnection(context, 1013, 'Busy');
    } else {
      sendState(context, 'unavailable');
      failConnection(context, 1011, 'Unavailable');
    }
  }

  function dispatchMessage(context, message) {
    if (context.session === null || context.phase !== 'active') return;
    try {
      if (message.type === 'input') context.session.write(message.data);
      else if (message.type === 'resize') context.session.resize(message.cols, message.rows);
      else failConnection(context, 1008, 'Policy violation');
    } catch {
      failConnection(context, 1011, 'Unavailable');
    }
  }

  function sessionCreated(context, session) {
    context.session = session;
    if (context.socketEnded || context.phase === 'closing' || shuttingDown) {
      closeSession(context, shuttingDown ? 'shutdown' : 'socket-close');
      return;
    }

    context.phase = 'active';
    const pending = context.pending.splice(0);
    for (const message of pending) {
      if (context.phase !== 'active') break;
      dispatchMessage(context, message);
    }
  }

  function beginSession(context) {
    if (isAtCapacity()) {
      sendState(context, 'busy');
      failConnection(context, 1013, 'Busy');
      return;
    }

    let creation;
    try {
      creation = sessionManager.create(context.socket, DEFAULT_TERMINAL_SIZE);
    } catch (error) {
      creationFailed(context, error);
      return;
    }
    context.creationPromise = Promise.resolve(creation).then(
      (session) => sessionCreated(context, session),
      (error) => creationFailed(context, error),
    );
  }

  function onMessage(context, raw, isBinary) {
    if (context.phase === 'closing' || context.socketEnded) return;

    let message;
    try {
      message = parseClientMessage(raw, isBinary);
    } catch {
      failConnection(context, 1008, 'Policy violation');
      return;
    }

    if (context.phase === 'awaiting-auth') {
      if (message.type !== 'auth' || !safeTokenEqual(message.token, config.accessToken)) {
        failConnection(context, 1008, 'Policy violation');
        return;
      }
      clearAuthTimer(context);
      context.phase = 'creating';
      if (!sendState(context, 'authenticated')) return;
      beginSession(context);
      return;
    }

    if (message.type === 'auth') {
      failConnection(context, 1008, 'Policy violation');
      return;
    }
    if (message.type !== 'input' && message.type !== 'resize') {
      failConnection(context, 1008, 'Policy violation');
      return;
    }

    if (context.phase === 'creating') {
      if (context.pending.length >= MAX_PENDING_MESSAGES) {
        failConnection(context, 1008, 'Policy violation');
      } else {
        context.pending.push(message);
      }
      return;
    }
    dispatchMessage(context, message);
  }

  webSocketServer.on('connection', (socket) => {
    if (shuttingDown) {
      try {
        socket.close(1012, 'Service restarting');
      } catch {
        socket.terminate?.();
      }
      return;
    }

    const context = {
      socket,
      phase: 'awaiting-auth',
      authTimer: null,
      creationPromise: null,
      session: null,
      sessionClosePromise: null,
      socketEnded: false,
      transportClosed: false,
      socketClosePromise: null,
      socketCloseTimer: null,
      resolveSocketClose: null,
      pending: [],
    };
    connections.add(context);

    // ws enforces maxPayload with 1009. Protocol violations consistently use 1008.
    const nativeClose = socket.close;
    socket.close = function mappedClose(code, ...args) {
      return nativeClose.call(this, code === 1009 ? 1008 : code, ...args);
    };

    socket.on('message', (raw, isBinary) => onMessage(context, raw, isBinary));
    socket.on('error', () => {
      endConnection(context, 'socket-error');
      closeSocket(context, 1008, 'Policy violation');
    });
    socket.on('close', () => {
      context.transportClosed = true;
      finishWebSocketClose(context);
      endConnection(context, 'socket-close');
    });
    context.authTimer = timers.setTimeout(() => {
      failConnection(context, 1008, 'Authentication timeout');
    }, config.authTimeoutMs);
  });
  function runtimeFailure() {
    if (fatal) return;
    fatal = true;
    degraded = true;
    const closing = shutdown();
    closing.then(
      () => resolveFatal(),
      () => resolveFatal(),
    );
  }

  webSocketServer.on('error', runtimeFailure);

  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => {});
    trackRawSocket(socket);
    if (shuttingDown) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }
    if (request.url !== WEBSOCKET_PATH) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    if (!isAllowedOrigin(request.headers.origin, config.allowedOrigins)) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }

    try {
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        releaseRawSocket(socket);
        if (shuttingDown) {
          try {
            webSocket.close(1012, 'Service restarting');
          } catch {
            webSocket.terminate?.();
          }
          return;
        }
        webSocketServer.emit('connection', webSocket, request);
      });
    } catch {
      rejectUpgrade(socket, 400, 'Bad Request');
    }
  });

  server.on('clientError', (_error, socket) => rejectUpgrade(socket, 400, 'Bad Request'));
  server.on('error', runtimeFailure);

  function listen() {
    if (shuttingDown) return Promise.reject(new Error('Gateway is shutting down'));
    if (server.listening) return Promise.resolve();
    if (listenPromise !== null) return listenPromise;

    listenPromise = new Promise((resolve, reject) => {
      const onError = () => {
        server.off('listening', onListening);
        listenPromise = null;
        reject(new Error('Gateway failed to listen'));
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(config.port, config.host);
    });
    return listenPromise;
  }

  function shutdown() {
    if (shutdownPromise !== null) return shutdownPromise;
    shuttingDown = true;

    for (const context of [...connections]) {
      clearAuthTimer(context);
      context.phase = 'closing';
      closeSocket(context, 1001, 'Server shutting down');
      closeSession(context, 'shutdown');
    }

    const rawSocketPromises = [...rawSockets.values()].map((record) => {
      forceDestroyRawSocket(record);
      return record.promise;
    });

    shutdownPromise = (async () => {
      const outcomes = await Promise.allSettled([
        closeHttpServer(server),
        Promise.resolve().then(() => sessionManager.shutdown()),
        ...rawSocketPromises,
        ...webSocketClosePromises,
      ]);
      const creationPromises = [...connections]
        .map((context) => context.creationPromise)
        .filter((promise) => promise !== null);
      await Promise.allSettled(creationPromises);
      await Promise.allSettled([...cleanupPromises]);
      if (
        fatal
        || degraded
        || outcomes.some((outcome) => outcome.status === 'rejected')
      ) {
        throw new Error('Gateway shutdown failed');
      }
    })();
    return shutdownPromise;
  }

  return {
    listen,
    address: () => server.address(),
    close: shutdown,
    shutdown,
    httpServer: server,
    webSocketServer,
    sessionManager,
    fatalPromise,
  };
}

export async function runMain({
  env = process.env,
  processAdapter = process,
  consoleAdapter = console,
  createServer = createGatewayServer,
} = {}) {
  let gateway;
  try {
    gateway = createServer(loadConfig(env));
    await gateway.listen();
  } catch {
    try {
      consoleAdapter.error('Failed to start Claude gateway');
    } finally {
      processAdapter.exitCode = 1;
    }
    return { gateway: null, fatalHandled: Promise.resolve() };
  }

  const fatalHandled = gateway.fatalPromise.then(() => {
    try {
      consoleAdapter.error('Claude gateway stopped after runtime failure');
    } finally {
      processAdapter.exitCode = 1;
    }
  });

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    gateway.shutdown().catch(() => {
      try {
        consoleAdapter.error('Failed to shut down Claude gateway');
      } finally {
        processAdapter.exitCode = 1;
      }
    });
  };
  processAdapter.once('SIGTERM', stop);
  processAdapter.once('SIGINT', stop);
  return { gateway, fatalHandled };
}

const entrypoint = process.argv[1] === undefined ? null : path.resolve(process.argv[1]);
if (entrypoint === fileURLToPath(import.meta.url)) {
  runMain().catch(() => {
    console.error('Failed to start Claude gateway');
    process.exitCode = 1;
  });
}
