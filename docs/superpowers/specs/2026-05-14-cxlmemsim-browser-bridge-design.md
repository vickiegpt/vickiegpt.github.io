# CXLMemSim ⇄ Browser WASM Bridge — Design

Status: draft for review
Author: vickieGPT
Last updated: 2026-05-14

## Problem

`victoryang00.github.io/cxl2/` already runs QEMU as WASM and the QEMU CXL
backend already speaks a "browser" transport that talks to a same-origin
`SharedWorker` over a `SharedArrayBuffer` using `Atomics.wait` / `Atomics.notify`.
But the SharedWorker (`cxlmemsim-pool-worker.js`) is only a flat memory pool:
it answers reads, writes, atomics, and fans out invalidations, but it has
**no controller, no coherency directory, no policy engine, and no latency
model**. The real simulator (`CXLMemSim/src/cxlmemsim_server_lib`) only
exists as a native binary speaking TCP / SHM / RDMA.

The goal is to replace the flat-pool implementation with the actual
CXLMemSim simulator, compiled to WebAssembly, running inside that same
SharedWorker so that every tab on the page — QEMU guests *and* the
dashboard — shares one in-browser CXLMemSim instance.

## Goals

1. Run the CXLMemSim core (`CXLController`, `CoherencyEngine`, the policy
   family, `HDMDecoder`, `SharedMemoryManager`) in the browser as
   WebAssembly, hosted by the existing same-origin `SharedWorker`.
2. Keep the existing wire format (`ServerRequest` / `ServerResponse`
   layouts in `main_server.cc`) so the QEMU side of the bridge needs no
   protocol change.
3. Make multiple browser tabs (multiple QEMU VMs + a dashboard) observe
   one consistent coherency state, one set of counters, and one pool.
4. Provide a dashboard view that surfaces simulator state — MESI
   histogram, per-policy decisions, latency, congestion — not just
   raw read/write counts.

## Non-goals

- Porting the distributed multi-node server
  (`DistributedMemoryServer`). The browser is one simulated node.
- Porting PEBS sampling (`perf`, `incore`, `uncore`, `monitor`,
  `pebs`) — Linux-only.
- Porting the socket transports (TCP, SHM, PGAS-SHM, RDMA, distributed
  SHM). The browser uses only the SAB transport.
- Changing the QEMU-side CXL backend or the `cxl-module.js` env
  plumbing. We keep `CXL_MEMSIM_TRANSPORT=browser`.

## Approach

