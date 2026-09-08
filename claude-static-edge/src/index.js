const STATIC_ROOT = 'https://raw.githubusercontent.com/vickiegpt/vickiegpt.github.io/main';
const STATIC_PREFIX = '/claude/';
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' data: https://challenges.cloudflare.com wss://wisp.mercurywork.shop",
  "worker-src 'self' blob: data:",
  "frame-src https://challenges.cloudflare.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.wasm', 'application/wasm'],
]);

function contentType(pathname, fallback) {
  for (const [extension, type] of CONTENT_TYPES) {
    if (pathname.endsWith(extension)) return type;
  }
  return fallback;
}

export async function handleRequest(request, fetchImpl = fetch) {
  const url = new URL(request.url);
  if ((request.method !== 'GET' && request.method !== 'HEAD') || !url.pathname.startsWith(STATIC_PREFIX)) {
    return new Response('Not found', { status: 404 });
  }

  const pathname = url.pathname === STATIC_PREFIX ? `${STATIC_PREFIX}index.html` : url.pathname;
  const upstreamUrl = new URL(`${STATIC_ROOT}${pathname}${url.search}`);
  const upstream = await fetchImpl(new Request(upstreamUrl, request));
  const headers = new Headers(upstream.headers);
  headers.set('Cache-Control', 'no-store, no-transform');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  headers.set('Content-Type', contentType(pathname, headers.get('Content-Type') || 'application/octet-stream'));
  headers.delete('Content-Length');

  return new Response(request.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

export default {
  fetch(request) {
    return handleRequest(request);
  },
};
