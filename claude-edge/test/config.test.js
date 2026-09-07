import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handleConfig } from "../src/config.js";

describe("browser Claude public config", () => {
  it("returns only the public Turnstile site key", async () => {
    const response = handleConfig(
      new Request("https://asplos.dev/api/claude/config"),
      {
        TURNSTILE_SITE_KEY: "public-site-key",
        TURNSTILE_SECRET: "must-not-leak",
        ZHIPU_API_KEY: "must-not-leak",
        RELAY_SIGNING_KEY: "must-not-leak",
      },
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { turnstileSiteKey: "public-site-key" });

    const body = await handleConfig(
      new Request("https://asplos.dev/api/claude/config"),
      { TURNSTILE_SITE_KEY: "public-site-key" },
    ).text();
    assert.doesNotMatch(body, /secret|zhipu|signing/i);
  });

  it("fails closed for missing bindings and non-GET methods", () => {
    assert.equal(
      handleConfig(new Request("https://asplos.dev/api/claude/config"), {}).status,
      503,
    );
    assert.equal(
      handleConfig(
        new Request("https://asplos.dev/api/claude/config", { method: "POST" }),
        { TURNSTILE_SITE_KEY: "public-site-key" },
      ).status,
      405,
    );
  });
});
