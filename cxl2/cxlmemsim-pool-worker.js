'use strict';

const DEFAULT_POOL = 'CXLMemSim';
const DEFAULT_SIZE = 256 * 1024 * 1024;
const REQUEST_DATA_OFFSET = 64;
const RESPONSE_OFFSET = 128;
const RESPONSE_SIZE = 81;
const TYPE2_MSG_SIZE = 96;
const TYPE2_DATA_OFFSET = 26;

const CXL_OP_READ = 0;
const CXL_OP_WRITE = 1;
const CXL_OP_ATOMIC_FAA = 3;
const CXL_OP_ATOMIC_CAS = 4;
const CXL_OP_FENCE = 5;
const CXL_OP_LSA_READ = 6;
const CXL_OP_LSA_WRITE = 7;

const CXL_T2_MSG_WRITE = 2;
const CXL_T2_MSG_READ = 1;
const CXL_T2_MSG_CACHE_FLUSH = 3;
const CXL_T2_MSG_INVALIDATE = 7;
const CXL_T2_MSG_WRITEBACK = 8;
const CXL_T2_MSG_GPU_ACCESS = 9;
const CXL_T2_MSG_RESPONSE = 10;

const pools = new Map();

function normalizePoolName(name) {
    const text = String(name || '').trim();
    return text || DEFAULT_POOL;
}

function clampSize(size) {
    const value = Number(size);
    if (!Number.isFinite(value) || value <= 0) {
        return DEFAULT_SIZE;
    }
    return Math.max(64 * 1024 * 1024, Math.min(value, 1024 * 1024 * 1024));
}

