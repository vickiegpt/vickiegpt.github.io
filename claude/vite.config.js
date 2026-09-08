import { resolve } from "node:path";
import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { defineConfig } from "vite";

const root = import.meta.dirname;
const sdkRoot = resolve(root, "node_modules/@wasmer/sdk");
const sdkOutput = resolve(root, "assets/wasmer-sdk");

function copyWasmerSdkAssets() {
  return {
    name: "copy-wasmer-sdk-assets",
    closeBundle() {
      mkdirSync(resolve(sdkOutput, "dist"), { recursive: true });
      for (const file of [
        "index.js",
        "browser-worker.js",
        "capi-worker-bridge.js",
        "node-network-rpc.js",
      ]) {
        copyFileSync(resolve(sdkRoot, "dist", file), resolve(sdkOutput, "dist", file));
      }
      const workerPath = resolve(sdkOutput, "dist", "browser-worker.js");
      const worker = readFileSync(workerPath, "utf8");
      const source = `globalThis.onmessage = ({ data }) => {
    void handleMessage(data).catch((error) => {
        console.error("Wasmer SDK worker failed:", error);
    });
};`;
      const replacement = `const messageQueue = [];
let processingMessages = false;
globalThis.onmessage = ({ data }) => {
    messageQueue.push(data);
    void drainMessages();
};
async function drainMessages() {
    if (processingMessages)
        return;
    processingMessages = true;
    try {
        while (messageQueue.length > 0) {
            await handleMessage(messageQueue.shift());
        }
    }
    catch (error) {
        console.error("Wasmer SDK worker failed:", error);
    }
    finally {
        processingMessages = false;
        if (messageQueue.length > 0)
            void drainMessages();
    }
}`;
      if (!worker.includes(source)) {
        throw new Error("Unsupported @wasmer/sdk browser-worker.js layout");
      }
      writeFileSync(workerPath, worker.replace(source, replacement));
      cpSync(resolve(sdkRoot, "pkg"), resolve(sdkOutput, "pkg"), { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [copyWasmerSdkAssets()],
  build: {
    target: "es2022",
    outDir: "assets",
    emptyOutDir: true,
    sourcemap: false,
    cssCodeSplit: false,
    lib: {
      entry: {
        app: resolve(root, "app.js"),
        "wasmer-sdk/dist/wisp-network": resolve(sdkRoot, "dist/wisp-network.js"),
      },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
      cssFileName: "styles",
    },
    rollupOptions: {
      external: ["/claude/assets/wasmer-sdk/dist/index.js"],
      output: {
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "[name][extname]",
      },
    },
  },
});