Compile `cxlmemsim_server_lib` to `wasm32-unknown-emscripten` as a single
ES module, instantiate it once inside the `SharedWorker`, and route each
incoming request from a tab through a thin C ABI into the simulator.
The simulated memory pool lives **inside the WASM heap** (a plain
`Uint8Array` region the simulator's `SharedMemoryManager` owns). The
only `SharedArrayBuffer`s on the wire are the small per-request staging
SABs that each tab already creates today for the `Atomics.wait` /
`Atomics.notify` handshake. The worker copies request bytes from a
tab's staging SAB into the WASM heap, runs the simulator, then copies
response bytes back into the same staging SAB.

This means there is exactly **one** copy of the pool data (the bytes in
the WASM heap, owned by the worker), and tabs never touch it directly.
Cross-tab consistency is provided by the worker serialising all
requests through one WASM instance, not by any tab seeing the pool SAB.

### Why one SharedWorker, not per-tab WASM

`SharedWorker` already gives us a singleton, same-origin process for the
whole page. If each tab compiled its own copy of the simulator, every
tab would have an independent coherency directory and the directories
would diverge as soon as two tabs touched the same line. By keeping a
single WASM instance behind a SharedWorker, the directory is the single
source of truth and tabs only exchange ports and pool bytes.

## Architecture

```
 ┌─────────────────────────────┐    ┌─────────────────────────────┐
 │ Tab #1  cxl2/index.html     │    │ Tab #2  cxl2/index.html     │
 │   QEMU WASM (Type-2 dev)    │    │   QEMU WASM (Type-2 dev)    │
 │   cxl_backend.h "browser"   │    │   cxl_backend.h "browser"   │
 └─────────┬───────────────────┘    └─────────┬───────────────────┘
           │ MessagePort + SAB Atomics       │
           │ (sync-request / type-2 msg)     │
           └────────────────┬───────────────-┘
                            │
                  ┌─────────▼──────────┐    ┌────────────────────┐
                  │ SharedWorker       │    │ Tab N  cxlmemsim.  │
                  │  hetgpu-cxlmemsim  │◀───┤  html dashboard    │
                  │                    │    │  (role: "ui")      │
                  │  ┌──────────────┐  │    └────────────────────┘
                  │  │ CXLMemSim    │  │       BroadcastChannel
                  │  │ WASM core    │  │       "cxlmemsim-events"
                  │  │ (controller, │  │       (live counters)
                  │  │  coherency,  │  │
                  │  │  policy)     │  │
                  │  └──────┬───────┘  │
                  │         │ owns      │
                  │  ┌──────▼───────┐   │
                  │  │ Pool inside  │   │
                  │  │ WASM heap    │   │
                  │  │ (256 MiB)    │   │
                  │  └──────────────┘   │
                  └────────────────────┘
```

The SharedWorker is the only place that holds (a) the WASM heap
(which contains the pool), (b) the coherency directory, and (c) the
client port table. Every tab connects to it via `MessagePort`. The
only `SharedArrayBuffer`s on the wire are the small per-request
staging SABs created by each tab for `Atomics.wait` / `Atomics.notify`
— tabs never see the pool bytes directly; they only send/receive
copies via the staging SAB or via Type-2 `postMessage`s.

## Components

| Unit | Responsibility | Location |
|---|---|---|
| `cxlmemsim_wasm` CMake target | Compiles core lib + new `wasm_bridge.cc` to a single ES-module `.mjs` + `.wasm`. | `CXLMemSim/CMakeLists.txt` (new emscripten branch) |
| `wasm_bridge.cc` | C exports: `cxlmemsim_init`, `cxlmemsim_handle_request`, `cxlmemsim_handle_type2`, `cxlmemsim_get_stats`, `cxlmemsim_reset`. Packs/unpacks `ServerRequest` / `ServerResponse` and any Type-2 message. | `CXLMemSim/src/wasm_bridge.cc` |
| `WasmHeapBackend` | New code path in `SharedMemoryManager` under `#ifdef __EMSCRIPTEN__`. Instead of `shm_open` + `mmap`, allocates the pool with `aligned_alloc(64, capacity_bytes)` inside the WASM heap and serves all reads/writes from that buffer. Pool bytes never leave the WASM heap. | `CXLMemSim/src/shared_memory_manager.cc` (new branch) |
| `cxlmemsim-pool-worker.js` | Loads `cxlmemsim_wasm.mjs`, allocates the SAB once, calls `cxlmemsim_init`, replaces today's hand-coded `handleSyncRequest` / `handleQemuMessage` with shims that copy the request bytes into the WASM heap and invoke the C exports. Keeps the existing per-client port and broadcast plumbing. | canonical: `CXLMemSim/web/`; deployed copy: `victoryang00.github.io/cxl2/` |
| `cxlmemsim.html` | Adds counters surfaced by the simulator (MESI-state histogram, per-policy migrations / evictions, latency p50/p95, congestion). | `victoryang00.github.io/cxl2/cxlmemsim.html` |
| `BroadcastChannel("cxlmemsim-events")` | Live event channel for the dashboard: cacheline state transitions, migration events, policy decisions. Lets dashboards in any tab subscribe without polling the SharedWorker. | new in worker + dashboard |
| `tools/build_cxlmemsim_wasm.sh` | Mirrors the existing `build_hetgpu_wasm_archive.sh`. Invokes `emcmake cmake` on `CXLMemSim/` with `-DCXLMEMSIM_BUILD_WASM=ON`, then copies output into `victoryang00.github.io/cxl2/cxlmemsim_wasm/`. | `hetGPU_new/tools/` |

### Boundaries

- **`wasm_bridge.cc` is the only seam** between JS and C++. Everything
  the worker does to the simulator goes through one of its five
  exports. No `EM_JS` or `EM_ASM` blocks elsewhere.
- **`SharedMemoryManager` keeps its public interface unchanged.** The
  emscripten backend is a constructor overload only.
- **The SharedWorker keeps the same outward MessagePort protocol** (the
  `connect` / `sync-request` / `qemu-message` / `reset` / `get-status`
  / `status` shapes already in `cxlmemsim-pool-worker.js`), so existing
  clients in `cxl-module.js` and `cxlmemsim.html` keep working.
- **Pool bytes never leave the WASM heap.** Tabs see pool data only
  through the response payload they receive on their staging SAB, or
  through Type-2 payloads the worker forwards via `postMessage`.

## C ABI

All addresses are offsets into the WASM heap. The JS side stages
request and response bytes into a small persistent scratch region
allocated once via `_malloc` at init time. `cxlmemsim_init` takes the
pool capacity in bytes; the simulator allocates the pool inside the
WASM heap and returns the base offset so the worker can reference it
for diagnostics.

```
// pool_capacity_bytes  : size of the simulated pool, max 256 MiB
// topology_json        : null-terminated, may be "" for default "(1);"
// out_pool_base        : filled with the WASM-heap offset of the pool
// returns              : 0 on success, non-zero error code otherwise
int cxlmemsim_init(uint32_t pool_capacity_bytes,
                   const char* topology_json,
                   uint32_t* out_pool_base);

// req_ptr  : ServerRequest (105 bytes), already in WASM heap
// resp_ptr : ServerResponse (81 bytes), filled on return
// inv_out  : optional uint32_t array (cap N) for invalidation
//            cacheline addresses produced as a side effect
// inv_cap  : capacity of inv_out
// returns  : number of invalidations written to inv_out
//            (negative on error)
int32_t cxlmemsim_handle_request(uint32_t req_ptr,
                                 uint32_t resp_ptr,
                                 uint32_t inv_out_ptr,
                                 uint32_t inv_cap);

// Type-2 message (96 bytes) from one tab; worker calls this so the
// simulator can update its directory / forward writes.
void cxlmemsim_handle_type2(uint32_t msg_ptr);

// Snapshot stats into a fixed 256-byte struct: total reads/writes/atomics,
// invalidations, MESI histogram, latency p50/p95, per-policy counters.
void cxlmemsim_get_stats(uint32_t out_ptr);

void cxlmemsim_reset(void);
```

`ServerRequest` and `ServerResponse` use the same byte layout as in
`main_server.cc`. No reordering or padding changes.

## Data flow — single sync read

1. Tab A's QEMU writes `op=READ, addr, size` into its 256-byte staging
   SAB and posts `{type:'sync-request', sab, op, addrLo, addrHi, size}`
   to the SharedWorker's port.
2. Worker copies the request bytes from the staging SAB into the WASM
   heap at the pre-allocated `req_ptr` and calls
   `cxlmemsim_handle_request(req_ptr, resp_ptr, inv_ptr, INV_CAP)`.
3. Inside WASM:
   - `CXLController::access_address(addr)` resolves the endpoint.
   - `SharedMemoryManager::read_cacheline(addr, ...)` reads from the
     SAB-backed storage.
   - `CoherencyEngine::on_read(addr, src_thread_id)` may transition
     the directory entry to SHARED and add the source to the sharer
     set.
   - `CXLController::calculate_latency(...)` fills `latency_ns`.
   - The policy hooks (`MigrationPolicy::should_migrate`, etc.) are
     invoked as today.
4. Worker copies `resp_ptr` bytes back into the staging SAB at offset
   `RESPONSE_OFFSET=128`, `Atomics.store(control,0,1)`,
   `Atomics.notify(control,0,1)`. The QEMU thread resumes.
5. For each invalidation produced, the worker `postMessage`s a Type-2
   INVALIDATE on every *other* tab's port (existing `broadcastType2`
   plumbing).
