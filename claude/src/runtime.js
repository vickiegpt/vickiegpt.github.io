const MANIFEST_PATH = '/about/runtime-manifest.json';
const ARTIFACT_PATH = '/about/node-claude.webc';
const WISP_URL = 'wss://wisp.mercurywork.shop/';
const SDK_VERSION = '0.11.0';
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

function runtimeError(message) {
  return new Error(`Invalid runtime manifest: ${message}`);
}

function sha256Hex(bytes) {
  return crypto.subtle.digest('SHA-256', bytes).then((digest) =>
    [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(''));
}

function validateManifestUrl(url) {
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:'
    || parsed.hostname !== 'asplos.dev'
    || parsed.port !== ''
    || parsed.pathname !== MANIFEST_PATH
    || parsed.search !== ''
    || parsed.hash !== ''
  ) {
    throw runtimeError('unexpected manifest URL');
  }
  return parsed;
}

function validateWispUrl(url) {
  if (url !== WISP_URL) throw new Error('Invalid WISP endpoint');
}

export function validateRuntimeManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw runtimeError('expected an object');
  }
  if (
    manifest.schema !== 1
    || manifest.url !== ARTIFACT_PATH
    || !Number.isSafeInteger(manifest.size)
    || manifest.size < 1
    || manifest.size > MAX_ARTIFACT_BYTES
    || !SHA256.test(manifest.sha256)
    || !SHA256.test(manifest.nodeSha256)
    || manifest.sdkVersion !== SDK_VERSION
    || typeof manifest.nodeVersion !== 'string'
    || manifest.nodeVersion.length === 0
    || typeof manifest.claudeVersion !== 'string'
    || manifest.claudeVersion.length === 0
    || manifest.command !== 'node'
    || !Array.isArray(manifest.args)
    || manifest.args.length !== 1
    || manifest.args[0] !== '/app/claude-debug.mjs'
  ) {
    throw runtimeError('contract mismatch');
  }
  return manifest;
}

export async function fetchVerifiedWebc(manifest, options = {}) {
  validateRuntimeManifest(manifest);
  const baseUrl = new URL(options.baseUrl ?? globalThis.location.href);
  const artifactUrl = new URL(manifest.url, baseUrl);
  if (artifactUrl.origin !== baseUrl.origin || artifactUrl.pathname !== ARTIFACT_PATH) {
    throw runtimeError('artifact must be same-origin');
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(artifactUrl.href, {
    cache: 'force-cache',
    credentials: 'omit',
  });
  if (!response.ok || !response.body) throw new Error('Runtime artifact unavailable');
  const declaredLength = response.headers.get('Content-Length');
  if (declaredLength !== null && Number(declaredLength) !== manifest.size) {
    throw new Error('Runtime artifact size mismatch');
  }

  const bytes = new Uint8Array(manifest.size);
  const reader = response.body.getReader();
  let offset = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (offset + value.byteLength > manifest.size) {
      await reader.cancel();
      throw new Error('Runtime artifact size mismatch');
    }
    bytes.set(value, offset);
    offset += value.byteLength;
    options.onProgress?.(offset, manifest.size);
  }
  if (offset !== manifest.size) throw new Error('Runtime artifact size mismatch');
  if (await sha256Hex(bytes) !== manifest.sha256) {
    throw new Error('Runtime artifact integrity check failed');
  }
  return bytes;
}

