if (typeof Module === 'undefined') {
    Module = {};
}

function parseCxlmemsimEndpoint(params) {
    const endpoint = params.get('cxlmemsim') || params.get('cxlmemsim_server') || params.get('cxlmemsim_tcp');
    let transport = params.get('cxlmemsim_transport')
        || params.get('cxl_transport')
        || params.get('transport')
        || 'browser';
    let pool = params.get('cxlmemsim_pool') || params.get('memsim_pool') || 'CXLMemSim';
    let host = params.get('cxlmemsim_host')
        || params.get('cxlmemsim_addr')
        || params.get('cxlmemsim-addr')
        || pool;
    let portText = params.get('cxlmemsim_port') || params.get('cxlmemsim-port') || '9999';

    if (endpoint) {
        const endpointText = String(endpoint).trim();
        const lower = endpointText.toLowerCase();
        let endpointHandled = false;
        if (['browser', 'sharedworker', 'wasm', 'wasm-shared', 'cxlmemsim'].includes(lower)) {
            transport = lower === 'cxlmemsim' ? 'browser' : lower;
            host = pool;
            endpointHandled = true;
        }
        const urlText = endpointText.includes('://') ? endpointText : `tcp://${endpointText}`;
        try {
            if (!endpointHandled) {
                const url = new URL(urlText);
                if (url.protocol === 'browser:' || url.protocol === 'sharedworker:' || url.protocol === 'wasm:') {
                    transport = url.protocol.slice(0, -1);
                    pool = url.hostname || url.pathname.replace(/^\/+/, '') || pool;
                    host = pool;
                    portText = url.port || portText;
                } else if (url.protocol === 'tcp:') {
                    transport = 'tcp';
                    host = url.hostname || host;
                    portText = url.port || portText;
                }
            }
        } catch (error) {
            const separator = endpointText.lastIndexOf(':');
            if (separator > 0) {
                host = endpointText.slice(0, separator);
                portText = endpointText.slice(separator + 1);
            } else {
                host = endpointText;
            }
        }
    }

    transport = String(transport || 'browser').trim().toLowerCase();
    if (!['tcp', 'browser', 'sharedworker', 'wasm', 'wasm-shared'].includes(transport)) {
        transport = 'browser';
    }
    if (transport !== 'tcp') {
        transport = 'browser';
    }
    pool = String(pool || host || 'CXLMemSim').trim().replace(/[,\s]/g, '') || 'CXLMemSim';
    host = transport === 'browser'
        ? pool
        : (String(host || '127.0.0.1').trim().replace(/[,\s]/g, '') || '127.0.0.1');
    const portValue = Number(portText);
    const port = Number.isInteger(portValue) && portValue > 0 && portValue <= 65535 ? portValue : 9999;
    return { transport, host, port, pool };
}

function normalizeFetchUrl(value) {
    const text = String(value || '').trim();
    if (!text) {
        return null;
    }
    if (/^file:/i.test(text)) {
        throw new Error('file:// URLs cannot be fetched from this page; serve the directory over localhost HTTP instead');
    }
    return new URL(text, location.href).href;
}

function normalizeDirectoryUrl(value) {
    const url = normalizeFetchUrl(value);
    if (!url) {
        return null;
    }
    return url.endsWith('/') ? url : `${url}/`;
}

function firstUrlParam(params, names) {
    for (const name of names) {
        const value = normalizeFetchUrl(params.get(name));
        if (value) {
            return value;
        }
    }
    return null;
}

function parseTimeoutSeconds(params, names, fallback) {
    for (const name of names) {
        const raw = params.get(name);
        if (!raw) {
            continue;
        }
        const match = String(raw).trim().match(/^(\d+)(?:s|sec|seconds?)?$/i);
        if (!match) {
            continue;
        }
        const value = Number(match[1]);
        if (Number.isInteger(value) && value >= 10 && value <= 3600) {
            return value;
        }
    }
    return fallback;
}

function parseIntegerParam(params, names, fallback, min, max) {
    for (const name of names) {
        const raw = params.get(name);
        if (!raw) {
            continue;
        }
        const value = Number(String(raw).trim());
        if (Number.isInteger(value) && value >= min && value <= max) {
            return value;
        }
    }
    return fallback;
}

