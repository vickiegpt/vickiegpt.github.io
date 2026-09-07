import { handleArtifact } from "./artifacts.js";

const NOT_FOUND_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "text/plain; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};

export default {
  async fetch(request, env) {
    const artifactResponse = await handleArtifact(request, env);
    if (artifactResponse) return artifactResponse;
    return new Response("Not found", { status: 404, headers: NOT_FOUND_HEADERS });
  },
};
