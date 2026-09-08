import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createCapability,
  verifyCapability,
} from "../src/capability.js";
import { handleSession } from "../src/session.js";
import { handleRelay } from "../src/relay.js";

const SECRET = "test-signing-key-with-at-least-32-bytes";
const NOW = 1_788_825_600_000;

async function capability() {
  return createCapability({
    secret: SECRET,
    sessionId: "5b355de8-42b1-4d9c-a9bd-a8c2a11925fd",
    now: NOW,
  });
}

describe("relay security", () => {
  it("binds a signed capability to its session and five-minute lifetime", async () => {
    const token = await capability();
    const claims = await verifyCapability(token, {
      secret: SECRET,
      now: NOW + 299_000,
    });

    assert.equal(claims.v, 2);
    assert.equal(claims.sid, "5b355de8-42b1-4d9c-a9bd-a8c2a11925fd");
    assert.equal("iph" in claims, false);
    await assert.rejects(
      verifyCapability(token, {
        secret: SECRET,
        now: NOW + 301_000,
      }),
      /Expired capability/,
    );
  });

  it("issues a capability only after a matching Turnstile validation", async () => {
    const request = new Request("https://asplos.dev/api/claude/session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://asplos.dev",
      },
      body: JSON.stringify({ token: "turnstile-token" }),
    });
    const response = await handleSession(
      request,
      {
        RELAY_SIGNING_KEY: SECRET,
        TURNSTILE_SECRET: "turnstile-secret",
      },
      {
        now: () => NOW,
        randomUUID: () => "5b355de8-42b1-4d9c-a9bd-a8c2a11925fd",
        fetchImpl: async (url, init) => {
          assert.equal(
            url,
            "https://challenges.cloudflare.com/turnstile/v0/siteverify",
          );
          const body = JSON.parse(init.body);
          assert.equal(body.secret, "turnstile-secret");
          assert.equal(body.response, "turnstile-token");
          assert.equal(body.remoteip, undefined);
          return Response.json({
            success: true,
            hostname: "asplos.dev",
            action: "claude-session",
          });
        },
      },
    );

    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.expiresIn, 300);
    const claims = await verifyCapability(result.capability, {
      secret: SECRET,
      now: NOW,
    });
    assert.equal(claims.sid, "5b355de8-42b1-4d9c-a9bd-a8c2a11925fd");
  });

  it("rejects a valid Turnstile token issued for another hostname", async () => {
    const response = await handleSession(
      new Request("https://asplos.dev/api/claude/session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://asplos.dev",
        },
        body: JSON.stringify({ token: "turnstile-token" }),
      }),
      {
        RELAY_SIGNING_KEY: SECRET,
        TURNSTILE_SECRET: "turnstile-secret",
      },
      {
        fetchImpl: async () =>
          Response.json({
            success: true,
            hostname: "attacker.example",
            action: "claude-session",
          }),
      },
    );

    assert.equal(response.status, 403);
  });

  it("forces the Zhipu endpoint and model, then releases the quota lease", async () => {
    const token = await capability();
    const releases = [];
    const pending = [];
    const stub = {
      async acquire(input) {
        assert.equal(input.sessionId, "5b355de8-42b1-4d9c-a9bd-a8c2a11925fd");
        return { ok: true, leaseId: "lease-1" };
      },
      async release(leaseId) {
        releases.push(leaseId);
      },
    };
    const env = {
      RELAY_SIGNING_KEY: SECRET,
      ZHIPU_API_KEY: "server-only-zhipu-key",
      RELAY_QUOTA: {
        getByName(name) {
          assert.equal(name, "5b355de8-42b1-4d9c-a9bd-a8c2a11925fd");
          return stub;
        },
      },
    };
    const response = await handleRelay(
      new Request("https://asplos.dev/api/anthropic/v1/messages", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-5-20250929",
          max_tokens: 20_000,
          messages: [{ role: "user", content: "Reply exactly OK" }],
          stream: true,
        }),
      }),
      env,
      { waitUntil(promise) { pending.push(promise); } },
      {
        now: () => NOW,
        fetchImpl: async (url, init) => {
          assert.equal(url, "https://api.z.ai/api/anthropic/v1/messages");
          assert.equal(init.headers.get("Authorization"), "Bearer server-only-zhipu-key");
          const body = JSON.parse(init.body);
          assert.equal(body.model, "glm-4.7");
          assert.equal(body.max_tokens, 8192);
          return new Response("data: OK\n\n", {
            headers: { "Content-Type": "text/event-stream" },
          });
        },
      },
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "data: OK\n\n");
    await Promise.all(pending);
    assert.deepEqual(releases, ["lease-1"]);
  });

  it("rejects oversized request bodies before quota or upstream work", async () => {
    const token = await capability();
    let touched = false;
    const response = await handleRelay(
      new Request("https://asplos.dev/api/anthropic/v1/messages", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Length": "1048577",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
      {
        RELAY_SIGNING_KEY: SECRET,
        RELAY_QUOTA: { getByName() { touched = true; } },
      },
      {},
      { now: () => NOW, fetchImpl: async () => { touched = true; } },
    );

    assert.equal(response.status, 413);
    assert.equal(touched, false);
  });
});