function parseByteSizeParam(params, names, fallback, min, max) {
    for (const name of names) {
        const raw = params.get(name);
        if (!raw) {
            continue;
        }
        const match = String(raw).trim().match(/^(\d+)(?:\s*([kmgt])i?b?)?$/i);
        if (!match) {
            continue;
        }
        const scale = {
            k: 1024,
            m: 1024 * 1024,
            g: 1024 * 1024 * 1024,
            t: 1024 * 1024 * 1024 * 1024
        }[(match[2] || '').toLowerCase()] || 1;
        const value = Number(match[1]) * scale;
        if (Number.isSafeInteger(value) && value >= min && value <= max) {
            return value;
        }
    }
    return fallback;
}

function parseExtraKernelArgs(params) {
    const value = params.get('extra_kernel_args') || params.get('kernel_args') || '';
    return String(value)
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .filter((arg) => /^[A-Za-z0-9_.:+/@=,-]+$/.test(arg))
        .slice(0, 32);
}

function parseImageConfig(params) {
    const imageDirParam = params.get('file_dir')
        || params.get('local_dir')
        || params.get('image_dir')
        || params.get('img_dir')
        || params.get('image_base');
    const localImageRequested = params.get('local_img') === '1' || Boolean(imageDirParam);
    const localDiskRequested = localImageRequested
        || params.get('local_disk') === '1'
        || params.get('local_qemu_img') === '1';
    const imageDir = normalizeDirectoryUrl(
        imageDirParam || (localDiskRequested ? 'http://127.0.0.1:8787/' : '')
    );
    const kernelUrl = firstUrlParam(params, ['kernel_url', 'bzimage_url', 'bzImage_url'])
        || (localImageRequested && imageDir ? new URL('bzImage', imageDir).href : '/about/bzImage');
    const diskUrl = firstUrlParam(params, ['disk_url', 'qemu_img_url', 'qemu_img', 'img_url'])
        || (localDiskRequested && imageDir ? new URL('qemu.img', imageDir).href : '/about/qemu.img');
    return {
        rom: '/pack-rom/',
        kernelUrl,
        diskUrl,
        kernel: '/remote/bzImage',
        disk: '/remote/qemu.img',
        source: localDiskRequested && imageDir ? 'local' : 'remote',
        imageDir
    };
}

