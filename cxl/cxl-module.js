if (typeof Module === 'undefined') {
    Module = {};
}

function parseCxlmemsimEndpoint(params) {
    const endpoint = params.get('cxlmemsim') || params.get('cxlmemsim_server') || params.get('cxlmemsim_tcp');
    let host = params.get('cxlmemsim_host')
        || params.get('cxlmemsim_addr')
        || params.get('cxlmemsim-addr')
        || '127.0.0.1';
    let portText = params.get('cxlmemsim_port') || params.get('cxlmemsim-port') || '9999';

    if (endpoint) {
        const urlText = endpoint.includes('://') ? endpoint : `tcp://${endpoint}`;
        try {
            const url = new URL(urlText);
            if (url.protocol === 'tcp:') {
                host = url.hostname || host;
                portText = url.port || portText;
            }
        } catch (error) {
            const separator = endpoint.lastIndexOf(':');
            if (separator > 0) {
                host = endpoint.slice(0, separator);
                portText = endpoint.slice(separator + 1);
            } else {
                host = endpoint;
            }
        }
    }

    host = String(host || '127.0.0.1').trim().replace(/[,\s]/g, '') || '127.0.0.1';
    const portValue = Number(portText);
    const port = Number.isInteger(portValue) && portValue > 0 && portValue <= 65535 ? portValue : 9999;
    return { host, port };
}

const CXL_WEB_CONFIG = (() => {
    const params = new URLSearchParams(location.search);
    const validProfiles = new Set(['all', 'type1', 'type2', 'type3']);
    const profile = validProfiles.has(params.get('cxl')) ? params.get('cxl') : 'all';
    const backend = params.get('hetgpu') || 'webgpu';
    const cxlmemsim = parseCxlmemsimEndpoint(params);
    const nativeType2 = params.get('native_type2') === '1' || params.get('cxl_type2') === 'native';
    return {
        profile,
        backend,
        nativeType2,
        assetBase: '/cxl/images/alpine-x86_64/',
        image: {
            rom: '/pack-rom/',
            kernelUrl: '/about/bzImage',
            diskUrl: '/about/qemu.img',
            kernel: '/remote/bzImage',
            disk: '/remote/qemu.img'
        },
        network: {
            mode: 'browser',
            websocketUrl: 'http://localhost:9999/',
            stackWorker: '/cxl/images/alpine-x86_64/dist/stack-worker.js',
            stackImage: '/cxl/images/alpine-x86_64/c2w-net-proxy.wasm.gzip',
            proxyUrl: 'http://192.168.127.253:80'
        },
        cxlmemsim: {
            transport: 'tcp',
            host: cxlmemsim.host,
            port: cxlmemsim.port
        }
    };
})();

window.CXL_WEB_CONFIG = CXL_WEB_CONFIG;
Module['ENV'] = {
    ...(Module['ENV'] || {}),
    CXL_MEMSIM_HOST: CXL_WEB_CONFIG.cxlmemsim.host,
    CXL_MEMSIM_PORT: String(CXL_WEB_CONFIG.cxlmemsim.port),
    CXL_MEMSIM_TRANSPORT: CXL_WEB_CONFIG.cxlmemsim.transport,
    CXL_TRANSPORT_MODE: CXL_WEB_CONFIG.cxlmemsim.transport
};

