import assert from 'node:assert/strict';
import test from 'node:test';

let implementation;
try {
  implementation = await import('../src/index.js');
} catch {
  implementation = null;
}

test('proxies only Claude static files with native isolation headers', async () => {
  assert.ok(implementation, 'Claude static edge implementation must exist');
  const seen = [];
  const response = await implementation.handleRequest(
    new Request('https://asplos.dev/claude/assets/app.js?v=2'),
    async (request) => {
      seen.push(request.url);
      return new Response('runtime', {
        headers: {
          'content-type': 'application/javascript',
          'content-security-policy': "default-src 'none'; sandbox",
        },
      });
    },
  );

  assert.deepEqual(seen, [
    'https://raw.githubusercontent.com/vickiegpt/vickiegpt.github.io/main/claude/assets/app.js?v=2',
  ]);
  assert.equal(await response.text(), 'runtime');
  assert.equal(response.headers.get('Cross-Origin-Opener-Policy'), 'same-origin');
  assert.equal(response.headers.get('Cross-Origin-Embedder-Policy'), 'credentialless');
  assert.equal(response.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
  assert.equal(response.headers.get('Cache-Control'), 'no-store, no-transform');
  const policy = response.headers.get('Content-Security-Policy');
  assert.doesNotMatch(policy, /sandbox|default-src 'none'/);
  assert.match(policy, /script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' https:\/\/challenges\.cloudflare\.com/);
  assert.match(policy, /worker-src 'self' blob: data:/);
  assert.match(policy, /connect-src 'self' data: https:\/\/challenges\.cloudflare\.com wss:\/\/wisp\.mercurywork\.shop/);
});

test('rejects requests outside the Claude static prefix', async () => {
  assert.ok(implementation, 'Claude static edge implementation must exist');
  const response = await implementation.handleRequest(
    new Request('https://asplos.dev/api/claude/config'),
    async () => new Response('unexpected'),
  );

  assert.equal(response.status, 404);
});