const CXL_WEB_CONFIG = (() => {
    const params = new URLSearchParams(location.search);
    const validProfiles = new Set(['all', 'type1', 'type2', 'type3']);
    const profile = validProfiles.has(params.get('cxl')) ? params.get('cxl') : 'all';
    const backend = params.get('hetgpu') || 'webgpu';
    const cxlmemsim = parseCxlmemsimEndpoint(params);
    const nativeType1 = params.get('native_type1') === '1' || params.get('cxl_type1') === 'native';
    const nativeType2 = params.get('native_type2') === '1' || params.get('cxl_type2') === 'native';
    const directShellParam = params.get('fast_login') || params.get('direct_shell') || '';
    const fastLogin = directShellParam === '1' || directShellParam === 'true';
    const fastBoot = params.get('fast_boot') !== '0';
    const acpiEnabled = params.get('acpi') === 'on';
    const qemuCxlEnabled = acpiEnabled && params.get('qemu_cxl') === '1';
    const coreParam = params.get('qemu_core') || params.get('core') || '';
    const qemuCore = coreParam === 'fpcast' ? 'fpcast' : 'fast';
    const diskBus = params.get('disk_bus') === 'virtio' ? 'virtio' : 'legacy';
    const tcgThread = params.get('tcg_thread') === 'single' ? 'single' : 'multi';
    const tbSize = parseIntegerParam(params, ['qemu_tb_size', 'tb_size', 'tcg_tb_size'], 500, 32, 1024);
    const cxlRootPortReserve = params.get('cxl_rp_reserve') !== '0';
    const hpet = params.get('hpet') === 'off' ? 'off' : 'on';
    const nodefaults = params.get('nodefaults') === '1';
    const rtc = params.get('rtc') === 'vm' ? 'vm' : 'off';
    const extraKernelArgs = parseExtraKernelArgs(params);
    const image = parseImageConfig(params);
    const debug = params.get('debug') === '1' || params.get('cxl_debug') === '1' || params.get('verbose') === '1';
    const startTimeoutSec = parseTimeoutSeconds(
        params,
        ['cxl_setup_timeout', 'cxlmem_setup_timeout', 'service_timeout', 'start_timeout'],
        fastBoot ? 180 : 300
    );
    const cxlmemsimSize = parseByteSizeParam(
        params,
        ['cxlmemsim_size', 'memsim_size', 'pool_size'],
        256 * 1024 * 1024,
        64 * 1024 * 1024,
        1024 * 1024 * 1024
    );
    return {
        profile,
        backend,
        nativeType1,
        nativeType2,
        fastLogin,
        fastBoot,
        acpiEnabled,
        qemuCxlEnabled,
        debug,
        startTimeoutSec,
        qemuCore,
        diskBus,
        hpet,
        nodefaults,
        rtc,
        cxlRootPortReserve,
        extraKernelArgs,
        tcg: {
            thread: tcgThread,
            tbSize
        },
        assetVersion: qemuCore === 'fpcast' ? '20260512-numfix' : '20260514-hetgpu-int',
        assetBase: qemuCore === 'fpcast' ? '/cxl2/images/alpine-x86_64-fpcast/' : '/cxl2/images/alpine-x86_64/',
        image,
        network: {
            mode: 'browser',
            websocketUrl: 'http://localhost:9999/',
            stackWorker: '/cxl2/images/alpine-x86_64/dist/stack-worker.js',
            stackImage: '/cxl2/images/alpine-x86_64/c2w-net-proxy.wasm.gzip',
            proxyUrl: 'http://192.168.127.253:80'
        },
        cxlmemsim: {
            transport: cxlmemsim.transport,
            host: cxlmemsim.host,
            port: cxlmemsim.port,
            pool: cxlmemsim.pool,
            size: cxlmemsimSize,
            workerUrl: '/cxl2/cxlmemsim-pool-worker.js?v=20260514-mjsfix'
        }
    };
})();

window.CXL_WEB_CONFIG = CXL_WEB_CONFIG;
Module['ENV'] = {
    ...(Module['ENV'] || {}),
    CXL_MEMSIM_HOST: CXL_WEB_CONFIG.cxlmemsim.host,
    CXL_MEMSIM_PORT: String(CXL_WEB_CONFIG.cxlmemsim.port),
    CXL_MEMSIM_POOL: CXL_WEB_CONFIG.cxlmemsim.pool,
    CXL_MEMSIM_SIZE: String(CXL_WEB_CONFIG.cxlmemsim.size),
    CXL_MEMSIM_TRANSPORT: CXL_WEB_CONFIG.cxlmemsim.transport,
    CXL_TRANSPORT_MODE: CXL_WEB_CONFIG.cxlmemsim.transport
};
Module['HETGPU_CXL_MEMSIM_WORKER_URL'] = new URL(
    CXL_WEB_CONFIG.cxlmemsim.workerUrl,
    location.href
).href;

