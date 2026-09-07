import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BrowserNodeRuntime } from "../src/runtime.js";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeTerminal() {
  const dataHandlers = new Set();
  const resizeHandlers = new Set();
  return {
    cols: 92,
    rows: 31,
    output: [],
    onData(handler) {
      dataHandlers.add(handler);
      return { dispose: () => dataHandlers.delete(handler) };
    },
    onResize(handler) {
      resizeHandlers.add(handler);
      return { dispose: () => resizeHandlers.delete(handler) };
    },
    write(chunk) {
      this.output.push(chunk);
    },
    emitData(value) {
      for (const handler of dataHandlers) handler(value);
    },
    emitResize(value) {
      for (const handler of resizeHandlers) handler(value);
    },
  };
}

function asyncChunks(chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

describe("BrowserNodeRuntime lifecycle", () => {
  it("connects terminal streams, serializes input, and forwards resize", async () => {
    const writes = [];
    const resizes = [];
    const firstWrite = deferred();
    const processExit = deferred();
    let writeCount = 0;
    const process = {
      stdin: {
        async write(value) {
          writes.push(value);
          writeCount += 1;
          if (writeCount === 1) await firstWrite.promise;
        },
      },
      stdout: asyncChunks([new Uint8Array([65]), new Uint8Array([66])]),
      stderr: asyncChunks([new Uint8Array([67])]),
      resizeTerminal(cols, rows) {
        resizes.push([cols, rows]);
      },
      async wait() {
        return processExit.promise;
      },
      async terminate() {},
    };
    const terminal = fakeTerminal();
    const runtime = new BrowserNodeRuntime({}, {
      launch: async (options) => {
        assert.equal(options.capability, "short-lived-capability");
        assert.equal(options.columns, 92);
        assert.equal(options.rows, 31);
        return { process, sandbox: { close: async () => {} }, wasmer: { close: async () => {} } };
      },
    });

    await runtime.start("short-lived-capability", terminal);
    terminal.emitData("first");
    terminal.emitData("second");
    await Promise.resolve();
    assert.deepEqual(writes, ["first"]);
    firstWrite.resolve();
    await runtime.flushInput();
    assert.deepEqual(writes, ["first", "second"]);

    terminal.emitResize({ cols: 120, rows: 44 });
    assert.deepEqual(resizes, [[120, 44]]);
    await runtime.waitForPumps();
    assert.deepEqual(terminal.output, [
      new Uint8Array([65]),
      new Uint8Array([67]),
      new Uint8Array([66]),
    ]);
    processExit.resolve({ exitCode: 0, reason: "exited" });
  });

  it("cancels a stale start and closes resources in reverse ownership order", async () => {
    const launched = deferred();
    const order = [];
    const runtime = new BrowserNodeRuntime({}, {
      launch: async () => launched.promise,
    });
    const start = runtime.start("capability", fakeTerminal());
    const stop = runtime.stop();
    launched.resolve({
      process: {
        stdin: null,
        stdout: null,
        stderr: null,
        async terminate() { order.push("process"); },
        async wait() { return { exitCode: 0, reason: "terminated" }; },
      },
      sandbox: { async close() { order.push("sandbox"); } },
      wasmer: { async close() { order.push("wasmer"); } },
    });

    await assert.rejects(start, { name: "AbortError" });
    await stop;
    assert.deepEqual(order, ["process", "sandbox", "wasmer"]);
    assert.equal(runtime.state, "idle");
  });
});