function makePool(name, size) {
    const buffer = new SharedArrayBuffer(clampSize(size));
    return {
        name,
        size: buffer.byteLength,
        buffer,
        bytes: new Uint8Array(buffer),
        view: new DataView(buffer),
        clients: new Map(),
        stats: {
            reads: 0,
            writes: 0,
            atomics: 0,
            fences: 0,
            messages: 0,
            invalidations: 0,
            bytesRead: 0,
            bytesWritten: 0,
            errors: 0
        }
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

function toU64(lo, hi) {
    return (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
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

function inRange(pool, addr, size) {
    return Number.isInteger(addr) && Number.isInteger(size) &&
        addr >= 0 && size >= 0 && size <= 64 && addr + size <= pool.size;
}

function readU64(pool, addr) {
    if (addr + 8 > pool.size) {
        return 0n;
    }
    return pool.view.getBigUint64(addr, true);
}

function writeU64(pool, addr, value) {
    if (addr + 8 <= pool.size) {
        pool.view.setBigUint64(addr, BigInt(value), true);
    }
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

function broadcastStatus(pool) {
    const status = {
        type: 'status',
        pool: pool.name,
        size: pool.size,
        clients: Array.from(pool.clients.values()).map((client) => ({
            id: client.id,
            role: client.role,
            device: client.device
        })),
        stats: { ...pool.stats }
    };
    for (const client of pool.clients.values()) {
        if (client.role === 'ui') {
            client.port.postMessage(status);
        }
    }
}

function broadcastType2(pool, sourceId, buffer) {
    for (const client of pool.clients.values()) {
        if (client.id === sourceId || client.role !== 'qemu') {
            continue;
        }
        client.port.postMessage({ type: 'message', bytes: buffer.slice(0) });
    }
}

function handleSyncRequest(pool, msg) {
    const sab = msg.sab;
    const requestBytes = new Uint8Array(sab);
    const addr = toOffset(msg.addrLo, msg.addrHi);
    const size = Number(msg.size >>> 0);

    try {
        if (!inRange(pool, addr, size)) {
            pool.stats.errors++;
            setResponse(sab, 2, null);
            return;
        }

        switch (msg.op) {
        case CXL_OP_READ:
        case CXL_OP_LSA_READ: {
            const payload = pool.bytes.subarray(addr, addr + size);
            pool.stats.reads++;
            pool.stats.bytesRead += size;
            setResponse(sab, 0, payload);
            break;
        }
        case CXL_OP_WRITE:
        case CXL_OP_LSA_WRITE: {
            pool.bytes.set(requestBytes.subarray(REQUEST_DATA_OFFSET,
                REQUEST_DATA_OFFSET + size), addr);
            pool.stats.writes++;
            pool.stats.bytesWritten += size;
            setResponse(sab, 0, null);
            broadcastType2(pool, msg.clientId,
                makeType2Message(CXL_T2_MSG_INVALIDATE, addr, size, 0, 0xff));
            break;
        }
        case CXL_OP_ATOMIC_FAA: {
            const oldValue = readU64(pool, addr);
            const addValue = toU64(msg.valueLo, msg.valueHi);
            writeU64(pool, addr, oldValue + addValue);
            pool.stats.atomics++;
            setResponse(sab, 0, null, oldValue);
            break;
        }
        case CXL_OP_ATOMIC_CAS: {
            const oldValue = readU64(pool, addr);
            const expected = toU64(msg.expectedLo, msg.expectedHi);
            if (oldValue === expected) {
                writeU64(pool, addr, toU64(msg.valueLo, msg.valueHi));
            }
            pool.stats.atomics++;
            setResponse(sab, 0, null, oldValue);
            break;
        }
        case CXL_OP_FENCE:
            pool.stats.fences++;
            setResponse(sab, 0, null);
            break;
        default:
            pool.stats.errors++;
            setResponse(sab, 3, null);
            break;
        }
        broadcastStatus(pool);
    } catch (error) {
        pool.stats.errors++;
        setResponse(sab, 1, null);
    }
}

function handleQemuMessage(pool, client, msg) {
    if (!msg.bytes) {
        return;
    }
    const buffer = msg.bytes;
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const type = view.getUint32(0, true);
    const size = Math.min(view.getUint32(4, true), 64);
    const addr = Number(view.getBigUint64(8, true));

    pool.stats.messages++;

    if ((type === CXL_T2_MSG_WRITE ||
         type === CXL_T2_MSG_WRITEBACK ||
         type === CXL_T2_MSG_GPU_ACCESS) &&
        inRange(pool, addr, size)) {
        pool.bytes.set(bytes.subarray(TYPE2_DATA_OFFSET,
            TYPE2_DATA_OFFSET + size), addr);
        pool.stats.writes++;
        pool.stats.bytesWritten += size;
        pool.stats.invalidations++;
        broadcastType2(pool, client.id,
            makeType2Message(CXL_T2_MSG_INVALIDATE, addr, size, 0, 0xff));
    } else if (type === CXL_T2_MSG_CACHE_FLUSH || type === CXL_T2_MSG_INVALIDATE) {
        pool.stats.invalidations++;
        broadcastType2(pool, client.id, buffer);
    } else if (type === CXL_T2_MSG_READ && inRange(pool, addr, size)) {
        const payload = pool.bytes.subarray(addr, addr + size);
        client.port.postMessage({
            type: 'message',
            bytes: makeType2Message(CXL_T2_MSG_RESPONSE, addr, size, 1, 0xfe, payload)
        });
    }
    broadcastStatus(pool);
}

function attachPort(port) {
    let client = null;

    port.onmessage = (event) => {
        const msg = event.data || {};
        const pool = getPool(msg.pool, msg.size);

        if (msg.type === 'connect') {
            const id = msg.clientId || `${msg.role || 'client'}-${Math.random().toString(16).slice(2)}`;
            client = {
                id,
                role: msg.role || 'client',
                device: msg.device || '',
                port
            };
            pool.clients.set(id, client);
            port.postMessage({
                type: 'connected',
                clientId: id,
                pool: pool.name,
                size: pool.size
            });
            broadcastStatus(pool);
            return;
        }

        if (msg.type === 'disconnect') {
            const id = msg.clientId || (client && client.id);
            if (id) {
                pool.clients.delete(id);
            }
            broadcastStatus(pool);
            return;
        }

        if (msg.type === 'sync-request') {
            handleSyncRequest(pool, msg);
            return;
        }

        if (msg.type === 'qemu-message' && client) {
            handleQemuMessage(pool, client, msg);
            return;
        }

        if (msg.type === 'reset') {
            pool.bytes.fill(0);
            for (const key of Object.keys(pool.stats)) {
                pool.stats[key] = 0;
            }
            broadcastStatus(pool);
            return;
        }

        if (msg.type === 'get-status') {
            broadcastStatus(pool);
        }
    };

    port.start();
}

onconnect = (event) => {
    attachPort(event.ports[0]);
};
