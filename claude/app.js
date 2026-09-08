import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";

import { BrowserNodeRuntime } from "./src/runtime.js";
import {
  RuntimeController,
  describeRuntimeError,
  ensureCrossOriginIsolation,
  loadPublicConfig,
  loadTurnstileApi,
  requestCapability,
} from "./src/main.js";

const FIXED_WISP_URL = "wss://wisp.mercurywork.shop/";
const MANIFEST_URL = "https://asplos.dev/about/runtime-manifest.json";

const $ = (selector) => document.querySelector(selector);
const statusText = $("#status-text");
const statusDot = $("#status-dot");
const startButton = $("#start-runtime");
const stopButton = $("#stop-runtime");
const progress = $("#runtime-progress");
const progressFill = $("#progress-fill");

function setProgress(percent, label) {
  const value = Math.max(0, Math.min(100, Math.round(percent || 0)));
  progress.setAttribute("aria-valuenow", String(value));
  progress.textContent = label;
  progressFill.style.width = `${value}%`;
}

function setState(state) {
  document.body.dataset.state = state;
  statusDot.className = state;
  const active = ["challenge", "starting", "running", "stopping"].includes(state);
  startButton.disabled = active;
  stopButton.disabled = !active;
  const labels = {
    idle: "runtime offline",
    challenge: "waiting for verification",
    starting: "starting browser Node",
    running: "Claude Code running",
    stopping: "stopping runtime",
    exited: "process exited",
    failed: "runtime failed",
  };
  statusText.textContent = labels[state] || state;
}

async function createChallenge(siteKey) {
  const turnstile = await loadTurnstileApi();
  let resolveToken = null;
  let rejectToken = null;
  const widget = turnstile.render("#turnstile-widget", {
    sitekey: siteKey,
    action: "claude-session",
    execution: "execute",
    appearance: "always",
    size: "compact",
    callback(token) {
      resolveToken?.(token);
      resolveToken = null;
      rejectToken = null;
    },
    "error-callback"() {
      rejectToken?.(new Error("Security challenge was not completed"));
      resolveToken = null;
      rejectToken = null;
    },
    "expired-callback"() {
      rejectToken?.(new Error("Security challenge expired"));
      resolveToken = null;
      rejectToken = null;
    },
  });
  return {
    execute() {
      if (resolveToken) throw new Error("Security challenge is already active");
      const token = new Promise((resolve, reject) => {
        resolveToken = resolve;
        rejectToken = reject;
      });
      turnstile.execute(widget);
      return token;
    },
    reset() {
      resolveToken = null;
      rejectToken = null;
      turnstile.reset(widget);
    },
  };
}

function safeMessage(error) {
  const message = describeRuntimeError(error);
  return message.endsWith(".") ? message : `${message}.`;
}

async function boot() {
  if (!await ensureCrossOriginIsolation()) return;

  const terminal = new Terminal({
    convertEol: true,
    cursorBlink: true,
    cursorStyle: "bar",
    fontFamily: '"IBM Plex Mono", "Cascadia Code", monospace',
    fontSize: 13,
    lineHeight: 1.25,
    scrollback: 8_000,
    theme: {
      background: "#0b0e0a",
      foreground: "#dce4d4",
      cursor: "#c7ff4a",
      cursorAccent: "#0b0e0a",
      selectionBackground: "#485537",
      black: "#171b15",
      red: "#ff7657",
      green: "#c7ff4a",
      yellow: "#f3c969",
      blue: "#70b7ff",
      magenta: "#efa8ff",
      cyan: "#68ddd3",
      white: "#dce4d4",
    },
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open($("#terminal"));

  function fitTerminal() {
    const dimensions = fit.proposeDimensions();
    if (!dimensions) return;
    terminal.resize(
      Math.max(20, Math.min(240, dimensions.cols)),
      Math.max(5, Math.min(100, dimensions.rows)),
    );
  }

  fitTerminal();
  terminal.writeln("\x1b[38;2;199;255;74mNode WASIX runtime ready to download.\x1b[0m");
  terminal.writeln("Press Start runtime to launch Claude Code.\r\n");

  let challengeInstance = null;
  let challengePromise = null;
  const challenge = {
    async execute() {
      if (!challengeInstance) {
        challengePromise ||= loadPublicConfig()
          .then((config) => createChallenge(config.turnstileSiteKey));
        try {
          challengeInstance = await challengePromise;
        } catch (error) {
          challengePromise = null;
          throw error;
        }
      }
      return challengeInstance.execute();
    },
    reset() {
      challengeInstance?.reset();
    },
  };
  const runtime = new BrowserNodeRuntime({
    manifestUrl: MANIFEST_URL,
    wispUrl: FIXED_WISP_URL,
    onProgress(loaded, total) {
      const detail = typeof loaded === "object" ? loaded : { loaded, total };
      const percent = detail.total ? (detail.loaded / detail.total) * 100 : 0;
      setProgress(percent, `Downloading runtime · ${Math.round(percent)}%`);
    },
    onExit(output) {
      terminal.writeln(`\r\n\x1b[38;2;137;146;129mProcess exited (${output?.exitCode ?? "unknown"}).\x1b[0m`);
      setState("exited");
    },
    onError(error) {
      console.error("Browser runtime stream failed", error);
      terminal.writeln(`\r\n\x1b[38;2;255;118;87mRuntime stream failed: ${safeMessage(error)}\x1b[0m`);
      setState("failed");
    },
  });
  const controller = new RuntimeController({
    runtime,
    terminal,
    challenge,
    requestSession: (token) => requestCapability(token),
    onState: setState,
  });

  startButton.addEventListener("click", async () => {
    setProgress(0, "Authorizing session");
    try {
      await controller.start();
      setProgress(100, "Runtime verified and running");
      terminal.focus();
    } catch (error) {
      console.error("Browser runtime startup failed", error);
      if (error?.name !== "AbortError") terminal.writeln(`\r\n\x1b[38;2;255;118;87m${safeMessage(error)}\x1b[0m`);
      setProgress(0, safeMessage(error));
    }
  });
  stopButton.addEventListener("click", async () => {
    await controller.stop();
    setProgress(0, "Runtime stopped");
  });
  $("#clear-terminal").addEventListener("click", () => terminal.clear());
  $("#focus-keyboard").addEventListener("click", () => terminal.focus());

  let resizeTimer;
  const resize = () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      fitTerminal();
      $("#terminal-size").textContent = `${terminal.cols} × ${terminal.rows}`;
    }, 80);
  };
  addEventListener("resize", resize);
  terminal.onResize(({ cols, rows }) => {
    $("#terminal-size").textContent = `${cols} × ${rows}`;
  });
  addEventListener("beforeunload", () => void controller.stop(), { once: true });
  setState("idle");
}

boot().catch((error) => {
  console.error("Browser runtime boot failed", error);
  setState("failed");
  setProgress(0, safeMessage(error));
});
