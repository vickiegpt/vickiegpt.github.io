# Browser Wasmer Node WEBC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package WASIX32 Node and Claude Code as a Git-LFS-managed WEBC artifact, serve it from Cloudflare R2, and run it in a browser xterm with a Turnstile-protected Zhipu relay.

**Architecture:** A deterministic Wasmer 6.1 build emits a content-hashed WEBC package and runtime manifest. Cloudflare R2 serves large bytes, while a Worker keeps the Zhipu key in a Secret, verifies Turnstile, issues five-minute capabilities, and enforces quotas through a Durable Object. The browser vendors Wasmer SDK 0.11.0 under `/claude/`, creates an ephemeral WASIX workspace, and connects fixed Node/Claude streams to xterm through a restricted WISP endpoint.

**Tech Stack:** Wasmer 6.1.0, WEBC, Git LFS 3.7.1, Node 22, `@wasmer/sdk` 0.11.0, xterm 6.0.0, Vite 8.2.2, Vitest 5.0.0, Wrangler 4.129.1, Cloudflare Workers, Durable Objects, Turnstile, and R2.

---

## File Map

- `.gitattributes`: LFS policy for the large WASM and WEBC files.
- `packaging/node-claude/wasmer.toml`: Node command and packaged `/app` filesystem.
- `tools/node-claude/artifact-config.json`: pinned source paths and versions.
- `tools/node-claude/build-webc.mjs`: safe staging, build, inspection, hashing, and atomic output.
- `tools/node-claude/*.test.mjs`: artifact and publication tests.
- `about/claude-debug.mjs`: pinned Claude Code 2.0.0 CLI bundle.
- `about/node.wasm`, `about/node-claude.webc`: LFS-managed runtime artifacts.
- `about/runtime-manifest.json`: public byte identity and fixed command metadata.
- `claude-edge/src/artifacts.js`: exact-path R2 reads.
- `claude-edge/src/capability.js`: HMAC capability issuance and verification.
- `claude-edge/src/limiter.js`: Durable Object quota/concurrency state.
- `claude-edge/src/relay.js`: bounded Anthropic-compatible Zhipu relay.
- `claude-edge/src/index.js`: Worker routing and Turnstile session endpoint.
- `claude-gateway/src/wisp.js`: restricted WISP upgrade handler.
- `claude/src/runtime.js`: manifest, download/hash, sandbox, process, streams, cleanup.
- `claude/src/main.js`: xterm, Turnstile session, and UI state.
- `claude/index.html`, `claude/app.js`, `claude/styles.css`: direct static terminal app.
- `claude/coi-serviceworker.js`: cross-origin isolation bootstrap.

### Task 1: Pin provenance and enable Git LFS

**Files:**
- Create: `.gitattributes`
- Create: `tools/node-claude/artifact-config.json`
- Create: `tools/node-claude/artifact-config.test.mjs`

- [ ] **Step 1: Write failing provenance tests**

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("artifact inputs are pinned", () => {
  const config = JSON.parse(fs.readFileSync(new URL("./artifact-config.json", import.meta.url)));
  assert.equal(config.wasmerVersion, "6.1.0");
  assert.equal(config.sdkVersion, "0.11.0");
  assert.equal(config.claudeVersion, "2.0.0");
  assert.equal(config.nodeSource, "about/node.wasm");
  assert.equal(config.claudeSource, "/home/out/claude-code-js-2.0.0/node_modules/@anthropic-ai/claude-code/cli.js");
});

