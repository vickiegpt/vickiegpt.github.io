const COPY_WORKGROUP_SIZE = 256;
const HITM_WORKGROUP_SIZE = 64;

function align(value, granularity) {
    return Math.ceil(value / granularity) * granularity;
}

function nowMs() {
    return performance.now();
}

function getAdapterLabel(adapter, info) {
    const fields = [
        info?.description,
        info?.vendor,
        info?.architecture,
        info?.device
    ].filter(Boolean);
    if (fields.length) {
        return fields.join(" ");
    }
    return adapter ? "WebGPU adapter" : "no adapter";
}

async function getAdapterInfo(adapter) {
    if (!adapter) return {};
    if (adapter.info) return adapter.info;
    if (typeof adapter.requestAdapterInfo === "function") {
        try {
            return await adapter.requestAdapterInfo();
        } catch (error) {
            return {};
        }
    }
    return {};
}

export class HetgpuWebGpuNativeBackend {
    constructor(options = {}) {
        this.options = {
            powerPreference: options.powerPreference || "high-performance",
            logger: typeof options.logger === "function" ? options.logger : null
        };
        this.adapter = null;
        this.adapterInfo = {};
        this.device = null;
        this.copyPipeline = null;
        this.copyLayout = null;
        this.hitmPipeline = null;
        this.hitmLayout = null;
        this.ready = false;
        this.stats = {
            dispatches: 0,
            bytesRead: 0,
            bytesWritten: 0,
            lineUpdates: 0,
            lastElapsedMs: 0
        };
    }

    log(message) {
        if (this.options.logger) {
            this.options.logger(message);
        }
    }

    async init() {
        if (this.ready) {
            return this;
        }
        if (!navigator.gpu) {
            throw new Error("navigator.gpu is unavailable");
        }

        this.adapter = await navigator.gpu.requestAdapter({
            powerPreference: this.options.powerPreference
        });
        if (!this.adapter) {
            throw new Error("WebGPU adapter is unavailable");
        }

        this.adapterInfo = await getAdapterInfo(this.adapter);
        this.device = await this.adapter.requestDevice();
        this.device.lost.then((info) => {
            this.ready = false;
            this.log(`WebGPU device lost: ${info.message || info.reason || "unknown"}`);
        });

        this.createPipelines();
        this.ready = true;
        return this;
    }

