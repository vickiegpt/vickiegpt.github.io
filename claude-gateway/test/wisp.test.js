import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';

import { createGatewayServer } from '../src/server.js';
import { createRestrictedWispRouter, WISP_PATH } from '../src/wisp.js';

const ORIGIN = 'https://asplos.dev';

function config() {
  return {
    accessToken: 'test-access-token',
    allowedOrigins: [ORIGIN],
    launcher: '/opt/claude-web/run-claude-session.sh',
    workspaceRoot: '/var/lib/claude-web/sessions',
    maxSessions: 1,
    idleTimeoutMs: 900_000,
    maxBufferedBytes: 1024 * 1024,
    terminationGraceMs: 1_000,
    killGraceMs: 1_000,
    socketCloseTimeoutMs: 100,
    authTimeoutMs: 100,
    port: 0,
    host: '127.0.0.1',
    childEnv: Object.create(null),
  };
}

function sessionManager() {
  return {
    activeCount: 0,
    async create() { throw new Error('not used'); },
    async shutdown() {},
  };
}

async function start(wispRouter) {
  const gateway = createGatewayServer(config(), {
    sessionManager: sessionManager(),
    wispRouter,
  });
  await gateway.listen();
  return { gateway, port: gateway.address().port };
}

function upgrade(port, path, origin = ORIGIN) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let response = '';
    socket.setEncoding('latin1');
    socket.once('connect', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\n`
        + `Host: 127.0.0.1:${port}\r\n`
        + 'Connection: Upgrade\r\n'
        + 'Upgrade: websocket\r\n'
        + 'Sec-WebSocket-Version: 13\r\n'
        + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
        + `Origin: ${origin}\r\n\r\n`,
      );
    });
    socket.on('data', (chunk) => {
      response += chunk;
      if (response.includes('\r\n\r\n')) resolve({ socket, response });
    });
    socket.once('error', reject);
  });
}

test('restricted WISP config allows only asplos.dev:443 over TCP', () => {
  const fake = { options: {}, routeRequest() {} };
  const router = createRestrictedWispRouter(fake);

  assert.equal(WISP_PATH, '/wisp/');
  assert.equal(router.path, WISP_PATH);
  assert.deepEqual(fake.options.port_whitelist, [443]);
  assert.equal(fake.options.hostname_whitelist.length, 1);
  assert.equal(fake.options.hostname_whitelist[0].test('asplos.dev'), true);
  assert.equal(fake.options.hostname_whitelist[0].test('api.z.ai'), false);
  assert.equal(fake.options.allow_tcp_streams, true);
  assert.equal(fake.options.allow_udp_streams, false);
  assert.equal(fake.options.allow_direct_ip, false);
  assert.equal(fake.options.allow_private_ips, false);
  assert.equal(fake.options.allow_loopback_ips, false);
});

test('gateway routes only exact, same-origin WISP upgrades', async (t) => {
  const calls = [];
  const { gateway, port } = await start({
    path: WISP_PATH,
    route(request, socket, head) {
      calls.push({ url: request.url, headLength: head.length });
      socket.end(
        'HTTP/1.1 101 Switching Protocols\r\n'
        + 'Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
      );
    },
  });
  t.after(() => gateway.shutdown());

  const accepted = await upgrade(port, '/wisp/');
  assert.match(accepted.response, /^HTTP\/1\.1 101 /);
  accepted.socket.destroy();
  assert.deepEqual(calls, [{ url: '/wisp/', headLength: 0 }]);

  const query = await upgrade(port, '/wisp/?target=internal');
  assert.match(query.response, /^HTTP\/1\.1 404 /);
  query.socket.destroy();

  const wrongOrigin = await upgrade(port, '/wisp/', 'https://attacker.example');
  assert.match(wrongOrigin.response, /^HTTP\/1\.1 403 /);
  wrongOrigin.socket.destroy();
  assert.equal(calls.length, 1);
});

test('gateway shutdown destroys accepted WISP raw sockets', async () => {
  const { gateway, port } = await start({
    path: WISP_PATH,
    route(_request, socket) {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n'
        + 'Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
      );
    },
  });
  const accepted = await upgrade(port, '/wisp/');
  const closed = new Promise((resolve) => accepted.socket.once('close', resolve));

  await gateway.shutdown();
  await closed;
  assert.equal(accepted.socket.destroyed, true);
});
