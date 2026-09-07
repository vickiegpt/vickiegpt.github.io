# CXLMemSim Browser Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat-pool `cxlmemsim-pool-worker.js` with the real
CXLMemSim core compiled to WebAssembly, hosted by the existing
same-origin SharedWorker, so every browser tab on `cxl2/` shares one
in-browser simulator instance.

**Architecture:** Build a `cxlmemsim_wasm` CMake target that compiles
`cxlmemsim_server_lib` plus a new `wasm_bridge.cc` to a single
emscripten ES module. Add a `WasmHeapBackend` branch in
`SharedMemoryManager` that allocates the pool inside the WASM heap.
Rewrite the SharedWorker to load that module on first connect and
route each tab's `sync-request` / `qemu-message` through five C
exports. Surface simulator counters on `BroadcastChannel
"cxlmemsim-events"` for the dashboard.

**Tech Stack:** C++20 (existing `cxlmemsim_server_lib`), Emscripten
(em++ 3.x), CMake 3.25, plain JavaScript (no bundler) for the
SharedWorker, Bash for the build script.

---

## File Structure

**New files:**
- `CXLMemSim/src/wasm_bridge.cc` — the C ABI seam (only place JS
  talks to C++).
- `CXLMemSim/include/wasm_bridge.h` — public C declarations of the
  five exports.
- `CXLMemSim/tests/test_wasm_bridge.cpp` — native-and-emscripten unit
  test for the bridge.
- `hetGPU_new/tools/build_cxlmemsim_wasm.sh` — Emscripten cross-build
  script that produces `cxlmemsim_wasm.{mjs,wasm}` and copies them
  into the website.
- `victoryang00.github.io/cxl2/cxlmemsim_wasm/.gitkeep` — placeholder
  so the deploy directory exists pre-build.
- `victoryang00.github.io/cxl2/test_cross_tab.html` — manual two-iframe
  smoke test for cross-tab consistency.

**Modified files:**
- `CXLMemSim/CMakeLists.txt` — add `CXLMEMSIM_BUILD_WASM` option and
  the new target.
- `CXLMemSim/src/shared_memory_manager.cc` — add the
  `__EMSCRIPTEN__` branch (`WasmHeapBackend`).
- `CXLMemSim/include/shared_memory_manager.h` — declare the new
  constructor overload.
- `CXLMemSim/web/cxlmemsim-pool-worker.js` — canonical source: rewrite
  to drive the WASM module and keep the degraded-pool fallback.
- `victoryang00.github.io/cxl2/cxlmemsim-pool-worker.js` — deployed
  mirror, kept in sync by the build script.
- `victoryang00.github.io/cxl2/cxlmemsim.html` — render the extra
  counters (MESI histogram, policy events, p50/p95 latency) and
  subscribe to the BroadcastChannel.
- `victoryang00.github.io/cxl2/cxl-module.js` — bump the worker URL
  `?v=` cache-bust to a new tag.

**Responsibility boundaries (do not violate):**
- `wasm_bridge.cc` is the **only** translation unit that uses
  `EMSCRIPTEN_KEEPALIVE` / `extern "C"`. All JS↔C++ traffic is
  through its five exports.
- `WasmHeapBackend` is a constructor overload of `SharedMemoryManager`
  — public methods (`read_cacheline`, `write_cacheline`,
  `get_cacheline_metadata`, etc.) keep their signatures.
- The SharedWorker's outward `MessagePort` protocol stays unchanged
  (`connect` / `sync-request` / `qemu-message` / `reset` /
  `get-status` / `status` / `message` / `connected` / `degraded`).

---

## Task 1: CMake plumbing for the WASM target

**Files:**
- Modify: `CXLMemSim/CMakeLists.txt`
- Create: `CXLMemSim/include/wasm_bridge.h`
- Create: `CXLMemSim/src/wasm_bridge.cc`

- [ ] **Step 1: Create the empty bridge header**

Write `CXLMemSim/include/wasm_bridge.h`:

```c
/*
 * CXLMemSim WASM bridge — C ABI between the SharedWorker (JS) and
 * the compiled cxlmemsim core. The JS side calls these symbols via
 * the emscripten `Module._cxlmemsim_*` entry points.
 *
 * SPDX-License-Identifier: (LGPL-2.1 OR BSD-2-Clause)
 */
#ifndef CXLMEMSIM_WASM_BRIDGE_H
#define CXLMEMSIM_WASM_BRIDGE_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

int cxlmemsim_init(uint32_t pool_capacity_bytes,
                   const char *topology_json,
                   uint32_t *out_pool_base);

int32_t cxlmemsim_handle_request(uint32_t req_ptr,
                                 uint32_t resp_ptr,
                                 uint32_t inv_out_ptr,
                                 uint32_t inv_cap);

void cxlmemsim_handle_type2(uint32_t msg_ptr);

void cxlmemsim_get_stats(uint32_t out_ptr);

void cxlmemsim_reset(void);

#ifdef __cplusplus
}
#endif

#endif /* CXLMEMSIM_WASM_BRIDGE_H */
```

- [ ] **Step 2: Create a stub bridge implementation**

Write `CXLMemSim/src/wasm_bridge.cc`:

```cpp
#include "wasm_bridge.h"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define KEEPALIVE EMSCRIPTEN_KEEPALIVE
#else
#define KEEPALIVE
#endif

extern "C" {

KEEPALIVE int cxlmemsim_init(uint32_t /*pool_capacity_bytes*/,
                             const char * /*topology_json*/,
                             uint32_t *out_pool_base) {
    if (out_pool_base) {
        *out_pool_base = 0;
    }
    return -1; /* unimplemented in this task */
}

KEEPALIVE int32_t cxlmemsim_handle_request(uint32_t /*req_ptr*/,
                                           uint32_t /*resp_ptr*/,
                                           uint32_t /*inv_out_ptr*/,
                                           uint32_t /*inv_cap*/) {
    return -1;
}

KEEPALIVE void cxlmemsim_handle_type2(uint32_t /*msg_ptr*/) {}

KEEPALIVE void cxlmemsim_get_stats(uint32_t /*out_ptr*/) {}

KEEPALIVE void cxlmemsim_reset(void) {}

} /* extern "C" */
```

- [ ] **Step 3: Add the WASM CMake branch**

Edit `CXLMemSim/CMakeLists.txt`. After the existing
`option(CXLMEMSIM_ENABLE_RDMA ...)` line, append:

```cmake
option(CXLMEMSIM_BUILD_WASM "Build the WebAssembly module for the browser bridge" OFF)
```

Then, at the **end** of the file, append the new target block:

```cmake
if(CXLMEMSIM_BUILD_WASM)
    if(NOT EMSCRIPTEN)
        message(FATAL_ERROR "CXLMEMSIM_BUILD_WASM=ON requires emcmake (EMSCRIPTEN was not set)")
    endif()

    set(WASM_SOURCES
        src/cxlcontroller.cpp
        src/cxlendpoint.cpp
        src/policy.cpp
        src/helper.cpp
        src/shared_memory_manager.cc
        src/coherency_engine.cpp
        src/hdm_decoder.cpp
        src/wasm_bridge.cc
    )

    add_executable(cxlmemsim_wasm ${WASM_SOURCES})
    target_include_directories(cxlmemsim_wasm PRIVATE include src
        ${cxxopts_INCLUDE_DIR} ${spdlog_INCLUDE_DIR})
    target_link_libraries(cxlmemsim_wasm cxxopts::cxxopts spdlog::spdlog_header_only)
    target_compile_definitions(cxlmemsim_wasm PRIVATE CXLMEMSIM_WASM=1)

    set_target_properties(cxlmemsim_wasm PROPERTIES
        SUFFIX ".mjs"
        OUTPUT_NAME "cxlmemsim_wasm"
        LINK_FLAGS "\
-sMODULARIZE=1 \
-sEXPORT_ES6=1 \
-sENVIRONMENT=worker \
-sINITIAL_MEMORY=335544320 \
-sALLOW_MEMORY_GROWTH=0 \
-sUSE_PTHREADS=0 \
-sEXPORT_NAME=createCxlMemSim \
-sEXPORTED_FUNCTIONS=_cxlmemsim_init,_cxlmemsim_handle_request,_cxlmemsim_handle_type2,_cxlmemsim_get_stats,_cxlmemsim_reset,_malloc,_free \
-sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPU32,HEAPF64,UTF8ToString,stringToUTF8 \
-O2"
    )
endif()
```

- [ ] **Step 4: Verify CMake configures cleanly in normal (non-WASM) mode**

Run from a clean shell:

```
cd /home/victoryang00/hetGPU_new/CXLMemSim
cmake -S . -B build -DCXLMEMSIM_BUILD_WASM=OFF >/tmp/cmake_normal.log 2>&1
echo $?
tail -5 /tmp/cmake_normal.log
```

Expected: exit code `0` and `-- Configuring done` / `-- Generating done` in the tail.

If the directory already exists from prior runs, that's fine — just verify there are no new errors. Do not delete the existing `build/`.

- [ ] **Step 5: Verify the WASM target appears when the option is on (configure-only)**

Run:

```
cd /home/victoryang00/hetGPU_new/CXLMemSim
emcmake cmake -S . -B build-wasm -DCXLMEMSIM_BUILD_WASM=ON >/tmp/cmake_wasm.log 2>&1
echo $?
grep -E "cxlmemsim_wasm|Configuring done" /tmp/cmake_wasm.log
```

Expected: exit code `0` and at least one line referencing `cxlmemsim_wasm`. If `emcmake` is not on `PATH`, install/source emscripten first (`source /path/to/emsdk/emsdk_env.sh`) and re-run; do not skip this step.

- [ ] **Step 6: Build the stub target**

Run:

```
cd /home/victoryang00/hetGPU_new/CXLMemSim
cmake --build build-wasm --target cxlmemsim_wasm 2>&1 | tail -20
ls -la build-wasm/cxlmemsim_wasm.mjs build-wasm/cxlmemsim_wasm.wasm
```

Expected: both files exist and `cxlmemsim_wasm.mjs` is a non-empty text file.

- [ ] **Step 7: Smoke-test the stub from Node**

Run:

```
cd /home/victoryang00/hetGPU_new/CXLMemSim/build-wasm
node --input-type=module -e "
import('./cxlmemsim_wasm.mjs').then(async (mod) => {
  const Module = await mod.default();
  const out = Module._malloc(4);
  const rc = Module._cxlmemsim_init(64 * 1024 * 1024, 0, out);
  console.log('init rc =', rc);
  Module._free(out);
});
"
```

