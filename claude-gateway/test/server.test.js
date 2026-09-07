import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';

import WebSocket from 'ws';

import { createGatewayServer, loadConfig } from '../src/server.js';

const ORIGIN = 'https://asplos.dev';
const TOKEN = 'test-access-token';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeSession {
  constructor() {
    this.writes = [];
    this.resizes = [];
    this.closeCalls = [];
  }

  write(data) {
    this.writes.push(data);
  }

  resize(cols, rows) {
    this.resizes.push([cols, rows]);
  }

  async close(reason) {
    this.closeCalls.push(reason);
  }
}

class FakeSessionManager {
  constructor({ create, activeCount = 0, shutdown } = {}) {
    this.createCalls = [];
    this.activeCount = activeCount;
    this.createImpl = create;
    this.shutdownCalls = 0;
    this.shutdownImpl = shutdown;
  }

  async create(socket, size) {
    this.createCalls.push({ socket, size });
    if (this.createImpl !== undefined) return this.createImpl(socket, size);
    return new FakeSession();
  }

  async shutdown() {
    this.shutdownCalls += 1;
    return this.shutdownImpl?.();
  }
}

function gatewayConfig(overrides = {}) {
  return {
    accessToken: TOKEN,
    allowedOrigins: [ORIGIN],
    launcher: '/opt/claude-web/run-claude-session.sh',
    workspaceRoot: '/var/lib/claude-web/sessions',
    maxSessions: 1,
    idleTimeoutMs: 900_000,
    maxBufferedBytes: 1024 * 1024,
    terminationGraceMs: 1_000,
    killGraceMs: 1_000,
    socketCloseTimeoutMs: 1_000,
    authTimeoutMs: 100,
    port: 0,
    host: '127.0.0.1',
    childEnv: Object.create(null),
    ...overrides,
  };
}

async function startGateway({ config = {}, manager = new FakeSessionManager(), adapters = {} } = {}) {
  const gateway = createGatewayServer(gatewayConfig(config), {
    sessionManager: manager,
    ...adapters,
  });
  await gateway.listen();
  const { port } = gateway.address();
  return { gateway, manager, port };
}