6. The worker also publishes a `{type:'stats', delta}` on the
   BroadcastChannel `cxlmemsim-events`; dashboards update without
   round-tripping through the worker.

## Cross-tab semantics

- **Coherency directory**: lives inside the WASM heap, single source
  of truth, serialised through the worker's single-threaded event
  loop.
- **Memory pool bytes**: the SAB. All tabs observe the same bytes
  because all writes go through the SAB-backed
  `SharedMemoryManager::write_cacheline`.
- **Invalidations**: a tab that writes a line causes the worker, on
  return from `cxlmemsim_handle_request`, to fan a Type-2 INVALIDATE
  to all other tabs via their ports. Tab-local caches drop the line.
- **Dashboard subscriptions**: a dashboard tab connects with
  `role:'ui'` and also opens a `BroadcastChannel("cxlmemsim-events")`.
  The worker batches state deltas (every ~50 ms) onto the channel.
  This decouples dashboards from the request hot path.
- **Two dashboards in two tabs see the same numbers** because both
  subscribe to the same BroadcastChannel and the worker publishes
  exactly once per delta.

## Build & deployment

- New CMake option `CXLMEMSIM_BUILD_WASM=ON` (only honoured when
  `CMAKE_CXX_COMPILER` is `em++`). It:
  - Skips `incore`, `uncore`, `perf`, `monitor`, `shm_communication`,
    `tcp_communication`, `rdma_communication`, `distributed_server`,
    `main_server` from the source list.
  - Drops `find_library(RT_LIB rt)` / `ATOMIC_LIB` / `RDMA_LIBS` deps.
  - Adds `src/wasm_bridge.cc` to the source list.
  - Adds the linker flags:
    `-sMODULARIZE=1 -sEXPORT_ES6=1
     -sINITIAL_MEMORY=335544320 -sALLOW_MEMORY_GROWTH=0
     -sUSE_PTHREADS=0
     -sENVIRONMENT=worker
     -sEXPORTED_FUNCTIONS=_cxlmemsim_init,_cxlmemsim_handle_request,
       _cxlmemsim_handle_type2,_cxlmemsim_get_stats,_cxlmemsim_reset,
       _malloc,_free
     -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32,HEAPF64`