function createRangeBackedFile(mod, parent, name, url, options = {}) {
    const FS = mod.FS;
    const chunkSize = 4 * 1024 * 1024;
    const maxChunks = 64;
    const chunks = new Map();
    const writes = new Map();
    const writable = options.writable === true;

    function request(method, requestUrl, start, end) {
        const xhr = new XMLHttpRequest();
        xhr.open(method, requestUrl, false);
        if (start !== undefined) {
            xhr.setRequestHeader('Range', `bytes=${start}-${end}`);
            if (xhr.overrideMimeType) {
                xhr.overrideMimeType('text/plain; charset=x-user-defined');
            }
        }
        xhr.send(null);
        if (!(xhr.status >= 200 && xhr.status < 300 || xhr.status === 304)) {
            throw new Error(`${method} ${requestUrl} failed: HTTP ${xhr.status}`);
        }
        return xhr;
    }

    function responseBytes(xhr) {
        if (xhr.response && typeof xhr.response !== 'string') {
            return new Uint8Array(xhr.response);
        }
        const text = xhr.responseText || '';
        const bytes = new Uint8Array(text.length);
        for (let i = 0; i < text.length; i++) {
            bytes[i] = text.charCodeAt(i) & 0xff;
        }
        return bytes;
    }

    const head = request('HEAD', url);
    const size = Number(head.getResponseHeader('Content-Length'));
    const acceptsRanges = /bytes/i.test(head.getResponseHeader('Accept-Ranges') || '');
    if (!Number.isFinite(size) || size <= 0) {
        throw new Error(`${url} did not return a usable Content-Length`);
    }
    if (!acceptsRanges) {
        throw new Error(`${url} does not advertise Accept-Ranges: bytes`);
    }

    function getChunk(chunkIndex) {
        if (writes.has(chunkIndex)) {
            return writes.get(chunkIndex);
        }
        if (chunks.has(chunkIndex)) {
            const cached = chunks.get(chunkIndex);
            chunks.delete(chunkIndex);
            chunks.set(chunkIndex, cached);
            return cached;
        }

        const start = chunkIndex * chunkSize;
        const end = Math.min(start + chunkSize - 1, size - 1);
        const xhr = request('GET', url, start, end);
        if (xhr.status !== 206 && size > chunkSize) {
            throw new Error(`${url} ignored Range ${start}-${end}: HTTP ${xhr.status}`);
        }
        const data = responseBytes(xhr);
        chunks.set(chunkIndex, data);
        while (chunks.size > maxChunks) {
            chunks.delete(chunks.keys().next().value);
        }
        return data;
    }

    function getWritableChunk(chunkIndex) {
        if (writes.has(chunkIndex)) {
            return writes.get(chunkIndex);
        }
        const start = chunkIndex * chunkSize;
        const end = Math.min(start + chunkSize, size);
        const data = new Uint8Array(chunkSize);
        data.set(getChunk(chunkIndex).subarray(0, end - start));
        writes.set(chunkIndex, data);
        return data;
    }

    const node = FS.createFile(parent, name, null, true, writable);
    node.usedBytes = size;
    node.contents = { length: size };
    node.stream_ops = {
        ...node.stream_ops,
        read(stream, buffer, offset, length, position) {
            if (position === undefined || position === null) {
                position = stream.position;
            }
            if (position >= size) return 0;
            const available = Math.min(length, size - position);
            let copied = 0;
            while (copied < available) {
                const absolute = position + copied;
                const chunkIndex = Math.floor(absolute / chunkSize);
                const chunkOffset = absolute % chunkSize;
                const chunk = getChunk(chunkIndex);
                const part = Math.min(available - copied, chunk.length - chunkOffset);
                buffer.set(chunk.subarray(chunkOffset, chunkOffset + part), offset + copied);
                copied += part;
            }
            return copied;
        },
        llseek(stream, offset, whence) {
            let position = offset;
            if (whence === 1) position += stream.position;
            if (whence === 2) position += size;
            if (position < 0) throw new FS.ErrnoError(28);
            return position;
        },
        write(stream, buffer, offset, length, position) {
            if (!writable) {
                throw new FS.ErrnoError(63);
            }
            if (position === undefined || position === null) {
                position = stream.position;
            }
            if (position >= size) return 0;
            const available = Math.min(length, size - position);
            let copied = 0;
            while (copied < available) {
                const absolute = position + copied;
                const chunkIndex = Math.floor(absolute / chunkSize);
                const chunkOffset = absolute % chunkSize;
                const chunk = getWritableChunk(chunkIndex);
                const part = Math.min(available - copied, chunk.length - chunkOffset);
                chunk.set(buffer.subarray(offset + copied, offset + copied + part), chunkOffset);
                copied += part;
            }
            return copied;
        },
        allocate() {
            throw new FS.ErrnoError(63);
        },
        mmap() {
            throw new FS.ErrnoError(43);
        },
        msync() {
            throw new FS.ErrnoError(43);
        }
    };
}

Module['preRun'] = Module['preRun'] || [];
Module['preRun'].push((mod) => {
    mod.FS.mkdir('/remote');
    createRangeBackedFile(mod, '/remote', 'bzImage', CXL_WEB_CONFIG.image.kernelUrl);
    createRangeBackedFile(mod, '/remote', 'qemu.img', CXL_WEB_CONFIG.image.diskUrl, { writable: true });
});

function profileHas(name) {
    return CXL_WEB_CONFIG.profile === 'all' || CXL_WEB_CONFIG.profile === name;
}