function request(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({
        statusCode: response.statusCode,
        headers: response.headers,
        body,
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

function rawUpgrade(port, path = '/ws/claude', origin = ORIGIN) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: '127.0.0.1',
      port,
      allowHalfOpen: true,
    });
    let response = '';
    socket.setEncoding('latin1');
    socket.on('connect', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n`
        + `Host: 127.0.0.1:${port}\r\n`
        + 'Connection: Upgrade\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Sec-WebSocket-Version: 13\r\n'
        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
        + (origin === null ? '' : `Origin: ${origin}\r\n`)
        + '\r\n',
      );
    });
    socket.on('data', (chunk) => {
      response += chunk;
      if (response.includes('\r\n\r\n')) resolve({ socket, response });
    });
    socket.once('error', reject);
  });
}

async function completesWithin(promise, timeoutMs = 500) {
  return Promise.race([
    promise.then(() => true, () => true),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

function openWebSocket(port, path = '/ws/claude', origin = ORIGIN) {
  return new Promise((resolve, reject) => {
    const options = origin === undefined ? {} : { origin };
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, options);
    socket.once('open', () => resolve(socket));
    socket.once('error', reject);
  });
}

function rejectedUpgrade(port, path = '/ws/claude', origin = ORIGIN) {
  return new Promise((resolve, reject) => {
    const options = origin === null ? {} : { origin };
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, options);
    socket.once('open', () => reject(new Error('upgrade unexpectedly accepted')));
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve(response.statusCode);
    });
    socket.once('error', (error) => {
      if (error.code === 'ECONNREFUSED') resolve(503);
      else reject(error);
    });
  });
}

function nextMessage(socket) {
  return new Promise((resolve, reject) => {
    socket.once('message', (data, isBinary) => {
      try {
        assert.equal(isBinary, false);
        resolve(JSON.parse(data.toString()));
      } catch (error) {
        reject(error);
      }
    });
    socket.once('error', reject);
  });
}

function nextClose(socket) {
  return new Promise((resolve) => {
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
  });
}

async function authenticate(socket) {
  const message = nextMessage(socket);
  socket.send(JSON.stringify({ type: 'auth', token: TOKEN }));
  assert.deepEqual(await message, { type: 'state', state: 'authenticated' });
}

async function eventually(predicate, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('condition was not reached');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test('loadConfig validates production settings and builds an explicit child environment', () => {
  const config = loadConfig({
    CLAUDE_WEB_ACCESS_TOKEN: 'production-secret',
    CLAUDE_WEB_ALLOWED_ORIGINS: 'https://asplos.dev',
    CLAUDE_WEB_LAUNCHER: '/opt/claude-web/run-claude-session.sh',
    CLAUDE_WEB_WORKSPACE_ROOT: '/var/lib/claude-web/sessions',
    CLAUDE_WEB_MAX_SESSIONS: '1',
    CLAUDE_WEB_IDLE_TIMEOUT_MS: '900000',
    CLAUDE_WEB_MAX_BUFFERED_BYTES: '2097152',
    CLAUDE_WEB_TERMINATION_GRACE_MS: '1500',
    CLAUDE_WEB_KILL_GRACE_MS: '1200',
    CLAUDE_WEB_SOCKET_CLOSE_TIMEOUT_MS: '800',
    PORT: '8787',
    HOST: '127.0.0.1',
    ANTHROPIC_BASE_URL: 'https://api.example',
    ANTHROPIC_AUTH_TOKEN: 'child-secret',
    NODE_WASMU: '/opt/wasmu',
    NODE_WASM_ROOT: '/opt/node',
    CLAUDE_CLI: '/opt/claude',
    PATH: '/usr/bin',
    HOME: '/root',
    SSH_AUTH_SOCK: '/private/agent',
  });

  assert.equal(config.accessToken, 'production-secret');
  assert.deepEqual(config.allowedOrigins, ['https://asplos.dev']);
  assert.equal(config.authTimeoutMs, 5_000);
  assert.equal(config.maxBufferedBytes, 2_097_152);
  assert.equal(config.terminationGraceMs, 1_500);
  assert.equal(config.killGraceMs, 1_200);
  assert.equal(config.socketCloseTimeoutMs, 800);
  assert.deepEqual({ ...config.childEnv }, {
    ANTHROPIC_BASE_URL: 'https://api.example',
    ANTHROPIC_AUTH_TOKEN: 'child-secret',
    NODE_WASMU: '/opt/wasmu',
    NODE_WASM_ROOT: '/opt/node',
    CLAUDE_CLI: '/opt/claude',
    PATH: '/usr/bin',
  });
});

test('loadConfig fails safely for missing values and invalid integer ranges', () => {
  const base = {
    CLAUDE_WEB_ACCESS_TOKEN: 'do-not-print-this',
    CLAUDE_WEB_ALLOWED_ORIGINS: 'https://asplos.dev',
    CLAUDE_WEB_LAUNCHER: '/private/launcher',
    CLAUDE_WEB_WORKSPACE_ROOT: '/private/workspaces',
    CLAUDE_WEB_MAX_SESSIONS: '1',
    CLAUDE_WEB_IDLE_TIMEOUT_MS: '900000',
    PORT: '8787',
    HOST: '127.0.0.1',
  };

  for (const [key, value] of [
    ['CLAUDE_WEB_MAX_SESSIONS', '0'],
    ['CLAUDE_WEB_IDLE_TIMEOUT_MS', '1.5'],
    ['CLAUDE_WEB_AUTH_TIMEOUT_MS', '-1'],
    ['CLAUDE_WEB_MAX_BUFFERED_BYTES', '0'],
    ['PORT', '65536'],
  ]) {
    assert.throws(
      () => loadConfig({ ...base, [key]: value }),
      (error) => {
        assert.equal(error.message.includes('do-not-print-this'), false);
        assert.equal(error.message.includes('/private/'), false);
        return true;
      },
    );
  }
  assert.throws(() => loadConfig({}), /configuration/i);
});

test('timer configuration accepts 2147483647 and rejects larger values', () => {
  const base = {
    CLAUDE_WEB_ACCESS_TOKEN: 'secret',
    CLAUDE_WEB_ALLOWED_ORIGINS: 'https://asplos.dev',
    CLAUDE_WEB_LAUNCHER: '/opt/claude-web/run-claude-session.sh',
    CLAUDE_WEB_WORKSPACE_ROOT: '/var/lib/claude-web/sessions',
    CLAUDE_WEB_MAX_SESSIONS: '1',
    CLAUDE_WEB_IDLE_TIMEOUT_MS: '900000',
    PORT: '8787',
    HOST: '127.0.0.1',
  };
  const timerKeys = [
    'CLAUDE_WEB_IDLE_TIMEOUT_MS',
    'CLAUDE_WEB_AUTH_TIMEOUT_MS',
    'CLAUDE_WEB_TERMINATION_GRACE_MS',
    'CLAUDE_WEB_KILL_GRACE_MS',
    'CLAUDE_WEB_SOCKET_CLOSE_TIMEOUT_MS',
  ];

  for (const key of timerKeys) {
    assert.doesNotThrow(() => loadConfig({ ...base, [key]: '2147483647' }));
    assert.throws(() => loadConfig({ ...base, [key]: '2147483648' }), /configuration/i);
  }
  assert.throws(
    () => createGatewayServer(gatewayConfig({ authTimeoutMs: 2_147_483_648 })),
    /configuration/i,
  );
});

test('GET /healthz is minimal JSON and other HTTP routes fail safely', async (t) => {
  const { gateway, port } = await startGateway();
  t.after(() => gateway.shutdown());

  const health = await request(port, '/healthz');
  assert.equal(health.statusCode, 200);
  assert.match(health.headers['content-type'], /^application\/json\b/);
  assert.deepEqual(JSON.parse(health.body), { status: 'ok' });
  assert.equal(health.body.includes(TOKEN), false);
  assert.equal(health.body.includes('/var/lib/claude-web'), false);

  assert.equal((await request(port, '/missing')).statusCode, 404);
  assert.equal((await request(port, '/healthz', 'POST')).statusCode, 405);
  assert.equal((await request(port, '/missing', 'POST')).statusCode, 404);
});

test('malformed HTTP requests receive a generic response without configuration values', async (t) => {
  const { gateway, port } = await startGateway();
  t.after(() => gateway.shutdown());

  const response = await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let data = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write('GET / HTTP/1.1\r\nBad Header\r\n\r\n'));
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });

  assert.match(response, /^HTTP\/1\.1 400 /);
  assert.equal(response.includes(TOKEN), false);
  assert.equal(response.includes('/var/lib/claude-web'), false);
});

test('upgrade requires the exact path without query confusion', async (t) => {
  const { gateway, port } = await startGateway();
  t.after(() => gateway.shutdown());

  for (const path of ['/ws/claude/', '/ws/claude?admin=1', '/ws/claudeevil', '/other']) {
    assert.equal(await rejectedUpgrade(port, path), 404);
  }
});

test('upgrade rejects missing, malformed, and non-matching origins before acceptance', async (t) => {
  const { gateway, port } = await startGateway();
  t.after(() => gateway.shutdown());

  assert.equal(await rejectedUpgrade(port, '/ws/claude', null), 403);
  assert.equal(await rejectedUpgrade(port, '/ws/claude', 'https://asplos.dev.attacker.example'), 403);
  assert.equal(await rejectedUpgrade(port, '/ws/claude', 'not-an-origin'), 403);
});

test('the first frame must authenticate before the configured deadline', async (t) => {
  const manager = new FakeSessionManager();
  const { gateway, port } = await startGateway({ config: { authTimeoutMs: 15 }, manager });
  t.after(() => gateway.shutdown());

  const socket = await openWebSocket(port);
  const closed = await nextClose(socket);
  assert.equal(closed.code, 1008);
  assert.equal(manager.createCalls.length, 0);
});

test('invalid token, malformed, binary, and oversized first frames close with 1008', async (t) => {
  const manager = new FakeSessionManager();
  const { gateway, port } = await startGateway({ manager });
  t.after(() => gateway.shutdown());
  const frames = [
    [JSON.stringify({ type: 'auth', token: 'wrong-token' }), {}],
    ['{bad-json', {}],
    [Buffer.from(JSON.stringify({ type: 'auth', token: TOKEN })), { binary: true }],
    ['x'.repeat(65_537), {}],
  ];

  for (const [frame, options] of frames) {
    const socket = await openWebSocket(port);
    const close = nextClose(socket);
    socket.send(frame, options);
    assert.equal((await close).code, 1008);
  }
  assert.equal(manager.createCalls.length, 0);
});

test('successful auth sends state and creates exactly one session', async (t) => {
  const manager = new FakeSessionManager();
  const { gateway, port } = await startGateway({ manager });
  t.after(() => gateway.shutdown());
  const socket = await openWebSocket(port);

  await authenticate(socket);
  await eventually(() => manager.createCalls.length === 1);
  assert.deepEqual(manager.createCalls[0].size, { cols: 80, rows: 24 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(manager.createCalls.length, 1);
  socket.close();
});

test('capacity exhaustion sends busy and closes without calling create', async (t) => {
  const manager = new FakeSessionManager({ activeCount: 1 });
  const { gateway, port } = await startGateway({ manager });
  t.after(() => gateway.shutdown());
  const socket = await openWebSocket(port);
  const messages = [];
  socket.on('message', (data) => messages.push(JSON.parse(data.toString())));
  const close = nextClose(socket);

  socket.send(JSON.stringify({ type: 'auth', token: TOKEN }));
  assert.equal((await close).code, 1013);
  assert.deepEqual(messages, [
    { type: 'state', state: 'authenticated' },
    { type: 'state', state: 'busy' },
  ]);
  assert.equal(manager.createCalls.length, 0);
});

test('post-auth input and resize are delegated, while duplicate and invalid messages violate policy', async (t) => {
  const sessions = [];
  const manager = new FakeSessionManager({
    create: async () => {
      const session = new FakeSession();
      sessions.push(session);
      return session;
    },
  });
  const { gateway, port } = await startGateway({ manager });
  t.after(() => gateway.shutdown());

  const socket = await openWebSocket(port);
  await authenticate(socket);
  socket.send(JSON.stringify({ type: 'input', data: 'pwd\n' }));
  socket.send(JSON.stringify({ type: 'resize', cols: 500, rows: 2 }));
  await eventually(() => sessions[0]?.writes.length === 1 && sessions[0]?.resizes.length === 1);
  assert.deepEqual(sessions[0].writes, ['pwd\n']);
  assert.deepEqual(sessions[0].resizes, [[240, 5]]);
  const duplicateClose = nextClose(socket);
  socket.send(JSON.stringify({ type: 'auth', token: TOKEN }));
  assert.equal((await duplicateClose).code, 1008);

  for (const frame of ['{"type":"unknown"}', '{bad-json']) {
    const invalidSocket = await openWebSocket(port);
    await authenticate(invalidSocket);
    const close = nextClose(invalidSocket);
    invalidSocket.send(frame);
    assert.equal((await close).code, 1008);
  }
});

test('disconnect during async creation closes the eventual session without leaking it', async (t) => {
  const creation = deferred();
  const manager = new FakeSessionManager({ create: () => creation.promise });
  const { gateway, port } = await startGateway({ manager });
  t.after(() => gateway.shutdown());
  const socket = await openWebSocket(port);

  await authenticate(socket);
  await eventually(() => manager.createCalls.length === 1);
  const closed = nextClose(socket);
  socket.close();
  await closed;
  const session = new FakeSession();
  creation.resolve(session);
  await eventually(() => session.closeCalls.length === 1);
});

test('session creation failures send only a generic unavailable state', async (t) => {
  const manager = new FakeSessionManager({
    create: async () => { throw new Error(`/host/private failed with ${TOKEN}`); },
  });
  const { gateway, port } = await startGateway({ manager });
  t.after(() => gateway.shutdown());
  const socket = await openWebSocket(port);
  const messages = [];
  socket.on('message', (data) => messages.push(JSON.parse(data.toString())));
  const close = nextClose(socket);

  socket.send(JSON.stringify({ type: 'auth', token: TOKEN }));
  assert.equal((await close).code, 1011);
  assert.deepEqual(messages, [
    { type: 'state', state: 'authenticated' },
    { type: 'state', state: 'unavailable' },
  ]);
  assert.equal(JSON.stringify(messages).includes('/host/private'), false);
  assert.equal(JSON.stringify(messages).includes(TOKEN), false);
});

test('hostile half-open rejected upgrades cannot hold shutdown indefinitely', async () => {
  const { gateway, port } = await startGateway({ config: { socketCloseTimeoutMs: 10 } });
  const { socket, response } = await rawUpgrade(port, '/rejected');
  assert.match(response, /^HTTP\/1\.1 404 /);

  const shutdown = gateway.shutdown();
  const completed = await completesWithin(shutdown, 250);
  socket.destroy();
  await shutdown;
  assert.equal(completed, true);
});

test('shutdown terminates a non-cooperating unauthenticated WebSocket and awaits closure', async () => {
  const { gateway, port } = await startGateway({ config: { socketCloseTimeoutMs: 10 } });
  const { socket, response } = await rawUpgrade(port);
  assert.match(response, /^HTTP\/1\.1 101 /);
  const remoteEnded = new Promise((resolve) => socket.once('end', resolve));

  const completed = await completesWithin(Promise.all([gateway.shutdown(), remoteEnded]), 250);
  socket.destroy();
  assert.equal(completed, true);
});

test('session cleanup failure degrades health and makes shutdown fail closed without leakage', async () => {
  const session = {
    write() {},
    resize() {},
    async close() {
      throw new Error(`/host/private cleanup failed with ${TOKEN}`);
    },
  };
  const manager = new FakeSessionManager({ create: async () => session });
  const { gateway, port } = await startGateway({ manager });
  const socket = await openWebSocket(port);
  await authenticate(socket);
  await eventually(() => manager.createCalls.length === 1);
  const closed = nextClose(socket);
  socket.close();
  await closed;
  await eventually(async () => (await request(port, '/healthz')).statusCode === 503);

  const health = await request(port, '/healthz');
  assert.equal(health.statusCode, 503);
  assert.deepEqual(JSON.parse(health.body), { status: 'degraded' });
  assert.equal(health.body.includes(TOKEN), false);
  await assert.rejects(gateway.shutdown(), (error) => {
    assert.match(error.message, /Gateway shutdown failed/);
    assert.equal(error.message.includes('/host/private'), false);
    assert.equal(error.message.includes(TOKEN), false);
    return true;
  });
});

test('runtime HTTP and WebSocket server errors trigger bounded sanitized fatal shutdown', async (t) => {
  for (const emitterName of ['httpServer', 'webSocketServer']) {
    await t.test(emitterName, async () => {
      const { gateway, port } = await startGateway({ config: { socketCloseTimeoutMs: 10 } });
      const socket = await openWebSocket(port);
      const closed = nextClose(socket);
      gateway[emitterName].emit('error', new Error(`/host/private ${TOKEN}`));

      await assert.rejects(gateway.shutdown(), (error) => {
        assert.equal(error.message, 'Gateway shutdown failed');
        assert.equal(error.message.includes('/host/private'), false);
        assert.equal(error.message.includes(TOKEN), false);
        return true;
      });
      await closed;
    });
  }
});

test('real SessionManager cleans a starting workspace during gateway shutdown', async () => {
  const workspaceCreation = deferred();
  const workspaceStarted = deferred();
  const removed = [];
  const ptys = [];
  const root = '/srv/claude-workspaces';
  const workspace = `${root}/claude-session-race`;
  const fakeFs = {
    async realpath(target) {
      return target;
    },
    async lstat(target) {
      return {
        dev: 1,
        ino: target === root ? 1 : 2,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      };
    },
    async mkdtemp() {
      workspaceStarted.resolve();
      await workspaceCreation.promise;
      return workspace;
    },
    async rm(target, options) {
      removed.push({ target, options });
    },
  };
  const fakePty = {
    spawn() {
      const exitListeners = new Set();
      const pty = {
        onData: () => ({ dispose() {} }),
        onExit(listener) {
          exitListeners.add(listener);
          return { dispose: () => exitListeners.delete(listener) };
        },
        kill(signal) {
          queueMicrotask(() => {
            for (const listener of [...exitListeners]) listener({ exitCode: null, signal });
          });
        },
        write() {},
        resize() {},
      };
      ptys.push(pty);
      return pty;
    },
  };
  const gateway = createGatewayServer(gatewayConfig({ workspaceRoot: root }), {
    sessionAdapters: { fs: fakeFs, pty: fakePty },
  });
  await gateway.listen();
  const { port } = gateway.address();
  const socket = await openWebSocket(port);
  await authenticate(socket);
  await workspaceStarted.promise;

  const shutdown = gateway.shutdown();
  workspaceCreation.resolve();
  await shutdown;

  assert.equal(removed.length, 1);
  assert.equal(removed[0].target, workspace);
  assert.deepEqual(removed[0].options, { recursive: true, force: true });
  assert.equal(ptys.length, 0);
});

test('real SessionManager startup cleanup quarantine degrades the gateway and retains capacity', async (t) => {
  const root = '/srv/claude-workspaces';
  const workspace = `${root}/claude-session-failed`;
  const fakeFs = {
    async realpath(target) {
      return target;
    },
    async lstat(target) {
      return {
        dev: 1,
        ino: target === root ? 1 : 2,
        isDirectory: () => true,
        isSymbolicLink: () => false,
      };
    },
    async mkdtemp() {
      return workspace;
    },
    async rm() {
      throw new Error(`/host/private removal failed with ${TOKEN}`);
    },
  };
  const fakePty = {
    spawn() {
      throw new Error(`/host/private spawn failed with ${TOKEN}`);
    },
  };
  const gateway = createGatewayServer(gatewayConfig({ workspaceRoot: root }), {
    sessionAdapters: { fs: fakeFs, pty: fakePty },
  });
  t.after(() => gateway.shutdown().catch(() => {}));
  await gateway.listen();
  const { port } = gateway.address();
  const socket = await openWebSocket(port);
  const messages = [];
  socket.on('message', (data) => messages.push(JSON.parse(data.toString())));
  const closed = nextClose(socket);

  socket.send(JSON.stringify({ type: 'auth', token: TOKEN }));
  assert.equal((await closed).code, 1011);
  assert.deepEqual(messages, [
    { type: 'state', state: 'authenticated' },
    { type: 'error', message: 'Unable to create session' },
  ]);
  assert.equal(gateway.sessionManager.activeCount, 1);
  const health = await request(port, '/healthz');
  assert.equal(health.statusCode, 503);
  assert.deepEqual(JSON.parse(health.body), { status: 'degraded' });
  assert.equal(JSON.stringify(messages).includes('/host/private'), false);
  assert.equal(health.body.includes(TOKEN), false);
  await assert.rejects(gateway.shutdown(), (error) => {
    assert.equal(error.message, 'Gateway shutdown failed');
    assert.equal(error.message.includes('/host/private'), false);
    assert.equal(error.message.includes(TOKEN), false);
    return true;
  });
  assert.equal(gateway.sessionManager.activeCount, 1);
});

test('injectable production main sets nonzero exit status after sanitized runtime fatal shutdown', async () => {
  const { runMain } = await import('../src/server.js');
  const processAdapter = new EventEmitter();
  processAdapter.exitCode = 0;
  const logs = [];
  const consoleAdapter = { error: (message) => logs.push(message) };
  const manager = new FakeSessionManager();
  const env = {
    CLAUDE_WEB_ACCESS_TOKEN: TOKEN,
    CLAUDE_WEB_ALLOWED_ORIGINS: ORIGIN,
    CLAUDE_WEB_LAUNCHER: '/opt/claude-web/run-claude-session.sh',
    CLAUDE_WEB_WORKSPACE_ROOT: '/var/lib/claude-web/sessions',
    CLAUDE_WEB_MAX_SESSIONS: '1',
    CLAUDE_WEB_IDLE_TIMEOUT_MS: '900000',
    PORT: '8787',
    HOST: '127.0.0.1',
  };
  const runtime = await runMain({
    env,
    processAdapter,
    consoleAdapter,
    createServer: (config) => createGatewayServer(
      { ...config, port: 0 },
      { sessionManager: manager },
    ),
  });

  runtime.gateway.webSocketServer.emit(
    'error',
    new Error(`/host/private runtime failed with ${TOKEN}`),
  );
  await runtime.fatalHandled;

  assert.equal(processAdapter.exitCode, 1);
  assert.deepEqual(logs, ['Claude gateway stopped after runtime failure']);
  assert.equal(JSON.stringify(logs).includes('/host/private'), false);
  assert.equal(JSON.stringify(logs).includes(TOKEN), false);
});

test('shutdown refuses upgrades, clears auth timers, closes unauthenticated sockets, and awaits cleanup', async () => {
  const managerShutdown = deferred();
  const manager = new FakeSessionManager({ shutdown: () => managerShutdown.promise });
  const timerHandles = new Set();
  const timers = {
    setTimeout(callback, delay) {
      const handle = setTimeout(callback, delay);
      timerHandles.add(handle);
      return handle;
    },
    clearTimeout(handle) {
      timerHandles.delete(handle);
      clearTimeout(handle);
    },
  };
  const { gateway, port } = await startGateway({ manager, adapters: { timers } });
  const unauthenticated = await openWebSocket(port);
  assert.equal(timerHandles.size, 1);
  const socketClosed = nextClose(unauthenticated);

  let shutdownFinished = false;
  const shutdown = gateway.shutdown().then(() => { shutdownFinished = true; });
  assert.equal((await socketClosed).code, 1001);
  await eventually(() => timerHandles.size === 0);
  assert.equal(timerHandles.size, 0);
  assert.equal(manager.shutdownCalls, 1);
  assert.equal(shutdownFinished, false);
  assert.equal(await rejectedUpgrade(port), 503);

  managerShutdown.resolve();
  await shutdown;
  assert.equal(shutdownFinished, true);
  await gateway.shutdown();
  assert.equal(manager.shutdownCalls, 1);
});
