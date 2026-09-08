import { createCapability } from "./capability.js";
import { HttpError, jsonResponse, readJsonBody } from "./http.js";
import {
  ALLOWED_ORIGIN,
  CAPABILITY_TTL_MS,
  SESSION_BODY_LIMIT,
} from "./policy.js";

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export async function handleSession(request, env, options = {}) {
  const randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "POST" });
  }
  if (request.headers.get("Origin") !== ALLOWED_ORIGIN) {
    return jsonResponse({ error: "Forbidden" }, 403);
  }
  const ip = request.headers.get("CF-Connecting-IP");
  if (!env.TURNSTILE_SECRET || !env.RELAY_SIGNING_KEY) {
    return jsonResponse({ error: "Service unavailable" }, 503);
  }

  let input;
  try {
    input = await readJsonBody(request, SESSION_BODY_LIMIT);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 400;
    return jsonResponse({ error: error.message }, status);
  }
  if (
    typeof input?.token !== "string" ||
    input.token.length === 0 ||
    input.token.length > 2048
  ) {
    return jsonResponse({ error: "Invalid challenge token" }, 400);
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  let verification;
  try {
    const verificationPayload = {
      secret: env.TURNSTILE_SECRET,
      response: input.token,
      idempotency_key: randomUUID(),
    };
    if (ip) verificationPayload.remoteip = ip;
    const response = await fetchImpl(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(verificationPayload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("Siteverify failed");
    verification = await response.json();
  } catch {
    return jsonResponse({ error: "Challenge verification unavailable" }, 503);
  }
  if (
    verification?.success !== true ||
    verification.hostname !== "asplos.dev" ||
    verification.action !== "claude-session"
  ) {
    return jsonResponse({ error: "Challenge rejected" }, 403);
  }

  const now = (options.now ?? Date.now)();
  const sessionId = randomUUID();
  const capability = await createCapability({
    secret: env.RELAY_SIGNING_KEY,
    sessionId,
    now,
  });
  return jsonResponse({
    capability,
    expiresIn: CAPABILITY_TTL_MS / 1000,
  });
}