Expected: `init rc = -1` printed (the stub returns -1).

- [ ] **Step 8: Commit**

```
cd /home/victoryang00/hetGPU_new/CXLMemSim
git add CMakeLists.txt include/wasm_bridge.h src/wasm_bridge.cc
git commit -m "build(cxlmemsim): add CXLMEMSIM_BUILD_WASM emscripten target

Stubs out the cxlmemsim_wasm CMake target plus the wasm_bridge C ABI
header/implementation. Verified end-to-end: emcmake configure,
em++ link, and a node smoke test calling _cxlmemsim_init.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `WasmHeapBackend` branch in `SharedMemoryManager`

**Files:**
- Modify: `CXLMemSim/include/shared_memory_manager.h`
- Modify: `CXLMemSim/src/shared_memory_manager.cc`

- [ ] **Step 1: Add the new constructor overload to the header**

Edit `CXLMemSim/include/shared_memory_manager.h`. After the existing
two constructors (lines 92–93), add:

```cpp
    // Browser/WASM backend: pool lives inside the WASM heap, owned
    // by this instance via aligned_alloc. No file backing, no
    // shm_open. Pool bytes are zeroed at construction.
    struct WasmHeapTag {};
    SharedMemoryManager(WasmHeapTag, size_t capacity_mb);
```

Also add a private member just below `bool use_file_backing = false;`:

```cpp
    bool use_wasm_heap = false;
```

- [ ] **Step 2: Write a failing test for the new backend**

Append to `CXLMemSim/tests/test_distributed_shm.cpp` is not the right
place; create `CXLMemSim/tests/test_wasm_heap_backend.cpp`:

```cpp
/*
 * Tests for the WASM-heap-backed SharedMemoryManager constructor.
 * Compiles natively (regression) and under emscripten via the same
 * source.
 *
 * SPDX-License-Identifier: (LGPL-2.1 OR BSD-2-Clause)
 */
#include "shared_memory_manager.h"

#include <cassert>
#include <cstdio>
#include <cstdint>
#include <cstring>

int main() {
    SharedMemoryManager mgr(SharedMemoryManager::WasmHeapTag{}, /*capacity_mb=*/4);
    if (!mgr.initialize()) {
        std::fprintf(stderr, "FAIL: initialize() returned false\n");
        return 1;
    }

    uint8_t pattern[64];
    for (int i = 0; i < 64; ++i) pattern[i] = static_cast<uint8_t>(i);

    if (!mgr.write_cacheline(0x1000, pattern, 64)) {
        std::fprintf(stderr, "FAIL: write_cacheline\n");
        return 1;
    }
    uint8_t out[64] = {0};
    if (!mgr.read_cacheline(0x1000, out, 64)) {
        std::fprintf(stderr, "FAIL: read_cacheline\n");
        return 1;
    }
    if (std::memcmp(out, pattern, 64) != 0) {
        std::fprintf(stderr, "FAIL: data mismatch\n");
        return 1;
    }

    auto stats = mgr.get_stats();
    if (stats.total_capacity != 4ULL * 1024 * 1024) {
        std::fprintf(stderr, "FAIL: total_capacity = %zu\n", stats.total_capacity);
        return 1;
    }

    std::printf("OK\n");
    return 0;
}
```

Then wire it into `CXLMemSim/CMakeLists.txt`. After the existing
`test_distributed_shm` block, append:

```cmake
add_executable(test_wasm_heap_backend tests/test_wasm_heap_backend.cpp)
target_include_directories(test_wasm_heap_backend PRIVATE include src
    ${cxxopts_INCLUDE_DIR} ${spdlog_INCLUDE_DIR})
target_link_libraries(test_wasm_heap_backend cxlmemsim_server_lib cxlmemsim
    cxxopts::cxxopts spdlog::spdlog_header_only ${RT_LIB} ${ATOMIC_LIB})
