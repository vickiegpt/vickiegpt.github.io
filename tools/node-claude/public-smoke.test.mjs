import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { verifyPublicRuntime } from "./public-smoke.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function response(url, body, init = {}) {
  const value = new Response(body, init);
  Object.defineProperty(value, "url", { value: url });
  return value;
}

function runtimeFetch(webc = Buffer.from("webc-runtime")) {
  const wasm = Buffer.from("wasm-runtime");
  const manifest = {
    schema: 1,
    url: "/about/node-claude.webc",
    size: webc.length,
    sha256: sha256(webc),
    nodeSha256: sha256(wasm),
  };
  return async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("runtime-manifest.json")) {
      return response(url, JSON.stringify(manifest), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const bytes = url.endsWith("node.wasm") ? wasm : webc;
    const type = url.endsWith("node.wasm") ? "application/wasm" : "application/octet-stream";
    if (init.method === "HEAD") {
      return response(url, null, {
        status: 200,
        headers: { "content-type": type, "content-length": String(bytes.length), "accept-ranges": "bytes" },
      });
    }
    if (init.headers?.Range === "bytes=0-7") {
      return response(url, bytes.subarray(0, 8), {
        status: 206,
        headers: {
          "content-type": type,
          "content-length": String(Math.min(8, bytes.length)),
          "content-range": `bytes 0-${Math.min(7, bytes.length - 1)}/${bytes.length}`,
        },
      });
    }
    return response(url, bytes, {
      status: 200,
      headers: { "content-type": type, "content-length": String(bytes.length) },
    });
  };
}

describe("public runtime smoke verifier", () => {
  it("checks public headers, ranges, byte lengths, and hashes", async () => {
    const result = await verifyPublicRuntime("https://asplos.dev", {
      fetchImpl: runtimeFetch(),
    });
    assert.equal(result.webc.sha256, sha256(Buffer.from("webc-runtime")));
    assert.equal(result.wasm.sha256, sha256(Buffer.from("wasm-runtime")));
  });

  it("rejects a Git LFS pointer even when its manifest hash matches", async () => {
    const pointer = Buffer.from(
      "version https://git-lfs.github.com/spec/v1\n" +
      "oid sha256:0000000000000000000000000000000000000000000000000000000000000000\n" +
      "size 121744300\n",
    );
    await assert.rejects(
      verifyPublicRuntime("https://asplos.dev", { fetchImpl: runtimeFetch(pointer) }),
      /Git LFS pointer/,
    );
  });
});