test("large artifacts use LFS", () => {
  const attrs = fs.readFileSync(new URL("../../.gitattributes", import.meta.url), "utf8");
  assert.match(attrs, /^about\/node\.wasm filter=lfs diff=lfs merge=lfs -text$/m);
  assert.match(attrs, /^about\/node-claude\.webc filter=lfs diff=lfs merge=lfs -text$/m);
});
```

- [ ] **Step 2: Run and observe missing-file failures**

```bash
PATH=/opt/node22/bin:$PATH node --test tools/node-claude/artifact-config.test.mjs
```

Expected: FAIL because both implementation files are absent.

- [ ] **Step 3: Add the exact config and attributes**

```json
{
  "wasmerVersion": "6.1.0",
  "sdkVersion": "0.11.0",
  "claudeVersion": "2.0.0",
  "nodeSource": "about/node.wasm",
  "claudeSource": "/home/out/claude-code-js-2.0.0/node_modules/@anthropic-ai/claude-code/cli.js",
  "webcOutput": "about/node-claude.webc",
  "manifestOutput": "about/runtime-manifest.json",
  "command": "node"
}
```

```gitattributes
about/node.wasm filter=lfs diff=lfs merge=lfs -text
about/node-claude.webc filter=lfs diff=lfs merge=lfs -text
```

- [ ] **Step 4: Verify and commit**

```bash
PATH=/opt/node22/bin:$PATH node --test tools/node-claude/artifact-config.test.mjs
git check-attr filter diff merge text -- about/node.wasm about/node-claude.webc
git add .gitattributes tools/node-claude/artifact-config.json tools/node-claude/artifact-config.test.mjs
git commit -m "build: define Claude WEBC artifact provenance"
```

Expected: tests PASS and both paths report the LFS filter.

### Task 2: Build deterministic WEBC bytes

**Files:**
- Create: `packaging/node-claude/wasmer.toml`
- Create: `tools/node-claude/build-webc.mjs`
- Create: `tools/node-claude/build-webc.test.mjs`
- Create: `about/claude-debug.mjs`
- Modify: `about/node.wasm`
- Create: `about/node-claude.webc`
- Create: `about/runtime-manifest.json`

- [ ] **Step 1: Write failing builder tests**

Require exports:

```js
export async function sha256File(path) {}
export async function validateInputs(config) {}
export async function build(config, adapters = {}) {}
```

Tests reject wrong WASM magic, symlink escapes, missing CLI input, wrong Wasmer version, missing package command, and missing `/app/claude-debug.mjs`. A `RUN_REAL_WEBC=1` test checks output size and SHA-256 against the generated manifest.

- [ ] **Step 2: Run and observe module-not-found**

```bash
PATH=/opt/node22/bin:$PATH node --test tools/node-claude/build-webc.test.mjs
```

- [ ] **Step 3: Add and validate the Wasmer 6.1 manifest**

```toml
[package]
name = "vickiegpt/node-claude"
version = "2.0.0"
description = "WASIX32 Node runtime with Claude Code"
entrypoint = "node"

[[module]]
name = "node"
source = "node.wasm"
abi = "wasi"

[[command]]
name = "node"
module = "node"
runner = "wasi"

