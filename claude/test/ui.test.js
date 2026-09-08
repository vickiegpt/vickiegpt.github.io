import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import * as mainModule from "../src/main.js";

import {
  RuntimeController,
  ensureCrossOriginIsolation,
  loadTurnstileApi,
  requestCapability,
} from "../src/main.js";

describe("browser Claude terminal UI", () => {
  it("unregisters the legacy isolation worker when edge headers already isolate the page", async () => {
    let unregistered = 0;
    const result = await ensureCrossOriginIsolation({
      isolated: true,
      navigatorImpl: {
        serviceWorker: {
          async getRegistrations() {
            return [{ async unregister() { unregistered += 1; } }];
          },
        },
      },
      storage: { removeItem() {} },
    });

    assert.equal(result, true);
    assert.equal(unregistered, 1);
  });

  it("shows concrete runtime failures without exposing bearer material", () => {
    assert.equal(typeof mainModule.describeRuntimeError, "function");
    assert.equal(
      mainModule.describeRuntimeError(new Error("WebAssembly.Memory(): could not allocate memory")),
      "WebAssembly.Memory(): could not allocate memory",
    );
    assert.doesNotMatch(
      mainModule.describeRuntimeError(new Error("network failed token=secret-value")),
      /secret-value/,
    );
  });

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

  it("waits for an existing Turnstile stub before calling render", async () => {
    let readyCallback;
    const turnstile = {
      ready(callback) {
        readyCallback = callback;
      },
    };
    const loading = loadTurnstileApi({
      globalImpl: { turnstile },
      documentImpl: null,
    });

    assert.equal(typeof readyCallback, "function");
    turnstile.render = () => "widget";
    readyCallback();
    assert.equal(await loading, turnstile);
  });

  it("loads Turnstile once through its explicit ready callback", async () => {
    const globalImpl = {};
    let script;
    const loading = loadTurnstileApi({
      globalImpl,
      documentImpl: {
        querySelector() { return null; },
        createElement() {
          script = {
            addEventListener() {},
            removeEventListener() {},
          };
          return script;
        },
        head: { append() {} },
      },
    });

    const source = new URL(script.src);
    assert.equal(source.searchParams.get("render"), "explicit");
    const callbackName = source.searchParams.get("onload");
    assert.ok(callbackName);
    assert.equal(typeof globalImpl[callbackName], "function");

    const turnstile = { render() {} };
    globalImpl.turnstile = turnstile;
    globalImpl[callbackName]();
    assert.equal(await loading, turnstile);
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

  it("lets the application own the single Turnstile script load", async () => {
    const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

    assert.doesNotMatch(html, /challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/);
    assert.match(html, /\.\/assets\/app\.js/);
  });

  it("uses a compact challenge that cannot widen the launch sidebar", async () => {
    const source = await readFile(new URL("../app.js", import.meta.url), "utf8");

    assert.match(source, /size:\s*["']compact["']/);
    assert.match(source, /appearance:\s*["']always["']/);
    assert.doesNotMatch(source, /size:\s*["']flexible["']/);
    assert.doesNotMatch(source, /appearance:\s*["']interaction-only["']/);
  });

  it("fits the terminal without observing its own changing dimensions", async () => {
    const source = await readFile(new URL("../app.js", import.meta.url), "utf8");

    assert.doesNotMatch(source, /new ResizeObserver/);
    assert.match(source, /Math\.min\(240,/);
    assert.match(source, /addEventListener\(["']resize["']/);
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

  assertVersionedEntry.match(html, /\.\/assets\/app\.js\?v=20260908-7/);
  assertVersionedEntry.match(html, /\.\/assets\/styles\.css\?v=20260908-7/);
});

versionedEntryTest('keeps terminal actions inside the toolbar on narrow screens', async () => {
  const css = await readVersionedEntry(new URL('../styles.css', import.meta.url), 'utf8');

  assertVersionedEntry.match(css, /\.terminal-toolbar\s*\{[^}]*min-width:\s*0/s);
  assertVersionedEntry.match(css, /\.terminal-actions\s*\{[^}]*flex-wrap:\s*wrap/s);
  assertVersionedEntry.match(css, /\.terminal-actions\s*\{[^}]*max-width:\s*100%/s);
  assertVersionedEntry.match(css, /\.runtime-shell\s*\{[^}]*min-width:\s*0/s);
  assertVersionedEntry.match(css, /#terminal\s*\{[^}]*contain:\s*inline-size/s);
  assertVersionedEntry.match(css, /@media\s*\(max-width:\s*640px\)[\s\S]*\.terminal-actions\s*\{[^}]*width:\s*100%/s);
});