function buildQemuArguments() {
    const type3Enabled = profileHas('type3');
    const cxlDebug = [
        'cxl_acpi.dyndbg=+fplm',
        'cxl_pci.dyndbg=+fplm',
        'cxl_core.dyndbg=+fplm',
        'cxl_mem.dyndbg=+fplm',
        'cxl_pmem.dyndbg=+fplm',
        'cxl_port.dyndbg=+fplm',
        'cxl_region.dyndbg=+fplm',
        'dax.dyndbg=+fplm',
        'dax_cxl.dyndbg=+fplm',
        'device_dax.dyndbg=+fplm'
    ];
    const append = [
        'root=/dev/sda',
        'rw',
        'console=ttyS0,115200',
        'ignore_loglevel',
        'nokaslr',
        `cxl.profile=${CXL_WEB_CONFIG.profile}`,
        profileHas('type1') ? 'cxl.type1=on' : 'cxl.type1=off',
        profileHas('type2') ? 'cxl.type2=on' : 'cxl.type2=off',
        profileHas('type3') ? 'cxl.type3=on' : 'cxl.type3=off',
        `hetgpu.backend=${CXL_WEB_CONFIG.backend}`,
        'hetgpu.device=hetgpu0',
        'cxlmemsim.transport=tcp',
        `cxlmemsim.host=${CXL_WEB_CONFIG.cxlmemsim.host}`,
        `cxlmemsim.port=${CXL_WEB_CONFIG.cxlmemsim.port}`,
        `CXL_MEMSIM_HOST=${CXL_WEB_CONFIG.cxlmemsim.host}`,
        `CXL_MEMSIM_PORT=${CXL_WEB_CONFIG.cxlmemsim.port}`,
        ...cxlDebug
    ].join(' ');

    const args = [
        '-nographic',
        '-M', 'q35,cxl=on',
        '-m', type3Enabled ? '768M,maxmem=1536M,slots=4' : '768M',
        '-smp', '1,sockets=1',
        '-accel', 'tcg,tb-size=500,thread=multi',
        '-L', CXL_WEB_CONFIG.image.rom,
        '-kernel', CXL_WEB_CONFIG.image.kernel,
        '-append', append,
        '-drive', `file=${CXL_WEB_CONFIG.image.disk},index=0,media=disk,format=raw`,
        '-netdev', 'socket,id=vmnic,connect=127.0.0.1:8888',
        '-device', 'virtio-net-pci,netdev=vmnic,mac=52:54:00:00:10:22',
        '-device', 'pxb-cxl,bus_nr=12,bus=pcie.0,id=cxl.1'
    ];

    if (profileHas('type2')) {
        if (CXL_WEB_CONFIG.nativeType2) {
            args.push(
                '-device', 'cxl-rp,port=1,bus=cxl.1,id=root_port14,chassis=0,slot=1',
                '-device', [
                    'cxl-type2',
                    'bus=root_port14',
                    'cache-size=64M',
                    'mem-size=256M',
                    'sn=0x2',
                    `cxlmemsim-addr=${CXL_WEB_CONFIG.cxlmemsim.host}`,
                    `cxlmemsim-port=${CXL_WEB_CONFIG.cxlmemsim.port}`,
                    'coherency-enabled=true',
                    'gpu-mode=2',
                    `hetgpu-backend=${CXL_WEB_CONFIG.backend}`,
                    'hetgpu-device=0',
                    'id=cxl-type2-hetgpu0'
                ].join(',')
            );
        } else {
            args.push(
                '-device', 'virtio-gpu-pci,bus=pcie.0,id=hetgpu0'
            );
        }
    }

    if (profileHas('type3')) {
        args.push(
            '-object', 'memory-backend-ram,id=vmem0,share=on,size=128M',
            '-device', 'cxl-rp,port=0,bus=cxl.1,id=root_port13,chassis=0,slot=0',
            '-device', 'cxl-type3,bus=root_port13,volatile-memdev=vmem0,id=cxl-vmem0',
            '-M', 'cxl-fmw.0.targets.0=cxl.1,cxl-fmw.0.size=256M'
        );
    }

    return args;
}

Module['arguments'] = buildQemuArguments();
window.CXL_WEB_CONFIG.arguments = Module['arguments'];
window.CXL_WEB_CONFIG.command = Module['arguments'].map((arg) => {
    return /\s/.test(arg) ? JSON.stringify(arg) : arg;
}).join(' ');
Module['locateFile'] = function(path, prefix) {
    return CXL_WEB_CONFIG.assetBase + path;
};
Module['mainScriptUrlOrBlob'] = CXL_WEB_CONFIG.assetBase + 'out.js';