- `tools/build_cxlmemsim_wasm.sh` runs the emscripten build then
  copies `cxlmemsim_wasm.mjs` and `cxlmemsim_wasm.wasm` into
  `victoryang00.github.io/cxl2/cxlmemsim_wasm/` and bumps the `?v=`
  cache-bust on the worker URL in `cxl-module.js`.
- `CXLMemSim/web/cxlmemsim-pool-worker.js` becomes the canonical
  source; the existing `cxl2/cxlmemsim-pool-worker.js` is the
  deployed mirror (kept in sync by the same build script).

## Error handling

- **WASM init fails** (file missing, instantiate threw, SAB allocation
  refused): the worker keeps today's dumb-pool behaviour as a
  fallback, sets an internal `degraded=true` flag, and posts
  `{type:'degraded', reason}` to every port. The dashboard renders a
  prominent "simulator unavailable — raw pool" badge. The QEMU side
  keeps working — it just sees zero latency and no coherency events.
- **WASM trap mid-request**: the worker catches via the standard
  emscripten abort hook, returns `status=1` (existing error path),
  increments `errors`, posts the trap text once, and then on
  subsequent requests refuses to call the WASM until reset.
- **Cross-origin isolation missing**: the existing
  `setStatus("needs isolation", false)` path already covers it; no
  WASM is loaded.
- **Topology JSON malformed**: `cxlmemsim_init` returns non-zero;
  worker falls back to a hard-coded default topology
  (`"(1);"` — the same default `main_server.cc` uses when no
  topology file is given).

## Testing

- `tests/test_wasm_bridge.cpp` exercises `cxlmemsim_handle_request`
  against a `std::vector<uint8_t>` standing in for the SAB. Compiles
  both natively (regression) and under emscripten, and runs under
  `node` via emscripten's standalone harness.
- `web/test_cross_tab.html` opens two iframes (each a fake QEMU
  client posting `sync-request`s) and asserts:
  - Both iframes see consistent reads after a write from either side.
  - An invalidation triggered by iframe A's write is delivered to
    iframe B's port.
  - The stats from the BroadcastChannel match between iframes.
- Manual test in `cxl2/`: open `index.html` in tab A, open
  `cxlmemsim.html` in tab B, run the existing CXL probe inside the
  guest, watch the dashboard reflect MESI transitions and policy
  decisions in tab B.

## Risks and open questions

- **Emscripten pthread story**: the core lib uses `std::mutex` and
  `std::shared_mutex`. We build with `-sUSE_PTHREADS=0` and the
  worker is single-threaded, so all mutexes degrade to no-ops via
  emscripten's standard library. Need to confirm no code relies on
  blocking semantics from condition variables. (The coherency engine
  uses `std::mutex` per directory entry — fine when there is one
  caller.)
- **Per-request copy cost**: the request/response staging copy is
  ~186 bytes per request (105 in, 81 out). At ~1 µs per request this
  is negligible; if it ever shows up in a profile we can lift the
  staging buffers into a shared WASM Memory and skip the copy.
- **256 MiB cap**: emscripten initial memory is sized to fit pool +
  simulator state + heap headroom (~320 MiB total). Anything bigger
  requires `ALLOW_MEMORY_GROWTH=1` which costs a bounds check on
  every access — measure before turning on.
- **Policy binary size**: full policy family adds ~80 KB to the
  WASM after `-Oz`. Acceptable for a one-time fetch.

## Milestones

1. CMake `CXLMEMSIM_BUILD_WASM=ON` branch + empty `wasm_bridge.cc`
   that links and exports stub functions. Verified by `node` smoke
   test.
2. `WasmHeapBackend` path in `SharedMemoryManager` + the five C
   exports filled in.
3. Worker rewrite that loads the WASM, allocates the SAB, calls
   `cxlmemsim_init`, and replaces `handleSyncRequest` /
   `handleQemuMessage` with WASM dispatch. Keeps existing
   degraded-pool fallback.
4. Dashboard counters surfaced via `cxlmemsim_get_stats` + the new
   BroadcastChannel.
5. `tests/test_wasm_bridge.cpp` and `web/test_cross_tab.html`.
6. Wire the new build into `hetGPU_new/tools/build_cxlmemsim_wasm.sh`
   and deploy artifacts into `cxl2/cxlmemsim_wasm/`.
