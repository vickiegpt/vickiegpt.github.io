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
import { SessionManager } from './session.js';

const WEBSOCKET_PATH = '/ws/claude';
const DEFAULT_AUTH_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;
const DEFAULT_KILL_GRACE_MS = 1_000;
const DEFAULT_SOCKET_CLOSE_TIMEOUT_MS = 1_000;
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
    idleTimeoutMs: parseInteger(env, 'CLAUDE_WEB_IDLE_TIMEOUT_MS'),
    authTimeoutMs: parseInteger(env, 'CLAUDE_WEB_AUTH_TIMEOUT_MS', {
      defaultValue: DEFAULT_AUTH_TIMEOUT_MS,
    }),
    maxBufferedBytes: parseInteger(env, 'CLAUDE_WEB_MAX_BUFFERED_BYTES', {
      defaultValue: DEFAULT_MAX_BUFFERED_BYTES,
    }),
    terminationGraceMs: parseInteger(env, 'CLAUDE_WEB_TERMINATION_GRACE_MS', {
      defaultValue: DEFAULT_TERMINATION_GRACE_MS,
    }),
    killGraceMs: parseInteger(env, 'CLAUDE_WEB_KILL_GRACE_MS', {
      defaultValue: DEFAULT_KILL_GRACE_MS,
    }),
    socketCloseTimeoutMs: parseInteger(env, 'CLAUDE_WEB_SOCKET_CLOSE_TIMEOUT_MS', {
      defaultValue: DEFAULT_SOCKET_CLOSE_TIMEOUT_MS,
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
  for (const key of [
    'maxSessions',
    'idleTimeoutMs',
    'authTimeoutMs',
    'maxBufferedBytes',
    'terminationGraceMs',
    'killGraceMs',
    'socketCloseTimeoutMs',
  ]) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw configurationError(key);
  }
  if (!Number.isSafeInteger(config.port) || config.port < 0 || config.port > 65_535) {
    throw configurationError('port');
  }
}

function rejectUpgrade(socket, statusCode, statusText) {
  if (socket.destroyed) return;
  try {
    socket.end(
      `HTTP/1.1 ${statusCode} ${statusText}\r\n`
      + 'Connection: close\r\n'
      + 'Content-Length: 0\r\n'
      + '\r\n',
    );
  } catch {
    try {
      socket.destroy();
    } catch {
      // The transport is already unusable.
    }
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
  let shuttingDown = false;
  let listenPromise = null;
  let shutdownPromise = null;

  const server = HttpServer.createServer((request, response) => {
    try {
      if (request.url === '/healthz' && request.method === 'GET') {
        const body = '{"status":"ok"}';
        response.writeHead(200, {
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

  function clearAuthTimer(context) {
    if (context.authTimer === null) return;
    timers.clearTimeout(context.authTimer);
    context.authTimer = null;
  }

  function closeSession(context, reason) {
    if (context.session === null || context.sessionClosePromise !== null) return;
    try {
      context.sessionClosePromise = Promise.resolve(context.session.close(reason)).catch(() => {});
    } catch {
      context.sessionClosePromise = Promise.resolve();
    }
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

  function closeSocket(context, code, reason) {
    if (!socketIsOpen(context.socket)) return;
    try {
      const result = context.socket.close(code, reason);
      if (result && typeof result.then === 'function') result.catch(() => {});
    } catch {
      try {
        context.socket.terminate();
      } catch {
        // Socket cleanup is best effort; session cleanup remains authoritative.
      }
    }
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

  function creationFailed(context) {
    if (context.phase === 'closing' || context.socketEnded) return;
    if (isAtCapacity()) {
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
    } catch {
      creationFailed(context);
      return;
    }
    context.creationPromise = Promise.resolve(creation).then(
      (session) => sessionCreated(context, session),
      () => creationFailed(context),
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
      pending: [],
    };
    connections.add(context);

    // ws enforces maxPayload with 1009. Protocol violations consistently use 1008.
    const nativeClose = socket.close;
    socket.close = function mappedClose(code, ...args) {
      return nativeClose.call(this, code === 1009 ? 1008 : code, ...args);
    };

    socket.on('message', (raw, isBinary) => onMessage(context, raw, isBinary));
    socket.on('error', () => endConnection(context, 'socket-error'));
    socket.on('close', () => endConnection(context, 'socket-close'));
    context.authTimer = timers.setTimeout(() => {
      failConnection(context, 1008, 'Authentication timeout');
    }, config.authTimeoutMs);
  });
  webSocketServer.on('error', () => {});

  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => {});
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
  server.on('error', () => {});

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
      if (context.phase === 'awaiting-auth' || context.phase === 'creating') {
        context.phase = 'closing';
        closeSocket(context, 1001, 'Server shutting down');
      }
    }

    shutdownPromise = (async () => {
      const outcomes = await Promise.allSettled([
        closeHttpServer(server),
        Promise.resolve().then(() => sessionManager.shutdown()),
      ]);
      const creationPromises = [...connections]
        .map((context) => context.creationPromise)
        .filter((promise) => promise !== null);
      await Promise.allSettled(creationPromises);
      if (outcomes.some((outcome) => outcome.status === 'rejected')) {
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
  };
}

async function main() {
  let gateway;
  try {
    gateway = createGatewayServer(loadConfig());
    await gateway.listen();
  } catch {
    console.error('Failed to start Claude gateway');
    process.exitCode = 1;
    return;
  }

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    gateway.shutdown().catch(() => {
      console.error('Failed to shut down Claude gateway');
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

const entrypoint = process.argv[1] === undefined ? null : path.resolve(process.argv[1]);
if (entrypoint === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Failed to start Claude gateway');
    process.exitCode = 1;
  });
}