    createPipelines() {
        const copyShader = this.device.createShaderModule({
            label: "hetgpu-copy-transform",
            code: `
struct CopyParams {
    words: u32,
    seed: u32,
    mode: u32,
    pad: u32,
}

@group(0) @binding(0) var<storage, read> src: array<u32>;
@group(0) @binding(1) var<storage, read_write> dst: array<u32>;
@group(0) @binding(2) var<uniform> params: CopyParams;

@compute @workgroup_size(${COPY_WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let i = global_id.x;
    if (i >= params.words) {
        return;
    }
    let value = src[i];
    if (params.mode == 0u) {
        dst[i] = value;
    } else {
        dst[i] = (value ^ params.seed) + i;
    }
}
`
        });

        this.copyLayout = this.device.createBindGroupLayout({
            label: "hetgpu-copy-layout",
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } }
            ]
        });
        this.copyPipeline = this.device.createComputePipeline({
            label: "hetgpu-copy-pipeline",
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this.copyLayout]
            }),
            compute: {
                module: copyShader,
                entryPoint: "main"
            }
        });

        const hitmShader = this.device.createShaderModule({
            label: "hetgpu-hitm-touch",
            code: `
struct HitmParams {
    lines: u32,
    iterations: u32,
    seq: u32,
    stride_words: u32,
}

@group(0) @binding(0) var<storage, read_write> state: array<u32>;
@group(0) @binding(1) var<uniform> params: HitmParams;

@compute @workgroup_size(${HITM_WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    let line = global_id.x;
    if (line >= params.lines) {
        return;
    }
    let base = line * params.stride_words;
    var acc = state[base] + line + params.seq;
    var i = 0u;
    loop {
        if (i >= params.iterations) {
            break;
        }
        acc = ((acc ^ (i + params.seq)) * 1664525u) + 1013904223u;
        i = i + 1u;
    }
    state[base] = acc;
    state[base + 1u] = params.seq + params.iterations;
    state[base + 3u] = acc ^ state[base + 1u];
}
`
        });

        this.hitmLayout = this.device.createBindGroupLayout({
            label: "hetgpu-hitm-layout",
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } }
            ]
        });
        this.hitmPipeline = this.device.createComputePipeline({
            label: "hetgpu-hitm-pipeline",
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this.hitmLayout]
            }),
            compute: {
                module: hitmShader,
                entryPoint: "main"
            }
        });
    }

    async runCopyBenchmark(options = {}) {
        await this.init();

        const requestedBytes = options.bytes || 4 * 1024 * 1024;
        const bytes = align(Math.max(4096, requestedBytes), 4);
        const words = bytes / 4;
        const mode = options.mode === "copy" ? 0 : 1;
        const seed = options.seed || 0x9e3779b9;

        const input = new Uint32Array(words);
        for (let i = 0; i < input.length; i++) {
            input[i] = (i * 2654435761) >>> 0;
        }

        const source = this.device.createBuffer({
            label: "hetgpu-copy-source",
            size: bytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
        });
        const target = this.device.createBuffer({
            label: "hetgpu-copy-target",
            size: bytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
        });
        const readback = this.device.createBuffer({
            label: "hetgpu-copy-readback",
            size: bytes,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        });
        const params = this.device.createBuffer({
            label: "hetgpu-copy-params",
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });

        this.device.queue.writeBuffer(source, 0, input);
        this.device.queue.writeBuffer(params, 0, new Uint32Array([words, seed, mode, 0]));

        const bindGroup = this.device.createBindGroup({
            label: "hetgpu-copy-bind-group",
            layout: this.copyLayout,
            entries: [
                { binding: 0, resource: { buffer: source } },
                { binding: 1, resource: { buffer: target } },
                { binding: 2, resource: { buffer: params } }
            ]
        });

        const encoder = this.device.createCommandEncoder({ label: "hetgpu-copy-encoder" });
        const pass = encoder.beginComputePass({ label: "hetgpu-copy-pass" });
        pass.setPipeline(this.copyPipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(words / COPY_WORKGROUP_SIZE));
        pass.end();
        encoder.copyBufferToBuffer(target, 0, readback, 0, bytes);

        const start = nowMs();
        this.device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const elapsedMs = Math.max(0.001, nowMs() - start);
        const output = new Uint32Array(readback.getMappedRange());

        const sampleIndexes = [0, 1, 17, Math.max(0, words - 1)];
        for (const index of sampleIndexes) {
            const expected = mode === 0
                ? input[index]
                : ((input[index] ^ seed) + index) >>> 0;
            if (output[index] !== expected) {
                readback.unmap();
                throw new Error(`WebGPU copy verification failed at ${index}: got ${output[index]}, expected ${expected}`);
            }
        }
        readback.unmap();

        source.destroy();
        target.destroy();
        readback.destroy();
        params.destroy();

        this.stats.dispatches += 1;
        this.stats.bytesRead += bytes;
        this.stats.bytesWritten += bytes;
        this.stats.lastElapsedMs = elapsedMs;

        return {
            name: mode === 0 ? "copy" : "transform",
            bytes,
            elapsedMs,
            bandwidthMBps: (bytes * 2) / elapsedMs / 1000,
            dispatches: 1
        };
    }

    async runHitmTouchBenchmark(options = {}) {
        await this.init();

        const lines = Math.max(1, options.lines || 64);
        const iterations = Math.max(1, options.iterations || 1000);
        const strideBytes = align(options.strideBytes || 64, 16);
        const strideWords = strideBytes / 4;
        const words = lines * strideWords;
        const bytes = words * 4;

        const state = this.device.createBuffer({
            label: "hetgpu-hitm-state",
            size: bytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
        });
        const readback = this.device.createBuffer({
            label: "hetgpu-hitm-readback",
            size: bytes,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
        });
        const params = this.device.createBuffer({
            label: "hetgpu-hitm-params",
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });

        this.device.queue.writeBuffer(state, 0, new Uint32Array(words));
        this.device.queue.writeBuffer(params, 0, new Uint32Array([lines, iterations, options.seq || 1, strideWords]));

        const bindGroup = this.device.createBindGroup({
            label: "hetgpu-hitm-bind-group",
            layout: this.hitmLayout,
            entries: [
                { binding: 0, resource: { buffer: state } },
                { binding: 1, resource: { buffer: params } }
            ]
        });

        const encoder = this.device.createCommandEncoder({ label: "hetgpu-hitm-encoder" });
        const pass = encoder.beginComputePass({ label: "hetgpu-hitm-pass" });
        pass.setPipeline(this.hitmPipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(lines / HITM_WORKGROUP_SIZE));
        pass.end();
        encoder.copyBufferToBuffer(state, 0, readback, 0, bytes);

        const start = nowMs();
        this.device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const elapsedMs = Math.max(0.001, nowMs() - start);
        const output = new Uint32Array(readback.getMappedRange());

        if (output[1] !== (options.seq || 1) + iterations) {
            readback.unmap();
            throw new Error(`WebGPU HITM verification failed: got seq ${output[1]}`);
        }
        readback.unmap();

        state.destroy();
        readback.destroy();
        params.destroy();

        const lineUpdates = lines * iterations;
        this.stats.dispatches += 1;
        this.stats.lineUpdates += lineUpdates;
        this.stats.bytesRead += bytes;
        this.stats.bytesWritten += bytes;
        this.stats.lastElapsedMs = elapsedMs;

        return {
            name: "hitm-touch",
            lines,
            iterations,
            elapsedMs,
            lineUpdates,
            lineUpdatesPerSec: lineUpdates / (elapsedMs / 1000),
            dispatches: 1
        };
    }

    async benchmark(options = {}) {
        await this.init();
        const copy = await this.runCopyBenchmark({
            bytes: options.copyBytes || 4 * 1024 * 1024,
            mode: options.copyMode || "transform"
        });
        const hitm = await this.runHitmTouchBenchmark({
            lines: options.hitmLines || 64,
            iterations: options.hitmIterations || 1000
        });
        return {
            backend: "native-webgpu",
            adapter: getAdapterLabel(this.adapter, this.adapterInfo),
            copy,
            hitm,
            totals: { ...this.stats }
        };
    }
}