export async function launchClaude(options) {
  const {
    capability,
    wispUrl,
    manifestUrl,
    columns = 80,
    rows = 24,
  } = options;
  const isolated = options.isolated ?? globalThis.crossOriginIsolated;
  if (isolated !== true) {
    throw new Error('This runtime requires a cross-origin isolated page');
  }
  validateWispUrl(wispUrl);
  const parsedManifestUrl = validateManifestUrl(manifestUrl);
  if (typeof capability !== 'string' || capability.length < 1 || capability.length > 4096) {
    throw new Error('Invalid relay capability');
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const manifestResponse = await fetchImpl(parsedManifestUrl.href, {
    cache: 'no-store',
    credentials: 'same-origin',
  });
  if (!manifestResponse.ok) throw new Error('Runtime manifest unavailable');
  const manifest = validateRuntimeManifest(await manifestResponse.json());
  const bytes = await fetchVerifiedWebc(manifest, {
    baseUrl: parsedManifestUrl.href,
    fetchImpl,
    onProgress: options.onProgress,
  });

  const sdkLoader = options.sdkLoader ?? (() => import('@wasmer/sdk/browser'));
  const { Wasmer } = await sdkLoader();
  const wasmer = new Wasmer({
    parallelism: 2,
    cache: { namespace: `node-claude-${manifest.sha256.slice(0, 16)}` },
  });
  let sandbox;
  try {
    await wasmer.ready();
    const packageObject = await wasmer.packages.load(bytes);
    sandbox = await wasmer.sandboxes.create({
      packages: [packageObject],
      env: {
        HOME: '/workspace',
        PATH: '/bin:/usr/bin',
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        ANTHROPIC_BASE_URL: 'https://asplos.dev/api/anthropic',
        ANTHROPIC_AUTH_TOKEN: capability,
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-4.7',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-4.7',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.7',
        API_TIMEOUT_MS: '90000',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      network: { mode: 'wisp', url: wispUrl },
    });
    const process = await sandbox
      .command(manifest.command, manifest.args, { cwd: '/workspace' })
      .spawn({
        terminal: {
          columns: Math.max(20, Math.min(240, Math.trunc(columns))),
          rows: Math.max(5, Math.min(100, Math.trunc(rows))),
        },
      });
    return { manifest, process, sandbox, wasmer };
  } catch (error) {
    if (sandbox) await sandbox.close().catch(() => {});
    await wasmer.close().catch(() => {});
    throw error;
  }
}

function runtimeAbortError() {
  return new DOMException("Runtime startup was cancelled", "AbortError");
}

async function closeRuntimeResources(resources, pumps = [], disposables = []) {
  for (const disposable of disposables) disposable?.dispose?.();
  if (!resources) return;

  try {
    await resources.process?.terminate?.({ gracePeriodMs: 1_000 });
  } finally {
    await Promise.allSettled(pumps);
    try {
      await resources.sandbox?.close?.();
    } finally {
      await resources.wasmer?.close?.();
    }
  }
}

export class BrowserNodeRuntime {
  constructor(options = {}, adapters = {}) {
    this.options = options;
    this.adapters = adapters;
    this.launch = adapters.launch ?? launchClaude;
    this.state = "idle";
    this.generation = 0;
    this.resources = null;
    this.startPromise = null;
    this.inputPromise = Promise.resolve();
    this.pumps = [];
    this.disposables = [];
  }

  async start(capability, terminal) {
    if (this.state !== "idle") {
      throw new Error("A browser Node runtime is already active");
    }
    if (!terminal || typeof terminal.write !== "function") {
      throw new TypeError("A writable terminal is required");
    }

    const generation = ++this.generation;
    this.state = "starting";
    const startPromise = (async () => {
      let resources;
      try {
        resources = await this.launch(
          {
            ...this.options,
            capability,
            columns: terminal.cols,
            rows: terminal.rows,
          },
          this.adapters,
        );
        if (generation !== this.generation) {
          await closeRuntimeResources(resources);
          throw runtimeAbortError();
        }

        const process = resources?.process;
        if (!process) throw new Error("Wasmer did not return a process");
        this.resources = resources;
        this.inputPromise = Promise.resolve();
        this.disposables = [
          terminal.onData?.((data) => {
            if (generation !== this.generation || !process.stdin) return;
            this.inputPromise = this.inputPromise
              .then(() => process.stdin.write(data))
              .catch((error) => this.options.onError?.(error));
          }),
          terminal.onResize?.(({ cols, rows }) => this.resize(cols, rows)),
        ].filter(Boolean);

        const pump = async (stream) => {
          if (!stream) return;
          for await (const chunk of stream) {
            if (generation !== this.generation) return;
            let output = chunk;
            if (ArrayBuffer.isView(chunk) && !(chunk.buffer instanceof ArrayBuffer)) {
              output = new Uint8Array(chunk.byteLength);
              output.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
            }
            terminal.write(output);
          }
        };
        this.pumps = [pump(process.stdout), pump(process.stderr)];
        this.state = "running";

        void process.wait?.().then(
          (output) => {
            if (generation !== this.generation) return;
            this.state = "exited";
            this.options.onExit?.(output);
          },
          (error) => {
            if (generation !== this.generation) return;
            this.state = "failed";
            this.options.onError?.(error);
          },
        );
        return resources;
      } catch (error) {
        if (generation === this.generation) this.state = "idle";
        throw error;
      }
    })();

    this.startPromise = startPromise;
    try {
      return await startPromise;
    } finally {
      if (this.startPromise === startPromise) this.startPromise = null;
    }
  }

  resize(cols, rows) {
    if (!this.resources?.process || this.state !== "running") return;
    const columns = Math.max(20, Math.min(500, Math.trunc(cols)));
    const lines = Math.max(5, Math.min(200, Math.trunc(rows)));
    if (!Number.isFinite(columns) || !Number.isFinite(lines)) return;
    this.resources.process.resizeTerminal(columns, lines);
  }

  flushInput() {
    return this.inputPromise;
  }

  waitForPumps() {
    return Promise.all(this.pumps);
  }

  async stop() {
    const generation = ++this.generation;
    if (this.state === "idle" && !this.startPromise && !this.resources) return;
    this.state = "stopping";

    if (this.startPromise) await this.startPromise.catch(() => {});
    if (generation !== this.generation) return;

    const resources = this.resources;
    const pumps = this.pumps;
    const disposables = this.disposables;
    this.resources = null;
    this.pumps = [];
    this.disposables = [];
    await this.inputPromise.catch(() => {});
    await closeRuntimeResources(resources, pumps, disposables);
    if (generation === this.generation) this.state = "idle";
  }
}
