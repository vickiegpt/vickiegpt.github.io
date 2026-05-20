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

function githubLfsMediaUrl(value) {
    let parsed;
    try {
        parsed = new URL(value, location.href);
    } catch (error) {
        return null;
    }
    if (parsed.hostname === 'raw.githubusercontent.com') {
        const parts = parsed.pathname.split('/').filter(Boolean);
        if (parts.length >= 4) {
            const [owner, repo, ref, ...pathParts] = parts;
            parsed.hostname = 'media.githubusercontent.com';
            parsed.pathname = `/media/${owner}/${repo}/${ref}/${pathParts.join('/')}`;
            return parsed.href;
        }
    }
    if (parsed.hostname === 'github.com') {
        const parts = parsed.pathname.split('/').filter(Boolean);
        if (parts.length >= 5 && parts[2] === 'raw') {
            const [owner, repo, , ref, ...pathParts] = parts;
            parsed.hostname = 'media.githubusercontent.com';
            parsed.pathname = `/media/${owner}/${repo}/${ref}/${pathParts.join('/')}`;
            return parsed.href;
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

function parseNativeCxlParam(params, names, fallback) {
    for (const name of names) {
        const raw = params.get(name);
        if (!raw) {
            continue;
        }
        const value = String(raw).trim().toLowerCase();
        if (['0', 'false', 'off', 'no', 'fallback', 'virtio'].includes(value)) {
            return false;
        }
        if (['1', 'true', 'on', 'yes', 'native', 'cxl'].includes(value)) {
            return true;
        }
    }
    return fallback;
}

function parseQemuCpuParam(params) {
    const raw = params.get('qemu_cpu') || params.get('cpu_model') || '';
    const value = String(raw || '').trim();
    if (!value) return '';
    return /^[A-Za-z0-9_.+,-]+$/.test(value) ? value.slice(0, 128) : '';
}

function parseClientLabelParam(params) {
    const raw = params.get('host_id') || params.get('qemu_host') ||
        params.get('qemu_client') || params.get('client_id') || '';
    const value = String(raw || '').trim();
    if (!value) return '';
    return value.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 48);
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

function parseInitrdProfile(params) {
    const raw = params.get('initrd_profile')
        || params.get('initramfs_profile')
        || params.get('toolset')
        || params.get('tools')
        || (params.get('hpc') === '1' ? 'hpc' : '');
    const value = String(raw || '').trim().toLowerCase();
    if (['hpc', 'full', 'mpi', 'openmpi', 'gromacs', 'gmx', 'llama', 'tigon'].includes(value)) {
        return 'hpc';
    }
    return 'shell';
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
    const diskUrl = firstUrlParam(params, ['disk_url', 'qemu_img_url', 'qemu_img', 'img_url'])
        || (localDiskRequested && imageDir ? new URL('qemu.img', imageDir).href : '/about/qemu.img');
    const explicitInitrdText = params.get('initrd_url') || params.get('initramfs_url') || '';
    let initrdProfile = parseInitrdProfile(params);
    if (initrdProfile === 'shell' && /hpc|mpi|openmpi|gromacs|gmx|llama|tigon/i.test(explicitInitrdText)) {
        initrdProfile = 'hpc';
    }
    const initrdName = initrdProfile === 'hpc' ? 'initramfs-hpc-dax2.cpio.gz' : 'initramfs-shell.cpio';
    const initrdVersion = initrdProfile === 'hpc' ? '20260520-hpc-dax-virtio2' : '20260518-tools2';
    const hpcKernelVersion = '20260520-force-cxl-kernel1';
    const pcBiosVersion = '20260518-bios256-1';
    const efiE1000RomVersion = '20260518-e1000-1';
    const defaultHpcKernelUrl = /^asplos\.dev$/i.test(location.hostname)
        ? `https://raw.githubusercontent.com/vickiegpt/vickiegpt.github.io/main/cxl2/images/alpine-x86_64/bzImage-cxl-dax?v=${hpcKernelVersion}`
        : new URL(`/cxl2/images/alpine-x86_64/bzImage-cxl-dax?v=${hpcKernelVersion}`, location.href).href;
    const kernelUrl = firstUrlParam(params, ['kernel_url', 'bzimage_url', 'bzImage_url'])
        || (localImageRequested && imageDir
            ? new URL('bzImage', imageDir).href
            : (initrdProfile === 'hpc' ? defaultHpcKernelUrl : '/about/bzImage'));
    const defaultInitrdUrl = initrdProfile === 'hpc' && /^asplos\.dev$/i.test(location.hostname)
        ? `https://media.githubusercontent.com/media/vickiegpt/vickiegpt.github.io/main/cxl2/images/alpine-x86_64/${initrdName}?v=${initrdVersion}`
        : new URL(`/cxl2/images/alpine-x86_64/${initrdName}?v=${initrdVersion}`, location.href).href;
    const initrdUrl = firstUrlParam(params, ['initrd_url', 'initramfs_url'])
        || defaultInitrdUrl;
    const biosUrl = firstUrlParam(params, ['bios_url', 'microvm_bios_url'])
        || new URL('/cxl2/images/alpine-x86_64/bios-microvm.bin', location.href).href;
    const defaultPcBiosUrl = /^asplos\.dev$/i.test(location.hostname)
        ? `https://raw.githubusercontent.com/vickiegpt/vickiegpt.github.io/main/cxl2/images/alpine-x86_64/bios-256k.bin?v=${pcBiosVersion}`
        : new URL(`/cxl2/images/alpine-x86_64/bios-256k.bin?v=${pcBiosVersion}`, location.href).href;
    const pcBiosUrl = firstUrlParam(params, ['pc_bios_url', 'bios256_url', 'seabios_url'])
        || defaultPcBiosUrl;
    const defaultEfiE1000RomUrl = /^asplos\.dev$/i.test(location.hostname)
        ? `https://raw.githubusercontent.com/vickiegpt/vickiegpt.github.io/main/cxl2/images/alpine-x86_64/efi-e1000.rom?v=${efiE1000RomVersion}`
        : new URL(`/cxl2/images/alpine-x86_64/efi-e1000.rom?v=${efiE1000RomVersion}`, location.href).href;
    const efiE1000RomUrl = firstUrlParam(params, ['efi_e1000_rom_url', 'e1000_rom_url'])
        || defaultEfiE1000RomUrl;
    return {
        rom: '/pack-rom/',
        kernelUrl,
        diskUrl,
        initrdUrl,
        biosUrl,
        pcBiosUrl,
        efiE1000RomUrl,
        kernel: '/remote/bzImage',
        disk: '/remote/qemu.img',
        initrd: `/remote/${initrdName}`,
        initrdName,
        initrdProfile,
        bios: '/remote/bios-microvm.bin',
        pcBios: '/remote/bios-256k.bin',
        efiE1000Rom: '/remote/efi-e1000.rom',
        source: localDiskRequested && imageDir ? 'local' : 'remote',
        imageDir
    };
}

const CXL_WEB_CONFIG = (() => {
    const params = new URLSearchParams(location.search);
    const validProfiles = new Set(['all', 'type1', 'type2', 'type3']);
    const cxlParam = params.get('cxl') || '';
    const profile = validProfiles.has(cxlParam) ? cxlParam : 'type2';
    const cxlDisabled = cxlParam === 'off' || cxlParam === 'none' || params.get('no_cxl') === '1';
    const backend = params.get('hetgpu') || 'webgpu';
    const backendName = String(backend || '').trim().toLowerCase();
    const webgpuNative = ['webgpu', 'webgpu-native', 'native-webgpu'].includes(backendName);
    const cxlmemsim = parseCxlmemsimEndpoint(params);
    const nativeType1 = parseNativeCxlParam(params, ['native_type1', 'cxl_type1'], true);
    const nativeType2 = parseNativeCxlParam(params, ['native_type2', 'cxl_type2'], true);
    const directShellParam = params.get('fast_login') || params.get('direct_shell');
    const fullBootRequested = params.get('full_boot') === '1' || params.get('systemd') === '1';
    const fastLogin = fullBootRequested ? false
        : (directShellParam === null
            ? true
            : !['0', 'false', 'off', 'no'].includes(String(directShellParam).toLowerCase()));
    const rootDiskRequested = params.get('rootdisk') === '1'
        || params.get('root_disk') === '1'
        || params.get('disk_boot') === '1';
    const initrdParam = params.get('initrd') || params.get('initramfs');
    const useInitrd = fastLogin && !rootDiskRequested && (initrdParam === null
        ? true
        : !['0', 'false', 'off', 'no'].includes(String(initrdParam).toLowerCase()));
    const attachDisk = !useInitrd || rootDiskRequested || params.get('attach_disk') === '1';
    const fastShellMachine = String(params.get('fast_shell_machine') || params.get('shell_machine') || '').toLowerCase();
    const acpiEnabled = params.get('acpi') !== 'off';
    const requestedInitrdProfile = (() => {
        const explicitInitrdText = params.get('initrd_url') || params.get('initramfs_url') || '';
        let profileName = parseInitrdProfile(params);
        if (profileName === 'shell' && /hpc|mpi|openmpi|gromacs|gmx|llama|tigon/i.test(explicitInitrdText)) {
            profileName = 'hpc';
        }
        return profileName;
    })();
    const forceQ35ForCxl = acpiEnabled && !cxlDisabled
        && (requestedInitrdProfile === 'hpc' || cxlParam === 'all' || validProfiles.has(cxlParam));
    const fastShellMicrovm = fastLogin && useInitrd && !attachDisk
        && !forceQ35ForCxl
        && !['q35', 'pc'].includes(fastShellMachine);
    const autoShellProbe = params.get('auto_shell_probe') === '1';
    const fastBoot = params.get('fast_boot') !== '0';
    const qemuCxlEnabled = acpiEnabled && !cxlDisabled && !fastShellMicrovm;
    const coreParam = params.get('qemu_core') || params.get('core') || '';
    const qemuCoreNames = new Set(['fast', 'fpcast', 'build', 'safe', 'relfix', 'o3-clean']);
    const defaultQemuCore = 'fast';
    const qemuCore = qemuCoreNames.has(coreParam) ? coreParam : defaultQemuCore;
    const qemuCpu = parseQemuCpuParam(params);
    const netParam = String(params.get('net') || params.get('network') || '').toLowerCase();
    const qemuNetworkEnabled = ['1', 'on', 'true', 'yes', 'browser', 'c2w'].includes(netParam);
    const clientLabel = parseClientLabelParam(params);
    const clientToken = `${clientLabel || 'tab'}-${Math.random().toString(16).slice(2, 10)}`;
    const diskBus = params.get('disk_bus') === 'legacy' || params.get('disk_bus') === 'sata' ? 'legacy' : 'virtio';
    const tcgThread = params.get('tcg_thread') === 'single' ? 'single' : 'multi';
    const tbSize = parseIntegerParam(params, ['qemu_tb_size', 'tb_size', 'tcg_tb_size'], 500, 32, 1024);
    const memoryBytes = parseByteSizeParam(
        params,
        ['qemu_mem', 'qemu_memory', 'guest_mem', 'guest_memory', 'memory', 'mem'],
        0,
        256 * 1024 * 1024,
        2048 * 1024 * 1024
    );
    const type2MemBytes = parseByteSizeParam(
        params,
        ['cxl_type2_mem', 'type2_mem', 'cxl_mem', 'hetgpu_mem'],
        0,
        16 * 1024 * 1024,
        256 * 1024 * 1024
    );
    const type2CacheBytes = parseByteSizeParam(
        params,
        ['cxl_type2_cache', 'type2_cache', 'cxl_cache', 'hetgpu_cache'],
        0,
        8 * 1024 * 1024,
        128 * 1024 * 1024
    );
    const cxlRootPortReserve = params.get('cxl_rp_reserve') !== '0';
    const hpet = params.get('hpet') === 'on' ? 'on' : 'off';
    const kernelIrqchipParam = String(params.get('kernel_irqchip') || params.get('kernel-irqchip') || '').toLowerCase();
    const kernelIrqchip = ['off', 'on', 'split'].includes(kernelIrqchipParam) ? kernelIrqchipParam : '';
    const fwCfgDma = params.get('fw_cfg_dma') === 'on' || params.get('fwcfg_dma') === 'on';
    const nodefaults = params.get('nodefaults') === '1' && params.get('defaults') !== '1';
    const rtcParam = String(params.get('rtc') || '').toLowerCase();
    const rtc = rtcParam === 'off' ? 'off' : (rtcParam === 'vm' ? 'vm' : 'host');
    const unsafeGuestMemory = params.get('unsafe_mem') === '1' || params.get('allow_oom_mem') === '1';
    const daxFallbackParam = String(
        params.get('dax_fallback') || params.get('virtio_pmem') || params.get('pmem_dax') || ''
    ).toLowerCase();
    const daxFallbackDisabled = ['0', 'false', 'off', 'no', 'none'].includes(daxFallbackParam);
    const daxFallbackRequested = ['1', 'true', 'on', 'yes', 'virtio', 'pmem', 'devdax'].includes(daxFallbackParam);
    const daxFallbackEnabled = !daxFallbackDisabled
        && (daxFallbackRequested || (requestedInitrdProfile === 'hpc' && (profile === 'type3' || profile === 'all')));
    const daxFallbackMode = daxFallbackEnabled
        ? (!daxFallbackParam || ['1', 'true', 'on', 'yes', 'virtio', 'virtio-pmem', 'virtio_pmem'].includes(daxFallbackParam) || params.get('virtio_pmem') === '1'
            ? 'virtio-pmem'
            : 'e820-pmem')
        : 'off';
    const extraKernelArgs = parseExtraKernelArgs(params);
    const image = parseImageConfig(params);
    const kernelExplicit = ['kernel_url', 'bzimage_url', 'bzImage_url'].some((name) => params.get(name));
    if (qemuCxlEnabled && !kernelExplicit) {
        image.kernelUrl = /^asplos\.dev$/i.test(location.hostname)
            ? 'https://raw.githubusercontent.com/vickiegpt/vickiegpt.github.io/main/cxl2/images/alpine-x86_64/bzImage-cxl-dax?v=20260520-force-cxl-kernel1'
            : new URL('/cxl2/images/alpine-x86_64/bzImage-cxl-dax?v=20260520-force-cxl-kernel1', location.href).href;
    }
    if (fastShellMicrovm && !kernelExplicit) {
        image.kernelUrl = new URL('/cxl2/images/hetgpu-webgpu/load-kernel.data', location.href).href;
    }
    const qemuCxlmemsimTransport = cxlmemsim.transport === 'browser' ? 'shm' : cxlmemsim.transport;
    const debug = params.get('debug') === '1' || params.get('cxl_debug') === '1' || params.get('verbose') === '1';
    const simpleBoot = params.get('simple_boot') === '1' && !qemuCxlEnabled;
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
        useInitrd,
        attachDisk,
        fastShellMicrovm,
        autoShellProbe,
        fastBoot,
        acpiEnabled,
        qemuCxlEnabled,
        debug,
        simpleBoot,
        startTimeoutSec,
        qemuCore,
        qemuCpu,
        qemuNetworkEnabled,
        clientLabel,
        clientToken,
        diskBus,
        hpet,
        kernelIrqchip,
        fwCfgDma,
        nodefaults,
        rtc,
        unsafeGuestMemory,
        daxFallbackEnabled,
        daxFallbackMode,
        cxlRootPortReserve,
        extraKernelArgs,
        tcg: {
            thread: tcgThread,
            tbSize
        },
        memoryBytes,
        type2MemBytes,
        type2CacheBytes,
        assetVersion: ({
            fast: '20260518-worker-import2',
            fpcast: '20260512-numfix',
            build: '20260516-build',
            safe: '20260512-safe',
            relfix: '20260512-relfix',
            'o3-clean': '20260512-o3-clean'
        })[qemuCore] || '20260518-worker-import2',
        assetBase: ({
            fast: '/cxl2/images/alpine-x86_64/',
            fpcast: '/cxl2/images/alpine-x86_64-fpcast/',
            build: '/cxl2/images/alpine-x86_64-build/',
            safe: '/cxl2/images/alpine-x86_64-safe/',
            relfix: '/cxl2/images/alpine-x86_64-relfix/',
            'o3-clean': '/cxl2/images/alpine-x86_64-o3-clean/'
        })[qemuCore] || '/cxl2/images/alpine-x86_64/',
        image,
        network: {
            mode: qemuNetworkEnabled ? 'browser' : 'disabled',
            websocketUrl: 'http://localhost:9999/',
            stackWorker: '/cxl2/images/alpine-x86_64/dist/stack-worker.js',
            stackImage: '/cxl2/images/alpine-x86_64/c2w-net-proxy.wasm.gzip',
            proxyUrl: 'http://192.168.127.253:80'
        },
        cxlmemsim: {
            transport: cxlmemsim.transport,
            qemuTransport: qemuCxlmemsimTransport,
            host: cxlmemsim.host,
            port: cxlmemsim.port,
            pool: cxlmemsim.pool,
            size: cxlmemsimSize,
            workerUrl: '/cxl2/cxlmemsim-pool-worker.js?v=20260518-multihost1',
            workerName: 'hetgpu-cxlmemsim-20260518-multihost1'
        },
        webgpuNative
    };
})();

window.CXL_WEB_CONFIG = CXL_WEB_CONFIG;
Module['ENV'] = {
    ...(Module['ENV'] || {}),
    CXL_MEMSIM_HOST: CXL_WEB_CONFIG.cxlmemsim.host,
    CXL_MEMSIM_PORT: String(CXL_WEB_CONFIG.cxlmemsim.port),
    CXL_MEMSIM_POOL: CXL_WEB_CONFIG.cxlmemsim.pool,
    CXL_MEMSIM_SIZE: String(CXL_WEB_CONFIG.cxlmemsim.size),
    CXL_MEMSIM_TRANSPORT: CXL_WEB_CONFIG.cxlmemsim.qemuTransport,
    CXL_TRANSPORT_MODE: CXL_WEB_CONFIG.cxlmemsim.qemuTransport,
    HETGPU_BACKEND: CXL_WEB_CONFIG.backend,
    HETGPU_WEBGPU_NATIVE: CXL_WEB_CONFIG.webgpuNative ? '1' : '0'
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
    const eager = options.eager === true;
    const allowFullFallback = options.allowFullFallback === true;
    const maxFullFallbackSize = options.maxFullFallbackSize || 64 * 1024 * 1024;
    const validateMagic = options.validateMagic === true;
    const dropCacheAfterMmap = options.dropCacheAfterMmap === true;
    let fullFile = null;

    if (options.githubLfsMedia === true) {
        url = githubLfsMediaUrl(url) || url;
    }

    function request(method, requestUrl, start, end) {
        const xhr = new XMLHttpRequest();
        xhr.open(method, requestUrl, false);
        if (method !== 'HEAD' && xhr.overrideMimeType) {
            xhr.overrideMimeType('text/plain; charset=x-user-defined');
        }
        if (start !== undefined) {
            xhr.setRequestHeader('Range', `bytes=${start}-${end}`);
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

    function exposedResponseHeader(xhr, name) {
        const target = String(name).toLowerCase();
        const headers = xhr.getAllResponseHeaders ? xhr.getAllResponseHeaders() : '';
        for (const line of headers.split(/\r?\n/)) {
            const separator = line.indexOf(':');
            if (separator < 0) continue;
            if (line.slice(0, separator).trim().toLowerCase() === target) {
                return line.slice(separator + 1).trim();
            }
        }
        return '';
    }

    const head = request('HEAD', url);
    const size = Number(head.getResponseHeader('Content-Length'));
    const acceptRangesHeader = exposedResponseHeader(head, 'Accept-Ranges');
    const acceptsRanges = acceptRangesHeader ? /bytes/i.test(acceptRangesHeader) : true;
    if (!Number.isFinite(size) || size <= 0) {
        throw new Error(`${url} did not return a usable Content-Length`);
    }
    if (!acceptsRanges && (!allowFullFallback || size > maxFullFallbackSize)) {
        throw new Error(`${url} must be served with Accept-Ranges: bytes and HTTP 206 byte-range responses`);
    }
    if (eager) {
        let bytes = responseBytes(request('GET', url));
        let sample = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, Math.min(bytes.length, 128)));
        if (/^version https:\/\/git-lfs\.github\.com\/spec/i.test(sample)) {
            const mediaUrl = githubLfsMediaUrl(url);
            if (mediaUrl && mediaUrl !== url) {
                bytes = responseBytes(request('GET', mediaUrl));
                sample = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, Math.min(bytes.length, 128)));
            }
            if (/^version https:\/\/git-lfs\.github\.com\/spec/i.test(sample)) {
                throw new Error(`${url} returned a Git LFS pointer instead of ${name}; serve the real LFS object or use the local server`);
            }
        }
        if (/\.gz$/i.test(name) && !(bytes[0] === 0x1f && bytes[1] === 0x8b)) {
            throw new Error(`${url} is not a gzip initramfs`);
        }
        if (/\.cpio$/i.test(name) && !/^07070[12]/.test(sample)) {
            throw new Error(`${url} is not a newc cpio initramfs`);
        }
        FS.writeFile(`${parent}/${name}`, bytes, { canOwn: true });
        return;
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

    if (validateMagic) {
        const bytes = getChunk(0);
        const sample = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, Math.min(bytes.length, 128)));
        if (/^version https:\/\/git-lfs\.github\.com\/spec/i.test(sample)) {
            throw new Error(`${url} returned a Git LFS pointer instead of ${name}; serve the real LFS object or use the local server`);
        }
        if (/\.gz$/i.test(name) && !(bytes[0] === 0x1f && bytes[1] === 0x8b)) {
            throw new Error(`${url} is not a gzip initramfs`);
        }
        if (/\.cpio$/i.test(name) && !/^07070[12]/.test(sample)) {
            throw new Error(`${url} is not a newc cpio initramfs`);
        }
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
        mmap(stream, length, position) {
            const malloc = mod['___libc_malloc'] || mod['_emscripten_builtin_malloc'] || mod['_malloc'];
            const heap = mod.HEAPU8;
            if (typeof malloc !== 'function' || !heap) {
                throw new FS.ErrnoError(48);
            }
            const ptr = malloc(length);
            if (!ptr) {
                throw new FS.ErrnoError(48);
            }
            const available = Math.min(length, Math.max(0, size - position));
            let copied = 0;
            while (copied < available) {
                const absolute = position + copied;
                const chunkIndex = Math.floor(absolute / chunkSize);
                const chunkOffset = absolute % chunkSize;
                const chunk = getChunk(chunkIndex);
                const part = Math.min(available - copied, chunk.length - chunkOffset);
                heap.set(chunk.subarray(chunkOffset, chunkOffset + part), ptr + copied);
                copied += part;
            }
            if (copied < length) {
                heap.fill(0, ptr + copied, ptr + length);
            }
            if (dropCacheAfterMmap) {
                chunks.clear();
            }
            return {
                ptr,
                allocated: true
            };
        },
        msync() {
            throw new FS.ErrnoError(43);
        }
    };
}
window.CXL_createRangeBackedFile = createRangeBackedFile;

