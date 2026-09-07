# Browser Wasmer Node WEBC Design

## Objective

Run the WASIX32 Node runtime and Claude Code directly in the browser at
`https://asplos.dev/claude/`, using `@wasmer/sdk`, xterm.js, and a versioned
WEBC package. Large runtime artifacts are tracked with Git LFS but served from
Cloudflare R2, because GitHub Pages does not serve Git LFS objects.

The browser process is distinct from the server-side PTY gateway. No native
Wasmer process or host workspace is required for browser execution.

## Deliverables

- `about/node.wasm`: the exact WASIX32 Node module used to build the package.
- `about/claude-debug.mjs`: a version-pinned Claude Code CLI bundle.
- `about/node-claude.webc`: a deterministic package containing the Node module
  and CLI bundle.
- `about/runtime-manifest.json`: small, Git-tracked metadata containing version,
  byte size, SHA-256, SDK version, and R2-backed download URL.
- A browser terminal at `/claude/` that downloads, verifies, starts, resizes,
  and stops the runtime.
- A narrowly scoped Cloudflare Worker route that serves large artifacts from
  R2 at the existing `/about/` URLs.
- A same-origin Anthropic-compatible relay that keeps the Zhipu credential in
  a Cloudflare Worker Secret and issues only short-lived browser capabilities.

## Package Construction

The WEBC package exposes one command backed by `node.wasm`. The command itself
is Node; the browser supplies exactly one fixed argument,
`/app/claude-debug.mjs`. Browser input never becomes a command name, script
path, or additional argument.

The package filesystem contains the CLI bundle at `/app/claude-debug.mjs`.
Build inputs are canonicalized and hashed before packaging. The build fails if
the Node module is not a WebAssembly binary, the CLI is missing, or the output
does not expose the expected command. Temporary staging data remains outside
the published tree.

The implementation will pin the Wasmer CLI and `@wasmer/sdk` versions. It will
first verify the installed Wasmer manifest syntax and WEBC output format rather
than assuming compatibility between CLI generations.

## Git LFS and Artifact Publication

`.gitattributes` tracks `about/node.wasm` and `about/node-claude.webc` through
Git LFS. The JavaScript bundle and JSON manifest remain ordinary Git files
unless their final size exceeds GitHub's normal object limit.

LFS is not the web origin. A deployment script uploads immutable objects to R2
under content-addressed keys, verifies their metadata, and only then updates a
small alias used by `asplos.dev`. A Cloudflare Worker route serves:

- `/about/node.wasm`
- `/about/node-claude.webc`
- optionally versioned `/about/artifacts/<sha256>/<name>` URLs

The worker accepts only `GET` and `HEAD`, returns explicit content types,
supports range requests, applies long immutable caching to hash-qualified
objects, and never exposes bucket listing or write operations. Deployment
credentials remain in Wrangler or Cloudflare bindings, never in Git.

## Browser Runtime

The page vendors a pinned browser build of `@wasmer/sdk`; it does not depend on
an unversioned CDN import. Startup is explicit rather than automatic so a page
visit does not immediately allocate hundreds of megabytes.

Startup sequence:

1. Establish cross-origin isolation. If origin headers cannot provide COOP and
   COEP, a same-origin isolation service worker installs and performs one
   controlled reload.
2. Fetch `runtime-manifest.json` without cache, validate its schema, and ensure
   the artifact URL is same-origin HTTPS.
3. Download WEBC bytes with progress and a cancellation signal.
4. Verify byte length and SHA-256 before parsing the package.
5. Initialize Wasmer, decode the in-memory WEBC package, and create one sandbox.
6. Create an ephemeral `/workspace` in the sandbox and set it as `HOME` and the
   command working directory.
7. Spawn the fixed Node command with `/app/claude-debug.mjs`, terminal columns,
   and rows.
8. Connect xterm input, output, resize, exit, and termination to the SDK process.

Only one runtime may exist per tab. Stop, page unload, startup cancellation, and
runtime exit close the process, sandbox, stream pumps, and Wasmer client in
order. A generation identifier prevents stale asynchronous startup work from
attaching to a newer terminal.

## Workspace

A workspace is still required, but it is a WASIX virtual filesystem rather
than a host directory. Each tab receives an empty, isolated `/workspace` and a
matching virtual `HOME`. Package files under `/app` are treated as immutable;
Claude writes only under `/workspace`.

The first implementation is ephemeral by default. Package bytes may use the
SDK's origin-scoped cache, but workspace files and API credentials are not
persisted automatically. Import/export or user-approved IndexedDB persistence
can be added later without changing the runtime boundary.

