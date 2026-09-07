const ARTIFACTS = new Map([
  [
    "/about/node.wasm",
    { key: "current/node.wasm", type: "application/wasm" },
  ],
  [
    "/about/node-claude.webc",
    { key: "current/node-claude.webc", type: "application/octet-stream" },
  ],
]);

const BASE_HEADERS = {
  "Cache-Control": "public, max-age=300",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
};

function errorResponse(status, message, extraHeaders = {}) {
  return new Response(message, {
    status,
    headers: {
      ...BASE_HEADERS,
      ...extraHeaders,
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

function validRangeHeader(value) {
  return value === null || /^bytes=(?:\d+-\d*|-\d+)$/.test(value);
}

export function artifactDescriptor(request) {
  const url = new URL(request.url);
  if (url.search || url.hash) return null;
  return ARTIFACTS.get(url.pathname) ?? null;
}

export async function handleArtifact(request, env) {
  const descriptor = artifactDescriptor(request);
  if (!descriptor) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return errorResponse(405, "Method not allowed", { Allow: "GET, HEAD" });
  }

  const rangeHeader = request.headers.get("Range");
  if (!validRangeHeader(rangeHeader)) {
    return errorResponse(416, "Range not satisfiable");
  }

  let object;
  try {
    object = await env.ARTIFACTS.get(
      descriptor.key,
      rangeHeader ? { range: request.headers } : undefined,
    );
  } catch {
    return errorResponse(503, "Artifact temporarily unavailable");
  }
  if (!object || !object.body) return errorResponse(404, "Artifact not found");

  const headers = new Headers(BASE_HEADERS);
  object.writeHttpMetadata?.(headers);
  headers.set("Content-Type", descriptor.type);
  if (object.httpEtag) headers.set("ETag", object.httpEtag);
  headers.set("Accept-Ranges", "bytes");

  let status = 200;
  if (rangeHeader && object.range && Number.isInteger(object.range.offset)) {
    const length = object.range.length;
    const end = object.range.offset + length - 1;
    headers.set("Content-Range", `bytes ${object.range.offset}-${end}/${object.size}`);
    headers.set("Content-Length", String(length));
    status = 206;
  } else {
    headers.set("Content-Length", String(object.size));
  }

  return new Response(request.method === "HEAD" ? null : object.body, {
    status,
    headers,
  });
}