[fs]
"/app" = "app"
```

Run `wasmer package build --check <staging-directory>`. If Wasmer 6.1 names a rejected manifest key, replace only that key with its accepted schema and encode the accepted fixture in tests before building the large module.

- [ ] **Step 4: Implement safe staging**

`build()` must require `wasmer 6.1.0`, canonicalize inputs, verify WASM magic `00 61 73 6d`, copy the CLI byte-for-byte, stage only the manifest/module/script, invoke Wasmer without a shell, unpack and inspect the result, atomically rename output, and remove owned temporary directories in `finally`.

The JSON output must contain:

```js
{
  schema: 1,
  url: "/about/node-claude.webc",
  size,
  sha256,
  sdkVersion: "0.11.0",
  nodeVersion: "25.0.0-pre",
  claudeVersion: "2.0.0",
  command: "node",
  args: ["/app/claude-debug.mjs"]
}
```

- [ ] **Step 5: Run unit and real builds**

```bash
PATH=/opt/node22/bin:$PATH node --test tools/node-claude/build-webc.test.mjs
cp /home/victoryang00/node-wasix32/vickiegpt.github.io/about/node.wasm about/node.wasm
PATH=/opt/node22/bin:$PATH RUN_REAL_WEBC=1 node --test tools/node-claude/build-webc.test.mjs
```

Expected: package build/unpack succeeds and metadata matches bytes.

- [ ] **Step 6: Verify LFS pointers and commit**

```bash
git add about/node.wasm about/node-claude.webc
git show :about/node.wasm | head -1
git show :about/node-claude.webc | head -1
git lfs fsck
git add packaging/node-claude/wasmer.toml tools/node-claude/build-webc.mjs tools/node-claude/build-webc.test.mjs about/claude-debug.mjs about/runtime-manifest.json
git commit -m "build: package WASIX Node and Claude as WEBC"
```

Expected: staged large files are LFS pointers while working-tree files remain binaries.

### Task 3: Add R2 artifact delivery

**Files:**
- Create: `claude-edge/package.json`
- Create: `claude-edge/package-lock.json`
- Create: `claude-edge/wrangler.jsonc`
- Create: `claude-edge/src/artifacts.js`
- Create: `claude-edge/src/index.js`
- Create: `claude-edge/test/artifacts.test.js`

- [ ] **Step 1: Pin Worker tooling**

```json
{
  "name": "claude-edge",
  "private": true,
  "type": "module",
  "scripts": { "test": "vitest run", "deploy": "wrangler deploy" },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "0.22.0",
    "vitest": "5.0.0",
    "wrangler": "4.129.1"
  }
}
```

Run `PATH=/opt/node22/bin:$PATH npm install` in `claude-edge`.

- [ ] **Step 2: Write failing exact-route tests**

Test only GET/HEAD for `/about/node.wasm` and `/about/node-claude.webc`. Unknown paths/query strings return 404, other methods return 405, HEAD has no body, missing objects return generic 404, and `Range: bytes=0-3` returns four bytes with 206.

- [ ] **Step 3: Implement allowlisted R2 reads**

```js
const OBJECTS = new Map([
  ["/about/node.wasm", { key: "current/node.wasm", type: "application/wasm" }],
  ["/about/node-claude.webc", { key: "current/node-claude.webc", type: "application/octet-stream" }]
]);
```

Use `env.ARTIFACTS.get(key, { range: request.headers })`, preserve R2 range/ETag metadata, set CORP same-origin, nosniff, and bounded cache headers, and never expose bucket keys or exceptions.

- [ ] **Step 4: Add binding/routes, test, and commit**

Configure bucket `asplos-claude-artifacts` and routes for the two exact artifact paths plus `/api/claude/*` and `/api/anthropic/*`.

```bash
cd claude-edge
PATH=/opt/node22/bin:$PATH npm test
cd ..
git add claude-edge
git commit -m "feat: serve Claude runtime artifacts from R2"
```

### Task 4: Add Turnstile capabilities and atomic quotas

**Files:**
- Create: `claude-edge/src/capability.js`
- Create: `claude-edge/src/limiter.js`
- Create: `claude-edge/src/relay.js`
- Modify: `claude-edge/src/index.js`
- Modify: `claude-edge/wrangler.jsonc`
- Create: `claude-edge/test/capability.test.js`
- Create: `claude-edge/test/limiter.test.js`
- Create: `claude-edge/test/relay.test.js`

- [ ] **Step 1: Test signed capabilities**

```js
export async function issueCapability(claims, secret, now = Date.now()) {}
export async function verifyCapability(token, secret, context, now = Date.now()) {}
```

Test five-minute expiry, audience `claude-relay`, random session ID, HMAC-SHA-256, tampering, malformed input, future issuance, expiry, constant-work signature checks, and a keyed hash of `CF-Connecting-IP` rather than raw IP claims.

- [ ] **Step 2: Implement compact HMAC capabilities**

Return `base64url(payload) + "." + base64url(signature)`, reject unknown claims, cap tokens at 2048 bytes, and never include a raw IP or upstream key.

- [ ] **Step 3: Test and implement the Durable Object limiter**

Support atomic operations:

```js
{ op: "issue", ipHash, now }
{ op: "reserve", sessionId, ipHash, requestedTokens, now }
{ op: "release", reservationId, now }
```

Enforce 10 sessions/IP/day, 8 requests/session, 4 global concurrent requests, 200 requests/day, and 200000 requested output tokens/day. Test UTC reset, concurrent reserve, idempotent release, 120-second stale reservation expiry, and fail-closed storage errors.

- [ ] **Step 4: Test Turnstile and relay boundaries**

`POST /api/claude/session` accepts at most 4096 JSON bytes containing only `turnstileToken`. Verify Turnstile success, timeout, duplicate token, hostname `asplos.dev`, and action `claude-runtime`.

Relay accepts only exact `POST /api/anthropic/v1/messages`, valid capability, JSON at most 1 MiB, model `glm-4.7`, and integer `max_tokens` from 1 to 8192.

- [ ] **Step 5: Implement fixed Zhipu forwarding**

Verify Turnstile via `https://challenges.cloudflare.com/turnstile/v0/siteverify`. Forward relay traffic only to `https://api.z.ai/api/anthropic/v1/messages`, replacing authorization with `Bearer ${env.ZHIPU_API_KEY}`. Strip client forwarding/hop-by-hop headers, impose a 90-second deadline, preserve only JSON/event-stream responses, release reservations in `finally`, and emit generic failures.

- [ ] **Step 6: Add bindings, tests, and commit**

Bind a SQLite Durable Object `RELAY_LIMITER`. Keep `ZHIPU_API_KEY`, `TURNSTILE_SECRET`, and `RELAY_SIGNING_KEY` out of files.

```bash
cd claude-edge
PATH=/opt/node22/bin:$PATH npm test
cd ..
git add claude-edge
git commit -m "feat: protect Zhipu relay with Turnstile quotas"
```

### Task 5: Provide restricted WISP networking

**Files:**
- Modify: `claude-gateway/package.json`
- Modify: `claude-gateway/package-lock.json`
- Create: `claude-gateway/src/wisp.js`
- Modify: `claude-gateway/src/server.js`
- Create: `claude-gateway/test/wisp.test.js`

- [ ] **Step 1: Add `@mercuryworkshop/wisp-js` 0.4.1**

Record its AGPL-3.0 server dependency in the package license inventory.

- [ ] **Step 2: Write failing WISP tests**

Require exact `/wisp/`, Origin `https://asplos.dev`, Wisp v2, TCP only, port 443 only, hostname `asplos.dev` only, no direct/private/loopback IP, total/per-host stream limits of 4, sanitized errors, and bounded shutdown.

- [ ] **Step 3: Implement and attach the adapter**

```js
export function createRestrictedWisp(
  { allowedOrigin, hostname = "asplos.dev" },
  adapters = {}
) {}
```

Route exact `/wisp/` before the existing exact `/ws/claude` upgrade. All other upgrades retain hardened rejection. Shutdown stops both protocols and awaits WISP sockets.

- [ ] **Step 4: Run all gateway tests and commit**

```bash
cd claude-gateway
PATH=/opt/node22/bin:$PATH NODE_OPTIONS=--unhandled-rejections=strict npm test
cd ..
git add claude-gateway/package.json claude-gateway/package-lock.json claude-gateway/src/wisp.js claude-gateway/src/server.js claude-gateway/test/wisp.test.js
git commit -m "feat: add restricted browser WASIX WISP"
```

### Task 6: Implement the browser Wasmer lifecycle

**Files:**
- Create: `claude/package.json`
- Create: `claude/package-lock.json`
- Create: `claude/vite.config.js`
- Create: `claude/config.js`
- Create: `claude/src/runtime.js`
- Create: `claude/src/runtime.test.js`

- [ ] **Step 1: Pin local browser dependencies**

Use `@wasmer/sdk` 0.11.0, `@xterm/xterm` 6.0.0, `@xterm/addon-fit` 0.11.0, Vite 8.2.2, Vitest 5.0.0, jsdom 30.0.1, and Playwright 1.63.0. Configure base `./`, no source maps, and stable `app.js`/`styles.css`. Emit all SDK WASM/worker assets below `/claude/`; use no CDN imports.

- [ ] **Step 2: Write failing lifecycle tests**

Require:

```js
export function validateManifest(value, pageOrigin) {}
export async function downloadAndVerify(url, expected, adapters = {}) {}
export class BrowserNodeRuntime {
  constructor(options, adapters = {}) {}
  async start(capability, terminal) {}
  resize(cols, rows) {}
  async stop() {}
}
```

Test same-origin HTTPS, schema/SDK pin, no credentials/query/hash in URLs, 512 MiB cap, progress, abort, exact size/hash, stale starts, one runtime, fixed command/args, stream pumps, resize, nonzero exit, and reverse cleanup.

- [ ] **Step 3: Implement verified download and SDK startup**

Use:

```js
const { Wasmer } = await import("@wasmer/sdk/browser");
const wasmer = new Wasmer({ parallelism: 2, cache: { namespace: "node-claude-v1" } });
await wasmer.ready();
const pkg = await wasmer.packages.load(webcBytes);
const sandbox = await wasmer.sandboxes.create({
  packages: [pkg],
  env: {
    HOME: "/workspace",
    ANTHROPIC_BASE_URL: "https://asplos.dev/api/anthropic",
    ANTHROPIC_AUTH_TOKEN: capability,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1"
  },
  network: { mode: "wisp", url: window.CLAUDE_CONFIG.wispUrl }
});
const process = await sandbox
  .command("node", ["/app/claude-debug.mjs"], { cwd: "/workspace" })
  .spawn({ terminal: { columns: terminal.cols, rows: terminal.rows } });
```

Hash before package parsing, connect raw terminal bytes, serialize stdin writes, and close process/sandbox/Wasmer exactly once. Never persist/log capability data.

- [ ] **Step 4: Test, build, and commit**

```bash
cd claude
PATH=/opt/node22/bin:$PATH npm test
PATH=/opt/node22/bin:$PATH npm run build
cd ..
git add claude/package.json claude/package-lock.json claude/vite.config.js claude/config.js claude/src/runtime.js claude/src/runtime.test.js claude/app.js
git commit -m "feat: add browser Wasmer Node runtime"
```

### Task 7: Overwrite the page with xterm and Turnstile

**Files:**
- Modify: `claude/index.html`
- Modify: `claude/app.js`
- Modify: `claude/styles.css`
- Create: `claude/coi-serviceworker.js`
- Create: `claude/src/main.js`
- Create: `claude/src/main.test.js`

- [ ] **Step 1: Write failing page tests**

Assert terminal/Start/Stop/Clear controls, disabled transitions, cancellation, resize debounce, one isolation reload, Turnstile before session issuance, and no token/upstream key in URL, DOM text, localStorage, or sessionStorage.

- [ ] **Step 2: Overwrite `claude/index.html` directly**

Remove the editor and direct API relay. Add:

```html
<button id="start-runtime" type="button">Start runtime</button>
<button id="stop-runtime" type="button" disabled>Stop</button>
<button id="clear-terminal" type="button">Clear</button>
<div id="turnstile" data-action="claude-runtime"></div>
<div id="runtime-progress" role="progressbar" aria-valuemin="0" aria-valuemax="100"></div>
<div id="terminal" aria-label="Claude Code terminal"></div>
```

Public config contains only Turnstile site key, WISP URL, session URL, and manifest URL.

- [ ] **Step 3: Add cross-origin isolation**

The service worker adds `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` to same-origin GET responses. Register only when isolation is absent, reload once, then block startup if isolation is still unavailable.

- [ ] **Step 4: Implement xterm state transitions**

Use `idle`, `challenge`, `downloading`, `verifying`, `starting`, `running`, `stopping`, `exited`, and `failed`. Exchange one Turnstile response for a capability immediately before startup. Stop on capability expiry and require a fresh challenge.

- [ ] **Step 5: Replace styles, test, build, and commit**

Keep the acid/ember language, make xterm primary, reserve `calc(100vh - 180px)` on desktop, stack controls below 720 px, preserve focus, and honor reduced motion.

```bash
cd claude
PATH=/opt/node22/bin:$PATH npm test
PATH=/opt/node22/bin:$PATH npm run build
cd ..
git add claude/index.html claude/app.js claude/styles.css claude/coi-serviceworker.js claude/src/main.js claude/src/main.test.js
git commit -m "feat: launch browser Claude terminal with Turnstile"
```

### Task 8: Publish and qualify the public system

**Files:**
- Create: `tools/node-claude/publish-r2.sh`
- Create: `tools/node-claude/publish-r2.test.mjs`
- Create: `tools/node-claude/public-smoke.mjs`
- Create: `claude/test/browser-runtime.test.mjs`

- [ ] **Step 1: Test and implement immutable-first publication**

Use an injected fake Wrangler. Assert immutable uploads/download verification precede aliases, failures prevent alias changes, metacharacters remain data, and no secret appears in output. Upload:

```bash
npx wrangler r2 object put "asplos-claude-artifacts/artifacts/$sha/node-claude.webc" --file about/node-claude.webc --remote
npx wrangler r2 object put "asplos-claude-artifacts/artifacts/$node_sha/node.wasm" --file about/node.wasm --remote
```

Verify downloads by hash, then write `current/` aliases. Use `set -euo pipefail`.

- [ ] **Step 2: Configure Worker Secrets without files or argv values**

```bash
cd claude-edge
PATH=/opt/node22/bin:$PATH npx wrangler whoami
PATH=/opt/node22/bin:$PATH npx wrangler secret put ZHIPU_API_KEY
PATH=/opt/node22/bin:$PATH npx wrangler secret put TURNSTILE_SECRET
PATH=/opt/node22/bin:$PATH npx wrangler secret put RELAY_SIGNING_KEY
```

- [ ] **Step 3: Deploy R2/Worker and verify public bytes**

```bash
cd claude-edge
PATH=/opt/node22/bin:$PATH npx wrangler r2 bucket create asplos-claude-artifacts
PATH=/opt/node22/bin:$PATH npm run deploy
cd ..
tools/node-claude/publish-r2.sh
PATH=/opt/node22/bin:$PATH node tools/node-claude/public-smoke.mjs https://asplos.dev
```

The smoke checker rejects LFS pointers, HTML, cross-origin redirects, missing range support, size mismatch, and SHA mismatch. If account/zone/bindings are absent, report deployment blocked without promoting mocks.

- [ ] **Step 4: Qualify browser Node**

Playwright requires `crossOriginIsolated`, starts the package, checks `v25.0.0-pre`, sends terminal input, resizes, stops, and restarts without duplicate pumps. Use Cloudflare's documented Turnstile test key only in preview.

- [ ] **Step 5: Qualify one real Claude request**

With production Secrets active, complete Turnstile, start Claude, enter `Reply exactly OK`, require exact `OK`, and confirm the Zhipu key is absent from browser storage, URL, DOM, console, and network responses. Confirm Durable Object counters increment.

- [ ] **Step 6: Run all final checks**

```bash
PATH=/opt/node22/bin:$PATH node --test tools/node-claude/*.test.mjs
(cd claude-edge && PATH=/opt/node22/bin:$PATH npm test)
(cd claude-gateway && PATH=/opt/node22/bin:$PATH NODE_OPTIONS=--unhandled-rejections=strict npm test)
(cd claude && PATH=/opt/node22/bin:$PATH npm test && PATH=/opt/node22/bin:$PATH npm run build)
git lfs fsck
git lfs ls-files --name-only
PATH=/opt/node22/bin:$PATH node tools/node-claude/public-smoke.mjs https://asplos.dev
```

Expected: all local checks pass, public bytes match, browser Node lifecycle passes, and Claude returns exact `OK`.

- [ ] **Step 7: Commit qualification and push normally**

```bash
git add tools/node-claude claude/test/browser-runtime.test.mjs
git commit -m "test: qualify public browser Claude runtime"
git push origin feature/claude-pty-web
```

Integrate through ordinary commits on top of `main`. Do not amend, squash, force-push, rewrite history, or push the Node repository.

## Completion Evidence

Completion requires one artifact identity across Wasmer build/unpack, LFS fsck, R2 public range/hash checks, Worker Turnstile/capability/quota tests, restricted WISP tests, Chromium Node lifecycle, and one exact-`OK` Claude request. Any individual build, pointer, upload, deploy, SDK initialization, or Node banner remains partial evidence.