function createRangeBackedFile(mod, parent, name, url, options = {}) {
    const FS = mod.FS;
    const chunkSize = options.chunkSize || 4 * 1024 * 1024;
    const maxChunks = options.maxChunks || 64;
    const chunks = new Map();
    const writes = new Map();
    const writable = options.writable === true;
    const allowFullFallback = options.allowFullFallback === true;
    const maxFullFallbackSize = options.maxFullFallbackSize || 64 * 1024 * 1024;
    let fullFile = null;

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
    if (!acceptsRanges && (!allowFullFallback || size > maxFullFallbackSize)) {
        throw new Error(`${url} must be served with Accept-Ranges: bytes and HTTP 206 byte-range responses`);
    }

    function getFullFile() {
        if (fullFile) {
            return fullFile;
        }
        if (!allowFullFallback || size > maxFullFallbackSize) {
            throw new Error(`${url} must be served with Accept-Ranges: bytes and HTTP 206 byte-range responses`);
        }
        fullFile = responseBytes(request('GET', url));
        return fullFile;
    }

    function getChunk(chunkIndex) {
        const start = chunkIndex * chunkSize;
        const end = Math.min(start + chunkSize - 1, size - 1);

        if (writes.has(chunkIndex)) {
            return writes.get(chunkIndex);
        }
        if (!acceptsRanges) {
            return getFullFile().subarray(start, end + 1);
        }
        if (chunks.has(chunkIndex)) {
            const cached = chunks.get(chunkIndex);
            chunks.delete(chunkIndex);
            chunks.set(chunkIndex, cached);
            return cached;
        }

        const xhr = request('GET', url, start, end);
        if (xhr.status !== 206) {
            if (xhr.status === 200 && allowFullFallback && size <= maxFullFallbackSize) {
                fullFile = responseBytes(xhr);
                return fullFile.subarray(start, end + 1);
            }
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
    createRangeBackedFile(mod, '/remote', 'bzImage', CXL_WEB_CONFIG.image.kernelUrl, { allowFullFallback: true });
    createRangeBackedFile(mod, '/remote', 'qemu.img', CXL_WEB_CONFIG.image.diskUrl, {
        writable: true,
        chunkSize: 16 * 1024 * 1024,
        maxChunks: 32
    });
});

function profileHas(name) {
    return CXL_WEB_CONFIG.profile === 'all' || CXL_WEB_CONFIG.profile === name;
}

function buildQemuArguments() {
    const type3Enabled = CXL_WEB_CONFIG.qemuCxlEnabled && profileHas('type3');
    const virtioDisk = CXL_WEB_CONFIG.diskBus !== 'legacy';
    const rootDevice = virtioDisk ? '/dev/vda' : '/dev/sda';
    const fastBootMasks = CXL_WEB_CONFIG.fastBoot ? [
        'systemd.mask=apt-daily.service',
        'systemd.mask=apt-daily.timer',
        'systemd.mask=apt-daily-upgrade.service',
        'systemd.mask=apt-daily-upgrade.timer',
        'systemd.mask=dpkg-db-backup.service',
        'systemd.mask=dpkg-db-backup.timer',
        'systemd.mask=e2scrub_all.service',
        'systemd.mask=e2scrub_all.timer',
        'systemd.mask=e2scrub_reap.service',
        'systemd.mask=logrotate.service',
        'systemd.mask=logrotate.timer',
        'systemd.mask=ldconfig.service',
        'systemd.mask=proc-sys-fs-binfmt_misc.automount',
        'systemd.mask=proc-sys-fs-binfmt_misc.mount',
        'systemd.mask=serial-getty@ttyS0.service',
        'systemd.mask=sys-fs-fuse-connections.mount',
        'systemd.mask=sys-kernel-config.mount',
        'systemd.mask=systemd-binfmt.service',
        'systemd.mask=systemd-hwdb-update.service',
        'systemd.mask=systemd-journal-catalog-update.service',
        'systemd.mask=systemd-journal-flush.service',
        'systemd.mask=systemd-journald-audit.socket',
        'systemd.mask=systemd-journald-dev-log.socket',
        'systemd.mask=systemd-journald.service',
        'systemd.mask=systemd-journald.socket',
        'systemd.mask=systemd-logind.service',
        'systemd.mask=systemd-udevd-control.socket',
        'systemd.mask=systemd-udevd-kernel.socket',
        'systemd.mask=systemd-udevd.service',
        'systemd.mask=systemd-udev-settle.service',
        'systemd.mask=systemd-udev-trigger.service',
        'systemd.mask=systemd-rfkill.socket',
        'systemd.mask=ssh.service',
        'systemd.mask=sshd.service',
        'systemd.mask=modprobe@drm.service'
    ] : [];
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
    const bootLogArgs = CXL_WEB_CONFIG.debug ? ['ignore_loglevel'] : [
        'quiet',
        'loglevel=3',
        'systemd.show_status=auto'
    ];
    const directBootLogArgs = CXL_WEB_CONFIG.debug ? ['loglevel=8'] : [
        'quiet',
        'loglevel=3'
    ];
    const baseAppend = [
        `root=${rootDevice}`,
        'rootwait',
        'rw',
        'console=ttyS0,115200',
        'devtmpfs.mount=1',
        'fsck.mode=skip',
        'fsck.repair=no',
        'random.trust_cpu=on',
        'log_buf_len=256K',
        'printk.time=0',
        ...CXL_WEB_CONFIG.extraKernelArgs
    ];
    const runtimeAppend = [
        `qemu.acpi=${CXL_WEB_CONFIG.acpiEnabled ? 'on' : 'off'}`,
        `qemu.cxl=${CXL_WEB_CONFIG.qemuCxlEnabled ? 'on' : 'off'}`,
        `cxl.profile=${CXL_WEB_CONFIG.profile}`,
        CXL_WEB_CONFIG.qemuCxlEnabled && profileHas('type1') ? 'cxl.type1=on' : 'cxl.type1=off',
        profileHas('type2') ? 'cxl.type2=on' : 'cxl.type2=off',
        type3Enabled ? 'cxl.type3=on' : 'cxl.type3=off',
        `hetgpu.backend=${CXL_WEB_CONFIG.backend}`,
        'hetgpu.device=hetgpu0',
        `cxlmemsim.transport=${CXL_WEB_CONFIG.cxlmemsim.transport}`,
        `cxlmemsim.host=${CXL_WEB_CONFIG.cxlmemsim.host}`,
        `cxlmemsim.port=${CXL_WEB_CONFIG.cxlmemsim.port}`,
        `cxlmemsim.pool=${CXL_WEB_CONFIG.cxlmemsim.pool}`,
        `cxl.setup_timeout_sec=${CXL_WEB_CONFIG.startTimeoutSec}`,
        `cxlmem.setup_timeout_sec=${CXL_WEB_CONFIG.startTimeoutSec}`
    ];
    const directShellAppend = [
        ...baseAppend,
        'init=/bin/sh',
        ...directBootLogArgs,
        ...runtimeAppend,
        ...(CXL_WEB_CONFIG.debug ? cxlDebug : [])
    ];
    const startTimeout = `${CXL_WEB_CONFIG.startTimeoutSec}s`;
    const stopTimeout = CXL_WEB_CONFIG.fastBoot ? '3s' : '10s';
    const systemdAppend = [
        ...baseAppend,
        'systemd.unit=multi-user.target',
        ...bootLogArgs,
        'nokaslr',
        'nowatchdog',
        'nosoftlockup',
        ...(CXL_WEB_CONFIG.fastBoot ? ['systemd.volatile=state'] : []),
        `systemd.default_timeout_start_sec=${startTimeout}`,
        `systemd.default_timeout_stop_sec=${stopTimeout}`,
        `systemd.setenv=CXL_SETUP_TIMEOUT_SEC=${CXL_WEB_CONFIG.startTimeoutSec}`,
        `systemd.setenv=CXLMEM_SETUP_TIMEOUT_SEC=${CXL_WEB_CONFIG.startTimeoutSec}`,
        `systemd.setenv=CXL_MEMSIM_HOST=${CXL_WEB_CONFIG.cxlmemsim.host}`,
        `systemd.setenv=CXL_MEMSIM_PORT=${CXL_WEB_CONFIG.cxlmemsim.port}`,
        `systemd.setenv=CXL_MEMSIM_POOL=${CXL_WEB_CONFIG.cxlmemsim.pool}`,
        `systemd.setenv=CXL_MEMSIM_SIZE=${CXL_WEB_CONFIG.cxlmemsim.size}`,
        `systemd.setenv=CXL_MEMSIM_TRANSPORT=${CXL_WEB_CONFIG.cxlmemsim.transport}`,
        `systemd.setenv=CXL_TRANSPORT_MODE=${CXL_WEB_CONFIG.cxlmemsim.transport}`,
        'systemd.default_device_timeout_sec=3s',
        'systemd.wants=console-getty.service',
        ...runtimeAppend,
        ...fastBootMasks,
        ...(CXL_WEB_CONFIG.debug ? cxlDebug : [])
    ];
    const append = (CXL_WEB_CONFIG.fastLogin ? directShellAppend : systemdAppend).join(' ');
    const machine = CXL_WEB_CONFIG.qemuCxlEnabled
        ? `q35,cxl=on,hpet=${CXL_WEB_CONFIG.hpet}`
        : (CXL_WEB_CONFIG.acpiEnabled ? `q35,hpet=${CXL_WEB_CONFIG.hpet}` : `q35,acpi=off,hpet=${CXL_WEB_CONFIG.hpet}`);
    const accel = `tcg,tb-size=${CXL_WEB_CONFIG.tcg.tbSize},thread=${CXL_WEB_CONFIG.tcg.thread}`;

    const args = [
        '-nographic',
        '-no-user-config',
        '-serial', 'stdio',
        '-monitor', 'none',
        '-M', machine,
        '-m', type3Enabled ? '768M,maxmem=1536M,slots=4' : '768M',
        '-smp', '1,sockets=1',
        '-accel', accel,
        '-L', CXL_WEB_CONFIG.image.rom,
        '-kernel', CXL_WEB_CONFIG.image.kernel,
        '-append', append,
        '-netdev', 'socket,id=vmnic,connect=127.0.0.1:8888',
        '-device', 'virtio-net-pci,netdev=vmnic,mac=52:54:00:00:10:22',
        '-device', 'virtio-rng-pci'
    ];
    if (CXL_WEB_CONFIG.rtc !== 'off') {
        const rtcIndex = args.indexOf('-L');
        args.splice(rtcIndex, 0, '-rtc', 'base=utc,clock=vm');
    }
    if (CXL_WEB_CONFIG.nodefaults) {
        args.splice(1, 0, '-nodefaults');
    }

    if (virtioDisk) {
        args.push(
            '-drive', `file=${CXL_WEB_CONFIG.image.disk},if=none,id=rootfs,format=raw,cache=unsafe`,
            '-device', 'virtio-blk-pci,drive=rootfs,bootindex=1'
        );
    } else {
        args.push(
            '-drive', `file=${CXL_WEB_CONFIG.image.disk},index=0,media=disk,format=raw,cache=unsafe`
        );
    }

    if (CXL_WEB_CONFIG.qemuCxlEnabled) {
        args.push('-device', 'pxb-cxl,bus_nr=12,bus=pcie.0,id=cxl.1');
    }

    if (profileHas('type1') && CXL_WEB_CONFIG.qemuCxlEnabled && CXL_WEB_CONFIG.nativeType1) {
        args.push(
            '-device', 'cxl-rp,port=2,bus=cxl.1,id=root_port15,chassis=0,slot=3',
            '-device', [
                'cxl-type1',
                'bus=root_port15',
                'size=256M',
                'cache-size=64M',
                `cxlmemsim-addr=${CXL_WEB_CONFIG.cxlmemsim.host}`,
                `cxlmemsim-port=${CXL_WEB_CONFIG.cxlmemsim.port}`,
                'id=cxl-type1-accel0'
            ].join(',')
        );
    }

    if (profileHas('type2')) {
        if (CXL_WEB_CONFIG.qemuCxlEnabled && CXL_WEB_CONFIG.nativeType2) {
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

    if (type3Enabled) {
        const rootPortOptions = [
            'cxl-rp',
            'port=0',
            'bus=cxl.1',
            'id=root_port13',
            'chassis=0',
            'slot=2'
        ];
        if (CXL_WEB_CONFIG.cxlRootPortReserve) {
            rootPortOptions.push('mem-reserve=64M', 'pref64-reserve=256M', 'io-reserve=4K');
        }
        args.push(
            '-object', 'memory-backend-ram,id=vmem0,share=on,size=128M',
            '-device', rootPortOptions.join(','),
            '-device', 'cxl-type3,bus=root_port13,volatile-memdev=vmem0,id=cxl-vmem0,sn=0x1',
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
    const url = new URL(path, new URL(CXL_WEB_CONFIG.assetBase, location.href));
    if (path === 'qemu-system-x86_64.worker.js' || path === 'qemu-system-x86_64.js' || path === 'qemu-system-x86_64.wasm') {
        url.searchParams.set('v', CXL_WEB_CONFIG.assetVersion);
    }
    return url.href;
};
{
    const mainScriptUrl = new URL('out.js', new URL(CXL_WEB_CONFIG.assetBase, location.href));
    mainScriptUrl.searchParams.set('v', CXL_WEB_CONFIG.assetVersion);
    Module['mainScriptUrlOrBlob'] = mainScriptUrl.href;
}