export async function installHetgpuWebGpuNative(options = {}) {
    const backend = new HetgpuWebGpuNativeBackend(options);
    const state = {
        backend,
        ready: false,
        error: null,
        async benchmark(benchmarkOptions = {}) {
            return backend.benchmark(benchmarkOptions);
        },
        async copyBenchmark(benchmarkOptions = {}) {
            return backend.runCopyBenchmark(benchmarkOptions);
        },
        async hitmTouchBenchmark(benchmarkOptions = {}) {
            return backend.runHitmTouchBenchmark(benchmarkOptions);
        }
    };
    globalThis.HETGPU_WEBGPU_NATIVE = state;

    try {
        await backend.init();
        state.ready = true;
    } catch (error) {
        state.error = error;
    }
    return state;
}

export function formatHetgpuWebGpuBenchmark(result) {
    if (!result) return "no result";
    return [
        `backend=${result.backend}`,
        `adapter=${result.adapter}`,
        `copy.name=${result.copy.name}`,
        `copy.bytes=${result.copy.bytes}`,
        `copy.elapsed_ms=${result.copy.elapsedMs.toFixed(3)}`,
        `copy.bandwidth_MBps=${result.copy.bandwidthMBps.toFixed(1)}`,
        `hitm.lines=${result.hitm.lines}`,
        `hitm.iterations=${result.hitm.iterations}`,
        `hitm.elapsed_ms=${result.hitm.elapsedMs.toFixed(3)}`,
        `hitm.line_updates_per_sec=${result.hitm.lineUpdatesPerSec.toFixed(1)}`,
        `totals.dispatches=${result.totals.dispatches}`,
        `totals.bytes_read=${result.totals.bytesRead}`,
        `totals.bytes_written=${result.totals.bytesWritten}`,
        `totals.line_updates=${result.totals.lineUpdates}`
    ].join("\n");
}