Module['preRun'] = Module['preRun'] || [];
Module['preRun'].push((mod) => {
    mod.FS.mkdir('/remote');
    createRangeBackedFile(mod, '/remote', 'bzImage', CXL_WEB_CONFIG.image.kernelUrl, { allowFullFallback: true });
    if (CXL_WEB_CONFIG.attachDisk) {
        createRangeBackedFile(mod, '/remote', 'qemu.img', CXL_WEB_CONFIG.image.diskUrl, {
            writable: true,
            chunkSize: 4 * 1024 * 1024,
            maxChunks: 4
        });
    }
    if (CXL_WEB_CONFIG.fastLogin && CXL_WEB_CONFIG.useInitrd) {
        const hpcInitrd = CXL_WEB_CONFIG.image.initrdProfile === 'hpc';
        createRangeBackedFile(mod, '/remote', CXL_WEB_CONFIG.image.initrdName || 'initramfs-shell.cpio', CXL_WEB_CONFIG.image.initrdUrl, {
            eager: !hpcInitrd,
            githubLfsMedia: hpcInitrd,
            validateMagic: hpcInitrd,
            chunkSize: hpcInitrd ? 8 * 1024 * 1024 : 4 * 1024 * 1024,
            maxChunks: hpcInitrd ? 1 : 64,
            dropCacheAfterMmap: hpcInitrd,
            allowFullFallback: true,
            maxFullFallbackSize: CXL_WEB_CONFIG.image.initrdProfile === 'hpc'
                ? 512 * 1024 * 1024
                : 16 * 1024 * 1024
        });
    }
    const biosIndex = (CXL_WEB_CONFIG.arguments || []).indexOf('-bios');
    if (biosIndex >= 0) {
        const biosPath = (CXL_WEB_CONFIG.arguments || [])[biosIndex + 1] || '';
        if (/bios-256k\.bin$/.test(biosPath)) {
            createRangeBackedFile(mod, '/remote', 'bios-256k.bin', CXL_WEB_CONFIG.image.pcBiosUrl, {
                allowFullFallback: true,
                maxFullFallbackSize: 1024 * 1024
            });
        } else {
            createRangeBackedFile(mod, '/remote', 'bios-microvm.bin', CXL_WEB_CONFIG.image.biosUrl, {
                allowFullFallback: true,
                maxFullFallbackSize: 1024 * 1024
            });
        }
    }
    if (CXL_WEB_CONFIG.image && CXL_WEB_CONFIG.image.efiE1000RomUrl) {
        const aliasDirs = ['/remote', '/pack-rom', '/', '/qemu/pc-bios', '/usr/local/share/qemu', '/usr/share/qemu'];
        const mkdirp = (path) => {
            if (!path || path === '/') return;
            const parts = path.split('/').filter(Boolean);
            let current = '';
            for (const part of parts) {
                current += `/${part}`;
                if (!mod.FS.analyzePath(current).exists) {
                    mod.FS.mkdir(current);
                }
            }
        };
        for (const dir of aliasDirs) {
            mkdirp(dir);
            const target = `${dir === '/' ? '' : dir}/efi-e1000.rom`;
            if (!mod.FS.analyzePath(target).exists) {
                createRangeBackedFile(mod, dir, 'efi-e1000.rom', CXL_WEB_CONFIG.image.efiE1000RomUrl, {
                    allowFullFallback: true,
                    maxFullFallbackSize: 1024 * 1024
                });
            }
        }
    }
});