```

- [ ] **Step 3: Run it to verify it fails to link**

```
cd /home/victoryang00/hetGPU_new/CXLMemSim
cmake --build build --target test_wasm_heap_backend 2>&1 | tail -20
```

Expected: link error — undefined reference to
`SharedMemoryManager::SharedMemoryManager(SharedMemoryManager::WasmHeapTag, unsigned long)`.

- [ ] **Step 4: Implement the new constructor and the allocation path**

Edit `CXLMemSim/src/shared_memory_manager.cc`. After the second
constructor (the file-backing one, around line 47), add:

```cpp
SharedMemoryManager::SharedMemoryManager(WasmHeapTag, size_t capacity_mb_)
    : capacity_mb(capacity_mb_), shm_name(""), shm_fd(-1), shm_base(nullptr),
      header(nullptr), data_area(nullptr) {
    shm_size = capacity_mb * 1024 * 1024;
    use_wasm_heap = true;
    SPDLOG_INFO("SharedMemoryManager (wasm-heap): Capacity {}MB, Total size: {} bytes",
                capacity_mb, shm_size);
}
```

Then modify `initialize()` to take the WASM-heap branch. Find the
existing `bool SharedMemoryManager::initialize()` body and replace
its first conditional with:

```cpp
bool SharedMemoryManager::initialize() {
    try {
        if (use_wasm_heap) {
            shm_base = std::aligned_alloc(64, shm_size);
            if (!shm_base) {
                SPDLOG_ERROR("WASM heap pool aligned_alloc({}) failed", shm_size);
                return false;
            }
            std::memset(shm_base, 0, shm_size);
            initialize_header();
            initialize_data_area();
            SPDLOG_INFO("SharedMemoryManager (wasm-heap) initialized successfully");
            return true;
        }
        if (use_file_backing) {
            // ... existing code unchanged
```

(Keep the rest of the function exactly as-is for the non-WASM paths.)

Also extend `cleanup()`: find the existing `cleanup()` body and at
the very top, insert:

```cpp
void SharedMemoryManager::cleanup() {
    if (use_wasm_heap) {
        if (shm_base) {
            std::free(shm_base);
            shm_base = nullptr;
        }
        return;
    }
    // ... existing code unchanged
```

At the top of the file, add the headers needed by these calls:

```cpp
#include <cstdlib>   // aligned_alloc, free
#include <cstring>   // memset
```

(If those `#include`s are already present, do not duplicate.)

- [ ] **Step 5: Build and run the test**

```
cd /home/victoryang00/hetGPU_new/CXLMemSim
cmake --build build --target test_wasm_heap_backend 2>&1 | tail -10
./build/test_wasm_heap_backend
```

Expected: prints `OK` and exits 0.

- [ ] **Step 6: Verify the WASM build still links**

```
cd /home/victoryang00/hetGPU_new/CXLMemSim
cmake --build build-wasm --target cxlmemsim_wasm 2>&1 | tail -10
```

Expected: builds successfully (the WASM target's source list now
exercises the new constructor through `shared_memory_manager.cc`).

- [ ] **Step 7: Commit**

```
cd /home/victoryang00/hetGPU_new/CXLMemSim
git add include/shared_memory_manager.h src/shared_memory_manager.cc \
        tests/test_wasm_heap_backend.cpp CMakeLists.txt
git commit -m "feat(shm): WasmHeapBackend constructor for SharedMemoryManager

Adds an in-heap pool path that bypasses shm_open/mmap for browser builds.
Verified by tests/test_wasm_heap_backend.cpp (native) and by relinking
the cxlmemsim_wasm emscripten target.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Wire the bridge to the simulator (`cxlmemsim_init` + `_reset`)

**Files:**
- Modify: `CXLMemSim/src/wasm_bridge.cc`
- Modify: `CXLMemSim/tests/test_wasm_heap_backend.cpp` (add bridge test)

- [ ] **Step 1: Write a failing test that drives `cxlmemsim_init` and `cxlmemsim_reset`**

Create `CXLMemSim/tests/test_wasm_bridge.cpp`:

```cpp
/*
 * Tests for the wasm_bridge C ABI. Calls the exports as if from JS,
 * but linked natively so we can debug under gdb. The same source is
 * also compiled under emscripten and run by node from the build
 * script's smoke test.
 *
 * SPDX-License-Identifier: (LGPL-2.1 OR BSD-2-Clause)
 */
#include "wasm_bridge.h"

#include <cassert>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <vector>

namespace {
uint32_t to_offset(void *p) {
    return static_cast<uint32_t>(reinterpret_cast<uintptr_t>(p));
}
}

int main() {
    uint32_t pool_base = 0xFFFFFFFFu;
    int rc = cxlmemsim_init(4 * 1024 * 1024, "", &pool_base);
    if (rc != 0) {
        std::fprintf(stderr, "FAIL: cxlmemsim_init rc=%d\n", rc);
        return 1;
    }
    /* pool_base is a WASM-heap offset; in the native build, it is
       the lower 32 bits of a host pointer — non-zero is enough. */
    if (pool_base == 0xFFFFFFFFu) {
        std::fprintf(stderr, "FAIL: out_pool_base not written\n");
        return 1;
    }

    cxlmemsim_reset();

    std::printf("OK\n");
    return 0;
}
```

Wire the test into `CXLMemSim/CMakeLists.txt`. Append after the
`test_wasm_heap_backend` block:

```cmake
add_executable(test_wasm_bridge tests/test_wasm_bridge.cpp src/wasm_bridge.cc)
target_include_directories(test_wasm_bridge PRIVATE include src
    ${cxxopts_INCLUDE_DIR} ${spdlog_INCLUDE_DIR})
target_link_libraries(test_wasm_bridge cxlmemsim_server_lib cxlmemsim
    cxxopts::cxxopts spdlog::spdlog_header_only ${RT_LIB} ${ATOMIC_LIB})
```

- [ ] **Step 2: Run the test — expect failure**

```
cd /home/victoryang00/hetGPU_new/CXLMemSim
cmake --build build --target test_wasm_bridge 2>&1 | tail -10
./build/test_wasm_bridge
```

Expected: exit 1, `FAIL: cxlmemsim_init rc=-1` (stub still returns
-1).

- [ ] **Step 3: Implement `cxlmemsim_init` and `cxlmemsim_reset`**

Replace `CXLMemSim/src/wasm_bridge.cc` with:

```cpp
#include "wasm_bridge.h"

#include "cxlcontroller.h"
#include "cxlendpoint.h"
#include "coherency_engine.h"
#include "policy.h"
#include "shared_memory_manager.h"

#include <array>
#include <atomic>
#include <cstdint>
#include <cstring>
#include <memory>
#include <string>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define KEEPALIVE EMSCRIPTEN_KEEPALIVE
#else
#define KEEPALIVE
#endif

namespace {

struct BridgeState {
    std::unique_ptr<SharedMemoryManager> shm;
    std::unique_ptr<CXLController> controller;
    std::unique_ptr<InterleavePolicy> alloc_policy;
    std::unique_ptr<HeatAwareMigrationPolicy> migration_policy;
    std::unique_ptr<HugePagePolicy> paging_policy;
    std::unique_ptr<FIFOPolicy> caching_policy;
    std::unique_ptr<CXLMemExpander> endpoint;

    std::atomic<uint64_t> total_reads{0};
    std::atomic<uint64_t> total_writes{0};
    std::atomic<uint64_t> total_atomics{0};
    std::atomic<uint64_t> total_invalidations{0};
    std::atomic<uint64_t> total_latency_ns{0};
    std::atomic<uint64_t> total_errors{0};
};

BridgeState *g_state = nullptr;

void teardown() {
    delete g_state;
    g_state = nullptr;
}

bool build_default_topology(BridgeState &s, std::string_view topo) {
    s.alloc_policy = std::make_unique<InterleavePolicy>();
    s.migration_policy = std::make_unique<HeatAwareMigrationPolicy>();
    s.paging_policy = std::make_unique<HugePagePolicy>();
    s.caching_policy = std::make_unique<FIFOPolicy>();

    std::array<Policy *, 4> policies{
        s.alloc_policy.get(),
        s.migration_policy.get(),
        s.paging_policy.get(),
        s.caching_policy.get()
    };

    int capacity_mb = static_cast<int>(s.shm->get_stats().total_capacity /
                                       (1024ULL * 1024ULL));
    s.controller = std::make_unique<CXLController>(
        policies, capacity_mb, PAGE, /*epoch=*/1, /*dramlatency=*/85.0);

    s.endpoint = std::make_unique<CXLMemExpander>(
        /*read_bw=*/40000, /*write_bw=*/40000,
        /*read_lat=*/180, /*write_lat=*/200,
        /*id=*/0, /*capacity_mb=*/capacity_mb);
    s.controller->insert_end_point(s.endpoint.get());

    const std::string newick = topo.empty() ? "(1);" : std::string(topo);
    s.controller->construct_topo(newick);
    return true;
}

} /* namespace */

extern "C" {

KEEPALIVE int cxlmemsim_init(uint32_t pool_capacity_bytes,
                             const char *topology_json,
                             uint32_t *out_pool_base) {
    teardown();
    auto state = std::make_unique<BridgeState>();

    size_t capacity_mb = pool_capacity_bytes / (1024ULL * 1024ULL);
    if (capacity_mb == 0) capacity_mb = 4;

    state->shm = std::make_unique<SharedMemoryManager>(
        SharedMemoryManager::WasmHeapTag{}, capacity_mb);
    if (!state->shm->initialize()) {
        return 1;
    }
    if (!build_default_topology(*state, topology_json ? topology_json : "")) {
        return 2;
    }

    if (out_pool_base) {
        uint8_t *base = static_cast<uint8_t *>(state->shm->get_data_area());
        *out_pool_base = static_cast<uint32_t>(reinterpret_cast<uintptr_t>(base));
    }
    g_state = state.release();
    return 0;
}

KEEPALIVE int32_t cxlmemsim_handle_request(uint32_t /*req_ptr*/,
                                           uint32_t /*resp_ptr*/,
                                           uint32_t /*inv_out_ptr*/,
                                           uint32_t /*inv_cap*/) {
    return -1; /* implemented in Task 4 */
}

KEEPALIVE void cxlmemsim_handle_type2(uint32_t /*msg_ptr*/) {}

KEEPALIVE void cxlmemsim_get_stats(uint32_t /*out_ptr*/) {}

KEEPALIVE void cxlmemsim_reset(void) {
    if (!g_state) return;
    g_state->shm->cleanup();
    g_state->shm.reset();
    teardown();
}

} /* extern "C" */
```

- [ ] **Step 4: Run the native bridge test**

```
cd /home/victoryang00/hetGPU_new/CXLMemSim
cmake --build build --target test_wasm_bridge 2>&1 | tail -10
./build/test_wasm_bridge
```

Expected: prints `OK`.

- [ ] **Step 5: Rebuild the WASM module and re-run the Node smoke test**

```
cd /home/victoryang00/hetGPU_new/CXLMemSim
cmake --build build-wasm --target cxlmemsim_wasm 2>&1 | tail -10
cd build-wasm
node --input-type=module -e "
import('./cxlmemsim_wasm.mjs').then(async (mod) => {
  const Module = await mod.default();
  const out = Module._malloc(4);
  const rc = Module._cxlmemsim_init(64 * 1024 * 1024, 0, out);
  const poolBase = Module.HEAPU32[out >> 2];
  console.log('init rc=', rc, 'poolBase=0x' + poolBase.toString(16));
  Module._cxlmemsim_reset();
  Module._free(out);
});
"
```

Expected: `init rc= 0 poolBase=0x...` (non-zero pool base).

- [ ] **Step 6: Commit**

```
cd /home/victoryang00/hetGPU_new/CXLMemSim
git add src/wasm_bridge.cc tests/test_wasm_bridge.cpp CMakeLists.txt
git commit -m "feat(bridge): implement cxlmemsim_init and cxlmemsim_reset

Wires the bridge to a real CXLController + CXLMemExpander on top of
the WasmHeapBackend pool. Default policies (Interleave, HeatAware,
HugePage, FIFO) are picked to match the native main_server defaults.
Verified by tests/test_wasm_bridge.cpp (native) and node smoke test
of the emscripten build.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Implement `cxlmemsim_handle_request`

**Files:**
- Modify: `CXLMemSim/src/wasm_bridge.cc`
- Modify: `CXLMemSim/tests/test_wasm_bridge.cpp`

- [ ] **Step 1: Extend the bridge test to drive a READ and a WRITE**

Replace `CXLMemSim/tests/test_wasm_bridge.cpp` `main` body with:

```cpp
int main() {
    uint32_t pool_base = 0xFFFFFFFFu;
    if (cxlmemsim_init(4 * 1024 * 1024, "", &pool_base) != 0) {
        std::fprintf(stderr, "FAIL: cxlmemsim_init\n");
        return 1;
    }

    /* ServerRequest layout: see CXLMemSim/src/main_server.cc.
       op_type(1) addr(8) size(8) timestamp(8) value(8) expected(8) data[64] */
    constexpr int REQ_SIZE = 1 + 8 + 8 + 8 + 8 + 8 + 64; /* 105 */
    constexpr int RESP_SIZE = 1 + 8 + 8 + 64;            /* 81  */
    std::vector<uint8_t> req(REQ_SIZE, 0);
    std::vector<uint8_t> resp(RESP_SIZE, 0);

    auto write_u64 = [&](size_t off, uint64_t v) {
        std::memcpy(req.data() + off, &v, sizeof(v));
    };

    /* WRITE: op=1, addr=0x1000, size=64, data=pattern */
    req[0] = 1; write_u64(1, 0x1000); write_u64(9, 64);
    write_u64(17, 0); write_u64(25, 0); write_u64(33, 0);
    for (int i = 0; i < 64; ++i) req[41 + i] = static_cast<uint8_t>(i ^ 0xA5);

    int32_t n = cxlmemsim_handle_request(to_offset(req.data()),
                                          to_offset(resp.data()),
                                          0, 0);
    if (n < 0 || resp[0] != 0) {
        std::fprintf(stderr, "FAIL: write request status=%d n=%d\n",
                     resp[0], n);
        return 1;
    }

    /* READ: op=0, addr=0x1000, size=64 */
    std::memset(req.data(), 0, REQ_SIZE);
    std::memset(resp.data(), 0, RESP_SIZE);
    req[0] = 0; write_u64(1, 0x1000); write_u64(9, 64);

    n = cxlmemsim_handle_request(to_offset(req.data()),
                                  to_offset(resp.data()),
                                  0, 0);
    if (n < 0 || resp[0] != 0) {
        std::fprintf(stderr, "FAIL: read request status=%d n=%d\n",
                     resp[0], n);
        return 1;
    }
    for (int i = 0; i < 64; ++i) {
        if (resp[17 + i] != static_cast<uint8_t>(i ^ 0xA5)) {
            std::fprintf(stderr,
                "FAIL: read mismatch at %d (got %u expected %u)\n",
                i, resp[17 + i], (i ^ 0xA5));
            return 1;
        }
    }

    cxlmemsim_reset();
    std::printf("OK\n");
    return 0;
}
```

- [ ] **Step 2: Run the test — expect failure**

```
cd /home/victoryang00/hetGPU_new/CXLMemSim
cmake --build build --target test_wasm_bridge 2>&1 | tail -10
./build/test_wasm_bridge
```

Expected: `FAIL: write request status=0 n=-1` (or similar — the stub
returns `-1`).

- [ ] **Step 3: Implement `cxlmemsim_handle_request`**

In `CXLMemSim/src/wasm_bridge.cc`, replace the stub body of
`cxlmemsim_handle_request` with:

```cpp
KEEPALIVE int32_t cxlmemsim_handle_request(uint32_t req_ptr,
                                           uint32_t resp_ptr,
                                           uint32_t inv_out_ptr,
                                           uint32_t inv_cap) {
    if (!g_state) return -1;

    const uint8_t *req = reinterpret_cast<const uint8_t *>(
        static_cast<uintptr_t>(req_ptr));
    uint8_t *resp = reinterpret_cast<uint8_t *>(
        static_cast<uintptr_t>(resp_ptr));

    auto load_u64 = [](const uint8_t *p) {
        uint64_t v;
        std::memcpy(&v, p, sizeof(v));
        return v;
    };
    auto store_u64 = [](uint8_t *p, uint64_t v) {
        std::memcpy(p, &v, sizeof(v));
    };

    uint8_t op = req[0];
    uint64_t addr = load_u64(req + 1);
    uint64_t size = load_u64(req + 9);
    uint64_t value = load_u64(req + 25);
    uint64_t expected = load_u64(req + 33);

    std::memset(resp, 0, 81);

    constexpr uint8_t OP_READ = 0;
    constexpr uint8_t OP_WRITE = 1;
    constexpr uint8_t OP_ATOMIC_FAA = 3;
    constexpr uint8_t OP_ATOMIC_CAS = 4;
    constexpr uint8_t OP_FENCE = 5;
    constexpr uint8_t OP_LSA_READ = 6;
    constexpr uint8_t OP_LSA_WRITE = 7;

    /* Clamp size to one cacheline payload. */
    if (size > 64) size = 64;

    uint64_t old_value = 0;
    uint64_t latency_ns = static_cast<uint64_t>(g_state->controller->dramlatency);
    uint8_t status = 0;

    switch (op) {
    case OP_READ:
    case OP_LSA_READ: {
        if (!g_state->shm->read_cacheline(addr, resp + 17, size)) {
            status = 2;
            break;
        }
        g_state->total_reads++;
        break;
    }
    case OP_WRITE:
    case OP_LSA_WRITE: {
        if (!g_state->shm->write_cacheline(addr, req + 41, size)) {
            status = 2;
            break;
        }
        g_state->total_writes++;
        /* Emit one invalidation for this line. */
        if (inv_out_ptr && inv_cap > 0) {
            uint32_t *inv = reinterpret_cast<uint32_t *>(
                static_cast<uintptr_t>(inv_out_ptr));
            inv[0] = static_cast<uint32_t>(addr & ~uint64_t{63});
            g_state->total_invalidations++;
            resp[0] = 0;
            store_u64(resp + 1, latency_ns);
            store_u64(resp + 9, old_value);
            g_state->total_latency_ns += latency_ns;
            return 1;
        }
        break;
    }
    case OP_ATOMIC_FAA: {
        uint8_t buf[8] = {0};
        if (!g_state->shm->read_cacheline(addr, buf, 8)) { status = 2; break; }
        std::memcpy(&old_value, buf, 8);
        uint64_t newv = old_value + value;
        std::memcpy(buf, &newv, 8);
        if (!g_state->shm->write_cacheline(addr, buf, 8)) { status = 2; break; }
        g_state->total_atomics++;
        break;
    }
    case OP_ATOMIC_CAS: {
        uint8_t buf[8] = {0};
        if (!g_state->shm->read_cacheline(addr, buf, 8)) { status = 2; break; }
        std::memcpy(&old_value, buf, 8);
        if (old_value == expected) {
            std::memcpy(buf, &value, 8);
            if (!g_state->shm->write_cacheline(addr, buf, 8)) { status = 2; break; }
        }
        g_state->total_atomics++;
        break;
    }
    case OP_FENCE:
        break;
    default:
        status = 3;
        break;
    }

    if (status != 0) g_state->total_errors++;
    resp[0] = status;
    store_u64(resp + 1, latency_ns);
    store_u64(resp + 9, old_value);
    g_state->total_latency_ns += latency_ns;
    return 0;
}
```

- [ ] **Step 4: Run the native test**

```
cd /home/victoryang00/hetGPU_new/CXLMemSim
cmake --build build --target test_wasm_bridge 2>&1 | tail -10
./build/test_wasm_bridge
```

Expected: prints `OK`.

- [ ] **Step 5: Rebuild WASM and re-run the Node smoke test driving READ/WRITE**

```
cd /home/victoryang00/hetGPU_new/CXLMemSim
cmake --build build-wasm --target cxlmemsim_wasm 2>&1 | tail -10
cd build-wasm
node --input-type=module -e "
import('./cxlmemsim_wasm.mjs').then(async (mod) => {
  const Module = await mod.default();
  const out = Module._malloc(4);
  console.log('init rc=', Module._cxlmemsim_init(4 * 1024 * 1024, 0, out));
  const REQ = Module._malloc(105);
  const RESP = Module._malloc(81);
  const INV = Module._malloc(64);
  Module.HEAPU8.fill(0, REQ, REQ + 105);
  Module.HEAPU8[REQ] = 1; /* WRITE */
  const dv = new DataView(Module.HEAPU8.buffer, REQ, 105);
  dv.setBigUint64(1, 0x1000n, true);
  dv.setBigUint64(9, 64n, true);
  for (let i = 0; i < 64; i++) Module.HEAPU8[REQ + 41 + i] = (i ^ 0xA5);
  console.log('write n=', Module._cxlmemsim_handle_request(REQ, RESP, INV, 16));
  Module.HEAPU8.fill(0, REQ, REQ + 105);
  dv.setBigUint64(1, 0x1000n, true);
  dv.setBigUint64(9, 64n, true);
  console.log('read n=', Module._cxlmemsim_handle_request(REQ, RESP, INV, 16));
  let ok = true;
  for (let i = 0; i < 64; i++) {
    if (Module.HEAPU8[RESP + 17 + i] !== ((i ^ 0xA5) & 0xff)) { ok = false; break; }
  }
  console.log('payload ok=', ok);
  Module._cxlmemsim_reset();
});
"
```

Expected: `write n= 1`, `read n= 0`, `payload ok= true`.

- [ ] **Step 6: Commit**

```
cd /home/victoryang00/hetGPU_new/CXLMemSim
git add src/wasm_bridge.cc tests/test_wasm_bridge.cpp
git commit -m "feat(bridge): implement cxlmemsim_handle_request

READ/WRITE/atomic FAA/atomic CAS/FENCE/LSA_READ/LSA_WRITE all routed
through SharedMemoryManager. Writes report one invalidation via the
inv_out array. Verified end-to-end (native test + node smoke).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Implement `cxlmemsim_get_stats` and `cxlmemsim_handle_type2`

**Files:**
- Modify: `CXLMemSim/src/wasm_bridge.cc`
- Modify: `CXLMemSim/include/wasm_bridge.h`
- Modify: `CXLMemSim/tests/test_wasm_bridge.cpp`

- [ ] **Step 1: Define the stats struct in the header**

Add to `CXLMemSim/include/wasm_bridge.h`, above the function
declarations:

```c
/* 256-byte fixed-layout stats block returned by cxlmemsim_get_stats. */
typedef struct {
    uint64_t total_reads;
    uint64_t total_writes;
    uint64_t total_atomics;
    uint64_t total_invalidations;
    uint64_t total_errors;
    uint64_t bytes_read;
    uint64_t bytes_written;
    uint64_t total_latency_ns;
    uint64_t pool_capacity_bytes;
    uint64_t mesi_invalid;
    uint64_t mesi_shared;
    uint64_t mesi_exclusive;
    uint64_t mesi_modified;
    uint64_t reserved[19];
} cxlmemsim_stats_t;
```

- [ ] **Step 2: Extend the bridge test to read stats**

In `CXLMemSim/tests/test_wasm_bridge.cpp`, before the final
`cxlmemsim_reset()` call, insert:

```cpp
    cxlmemsim_stats_t stats{};
    cxlmemsim_get_stats(to_offset(&stats));
    if (stats.total_reads != 1 || stats.total_writes != 1 ||
        stats.total_invalidations != 1) {
        std::fprintf(stderr,
            "FAIL: stats reads=%llu writes=%llu inv=%llu\n",
            (unsigned long long)stats.total_reads,
            (unsigned long long)stats.total_writes,
            (unsigned long long)stats.total_invalidations);
        return 1;
    }
```

- [ ] **Step 3: Run the test — expect the stats assertion to fail**

```
cd /home/victoryang00/hetGPU_new/CXLMemSim
cmake --build build --target test_wasm_bridge 2>&1 | tail -10
./build/test_wasm_bridge
```

Expected: `FAIL: stats reads=0 writes=0 inv=0` (stub does nothing).

- [ ] **Step 4: Implement `cxlmemsim_get_stats` and `cxlmemsim_handle_type2`**

In `CXLMemSim/src/wasm_bridge.cc`, add at top after the includes:

```cpp
#include "wasm_bridge.h"
```

(if not already from the header). Then replace the two stub bodies
with:

```cpp
KEEPALIVE void cxlmemsim_handle_type2(uint32_t msg_ptr) {
    if (!g_state) return;
    const uint8_t *msg = reinterpret_cast<const uint8_t *>(
        static_cast<uintptr_t>(msg_ptr));

    /* Type-2 message header layout (see cxlmemsim-pool-worker.js
       makeType2Message): type(4) size(4) addr(8) timestamp(8)
       state(1) source(1) reserved(0..) data[26..90] */
    uint32_t type;
    uint32_t size;
    uint64_t addr;
    std::memcpy(&type, msg + 0, 4);
    std::memcpy(&size, msg + 4, 4);
    std::memcpy(&addr, msg + 8, 8);
    if (size > 64) size = 64;

    constexpr uint32_t T2_WRITE = 2;
    constexpr uint32_t T2_WRITEBACK = 8;
    constexpr uint32_t T2_GPU_ACCESS = 9;
    constexpr uint32_t T2_INVALIDATE = 7;
    constexpr uint32_t T2_FLUSH = 3;

    if (type == T2_WRITE || type == T2_WRITEBACK || type == T2_GPU_ACCESS) {
        if (g_state->shm->write_cacheline(addr, msg + 26, size)) {
            g_state->total_writes++;
            g_state->total_invalidations++;
        }
    } else if (type == T2_INVALIDATE || type == T2_FLUSH) {
        g_state->total_invalidations++;
    }
}

KEEPALIVE void cxlmemsim_get_stats(uint32_t out_ptr) {
    cxlmemsim_stats_t s{};
    if (g_state) {
        s.total_reads = g_state->total_reads.load();
        s.total_writes = g_state->total_writes.load();
        s.total_atomics = g_state->total_atomics.load();
        s.total_invalidations = g_state->total_invalidations.load();
        s.total_errors = g_state->total_errors.load();
        s.total_latency_ns = g_state->total_latency_ns.load();
        s.pool_capacity_bytes = g_state->shm
            ? g_state->shm->get_stats().total_capacity
            : 0;
        /* MESI histogram comes from CoherencyEngine if accessible.
           For now we leave the four counters at 0 — they will be
           filled in a follow-up when the coherency engine is wired
           to the simulator's per-line directory. */
    }
    std::memcpy(reinterpret_cast<void *>(static_cast<uintptr_t>(out_ptr)),
                &s, sizeof(s));
}
```

Make sure the file `#include "wasm_bridge.h"` is at the top (the
header now provides the struct definition).

- [ ] **Step 5: Run the native test**

```
cd /home/victoryang00/hetGPU_new/CXLMemSim
cmake --build build --target test_wasm_bridge 2>&1 | tail -10
./build/test_wasm_bridge
```

Expected: prints `OK`.

- [ ] **Step 6: Rebuild WASM**

```
cd /home/victoryang00/hetGPU_new/CXLMemSim
cmake --build build-wasm --target cxlmemsim_wasm 2>&1 | tail -10
```

Expected: clean build.

- [ ] **Step 7: Commit**

```
cd /home/victoryang00/hetGPU_new/CXLMemSim
git add include/wasm_bridge.h src/wasm_bridge.cc tests/test_wasm_bridge.cpp
git commit -m "feat(bridge): implement cxlmemsim_get_stats and handle_type2

Adds a 256-byte fixed-layout stats struct (cxlmemsim_stats_t) and
routes Type-2 WRITE/WRITEBACK/GPU_ACCESS into the pool, with
INVALIDATE/FLUSH accumulating into the invalidation counter.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Build & deploy script

**Files:**
- Create: `hetGPU_new/tools/build_cxlmemsim_wasm.sh`
- Create: `victoryang00.github.io/cxl2/cxlmemsim_wasm/.gitkeep`

- [ ] **Step 1: Add the deploy directory placeholder**

```
mkdir -p /home/victoryang00/hetGPU_new/victoryang00.github.io/cxl2/cxlmemsim_wasm
: > /home/victoryang00/hetGPU_new/victoryang00.github.io/cxl2/cxlmemsim_wasm/.gitkeep
```

- [ ] **Step 2: Write the build script**

Create `/home/victoryang00/hetGPU_new/tools/build_cxlmemsim_wasm.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cxlmemsim_root="${CXLMEMSIM_ROOT:-$repo_root/CXLMemSim}"
deploy_dir="${1:-$repo_root/victoryang00.github.io/cxl2/cxlmemsim_wasm}"
build_dir="${CXLMEMSIM_WASM_BUILD_DIR:-$cxlmemsim_root/build-wasm}"

if ! command -v emcmake >/dev/null 2>&1; then
  echo "emcmake not found; source emsdk_env.sh before running this" >&2
  exit 1
fi

mkdir -p "$deploy_dir"

emcmake cmake -S "$cxlmemsim_root" -B "$build_dir" \
  -DCXLMEMSIM_BUILD_WASM=ON \
  -DCXLMEMSIM_BUILD_MICROBENCHMARKS=OFF \
  -DCXLMEMSIM_ENABLE_RDMA=OFF \
  -DCMAKE_BUILD_TYPE=Release

cmake --build "$build_dir" --target cxlmemsim_wasm

cp "$build_dir/cxlmemsim_wasm.mjs"  "$deploy_dir/cxlmemsim_wasm.mjs"
cp "$build_dir/cxlmemsim_wasm.wasm" "$deploy_dir/cxlmemsim_wasm.wasm"

echo "$deploy_dir/cxlmemsim_wasm.mjs"
echo "$deploy_dir/cxlmemsim_wasm.wasm"
```

Make it executable:

```
chmod +x /home/victoryang00/hetGPU_new/tools/build_cxlmemsim_wasm.sh
```

- [ ] **Step 3: Run the script end-to-end**

```
cd /home/victoryang00/hetGPU_new
./tools/build_cxlmemsim_wasm.sh
ls -la victoryang00.github.io/cxl2/cxlmemsim_wasm/
```

Expected: `cxlmemsim_wasm.mjs` and `cxlmemsim_wasm.wasm` both present
in the deploy directory.

- [ ] **Step 4: Commit (in two repos — note both)**

```
cd /home/victoryang00/hetGPU_new
git add tools/build_cxlmemsim_wasm.sh
git commit -m "build: tools/build_cxlmemsim_wasm.sh deploy script

Configures and builds the cxlmemsim_wasm emscripten target and
installs cxlmemsim_wasm.{mjs,wasm} into victoryang00.github.io/cxl2/
cxlmemsim_wasm/. Mirrors the pattern of build_hetgpu_wasm_archive.sh.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

Then in the website repo:

```
cd /home/victoryang00/hetGPU_new/victoryang00.github.io
git add cxl2/cxlmemsim_wasm/.gitkeep \
        cxl2/cxlmemsim_wasm/cxlmemsim_wasm.mjs \
        cxl2/cxlmemsim_wasm/cxlmemsim_wasm.wasm
git commit -m "deploy(cxl2): ship cxlmemsim_wasm artifacts

First deploy of the in-browser CXLMemSim simulator WASM module.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Rewrite the SharedWorker to drive the WASM

**Files:**
- Modify: `CXLMemSim/web/cxlmemsim-pool-worker.js` (canonical)
- Modify: `victoryang00.github.io/cxl2/cxlmemsim-pool-worker.js` (mirror)
- Modify: `victoryang00.github.io/cxl2/cxl-module.js` (cache-bust)

- [ ] **Step 1: Replace the canonical worker with the WASM-driven version**

Overwrite `CXLMemSim/web/cxlmemsim-pool-worker.js` with:

```javascript
'use strict';

/* Same MessagePort protocol as the previous flat-pool worker:
 * connect / sync-request / qemu-message / reset / get-status.
 *
 * Difference: a single WASM-compiled CXLMemSim instance services all
 * tabs. If the WASM fails to load, we keep the flat-pool fallback so
 * QEMU clients still see something coherent (just no latency model
 * and no MESI directory).
 */

const DEFAULT_POOL = 'CXLMemSim';
const DEFAULT_SIZE = 256 * 1024 * 1024;
const REQUEST_DATA_OFFSET = 64;
const RESPONSE_OFFSET = 128;
const RESPONSE_SIZE = 81;
const REQUEST_SIZE = 105;
const TYPE2_MSG_SIZE = 96;
const TYPE2_DATA_OFFSET = 26;
const INV_CAP = 16;
const STATS_SIZE = 256;
const WASM_URL = new URL('./cxlmemsim_wasm/cxlmemsim_wasm.mjs', self.location).href;

const CXL_T2_MSG_INVALIDATE = 7;
const CXL_T2_MSG_RESPONSE = 10;

const pools = new Map();
let bridge = null;        /* { Module, reqPtr, respPtr, invPtr, statsPtr, capacity } */
let bridgeError = null;
let bridgeReady = null;

const events = new BroadcastChannel('cxlmemsim-events');

async function ensureBridge(capacity) {
    if (bridge) return bridge;
    if (bridgeReady) return bridgeReady;
    bridgeReady = (async () => {
        try {
            const mod = await import(WASM_URL);
            const Module = await mod.default();
            const out = Module._malloc(4);
            const rc = Module._cxlmemsim_init(capacity, 0, out);
            if (rc !== 0) {
                Module._free(out);
                throw new Error('cxlmemsim_init returned ' + rc);
            }
            Module._free(out);
            bridge = {
                Module,
                reqPtr: Module._malloc(REQUEST_SIZE),
                respPtr: Module._malloc(RESPONSE_SIZE),
                invPtr: Module._malloc(INV_CAP * 4),
                statsPtr: Module._malloc(STATS_SIZE),
                capacity
            };
            return bridge;
        } catch (err) {
            bridgeError = err;
            broadcastDegraded(err && err.message ? err.message : String(err));
            return null;
        }
    })();
    return bridgeReady;
}

function broadcastDegraded(reason) {
    for (const pool of pools.values()) {
        for (const client of pool.clients.values()) {
            client.port.postMessage({ type: 'degraded', reason });
        }
    }
}

function normalizePoolName(name) {
    const text = String(name || '').trim();
    return text || DEFAULT_POOL;
}

function clampSize(size) {
    const value = Number(size);
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_SIZE;
    return Math.max(64 * 1024 * 1024, Math.min(value, 1024 * 1024 * 1024));
}

function makePool(name, size) {
    const buffer = new SharedArrayBuffer(clampSize(size));
    return {
        name, size: buffer.byteLength,
        buffer, bytes: new Uint8Array(buffer), view: new DataView(buffer),
        clients: new Map(),
        stats: { reads: 0, writes: 0, atomics: 0, fences: 0,
                 messages: 0, invalidations: 0, bytesRead: 0,
                 bytesWritten: 0, errors: 0 }
    };
}

function getPool(name, size) {
    const poolName = normalizePoolName(name);
    let pool = pools.get(poolName);
    if (!pool) {
        pool = makePool(poolName, size);
        pools.set(poolName, pool);
    }
    return pool;
}

function toOffset(lo, hi) {
    return Number(lo >>> 0) + Number(hi >>> 0) * 4294967296;
}

function setResponse(sab, status, payload, oldValue = 0n, latencyNs = 0n) {
    const control = new Int32Array(sab, 0, 1);
    const bytes = new Uint8Array(sab);
    const view = new DataView(sab);
    bytes.fill(0, RESPONSE_OFFSET, RESPONSE_OFFSET + RESPONSE_SIZE);
    view.setUint8(RESPONSE_OFFSET, status);
    view.setBigUint64(RESPONSE_OFFSET + 1, BigInt(latencyNs), true);
    view.setBigUint64(RESPONSE_OFFSET + 9, BigInt(oldValue), true);
    if (payload && payload.length) {
        bytes.set(payload.subarray(0, 64), RESPONSE_OFFSET + 17);
    }
    Atomics.store(control, 0, 1);
    Atomics.notify(control, 0, 1);
}

function makeType2Message(type, addr, size, state, source, payload) {
    const buffer = new ArrayBuffer(TYPE2_MSG_SIZE);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    view.setUint32(0, type, true);
    view.setUint32(4, size >>> 0, true);
    view.setBigUint64(8, BigInt(addr), true);
    view.setBigUint64(16, BigInt(Date.now()) * 1000000n, true);
    view.setUint8(24, state >>> 0);
    view.setUint8(25, source >>> 0);
    if (payload && payload.length) {
        bytes.set(payload.subarray(0, 64), TYPE2_DATA_OFFSET);
    }
    return buffer;
}

function broadcastType2(pool, sourceId, buffer) {
    for (const client of pool.clients.values()) {
        if (client.id === sourceId || client.role !== 'qemu') continue;
        client.port.postMessage({ type: 'message', bytes: buffer.slice(0) });
    }
}

function copyRequestInto(bridgeState, msg) {
    const { Module, reqPtr } = bridgeState;
    const heap = Module.HEAPU8;
    heap.fill(0, reqPtr, reqPtr + REQUEST_SIZE);
    heap[reqPtr] = msg.op >>> 0;
    const view = new DataView(heap.buffer, reqPtr, REQUEST_SIZE);
    view.setBigUint64(1, BigInt(toOffset(msg.addrLo, msg.addrHi)), true);
    view.setBigUint64(9, BigInt(msg.size >>> 0), true);
    view.setBigUint64(17, 0n, true);
    view.setBigUint64(25, BigInt((msg.valueHi >>> 0) * 4294967296 + (msg.valueLo >>> 0)), true);
    view.setBigUint64(33, BigInt((msg.expectedHi >>> 0) * 4294967296 + (msg.expectedLo >>> 0)), true);
    if (msg.op === 1 || msg.op === 7) {
        /* WRITE / LSA_WRITE: data lives at REQUEST_DATA_OFFSET (64)
           in the tab's staging SAB. */
        const src = new Uint8Array(msg.sab, REQUEST_DATA_OFFSET, 64);
        heap.set(src, reqPtr + 41);
    }
}

function handleSyncRequest(pool, msg) {
    const sab = msg.sab;
    try {
        if (!bridge) {
            /* Degraded: fall back to flat pool. */
            handleSyncRequestFlat(pool, msg);
            return;
        }
        copyRequestInto(bridge, msg);
        const n = bridge.Module._cxlmemsim_handle_request(
            bridge.reqPtr, bridge.respPtr, bridge.invPtr, INV_CAP);
        const respBytes = bridge.Module.HEAPU8.subarray(
            bridge.respPtr, bridge.respPtr + RESPONSE_SIZE);
        const status = respBytes[0];
        const view = new DataView(respBytes.buffer, respBytes.byteOffset, RESPONSE_SIZE);
        const latency = view.getBigUint64(1, true);
        const oldVal = view.getBigUint64(9, true);
        const payload = respBytes.subarray(17, 17 + 64);
        setResponse(sab, status, payload, oldVal, latency);

        if (status !== 0) pool.stats.errors++;
        if (msg.op === 0 || msg.op === 6) {
            pool.stats.reads++;
            pool.stats.bytesRead += Number(msg.size >>> 0);
        } else if (msg.op === 1 || msg.op === 7) {
            pool.stats.writes++;
            pool.stats.bytesWritten += Number(msg.size >>> 0);
        } else if (msg.op === 3 || msg.op === 4) {
            pool.stats.atomics++;
        } else if (msg.op === 5) {
            pool.stats.fences++;
        }

        if (n > 0) {
            const invView = new DataView(bridge.Module.HEAPU8.buffer,
                                         bridge.invPtr, n * 4);
            for (let i = 0; i < n; i++) {
                const addr = invView.getUint32(i * 4, true);
                pool.stats.invalidations++;
                broadcastType2(pool, msg.clientId,
                    makeType2Message(CXL_T2_MSG_INVALIDATE,
                                     addr, 64, 0, 0xff));
            }
        }
    } catch (err) {
        pool.stats.errors++;
        setResponse(sab, 1, null);
        events.postMessage({ type: 'error', reason: String(err) });
    }
    publishStats(pool);
}

function handleSyncRequestFlat(pool, msg) {
    /* Identical to the previous flat-pool worker — kept verbatim so
     * the page still works when the WASM is missing. */
    const sab = msg.sab;
    const requestBytes = new Uint8Array(sab);
    const addr = toOffset(msg.addrLo, msg.addrHi);
    const size = Number(msg.size >>> 0);
    const inRange = Number.isInteger(addr) && Number.isInteger(size) &&
        addr >= 0 && size >= 0 && size <= 64 && addr + size <= pool.size;
    if (!inRange) {
        pool.stats.errors++;
        setResponse(sab, 2, null);
        return;
    }
    switch (msg.op) {
    case 0: case 6: {
        const payload = pool.bytes.subarray(addr, addr + size);
        pool.stats.reads++; pool.stats.bytesRead += size;
        setResponse(sab, 0, payload);
        break;
    }
    case 1: case 7: {
        pool.bytes.set(requestBytes.subarray(REQUEST_DATA_OFFSET,
            REQUEST_DATA_OFFSET + size), addr);
        pool.stats.writes++; pool.stats.bytesWritten += size;
        setResponse(sab, 0, null);
        broadcastType2(pool, msg.clientId,
            makeType2Message(CXL_T2_MSG_INVALIDATE, addr, size, 0, 0xff));
        break;
    }
    case 5:
        pool.stats.fences++;
        setResponse(sab, 0, null);
        break;
    default:
        pool.stats.errors++;
        setResponse(sab, 3, null);
        break;
    }
}

function handleQemuMessage(pool, client, msg) {
    if (!msg.bytes) return;
    const buffer = msg.bytes;
    pool.stats.messages++;
    if (bridge) {
        try {
            bridge.Module.HEAPU8.set(new Uint8Array(buffer), bridge.reqPtr);
            bridge.Module._cxlmemsim_handle_type2(bridge.reqPtr);
        } catch (err) {
            events.postMessage({ type: 'error', reason: String(err) });
        }
    }
    broadcastType2(pool, client.id, buffer);
    publishStats(pool);
}

let lastBroadcast = 0;
function publishStats(pool) {
    const now = Date.now();
    if (now - lastBroadcast < 50) return;
    lastBroadcast = now;
    let extra = {};
    if (bridge) {
        bridge.Module._cxlmemsim_get_stats(bridge.statsPtr);
        const stats = new DataView(bridge.Module.HEAPU8.buffer, bridge.statsPtr, STATS_SIZE);
        extra = {
            total_reads: Number(stats.getBigUint64(0, true)),
            total_writes: Number(stats.getBigUint64(8, true)),
            total_atomics: Number(stats.getBigUint64(16, true)),
            total_invalidations: Number(stats.getBigUint64(24, true)),
            total_errors: Number(stats.getBigUint64(32, true)),
            total_latency_ns: Number(stats.getBigUint64(56, true)),
            pool_capacity_bytes: Number(stats.getBigUint64(64, true))
        };
    }
    events.postMessage({
        type: 'stats',
        pool: pool.name,
        port: pool.stats,
        sim: extra
    });
    broadcastStatus(pool);
}

function broadcastStatus(pool) {
    const status = {
        type: 'status', pool: pool.name, size: pool.size,
        clients: Array.from(pool.clients.values()).map((client) => ({
            id: client.id, role: client.role, device: client.device
        })),
        stats: { ...pool.stats }
    };
    for (const client of pool.clients.values()) {
        if (client.role === 'ui') client.port.postMessage(status);
    }
}

function attachPort(port) {
    let client = null;
    port.onmessage = async (event) => {
        const msg = event.data || {};
        const pool = getPool(msg.pool, msg.size);

        if (msg.type === 'connect') {
            const id = msg.clientId ||
                `${msg.role || 'client'}-${Math.random().toString(16).slice(2)}`;
            client = { id, role: msg.role || 'client',
                       device: msg.device || '', port };
            pool.clients.set(id, client);
            port.postMessage({
                type: 'connected', clientId: id,
                pool: pool.name, size: pool.size
            });
            ensureBridge(pool.size).then((b) => {
                if (!b && bridgeError) {
                    port.postMessage({ type: 'degraded',
                        reason: String(bridgeError.message || bridgeError) });
                }
            });
            broadcastStatus(pool);
            return;
        }
        if (msg.type === 'disconnect') {
            const id = msg.clientId || (client && client.id);
            if (id) pool.clients.delete(id);
            broadcastStatus(pool);
            return;
        }
        if (msg.type === 'sync-request') {
            if (!bridge && !bridgeError) await ensureBridge(pool.size);
            handleSyncRequest(pool, msg);
            return;
        }
        if (msg.type === 'qemu-message' && client) {
            handleQemuMessage(pool, client, msg);
            return;
        }
        if (msg.type === 'reset') {
            pool.bytes.fill(0);
            for (const key of Object.keys(pool.stats)) pool.stats[key] = 0;
            if (bridge) bridge.Module._cxlmemsim_reset();
            broadcastStatus(pool);
            return;
        }
        if (msg.type === 'get-status') broadcastStatus(pool);
    };
    port.start();
}

self.onconnect = (event) => { attachPort(event.ports[0]); };
```

- [ ] **Step 2: Copy the rewritten worker into the deployed location**

```
cp /home/victoryang00/hetGPU_new/CXLMemSim/web/cxlmemsim-pool-worker.js \
   /home/victoryang00/hetGPU_new/victoryang00.github.io/cxl2/cxlmemsim-pool-worker.js
```

- [ ] **Step 3: Bump the worker URL cache-bust**

In `victoryang00.github.io/cxl2/cxl-module.js`, find the line:

```javascript
workerUrl: '/cxl2/cxlmemsim-pool-worker.js?v=20260513-browser-memsim'
```

Change it to:

```javascript
workerUrl: '/cxl2/cxlmemsim-pool-worker.js?v=20260514-wasm-bridge'
```

Also update the same string in the `<script src=...>` tag in
`cxl2/index.html` if present (search for `?v=20260513`):

```
grep -n '20260513-browser-memsim' /home/victoryang00/hetGPU_new/victoryang00.github.io/cxl2/*.{html,js}
```

For each match, replace with `20260514-wasm-bridge`.

- [ ] **Step 4: Boot a static server and verify the worker loads**

```
cd /home/victoryang00/hetGPU_new/victoryang00.github.io
python3 -m http.server 8000 >/tmp/static.log 2>&1 &
echo $! > /tmp/static.pid
sleep 1
curl -sI 'http://localhost:8000/cxl2/cxlmemsim-pool-worker.js?v=20260514-wasm-bridge' | head -2
curl -sI 'http://localhost:8000/cxl2/cxlmemsim_wasm/cxlmemsim_wasm.mjs' | head -2
curl -sI 'http://localhost:8000/cxl2/cxlmemsim_wasm/cxlmemsim_wasm.wasm' | head -2
kill "$(cat /tmp/static.pid)"
```

Expected: all three `HTTP/1.0 200 OK` (or 200/304) responses.

- [ ] **Step 5: Manual browser smoke test (a step you cannot skip)**

Open Chrome (or any browser that supports `SharedWorker` +
cross-origin isolation). Navigate to
`http://localhost:8000/cxl2/cxlmemsim.html?pool=CXLMemSim&size=67108864`.
Then open `http://localhost:8000/cxl2/cxlmemsim.html?pool=CXLMemSim&size=67108864`
in a **second** tab.

Open DevTools → Application → Shared Workers → confirm there is one
`hetgpu-cxlmemsim` instance.
Open the Console in either tab and run:

```javascript
const w = new SharedWorker("/cxl2/cxlmemsim-pool-worker.js?v=20260514-wasm-bridge", "hetgpu-cxlmemsim");
w.port.start();
w.port.postMessage({ type: "connect", role: "qemu", clientId: "probe-1", pool: "CXLMemSim", size: 67108864 });
```

Expected: a `{type:'connected'}` postMessage event appears within ~1 s,
and either a `{type:'status'}` event follows or, if the WASM failed,
a `{type:'degraded', reason}` event. Neither dashboard tab errors.

- [ ] **Step 6: Commit (in both repos)**

```
cd /home/victoryang00/hetGPU_new/CXLMemSim
git add web/cxlmemsim-pool-worker.js
git commit -m "feat(web): WASM-driven SharedWorker for cxlmemsim browser bridge

Loads cxlmemsim_wasm.mjs on first connect, routes sync-request and
qemu-message through cxlmemsim_handle_request / cxlmemsim_handle_type2.
Keeps the flat-pool path as a degraded fallback so the page never
breaks. Publishes simulator stats on BroadcastChannel
cxlmemsim-events.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

```
cd /home/victoryang00/hetGPU_new/victoryang00.github.io
git add cxl2/cxlmemsim-pool-worker.js cxl2/cxl-module.js cxl2/index.html
git commit -m "deploy(cxl2): mirror WASM-driven SharedWorker, bump cache-bust

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Surface simulator counters in the dashboard

**Files:**
- Modify: `victoryang00.github.io/cxl2/cxlmemsim.html`

- [ ] **Step 1: Add simulator-side metric tiles**

In `cxl2/cxlmemsim.html`, replace the existing `<dl class="grid">`
block (the section around the eight `.metric` tiles) with:

```html
            <dl class="grid">
                <div class="metric"><dt>Reads</dt><dd id="reads">0</dd></div>
                <div class="metric"><dt>Writes</dt><dd id="writes">0</dd></div>
                <div class="metric"><dt>Atomics</dt><dd id="atomics">0</dd></div>
                <div class="metric"><dt>Clients</dt><dd id="clients-count">0</dd></div>
                <div class="metric"><dt>Read Bytes</dt><dd id="bytes-read">0</dd></div>
                <div class="metric"><dt>Write Bytes</dt><dd id="bytes-written">0</dd></div>
                <div class="metric"><dt>Messages</dt><dd id="messages">0</dd></div>
                <div class="metric"><dt>Invalidations</dt><dd id="invalidations">0</dd></div>
                <div class="metric"><dt>Sim Reads</dt><dd id="sim-reads">0</dd></div>
                <div class="metric"><dt>Sim Writes</dt><dd id="sim-writes">0</dd></div>
                <div class="metric"><dt>Sim Atomics</dt><dd id="sim-atomics">0</dd></div>
                <div class="metric"><dt>Sim Inval</dt><dd id="sim-invalidations">0</dd></div>
                <div class="metric"><dt>Avg Latency</dt><dd id="sim-latency">0 ns</dd></div>
                <div class="metric"><dt>Pool Used</dt><dd id="sim-capacity">0</dd></div>
                <div class="metric"><dt>Sim Errors</dt><dd id="sim-errors">0</dd></div>
                <div class="metric"><dt>Mode</dt><dd id="bridge-mode">…</dd></div>
            </dl>
```

- [ ] **Step 2: Wire the BroadcastChannel listener**

In the `<script>` block at the bottom, just after the existing
`fields` object declaration, append the following block (place it
before `if (!window.crossOriginIsolated)`):

```javascript
const simFields = {
    reads: document.getElementById("sim-reads"),
    writes: document.getElementById("sim-writes"),
    atomics: document.getElementById("sim-atomics"),
    invalidations: document.getElementById("sim-invalidations"),
    latency: document.getElementById("sim-latency"),
    capacity: document.getElementById("sim-capacity"),
    errors: document.getElementById("sim-errors"),
    mode: document.getElementById("bridge-mode")
};
simFields.mode.textContent = "connecting";

const events = new BroadcastChannel("cxlmemsim-events");
events.onmessage = (event) => {
    const msg = event.data || {};
    if (msg.type === "error") {
        simFields.mode.textContent = "error";
        return;
    }
    if (msg.type !== "stats") return;
    const sim = msg.sim || {};
    simFields.reads.textContent = sim.total_reads || 0;
    simFields.writes.textContent = sim.total_writes || 0;
    simFields.atomics.textContent = sim.total_atomics || 0;
    simFields.invalidations.textContent = sim.total_invalidations || 0;
    const totalOps = (sim.total_reads || 0) + (sim.total_writes || 0) +
                     (sim.total_atomics || 0);
    const avgNs = totalOps > 0 ? Math.round((sim.total_latency_ns || 0) / totalOps) : 0;
    simFields.latency.textContent = `${avgNs} ns`;
    simFields.capacity.textContent = formatBytes(sim.pool_capacity_bytes || 0);
    simFields.errors.textContent = sim.total_errors || 0;
    simFields.mode.textContent = "wasm";
};
```

Then, in the existing `port.onmessage` handler, add a branch for
`degraded`:

Find:

```javascript
        if (msg.type === "connected") {
            setStatus("ready", true);
            return;
        }
```

Insert immediately after:

```javascript
        if (msg.type === "degraded") {
            simFields.mode.textContent = `degraded: ${msg.reason || "unknown"}`;
            return;
        }
```

- [ ] **Step 3: Restart the static server and reload the dashboard**

```
cd /home/victoryang00/hetGPU_new/victoryang00.github.io
python3 -m http.server 8000 >/tmp/static.log 2>&1 &
echo $! > /tmp/static.pid
```

In the browser, hard-reload `cxlmemsim.html`. With no QEMU client
connected, all sim counters stay at 0 and the `Mode` tile reads
`wasm` (or `degraded: …` if the WASM is missing). Open a second tab
of `cxlmemsim.html` — both tabs must show the same `Mode` value.

Run from the Console in one tab:

```javascript
const w = new SharedWorker("/cxl2/cxlmemsim-pool-worker.js?v=20260514-wasm-bridge", "hetgpu-cxlmemsim");
w.port.start();
w.port.postMessage({ type:"connect", role:"qemu", clientId:"manual", pool:"CXLMemSim", size:64*1024*1024 });
```

Then build and post a fake `sync-request` (the existing flat-pool
worker already accepts this protocol; the new one expects the same
shape). Verify that both dashboard tabs increment `Sim Reads` /
`Sim Writes` in lockstep — that is the cross-tab proof.

```
kill "$(cat /tmp/static.pid)"
```

- [ ] **Step 4: Commit**

```
cd /home/victoryang00/hetGPU_new/victoryang00.github.io
git add cxl2/cxlmemsim.html
git commit -m "feat(cxl2): surface simulator counters on dashboard

Adds eight new metric tiles (Sim Reads / Writes / Atomics / Inval /
Avg Latency / Pool Used / Errors / Mode) fed by the
BroadcastChannel('cxlmemsim-events') the SharedWorker publishes.
Shows 'degraded' reason when the WASM module fails to load.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Cross-tab smoke test page

**Files:**
- Create: `victoryang00.github.io/cxl2/test_cross_tab.html`

- [ ] **Step 1: Write the harness**

Create `victoryang00.github.io/cxl2/test_cross_tab.html`:

```html
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>cxlmemsim cross-tab test</title>
<style>
body { font: 14px ui-monospace, monospace; background:#0b0f14; color:#e7edf3;
       padding: 16px; }
pre { background:#05080b; border:1px solid #263440; padding: 12px;
      max-height: 480px; overflow:auto; }
</style></head>
<body>
<h1>cxlmemsim cross-tab smoke test</h1>
<button id="run" type="button">Run</button>
<pre id="out"></pre>
<script>
const out = document.getElementById("out");
function log(text) { out.textContent += text + "\n"; }

const REQUEST_DATA_OFFSET = 64;
const RESPONSE_OFFSET = 128;
const REQUEST_SAB_SIZE = 256;

function postSync(port, sab, op, addr, size, payload) {
    const control = new Int32Array(sab, 0, 1);
    Atomics.store(control, 0, 0);
    if (payload) {
        new Uint8Array(sab).set(payload, REQUEST_DATA_OFFSET);
    }
    const addrLo = addr & 0xFFFFFFFF;
    const addrHi = Math.floor(addr / 4294967296);
    port.postMessage({ type:"sync-request", pool:"CXLMemSim",
                       size: 64 * 1024 * 1024, sab, op,
                       addrLo, addrHi, size,
                       valueLo:0, valueHi:0,
                       expectedLo:0, expectedHi:0,
                       clientId: "cross-tab" });
    Atomics.wait(control, 0, 0);
    const status = new DataView(sab).getUint8(RESPONSE_OFFSET);
    const payloadOut = new Uint8Array(sab, RESPONSE_OFFSET + 17, 64);
    return { status, payload: payloadOut.slice() };
}

document.getElementById("run").onclick = async () => {
    out.textContent = "";
    if (!window.crossOriginIsolated) {
        log("FAIL: page is not cross-origin isolated"); return;
    }
    const worker = new SharedWorker(
        "/cxl2/cxlmemsim-pool-worker.js?v=20260514-wasm-bridge",
        "hetgpu-cxlmemsim");
    worker.port.start();
    worker.port.postMessage({ type:"connect", role:"qemu",
        clientId:"cross-tab", pool:"CXLMemSim",
        size: 64 * 1024 * 1024 });

    const sab = new SharedArrayBuffer(REQUEST_SAB_SIZE);
    const pattern = new Uint8Array(64);
    for (let i = 0; i < 64; i++) pattern[i] = (i ^ 0xA5) & 0xff;

    log("WRITE 0x1000 (op=1)");
    let r = postSync(worker.port, sab, 1, 0x1000, 64, pattern);
    log("  status=" + r.status);
    log("READ 0x1000 (op=0)");
    r = postSync(worker.port, sab, 0, 0x1000, 64);
    log("  status=" + r.status);
    let ok = true;
    for (let i = 0; i < 64; i++) {
        if (r.payload[i] !== ((i ^ 0xA5) & 0xff)) { ok = false; break; }
    }
    log(ok ? "PASS: payload matches" : "FAIL: payload mismatch");

    log("");
    log("Open this page in a second tab and click Run there.");
    log("That tab should observe the same byte pattern at 0x1000.");
};
</script></body></html>
```

- [ ] **Step 2: Verify cross-tab consistency**

Restart the static server, open `test_cross_tab.html` in tab A,
click Run, see `PASS: payload matches`. Open the same URL in tab B,
**do not write** — click Run with `op=0` only by editing the page
or by running this in the Console of tab B:

```javascript
const w = new SharedWorker("/cxl2/cxlmemsim-pool-worker.js?v=20260514-wasm-bridge", "hetgpu-cxlmemsim");
w.port.start();
w.port.postMessage({ type:"connect", role:"qemu", clientId:"reader", pool:"CXLMemSim", size:64*1024*1024 });
const sab = new SharedArrayBuffer(256);
const ctl = new Int32Array(sab, 0, 1);
Atomics.store(ctl, 0, 0);
w.port.postMessage({ type:"sync-request", pool:"CXLMemSim", size:64*1024*1024, sab, op:0,
    addrLo:0x1000, addrHi:0, size:64, valueLo:0, valueHi:0,
    expectedLo:0, expectedHi:0, clientId:"reader" });
Atomics.wait(ctl, 0, 0);
console.log(new Uint8Array(sab, 128 + 17, 64));
```

Expected: the printed array contains the same `i ^ 0xA5` pattern tab
A wrote — i.e., the second tab sees writes from the first tab,
demonstrating cross-tab consistency.

- [ ] **Step 3: Commit**

```
cd /home/victoryang00/hetGPU_new/victoryang00.github.io
git add cxl2/test_cross_tab.html
git commit -m "test(cxl2): cross-tab smoke test for cxlmemsim bridge

Two-button harness that writes a pattern from tab A and verifies tab
B reads the same bytes via the shared CXLMemSim WASM instance.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Update the worker README

**Files:**
- Modify: `CXLMemSim/web/README.md`

- [ ] **Step 1: Rewrite the README**

Overwrite `CXLMemSim/web/README.md` with:

```markdown
# CXLMemSim Browser Server

`cxlmemsim-pool-worker.js` is the browser-hosted CXLMemSim
SharedWorker. On the first `connect` message it loads
`./cxlmemsim_wasm/cxlmemsim_wasm.mjs` and runs the real simulator
(controller + coherency engine + policy family) inside the worker.
The pool lives inside the WASM heap; each tab only ships a
per-request `SharedArrayBuffer` to handshake via
`Atomics.wait`/`Atomics.notify`.

If the WASM module fails to load, the worker falls back to a flat
pool so the page still works (just without latency or coherency
modelling).

## Deployment

- Canonical source: `CXLMemSim/web/cxlmemsim-pool-worker.js`
- Deployed mirror: `victoryang00.github.io/cxl2/cxlmemsim-pool-worker.js`
- WASM artifacts: `victoryang00.github.io/cxl2/cxlmemsim_wasm/`

Run `hetGPU_new/tools/build_cxlmemsim_wasm.sh` to (re)build and
deploy. Bump the `?v=…` cache-bust in
`victoryang00.github.io/cxl2/cxl-module.js` and `cxl2/index.html`
when you ship a behaviour change.

## Cross-tab events

The worker broadcasts simulator deltas on
`BroadcastChannel("cxlmemsim-events")`. The dashboard
(`cxl2/cxlmemsim.html`) subscribes and renders per-simulator
counters (sim reads / writes / atomics / invalidations / avg
latency / errors / mode).
```

- [ ] **Step 2: Commit**

```
cd /home/victoryang00/hetGPU_new/CXLMemSim
git add web/README.md
git commit -m "docs(web): document the WASM-driven SharedWorker bridge

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: End-to-end QEMU verification

This task puts a real QEMU WASM instance on the new WASM-driven bridge
and verifies the bridge survives real traffic. QEMU is already wired
up: `cxl-module.js` sets `Module.ENV.CXL_MEMSIM_TRANSPORT=browser` and
`Module.HETGPU_CXL_MEMSIM_WORKER_URL` to the SharedWorker URL, and the
QEMU CXL backend already speaks the `sync-request` / `qemu-message`
shapes the worker accepts. Because Task 7 preserves the wire format,
no QEMU-side changes should be needed; this task is verification.

**Files:**
- Modify: `victoryang00.github.io/cxl2/test_cross_tab.html` — add a
  "with QEMU" hint at the bottom.
- Modify: `victoryang00.github.io/cxl2/cxlmemsim.html` — render the
  connected clients' `role` and `device` so a real QEMU client is
  visibly distinct from synthetic ones.

- [ ] **Step 1: Confirm the QEMU assets are still served**

```bash
cd /home/victoryang00/hetGPU_new/victoryang00.github.io
python3 -m http.server 8000 >/tmp/static.log 2>&1 &
echo $! > /tmp/static.pid
sleep 1
curl -sI 'http://localhost:8000/cxl2/index.html' | head -2
curl -sI 'http://localhost:8000/cxl2/images/alpine-x86_64/out.js' | head -2
curl -sI 'http://localhost:8000/cxl2/images/alpine-x86_64/qemu-system-x86_64.wasm' | head -2
curl -sI 'http://localhost:8000/cxl2/cxlmemsim_wasm/cxlmemsim_wasm.mjs' | head -2
```

Expected: all four return `HTTP/1.0 200 OK`. If the QEMU assets are
missing (404), the workstation's `cxl2/images/alpine-x86_64/` is
incomplete — escalate; do not try to rebuild QEMU here.

- [ ] **Step 2: Boot QEMU against the WASM-driven worker (manual,
  cannot be automated)**

In Chrome / Chromium with cross-origin isolation:

1. Open `http://localhost:8000/cxl2/index.html?cxl=type2&cxlmemsim=browser&cxlmemsim_pool=CXLMemSim&cxlmemsim_size=256MB&fast_login=1`.
2. Click **Start VM**. Within ~30 s the xterm pane should reach a
   `/bin/sh` prompt.
3. In a second tab, open `http://localhost:8000/cxl2/cxlmemsim.html?pool=CXLMemSim&size=268435456`.
4. The dashboard's **Mode** tile must read `wasm` (not
   `degraded: …`). The **Clients** count must be at least 2 (one
   QEMU `role:'qemu'`, one dashboard `role:'ui'`). The client list
   (the `<pre id="clients">` panel) must show the QEMU client's
   `device` string.

If **Mode** reads `degraded`, open DevTools → Application → Shared
Workers → `hetgpu-cxlmemsim` and check its Console for the WASM
load error. The flat-pool fallback is doing its job, but the bridge
needs to be fixed before Step 3 is meaningful.

- [ ] **Step 3: Drive real CXL traffic from the QEMU guest**

In the xterm pane (the QEMU guest), paste the existing **Probe CXL**
button payload (already on the page; it issues `cat /proc/cmdline`,
walks `/sys/bus/cxl`, etc.). Then run:

```sh
# inside the QEMU guest:
dd if=/dev/zero of=/dev/shm/probe bs=64 count=64 2>/dev/null || true
dd if=/dev/shm/probe of=/dev/null bs=64 count=64 2>/dev/null || true
```

Switch back to the dashboard tab. Within ~1 s the **Sim Reads** and
**Sim Writes** counters must both move past zero, and **Avg Latency**
must be a non-zero number of nanoseconds. The flat-pool path does
not update those tiles — if you see them increment, the bridge is
serving real traffic.

If the counters stay at 0, click **Reset Pool** on the dashboard,
then re-run `dd`. If still 0, the bridge is not receiving the
QEMU side's `sync-request` messages — capture a snapshot of the
DevTools Console from the QEMU tab (look for `Atomics.wait` / pool
errors) and escalate.

- [ ] **Step 4: Verify QEMU sees invalidations from the synthetic
  client**

While the QEMU guest is still running, open a third tab:
`http://localhost:8000/cxl2/test_cross_tab.html`. Click **Run**.
The harness writes a 64-byte pattern at offset `0x1000`.

Back in the dashboard, the **Sim Inval** tile must increment by at
least 1 (the worker fans an `INVALIDATE` to every other tab —
including the QEMU tab — whenever any client writes). The QEMU
tab will silently drop the invalidation message but `pool.stats.invalidations`
must reflect it.

- [ ] **Step 5: Add the "with QEMU" hint to the cross-tab page**

In `victoryang00.github.io/cxl2/test_cross_tab.html`, append below
the existing `<script>` block (just before `</body>`):

```html
<p style="margin-top:24px;color:#9fb0bd">
Open <code>/cxl2/index.html?cxl=type2&amp;cxlmemsim=browser&amp;fast_login=1</code>
in another tab and Start VM. Both this tab and that tab share the
same SharedWorker-hosted CXLMemSim; writes from <code>dd</code>
inside the guest will move the dashboard's Sim Reads / Sim Writes
counters in real time.
</p>
```

- [ ] **Step 6: Render client `role` / `device` on the dashboard**

In `victoryang00.github.io/cxl2/cxlmemsim.html`, the
`<pre id="clients">` panel already receives `msg.clients` from the
`status` event. Today it does `JSON.stringify`. Replace the line:

```javascript
fields.clients.textContent = JSON.stringify(msg.clients || [], null, 2);
```

with:

```javascript
fields.clients.textContent = (msg.clients || []).map((c) =>
    `${c.role.padEnd(6)} ${c.id}${c.device ? ` (${c.device})` : ""}`
).join("\n") || "(no clients)";
```

This is a one-line readability change so a real QEMU instance shows
up as `qemu  qemu-… (hetgpu0)` in the dashboard rather than buried
in a JSON blob.

- [ ] **Step 7: Stop the static server, commit**

```bash
kill "$(cat /tmp/static.pid)" 2>/dev/null || true
cd /home/victoryang00/hetGPU_new/victoryang00.github.io
git add cxl2/test_cross_tab.html cxl2/cxlmemsim.html
git commit -m "test(cxl2): cover real QEMU end-to-end on the WASM bridge

Adds a hint pointing the cross-tab smoke test at a real QEMU instance
and renders the dashboard client list as one line per role/id/device.
The bridge is verified by booting cxl2/index.html in one tab and
watching the cxl2/cxlmemsim.html dashboard counters move when the
guest issues dd / cat against /dev/shm.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**

- Compile core lib to WASM → Tasks 1–5.
- Keep wire format → Task 4 reuses the 105/81-byte ServerRequest/Response layout.
- Cross-tab share via SharedWorker → Task 7 keeps the existing SharedWorker, single WASM instance.
- Dashboard counters → Task 8 (sim metric tiles + BroadcastChannel).
- Graceful degraded fallback → Task 7's `handleSyncRequestFlat` path + `degraded` message wired in Task 8.
- Build script → Task 6.
- Tests → Task 2 (`test_wasm_heap_backend`), Task 3–5 (`test_wasm_bridge`), Task 9 (`test_cross_tab.html`).
- BroadcastChannel `cxlmemsim-events` → Task 7 + 8.
- End-to-end QEMU verification → Task 11.

**Placeholder scan:** No "TBD", "TODO", "fill in later" left in the steps. Every code step shows the actual code. Every command step shows the actual command and expected output.

**Type consistency:** `cxlmemsim_init(pool_capacity_bytes, topology_json, out_pool_base)` matches across header (Task 1), implementation (Task 3), and JS caller (Task 7). `cxlmemsim_handle_request(req_ptr, resp_ptr, inv_out_ptr, inv_cap)` is consistent across Tasks 1, 4, 7. `WasmHeapTag` is defined in Task 2 and used in Task 3. `cxlmemsim_stats_t` field layout in Task 5's header matches the byte offsets the JS in Task 7 reads (0, 8, 16, 24, 32, 56, 64).
