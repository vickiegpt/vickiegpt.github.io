import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  RuntimeController,
  loadTurnstileApi,
  requestCapability,
} from "../src/main.js";

describe("browser Claude terminal UI", () => {
  it("reuses an existing Turnstile API without appending another script", async () => {
    const turnstile = { render() {} };
    let appended = 0;
    const result = await loadTurnstileApi({
      globalImpl: { turnstile },
      documentImpl: {
        querySelector() { return null; },
        createElement() { throw new Error("must not create a script"); },
        head: { append() { appended += 1; } },
      },
    });
    assert.equal(result, turnstile);
    assert.equal(appended, 0);
  });

  it("contains terminal controls and removes the direct API editor", async () => {
    const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
    for (const id of [
      "start-runtime",
      "stop-runtime",
      "clear-terminal",
      "runtime-progress",
      "terminal",
      "turnstile",
    ]) {
      assert.match(html, new RegExp(`id=["']${id}["']`));
    }
    assert.doesNotMatch(html, /id=["'](?:editor|api-key|endpoint)["']/);
    assert.match(html, /\.\/assets\/app\.js/);
  });

  it("exchanges a one-time challenge using the fixed same-origin endpoint", async () => {
    const calls = [];
    const result = await requestCapability("challenge-token", {
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({
          capability: "short-lived-capability",
          expiresIn: 300,
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
      pageOrigin: "https://asplos.dev",
    });

    assert.deepEqual(result, {
      capability: "short-lived-capability",
      expiresIn: 300,
    });
    assert.equal(calls[0].url, "https://asplos.dev/api/claude/session");
    assert.deepEqual(JSON.parse(calls[0].init.body), { token: "challenge-token" });
    assert.equal(calls[0].init.headers["content-type"], "application/json");
  });

  it("runs challenge, session, and runtime in order without persisting capability", async () => {
    const order = [];
    const storageWrites = [];
    const controller = new RuntimeController({
      runtime: {
        async start(capability) {
          order.push(`runtime:${capability}`);
        },
        async stop() {
          order.push("stop");
        },
      },
      terminal: {},
      challenge: {
        async execute() {
          order.push("challenge");
          return "one-time-token";
        },
        reset() {
          order.push("reset");
        },
      },
      requestSession: async (token) => {
        order.push(`session:${token}`);
        return { capability: "private-capability", expiresIn: 300 };
      },
      onState: (state) => order.push(`state:${state}`),
      storage: {
        setItem(key, value) {
          storageWrites.push([key, value]);
        },
      },
    });

    await controller.start();
    assert.deepEqual(order.slice(0, 7), [
      "state:challenge",
      "challenge",
      "state:starting",
      "session:one-time-token",
      "reset",
      "runtime:private-capability",
      "state:running",
    ]);
    assert.deepEqual(storageWrites, []);
  });

  it("invalidates a pending start before stopping the runtime", async () => {
    let releaseChallenge;
    const challenge = new Promise((resolve) => {
      releaseChallenge = resolve;
    });
    const states = [];
    let starts = 0;
    const controller = new RuntimeController({
      runtime: {
        async start() { starts += 1; },
        async stop() {},
      },
      terminal: {},
      challenge: {
        execute: () => challenge,
        reset() {},
      },
      requestSession: async () => ({ capability: "cap", expiresIn: 300 }),
      onState: (state) => states.push(state),
    });

    const starting = controller.start();
    const stopping = controller.stop();
    releaseChallenge("late-token");
    await assert.rejects(starting, { name: "AbortError" });
    await stopping;
    assert.equal(starts, 0);
    assert.equal(states.at(-1), "idle");
  });
});
import { test as versionedEntryTest } from 'node:test';
import { readFile as readVersionedEntry } from 'node:fs/promises';
import assertVersionedEntry from 'node:assert/strict';

versionedEntryTest('loads the browser runtime through a versioned entry URL', async () => {
  const html = await readVersionedEntry(new URL('../index.html', import.meta.url), 'utf8');

  assertVersionedEntry.match(html, /\.\/assets\/app\.js\?v=20260908-2/);
});

versionedEntryTest('keeps terminal actions inside the toolbar on narrow screens', async () => {
  const css = await readVersionedEntry(new URL('../styles.css', import.meta.url), 'utf8');

  assertVersionedEntry.match(css, /\.terminal-toolbar\s*\{[^}]*min-width:\s*0/s);
  assertVersionedEntry.match(css, /\.terminal-actions\s*\{[^}]*flex-wrap:\s*wrap/s);
  assertVersionedEntry.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*\.terminal-actions\s*\{[^}]*width:\s*100%/s);
});