function profileHas(name) {
    return CXL_WEB_CONFIG.profile === 'all' || CXL_WEB_CONFIG.profile === name;
}

function buildQemuArguments() {
    const type1Enabled = CXL_WEB_CONFIG.qemuCxlEnabled && profileHas('type1') && CXL_WEB_CONFIG.nativeType1;
    const type2Enabled = CXL_WEB_CONFIG.qemuCxlEnabled && profileHas('type2') && CXL_WEB_CONFIG.nativeType2;
    const type3Enabled = CXL_WEB_CONFIG.qemuCxlEnabled && profileHas('type3');
    const virtioDisk = CXL_WEB_CONFIG.attachDisk && CXL_WEB_CONFIG.diskBus !== 'legacy';
    const legacyDisk = CXL_WEB_CONFIG.attachDisk && CXL_WEB_CONFIG.diskBus === 'legacy';
    const rootDevice = virtioDisk ? '/dev/vda' : '/dev/sda';
    const hpcInitrd = CXL_WEB_CONFIG.image?.initrdProfile === 'hpc';
    const needsMemorySlots = type3Enabled || CXL_WEB_CONFIG.daxFallbackMode === 'virtio-pmem';
    const safeHpcAttachBytes = 768 * 1024 * 1024;
    const safeHpcBytes = 768 * 1024 * 1024;
    const defaultMemoryBytes = hpcInitrd
        ? (CXL_WEB_CONFIG.attachDisk ? safeHpcAttachBytes : safeHpcBytes)
        : 768 * 1024 * 1024;
    const requestedMemoryBytes = CXL_WEB_CONFIG.memoryBytes || defaultMemoryBytes;
    const safeMemoryBytes = hpcInitrd
        ? (CXL_WEB_CONFIG.attachDisk ? safeHpcAttachBytes : safeHpcBytes)
        : requestedMemoryBytes;
    const memoryBytes = CXL_WEB_CONFIG.unsafeGuestMemory
        ? requestedMemoryBytes
        : Math.min(requestedMemoryBytes, safeMemoryBytes);
    const memoryMb = Math.ceil(memoryBytes / (1024 * 1024));
    const maxMemoryMb = Math.max(memoryMb + 512, hpcInitrd ? 2048 : 1536);
    const memoryArg = needsMemorySlots
        ? `${memoryMb}M,maxmem=${maxMemoryMb}M,slots=4`
        : `${memoryMb}M`;
    const defaultType2MemBytes = hpcInitrd && !CXL_WEB_CONFIG.unsafeGuestMemory
        ? 32 * 1024 * 1024
        : 256 * 1024 * 1024;
    const defaultType2CacheBytes = hpcInitrd && !CXL_WEB_CONFIG.unsafeGuestMemory
        ? 8 * 1024 * 1024
        : 64 * 1024 * 1024;
    const type2MemMb = Math.ceil((CXL_WEB_CONFIG.type2MemBytes || defaultType2MemBytes) / (1024 * 1024));
    const type2CacheMb = Math.ceil((CXL_WEB_CONFIG.type2CacheBytes || defaultType2CacheBytes) / (1024 * 1024));
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
        'loglevel=4'
    ];
    const rootAppend = [
        `root=${rootDevice}`,
        'rootfstype=ext4',
        'rootwait',
        'rw'
    ];
    const commonAppend = [
        'console=ttyS0,115200',
        'nokaslr',
        'kaslr=off',
        'earlycon=uart8250,io,0x3f8,115200n8',
        'earlyprintk=serial,ttyS0,115200',
        'devtmpfs.mount=1',
        ...CXL_WEB_CONFIG.extraKernelArgs
    ];
    const baseAppend = [
        ...rootAppend,
        ...commonAppend
    ];
    const runtimeAppend = [
        `qemu.acpi=${CXL_WEB_CONFIG.acpiEnabled ? 'on' : 'off'}`,
        `qemu.cxl=${CXL_WEB_CONFIG.qemuCxlEnabled ? 'on' : 'off'}`,
        `cxl.profile=${CXL_WEB_CONFIG.profile}`,
        type1Enabled ? 'cxl.type1=on' : 'cxl.type1=off',
        type2Enabled ? 'cxl.type2=on' : 'cxl.type2=off',
        type3Enabled ? 'cxl.type3=on' : 'cxl.type3=off',
        `hetgpu.backend=${CXL_WEB_CONFIG.backend}`,
        'hetgpu.device=hetgpu0',
        `cxlmemsim.transport=${CXL_WEB_CONFIG.cxlmemsim.transport}`,
        `cxlmemsim.qemu_transport=${CXL_WEB_CONFIG.cxlmemsim.qemuTransport}`,
        `cxlmemsim.host=${CXL_WEB_CONFIG.cxlmemsim.host}`,
        `cxlmemsim.port=${CXL_WEB_CONFIG.cxlmemsim.port}`,
        `cxlmemsim.pool=${CXL_WEB_CONFIG.cxlmemsim.pool}`,
        `dax_fallback=${CXL_WEB_CONFIG.daxFallbackMode}`,
        `cxl.setup_timeout_sec=${CXL_WEB_CONFIG.startTimeoutSec}`,
        `cxlmem.setup_timeout_sec=${CXL_WEB_CONFIG.startTimeoutSec}`
    ];
    const q35TimerAppend = [
        'notsc',
        'lpj=1000000',
        'nolapic_timer',
        'no_timer_check',
        'nohz=off',
        'highres=off',
        'nowatchdog',
        'nmi_watchdog=0',
        'nosoftlockup'
    ];
    const q35InitcallBlacklist = [
        ...(legacyDisk ? [] : ['ahci_pci_driver_init'])
    ];
    const q35FastShellAppend = [
        ...q35TimerAppend,
        ...(CXL_WEB_CONFIG.daxFallbackMode === 'e820-pmem' ? ['memmap=64M!512M'] : []),
        ...(CXL_WEB_CONFIG.qemuCpu ? ['genl_relax_init=1'] : []),
        ...(q35InitcallBlacklist.length ? [`initcall_blacklist=${q35InitcallBlacklist.join(',')}`] : [])
    ];
    const directShellAppend = [
        ...(CXL_WEB_CONFIG.useInitrd ? commonAppend : baseAppend),
        ...(!CXL_WEB_CONFIG.fastShellMicrovm ? q35FastShellAppend : []),
        CXL_WEB_CONFIG.useInitrd ? 'rdinit=/init' : 'init=/bin/sh',
        ...(CXL_WEB_CONFIG.useInitrd ? ['rootfstype=ramfs'] : []),
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
        'systemd.wants=serial-getty@ttyS0.service',
        ...runtimeAppend,
        ...fastBootMasks,
        ...(CXL_WEB_CONFIG.debug ? cxlDebug : [])
    ];
    const append = (CXL_WEB_CONFIG.fastLogin ? directShellAppend : systemdAppend).join(' ');
    const accel = `tcg,tb-size=${CXL_WEB_CONFIG.tcg.tbSize},thread=${CXL_WEB_CONFIG.tcg.thread}`;
    // WASM microvm lacks a reliable early timer reference for TSC calibration.
    const microvmTimerAppend = [
        'notsc',
        'lpj=1000000',
        'nolapic_timer'
    ];
    if (CXL_WEB_CONFIG.fastShellMicrovm) {
        const microvmShellAppend = [
            'console=ttyS0,115200',
            'rdinit=/init',
            'devtmpfs.mount=1',
            'nokaslr',
            'loglevel=8',
            'earlyprintk=serial,ttyS0,115200',
            ...microvmTimerAppend,
            ...CXL_WEB_CONFIG.extraKernelArgs
        ].join(' ');
        return [
            '-display', 'none',
            '-nodefaults',
            '-M', 'microvm,pic=on,pit=on,rtc=on',
            '-m', '512M',
            '-accel', accel,
            '-rtc', 'base=utc,clock=vm',
            '-L', CXL_WEB_CONFIG.image.rom,
            '-bios', CXL_WEB_CONFIG.image.bios,
            '-serial', 'mon:stdio',
            '-kernel', CXL_WEB_CONFIG.image.kernel,
            '-initrd', CXL_WEB_CONFIG.image.initrd,
            '-append', microvmShellAppend
        ];
    }
    if (CXL_WEB_CONFIG.simpleBoot) {
        const simpleMinimal = new URLSearchParams(location.search).get('simple_minimal') === '1';
        const simpleNodefaults = new URLSearchParams(location.search).get('simple_nodefaults') === '1';
        const simpleMachineParam = new URLSearchParams(location.search).get('simple_machine') || '';
        const simpleMachine = simpleMachineParam === 'microvm' ? 'microvm'
            : (simpleMachineParam === 'pc' ? 'pc' : 'q35');
        const simpleMachineArg = simpleMachine === 'microvm' ? 'microvm,pic=on,pit=on,rtc=on'
            : (simpleMachine === 'pc' ? 'pc,hpet=on' : 'q35,hpet=on');
        const simpleAppend = simpleMinimal ? [
            'console=ttyS0,115200',
            'rdinit=/init',
            'devtmpfs.mount=1',
            'nokaslr',
            'kaslr=off',
            'loglevel=8',
            'earlyprintk=serial,ttyS0,115200',
            ...(simpleMachine === 'microvm' ? microvmTimerAppend : q35TimerAppend),
            ...CXL_WEB_CONFIG.extraKernelArgs
        ] : [
            'console=ttyS0,115200',
            'rdinit=/init',
            'devtmpfs.mount=1',
            ...q35TimerAppend,
            'clk_ignore_unused',
            'pd_ignore_unused',
            'nokaslr',
            'kaslr=off',
            'loglevel=8',
            'earlyprintk=serial,ttyS0,115200',
            ...CXL_WEB_CONFIG.extraKernelArgs
        ];
        if (simpleNodefaults) {
            return [
                '-display', 'none',
                '-nodefaults',
                '-M', simpleMachineArg,
                '-m', '512M',
                '-accel', accel,
                '-rtc', 'base=utc,clock=vm',
                '-L', CXL_WEB_CONFIG.image.rom,
                '-bios', simpleMachine === 'microvm' ? CXL_WEB_CONFIG.image.bios : CXL_WEB_CONFIG.image.pcBios,
                '-serial', 'stdio',
                '-monitor', 'none',
                '-kernel', CXL_WEB_CONFIG.image.kernel,
                '-initrd', CXL_WEB_CONFIG.image.initrd,
                '-append', simpleAppend.join(' ')
            ];
        }
        return [
            '-nographic',
            '-M', simpleMachineArg,
            '-m', '512M',
            '-accel', accel,
            '-rtc', 'base=utc,clock=vm',
            '-L', CXL_WEB_CONFIG.image.rom,
            '-bios', simpleMachine === 'microvm' ? CXL_WEB_CONFIG.image.bios : CXL_WEB_CONFIG.image.pcBios,
            '-nic', 'none',
            '-kernel', CXL_WEB_CONFIG.image.kernel,
            '-initrd', CXL_WEB_CONFIG.image.initrd,
            '-append', simpleAppend.join(' ')
        ];
    }
    const machineOptions = [
        'q35',
        ...(CXL_WEB_CONFIG.qemuCxlEnabled ? ['cxl=on'] : []),
        ...(!CXL_WEB_CONFIG.acpiEnabled && !CXL_WEB_CONFIG.qemuCxlEnabled ? ['acpi=off'] : []),
        `hpet=${CXL_WEB_CONFIG.hpet}`,
        ...(CXL_WEB_CONFIG.kernelIrqchip ? [`kernel-irqchip=${CXL_WEB_CONFIG.kernelIrqchip}`] : [])
    ];
    const machine = machineOptions.join(',');

    const args = [
        '-nographic',
        '-no-user-config',
        '-M', machine,
        '-m', memoryArg,
        '-smp', '1,sockets=1',
        '-accel', accel,
        '-boot', 'menu=off',
        '-L', CXL_WEB_CONFIG.image.rom,
        '-bios', CXL_WEB_CONFIG.image.pcBios,
        '-kernel', CXL_WEB_CONFIG.image.kernel,
        '-append', append,
        '-device', 'virtio-rng-pci'
    ];
    if (CXL_WEB_CONFIG.qemuNetworkEnabled) {
        args.push(
            '-netdev', 'socket,id=vmnic,connect=127.0.0.1:8888',
            '-device', 'virtio-net-pci,netdev=vmnic,mac=52:54:00:00:10:22,romfile='
        );
    } else {
        args.push('-nic', 'none');
    }
    if (CXL_WEB_CONFIG.qemuCpu) {
        const accelIndex = args.indexOf('-accel');
        args.splice(accelIndex, 0, '-cpu', CXL_WEB_CONFIG.qemuCpu);
    }
    if (CXL_WEB_CONFIG.fastLogin && CXL_WEB_CONFIG.useInitrd) {
        const appendIndex = args.indexOf('-append');
        args.splice(appendIndex, 0, '-initrd', CXL_WEB_CONFIG.image.initrd);
    }
    if (CXL_WEB_CONFIG.rtc !== 'off') {
        const rtcIndex = args.indexOf('-L');
        args.splice(rtcIndex, 0, '-rtc', `base=utc,clock=${CXL_WEB_CONFIG.rtc}`);
    }
    if (CXL_WEB_CONFIG.nodefaults) {
        args.unshift('-nodefaults');
    }
    if (!CXL_WEB_CONFIG.fwCfgDma) {
        const machineIndex = args.indexOf('-M');
        args.splice(machineIndex, 0, '-global', 'fw_cfg_io.dma_enabled=off');
    }

    if (virtioDisk) {
        args.push(
            '-drive', `file=${CXL_WEB_CONFIG.image.disk},if=none,id=rootfs,format=raw,cache=unsafe`,
            '-device', 'virtio-blk-pci,drive=rootfs,bootindex=1'
        );
    } else if (legacyDisk) {
        args.push(
            '-drive', `file=${CXL_WEB_CONFIG.image.disk},index=0,media=disk,format=raw,cache=unsafe`
        );
    }

    if (CXL_WEB_CONFIG.qemuCxlEnabled) {
        args.push('-device', 'pxb-cxl,bus_nr=12,bus=pcie.0,id=cxl.1');
    }

    if (type1Enabled) {
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
        if (type2Enabled) {
            args.push(
                '-device', 'cxl-rp,port=1,bus=cxl.1,id=root_port14,chassis=0,slot=1',
                '-device', [
                    'cxl-type2',
                    'bus=root_port14',
                    `cache-size=${type2CacheMb}M`,
                    `mem-size=${type2MemMb}M`,
                    'sn=0x2',
                    `cxlmemsim-addr=${CXL_WEB_CONFIG.cxlmemsim.host}`,
                    `cxlmemsim-port=${CXL_WEB_CONFIG.cxlmemsim.port}`,
                    'coherency-enabled=true',
                    'gpu-mode=2',
                    /* QEMU hetgpu-backend is UINT32 enum (cxl_hetgpu.h):
                     *   0=AUTO 1=INTEL 2=AMD 3=NVIDIA 4=TENSTORRENT 5=SIMULATION
                     * The browser native WebGPU service is exposed through JS; this
                     * pre-bridge wasm still uses the QEMU SIMULATION enum. */
                    `hetgpu-backend=${({intel:1,amd:2,nvidia:3,tenstorrent:4,simulation:5,webgpu:5,'webgpu-native':5,'native-webgpu':5,sim:5,auto:0})[String(CXL_WEB_CONFIG.backend).toLowerCase()] ?? 5}`,
                    'hetgpu-device=0',
                    'id=cxl-type2-hetgpu0'
                ].join(',')
            );
        } else if (CXL_WEB_CONFIG.qemuCxlEnabled) {
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

    if (CXL_WEB_CONFIG.daxFallbackMode === 'virtio-pmem') {
        args.push(
            '-object', 'memory-backend-ram,id=daxpmem0,share=on,size=64M',
            '-device', 'virtio-pmem-pci,bus=pcie.0,memdev=daxpmem0,id=dax-pmem0'
        );
    }

    if (CXL_WEB_CONFIG.daxFallbackMode === 'virtio-pmem') {
        for (const option of ['-kernel', '-initrd', '-append']) {
            const index = args.indexOf(option);
            if (index >= 0) {
                const pair = args.splice(index, 2);
                args.push(...pair);
            }
        }
    }

    return args;
}

Module['arguments'] = buildQemuArguments();
window.CXL_WEB_CONFIG.arguments = Module['arguments'];
window.CXL_WEB_CONFIG.command = Module['arguments'].map((arg) => {
    return /\s/.test(arg) ? JSON.stringify(arg) : arg;
}).join(' ');

function registerCxlMemsimClients() {
    if (!window.crossOriginIsolated || typeof SharedWorker === 'undefined') {
        return [];
    }
    if (!CXL_WEB_CONFIG.qemuCxlEnabled || CXL_WEB_CONFIG.cxlmemsim.transport !== 'browser') {
        return [];
    }

    const ports = [];
    const workerUrl = new URL(CXL_WEB_CONFIG.cxlmemsim.workerUrl, location.href).href;
    const deviceArgs = Module['arguments'].filter((arg) =>
        /(^|,)cxl-type[12](,|$)/.test(arg) && /(^|,)cxlmemsim-addr=/.test(arg)
    );

    for (const arg of deviceArgs) {
        const type = (arg.match(/(^|,)(cxl-type[12])(?=,|$)/) || [])[2] || 'cxl-device';
        const id = (arg.match(/(^|,)id=([^,]+)/) || [])[2] || `${type}-${ports.length}`;
        const worker = new SharedWorker(workerUrl, CXL_WEB_CONFIG.cxlmemsim.workerName);
        const port = worker.port;
        const host = CXL_WEB_CONFIG.clientLabel || CXL_WEB_CONFIG.clientToken;
        const clientId = `qemu-${id}-${CXL_WEB_CONFIG.clientToken}-${ports.length}`;

        port.start();
        port.postMessage({
            type: 'connect',
            role: 'qemu',
            clientId,
            device: `${id}@${host}`,
            pool: CXL_WEB_CONFIG.cxlmemsim.pool,
            size: CXL_WEB_CONFIG.cxlmemsim.size
        });
        ports.push({ port, clientId, workerUrl });
    }

    window.addEventListener('pagehide', () => {
        for (const entry of ports) {
            entry.port.postMessage({
                type: 'disconnect',
                clientId: entry.clientId,
                pool: CXL_WEB_CONFIG.cxlmemsim.pool
            });
        }
    }, { once: true });

    return ports;
}

window.CXL_WEB_CONFIG.cxlmemsimClients = registerCxlMemsimClients();
Module['locateFile'] = function(path, prefix) {
    if (path === 'load-rom.data' || path.startsWith('load-rom.data?')) {
        return new URL(path, new URL('/cxl2/images/alpine-x86_64/', location.href)).href;
    }
    if (path === 'qemu-system-x86_64.wasm' && new URLSearchParams(location.search).get('build_wasm') === '1') {
        const url = new URL('qemu-system-x86_64.build.wasm', new URL(CXL_WEB_CONFIG.assetBase, location.href));
        url.searchParams.set('v', CXL_WEB_CONFIG.assetVersion);
        return url.href;
    }
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
