const SESSION_PATH = "/api/claude/session";
const CONFIG_PATH = "/api/claude/config";
const ISOLATION_RELOAD_KEY = "claude-coi-reload";

function abortError() {
  return new DOMException("Runtime startup was cancelled", "AbortError");
}

function requireProductionOrigin(value) {
  const origin = new URL(value).origin;
  if (origin !== "https://asplos.dev") {
    throw new Error("Claude runtime requires https://asplos.dev");
  }
  return origin;
}

export async function loadPublicConfig({
  fetchImpl = globalThis.fetch,
  pageOrigin = globalThis.location?.origin,
} = {}) {
  const origin = requireProductionOrigin(pageOrigin);
  const response = await fetchImpl(`${origin}${CONFIG_PATH}`, {
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Runtime configuration is unavailable");
  const value = await response.json();
  if (
    typeof value?.turnstileSiteKey !== "string" ||
    value.turnstileSiteKey.length === 0 ||
    value.turnstileSiteKey.length > 256
  ) {
    throw new Error("Runtime configuration is invalid");
  }
  return Object.freeze({ turnstileSiteKey: value.turnstileSiteKey });
}

export async function requestCapability(token, {
  fetchImpl = globalThis.fetch,
  pageOrigin = globalThis.location?.origin,
} = {}) {
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) {
    throw new Error("Complete the security challenge first");
  }
  const origin = requireProductionOrigin(pageOrigin);
  const response = await fetchImpl(`${origin}${SESSION_PATH}`, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) throw new Error("Session authorization failed");
  const value = await response.json();
  if (
    typeof value?.capability !== "string" ||
    value.capability.length === 0 ||
    value.capability.length > 4096 ||
    !Number.isSafeInteger(value.expiresIn) ||
    value.expiresIn < 1 ||
    value.expiresIn > 300
  ) {
    throw new Error("Session authorization returned invalid data");
  }
  return { capability: value.capability, expiresIn: value.expiresIn };
}

export async function ensureCrossOriginIsolation({
  isolated = globalThis.crossOriginIsolated,
  navigatorImpl = globalThis.navigator,
  locationImpl = globalThis.location,
  storage = globalThis.sessionStorage,
} = {}) {
  if (isolated) {
    storage?.removeItem(ISOLATION_RELOAD_KEY);
    return true;
  }
  if (!navigatorImpl?.serviceWorker || !locationImpl) {
    throw new Error("This browser cannot create an isolated WebAssembly runtime");
  }
  if (storage?.getItem(ISOLATION_RELOAD_KEY) === "1") {
    throw new Error("Cross-origin isolation could not be enabled");
  }
  await navigatorImpl.serviceWorker.register("./coi-serviceworker.js", { scope: "./" });
  await navigatorImpl.serviceWorker.ready;
  storage?.setItem(ISOLATION_RELOAD_KEY, "1");
  locationImpl.reload();
  return false;
}

export class RuntimeController {
  constructor({ runtime, terminal, challenge, requestSession, onState = () => {}, setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout }) {
    this.runtime = runtime;
    this.terminal = terminal;
    this.challenge = challenge;
    this.requestSession = requestSession;
    this.onState = onState;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.state = "idle";
    this.generation = 0;
    this.expiryTimer = null;
  }

  setState(state) {
    this.state = state;
    this.onState(state);
  }

  async start() {
    if (!["idle", "exited", "failed"].includes(this.state)) throw new Error("Runtime startup is already in progress");
    const generation = ++this.generation;
    try {
      this.setState("challenge");
      const token = await this.challenge.execute();
      if (generation !== this.generation) throw abortError();
      this.setState("starting");
      const { capability, expiresIn } = await this.requestSession(token);
      if (generation !== this.generation) throw abortError();
      this.challenge.reset();
      await this.runtime.start(capability, this.terminal);
      if (generation !== this.generation) {
        await this.runtime.stop();
        throw abortError();
      }
      this.setState("running");
      this.expiryTimer = this.setTimer(() => void this.stop(), expiresIn * 1_000);
      this.expiryTimer?.unref?.();
    } catch (error) {
      if (generation === this.generation) {
        this.challenge.reset();
        this.setState(error?.name === "AbortError" ? "idle" : "failed");
      }
      throw error;
    }
  }

  async stop() {
    const generation = ++this.generation;
    if (this.expiryTimer !== null) {
      this.clearTimer(this.expiryTimer);
      this.expiryTimer = null;
    }
    this.setState("stopping");
    try {
      await this.runtime.stop();
    } finally {
      this.challenge.reset();
      if (generation === this.generation) this.setState("idle");
    }
  }
}
