import { handleArtifact } from "./artifacts.js";
import { handleRelay } from "./relay.js";
import { handleSession } from "./session.js";

const NOT_FOUND_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "text/plain; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};

export default {
  async fetch(request, env, ctx) {
    const artifactResponse = await handleArtifact(request, env);
    if (artifactResponse) return artifactResponse;

    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/claude/session") {
      return handleSession(request, env);
    }
    if (pathname === "/api/anthropic/v1/messages") {
      return handleRelay(request, env, ctx);
    }
    return new Response("Not found", { status: 404, headers: NOT_FOUND_HEADERS });
  },
};
