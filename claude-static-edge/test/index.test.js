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
        headers: { 'content-type': 'application/javascript' },
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
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('rejects requests outside the Claude static prefix', async () => {
  assert.ok(implementation, 'Claude static edge implementation must exist');
  const response = await implementation.handleRequest(
    new Request('https://asplos.dev/api/claude/config'),
    async () => new Response('unexpected'),
  );

  assert.equal(response.status, 404);
});
