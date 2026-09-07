import assert from "node:assert/strict";
import { describe, it } from "node:test";
import worker from "../src/index.js";

function bodyStream(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(Uint8Array.from(bytes));
      controller.close();
    },
  });
}

function fakeObject(bytes, range = undefined) {
  return {
    body: bodyStream(bytes),
    size: range?.total ?? bytes.length,
    range: range
      ? { offset: range.offset, length: bytes.length }
      : undefined,
    httpEtag: '"artifact-etag"',
    writeHttpMetadata(headers) {
      headers.set("Content-Language", "en");
    },
  };
}

function environment(get) {
  return { ARTIFACTS: { get } };
}

describe("artifact delivery", () => {
  it("streams the exact WEBC object", async () => {
    const env = environment(async (key) => {
      assert.equal(key, "current/node-claude.webc");
      return fakeObject([0x00, 0x77, 0x65, 0x62, 0x63]);
    });
    const response = await worker.fetch(
      new Request("https://asplos.dev/about/node-claude.webc"),
      env,
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/octet-stream");
    assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [
      0x00, 0x77, 0x65, 0x62, 0x63,
    ]);
  });

  it("serves WASM with its exact media type", async () => {
    const env = environment(async () => fakeObject([0x00, 0x61, 0x73, 0x6d]));
    const response = await worker.fetch(
      new Request("https://asplos.dev/about/node.wasm"),
      env,
    );
    assert.equal(response.headers.get("content-type"), "application/wasm");
  });

  it("supports HEAD without returning the R2 body", async () => {
    const env = environment(async () => fakeObject([1, 2, 3, 4]));
    const response = await worker.fetch(
      new Request("https://asplos.dev/about/node.wasm", { method: "HEAD" }),
      env,
    );
    assert.equal(response.status, 200);
    assert.equal(response.body, null);
    assert.equal(response.headers.get("content-length"), "4");
  });

  it("passes a single range to R2 and returns 206", async () => {
    const env = environment(async (_key, options) => {
      assert.equal(options.range.get("Range"), "bytes=4-7");
      return fakeObject([4, 5, 6, 7], { offset: 4, total: 12 });
    });
    const response = await worker.fetch(
      new Request("https://asplos.dev/about/node.wasm", {
        headers: { Range: "bytes=4-7" },
      }),
      env,
    );
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), "bytes 4-7/12");
    assert.equal(response.headers.get("content-length"), "4");
  });

  it("rejects methods, query strings, and malformed ranges", async () => {
    const env = environment(async () => fakeObject([1]));
    assert.equal(
      (
        await worker.fetch(
          new Request("https://asplos.dev/about/node.wasm", { method: "POST" }),
          env,
        )
      ).status,
      405,
    );
    assert.equal(
      (
        await worker.fetch(
          new Request("https://asplos.dev/about/node.wasm?download=1"),
          env,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await worker.fetch(
          new Request("https://asplos.dev/about/node.wasm", {
            headers: { Range: "bytes=0-1,4-5" },
          }),
          env,
        )
      ).status,
      416,
    );
  });

  it("does not expose bucket keys or R2 errors", async () => {
    const env = environment(async () => {
      throw new Error("current/node.wasm internal bucket detail");
    });
    const response = await worker.fetch(
      new Request("https://asplos.dev/about/node.wasm"),
      env,
    );
    assert.equal(response.status, 503);
    assert.equal(await response.text(), "Artifact temporarily unavailable");
  });

  it("returns generic 404 for absent and unknown objects", async () => {
    const env = environment(async () => null);
    const absent = await worker.fetch(
      new Request("https://asplos.dev/about/node.wasm"),
      env,
    );
    const unknown = await worker.fetch(
      new Request("https://asplos.dev/private/object"),
      env,
    );
    assert.equal(absent.status, 404);
    assert.equal(unknown.status, 404);
  });
});
