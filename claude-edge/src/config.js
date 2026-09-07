import { jsonResponse } from "./http.js";

export function handleConfig(request, env) {
  if (request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405, { Allow: "GET" });
  }
  if (
    typeof env.TURNSTILE_SITE_KEY !== "string" ||
    env.TURNSTILE_SITE_KEY.length === 0 ||
    env.TURNSTILE_SITE_KEY.length > 256
  ) {
    return jsonResponse({ error: "Service unavailable" }, 503);
  }
  return jsonResponse({ turnstileSiteKey: env.TURNSTILE_SITE_KEY });
}
