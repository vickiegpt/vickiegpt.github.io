import { verifyCapability } from "./capability.js";
import { HttpError, jsonResponse, readJsonBody } from "./http.js";
import {
  MESSAGE_BODY_LIMIT,
  UPSTREAM_TIMEOUT_MS,
  ZHIPU_MESSAGES_URL,
  ZHIPU_MODEL,
} from "./policy.js";

function capabilityFrom(request) {
  const authorization = request.headers.get("Authorization");
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7);
  return request.headers.get("X-Api-Key");
}

async function releaseLease(stub, leaseId) {
  try {
    await stub.release(leaseId);
  } catch {
    // Expiring leases provide the fail-safe if a release RPC is interrupted.
  }
}

function upstreamHeaders(request, apiKey) {
  const headers = new Headers({
    Accept: request.headers.get("Accept") ?? "application/json",
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "anthropic-version": request.headers.get("anthropic-version") ?? "2023-06-01",
  });
  const beta = request.headers.get("anthropic-beta");
  if (beta && beta.length <= 4096) headers.set("anthropic-beta", beta);
  return headers;
}

function responseHeaders(upstream) {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  for (const name of [
    "content-type",
    "request-id",
    "retry-after",
    "x-request-id",
  ]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

export async function handleRelay(request, env, ctx = {}, options = {}) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "POST" });
  }
  const ip = request.headers.get("CF-Connecting-IP");
  const token = capabilityFrom(request);
  if (!ip || !token || !env.RELAY_SIGNING_KEY) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const now = (options.now ?? Date.now)();
  let claims;
  try {
    claims = await verifyCapability(token, {
      secret: env.RELAY_SIGNING_KEY,
      ip,
      now,
    });
  } catch {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let input;
  try {
    input = await readJsonBody(request, MESSAGE_BODY_LIMIT);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 400;
    return jsonResponse({ error: error.message }, status);
  }
  if (!input || typeof input !== "object" || !Array.isArray(input.messages)) {
    return jsonResponse({ error: "Invalid Messages request" }, 400);
  }
  if (!env.ZHIPU_API_KEY || !env.RELAY_QUOTA) {
    return jsonResponse({ error: "Service unavailable" }, 503);
  }

  const requestedMax = Number.isInteger(input.max_tokens) && input.max_tokens > 0
    ? input.max_tokens
    : 8192;
  const body = JSON.stringify({
    ...input,
    model: ZHIPU_MODEL,
    max_tokens: Math.min(requestedMax, 8192),
  });

  const stub = env.RELAY_QUOTA.getByName(claims.iph);
  let lease;
  try {
    lease = await stub.acquire({
      sessionId: claims.sid,
      sessionExpiresAt: claims.exp * 1000,
      now,
    });
  } catch {
    return jsonResponse({ error: "Quota service unavailable" }, 503);
  }
  if (!lease?.ok) {
    return jsonResponse(
      { error: "Request quota exceeded" },
      429,
      { "Retry-After": String(lease?.retryAfter ?? 60) },
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  if (request.signal) {
    request.signal.addEventListener("abort", () => controller.abort(), {
      once: true,
    });
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  let upstream;
  try {
    upstream = await fetchImpl(ZHIPU_MESSAGES_URL, {
      method: "POST",
      headers: upstreamHeaders(request, env.ZHIPU_API_KEY),
      body,
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    await releaseLease(stub, lease.leaseId);
    return jsonResponse({ error: "Upstream unavailable" }, 502);
  }

  if (!upstream.body) {
    clearTimeout(timer);
    await releaseLease(stub, lease.leaseId);
    return new Response(null, {
      status: upstream.status,
      headers: responseHeaders(upstream),
    });
  }

  const transform = new TransformStream();
  const completion = upstream.body
    .pipeTo(transform.writable)
    .finally(async () => {
      clearTimeout(timer);
      await releaseLease(stub, lease.leaseId);
    });
  if (typeof ctx.waitUntil === "function") {
    ctx.waitUntil(completion.catch(() => {}));
  } else {
    void completion.catch(() => {});
  }
  return new Response(transform.readable, {
    status: upstream.status,
    headers: responseHeaders(upstream),
  });
}
