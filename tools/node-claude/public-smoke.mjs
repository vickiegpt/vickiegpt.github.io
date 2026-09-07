import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const MAX_ARTIFACT_SIZE = 512 * 1024 * 1024;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const LFS_HEADER = "version https://git-lfs.github.com/spec/v1";

function exactUrl(origin, pathname) {
  const url = new URL(pathname, origin);
  if (url.origin !== origin || url.search || url.hash) throw new Error("Artifact URL must remain same-origin");
  return url.href;
}

async function fetchExact(fetchImpl, url, init = {}) {
  const response = await fetchImpl(url, { ...init, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) throw new Error(`Redirect rejected for ${url}`);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  if (response.url && new URL(response.url).origin !== new URL(url).origin) {
    throw new Error(`Cross-origin response rejected for ${url}`);
  }
  return response;
}

function contentLength(response) {
  const value = Number(response.headers.get("content-length"));
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ARTIFACT_SIZE) {
    throw new Error("Invalid artifact Content-Length");
  }
  return value;
}

async function verifyArtifact({ fetchImpl, url, type, expectedHash, expectedSize }) {
  const head = await fetchExact(fetchImpl, url, { method: "HEAD" });
  if (head.status !== 200 || head.headers.get("content-type") !== type) {
    throw new Error(`Unexpected artifact metadata for ${url}`);
  }
  if (head.headers.get("accept-ranges") !== "bytes") throw new Error(`Range support missing for ${url}`);
  const size = contentLength(head);
  if (expectedSize !== undefined && size !== expectedSize) throw new Error(`Artifact size mismatch for ${url}`);

  const rangeEnd = Math.min(7, size - 1);
  const range = await fetchExact(fetchImpl, url, {
    method: "GET",
    headers: { Range: "bytes=0-7" },
  });
  if (range.status !== 206) throw new Error(`Range request was not honored for ${url}`);
  if (range.headers.get("content-range") !== `bytes 0-${rangeEnd}/${size}`) {
    throw new Error(`Invalid Content-Range for ${url}`);
  }
  const prefix = new Uint8Array(await range.arrayBuffer());
  if (prefix.byteLength !== rangeEnd + 1) throw new Error(`Invalid range length for ${url}`);

  const full = await fetchExact(fetchImpl, url, { method: "GET", cache: "no-store" });
  if (full.status !== 200 || full.headers.get("content-type") !== type) {
    throw new Error(`Unexpected artifact response for ${url}`);
  }
  if (contentLength(full) !== size || !full.body) throw new Error(`Artifact body metadata mismatch for ${url}`);

  const hash = createHash("sha256");
  const reader = full.body.getReader();
  let received = 0;
  let header = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > size || received > MAX_ARTIFACT_SIZE) throw new Error(`Artifact exceeded declared size for ${url}`);
    if (header.length < LFS_HEADER.length) header += new TextDecoder().decode(value.subarray(0, LFS_HEADER.length - header.length));
    hash.update(value);
  }
  if (header.startsWith(LFS_HEADER)) throw new Error(`Git LFS pointer returned for ${url}`);
  if (received !== size) throw new Error(`Artifact body size mismatch for ${url}`);
  const actualHash = hash.digest("hex");
  if (actualHash !== expectedHash) throw new Error(`Artifact SHA-256 mismatch for ${url}`);
  return { url, size, sha256: actualHash };
}

export async function verifyPublicRuntime(baseUrl, { fetchImpl = globalThis.fetch } = {}) {
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" || base.origin !== "https://asplos.dev") {
    throw new Error("Public runtime smoke test requires https://asplos.dev");
  }
  const origin = base.origin;
  const manifestUrl = exactUrl(origin, "/about/runtime-manifest.json");
  const manifestResponse = await fetchExact(fetchImpl, manifestUrl, { cache: "no-store" });
  if (!(manifestResponse.headers.get("content-type") || "").startsWith("application/json")) {
    throw new Error("Runtime manifest is not JSON");
  }
  const manifest = await manifestResponse.json();
  if (
    manifest?.schema !== 1 ||
    manifest.url !== "/about/node-claude.webc" ||
    !Number.isSafeInteger(manifest.size) ||
    manifest.size < 1 ||
    manifest.size > MAX_ARTIFACT_SIZE ||
    !HASH_PATTERN.test(manifest.sha256) ||
    !HASH_PATTERN.test(manifest.nodeSha256)
  ) {
    throw new Error("Runtime manifest is invalid");
  }

  const webc = await verifyArtifact({
    fetchImpl,
    url: exactUrl(origin, manifest.url),
    type: "application/octet-stream",
    expectedHash: manifest.sha256,
    expectedSize: manifest.size,
  });
  const wasm = await verifyArtifact({
    fetchImpl,
    url: exactUrl(origin, "/about/node.wasm"),
    type: "application/wasm",
    expectedHash: manifest.nodeSha256,
  });
  return { manifest, webc, wasm };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyPublicRuntime(process.argv[2] || "https://asplos.dev").then(
    ({ webc, wasm }) => console.log(JSON.stringify({ ok: true, webc, wasm })),
    (error) => {
      console.error(error.message);
      process.exitCode = 1;
    },
  );
}