## Networking, Relay, and Credentials

Browser WASIX cannot open TCP sockets directly. The sandbox therefore uses a
configured, access-controlled WISP WebSocket endpoint. Production readiness
requires that endpoint to resolve DNS and permit TLS connections to the chosen
Anthropic-compatible API while rejecting unrelated destinations where
possible.

The Zhipu API credential is stored only as the Cloudflare Worker Secret
`ZHIPU_API_KEY`. It is never returned to the browser, injected into WEBC,
stored in `.env`, committed to Git, uploaded to R2, or written to logs. The
browser-side Claude process uses the same-origin base URL
`https://asplos.dev/api/anthropic` and receives a short-lived relay capability
as `ANTHROPIC_AUTH_TOKEN`; it never receives the upstream credential.

No account login is required. Before starting the runtime, the page completes
a Cloudflare Turnstile challenge and sends its one-time response to
`/api/claude/session`. The Worker validates the response with the Turnstile
siteverify API, then signs a capability that expires within five minutes. The
capability is bound to a random session identifier, the relay audience, and a
coarse client-network fingerprint. It grants access only to the allowlisted
Anthropic Messages endpoint and cannot be exchanged for the Zhipu key.

The relay validates the capability before reading or forwarding a request. It
accepts only `POST` requests with bounded JSON bodies, an allowlisted model,
and a configured maximum output-token count. It rewrites the upstream origin
and authorization header, strips hop-by-hop and client-supplied forwarding
headers, enforces response-size and duration limits, and streams the allowed
response content types back to the guest.

Abuse controls are fail-closed and use Cloudflare state rather than browser
claims: per-IP issuance limits, per-capability request limits, concurrent
request limits, and a daily global request/token budget. When any threshold is
reached, the Worker stops forwarding and returns a generic rate-limit error.
Turnstile and rate limits reduce anonymous abuse but cannot guarantee that a
public free endpoint will never consume unwanted quota; the daily global
budget is the final cost-containment boundary.

## User Interface

`claude/index.html` is replaced with a terminal-first interface. It contains:

- runtime status and download/verification progress;
- Start, Stop, and Clear controls;
- a full-size xterm terminal with mobile keyboard support;
- a compact settings dialog for the WISP URL and public relay status;
- a Turnstile challenge completed before runtime startup;
- explicit diagnostics for isolation, download, hash, package, network, and
  process failures.

The interface preserves the existing visual language but removes the fake file
editor and direct Messages API relay. No unrelated debug traces are shown.

## Failure Handling

- Missing cross-origin isolation blocks startup with a precise remediation.
- Manifest, size, or hash mismatch fails before WEBC decoding.
- Startup cancellation aborts the fetch and destroys partial runtime state.
- Stream errors terminate the process and show one sanitized terminal message.
- WISP failures remain distinguishable from Node or package failures.
- Turnstile, capability, rate-limit, and upstream failures expose no secret or
  internal Worker details.
- Expired relay capabilities trigger one fresh Turnstile/session flow rather
  than silently retrying an upstream request.
- A non-zero guest exit is displayed and does not trigger an automatic restart.
- Memory pressure is reported as an unsupported-device/runtime-capacity error;
  the page never loops retries.

## Verification

Automated tests cover manifest validation, same-origin URL enforcement, hash
verification, lifecycle generation races, input/resize routing, cleanup, and
secret non-persistence. Relay tests cover Turnstile verification, capability
expiry and tampering, endpoint/model/body constraints, header rewriting,
streaming, per-IP and per-session limits, concurrency, and the daily global
budget. Package tests inspect the WEBC command and filesystem and run a finite
`node /app/claude-debug.mjs --version` smoke test when the browser-compatible
runtime is available.

Browser verification uses a cross-origin-isolated Chromium context and checks:

- SDK initialization and WEBC loading;
- Node version output;
- terminal echo and resize behavior;
- clean stop and restart;
- WISP DNS/TLS connectivity;
- one real Claude request through a short-lived relay capability while the
  Zhipu Worker Secret remains absent from all browser-visible state.

Publication verification downloads the public R2-backed object, checks that it
is not an LFS pointer, validates byte length and SHA-256 against the manifest,
and confirms range requests.

## Acceptance Boundary

The feature is complete only when the public page starts the WEBC package in a
browser, displays Node output in xterm, and cleans up reliably. Claude is not
reported as working until WISP networking, Turnstile capability issuance,
relay abuse controls, and a real API request pass. A built WEBC file, an LFS
pointer, a successful R2 upload, or an SDK initialization message alone is
insufficient evidence.
