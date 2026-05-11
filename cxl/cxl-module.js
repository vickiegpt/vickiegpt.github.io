if (typeof Module === 'undefined') {
    Module = {};
}

const HETGPU_ASSET_BASE = '/cxl/images/hetgpu-webgpu/';
const HETGPU_IMAGE_PATHS = {
    rom: '/pack-rom/',
    kernel: '/pack-kernel/vmlinuz-virt',
    initramfs: '/pack-initramfs/initramfs-virt',
    disk: '/pack-rootfs/disk-rootfs.img'
};

const CXL_WEB_CONFIG = (() => {
    const params = new URLSearchParams(location.search);
    const validProfiles = new Set(['all', 'type1', 'type2', 'type3']);
    const profile = validProfiles.has(params.get('cxl')) ? params.get('cxl') : 'all';
    const backend = params.get('hetgpu') || 'webgpu';
    return { profile, backend, assetBase: HETGPU_ASSET_BASE, image: HETGPU_IMAGE_PATHS };
})();

window.CXL_WEB_CONFIG = CXL_WEB_CONFIG;

function profileHas(name) {
    return CXL_WEB_CONFIG.profile === 'all' || CXL_WEB_CONFIG.profile === name;
}

function buildQemuArguments() {
    const type3Enabled = profileHas('type3');
    const append = [
        'console=ttyS0',
        'root=/dev/vda',
        'rw',
        'rootwait',
        'hostname=cxl-web',
        'pci=realloc',
        `cxl.profile=${CXL_WEB_CONFIG.profile}`,
        profileHas('type1') ? 'cxl.type1=on' : 'cxl.type1=off',
        profileHas('type2') ? 'cxl.type2=on' : 'cxl.type2=off',
        profileHas('type3') ? 'cxl.type3=on' : 'cxl.type3=off',
        `hetgpu.backend=${CXL_WEB_CONFIG.backend}`,
        'hetgpu.device=hetgpu0'
    ].join(' ');

    const args = [
        '-nographic',
        '-M', 'q35,cxl=on',
        '-m', type3Enabled ? '512M,maxmem=1536M,slots=4' : '512M',
        '-accel', 'tcg,tb-size=500',
        '-L', CXL_WEB_CONFIG.image.rom,
        '-nic', 'none',
        '-kernel', CXL_WEB_CONFIG.image.kernel,
        '-initrd', CXL_WEB_CONFIG.image.initramfs,
        '-append', append,
        '-drive', `id=test,file=${CXL_WEB_CONFIG.image.disk},format=raw,if=none,readonly=on`,
        '-device', 'virtio-blk-pci,drive=test'
    ];

    if (profileHas('type1')) {
        args.push('-device', 'cxl-rp,port=0,bus=pcie.0,id=type1_port,chassis=0,slot=2');
    }

    if (profileHas('type2')) {
        args.push(
            '-device', 'cxl-rp,port=1,bus=pcie.0,id=type2_port,chassis=0,slot=3',
            '-device', 'virtio-gpu-pci,bus=type2_port,id=hetgpu0'
        );
    }

    if (profileHas('type3')) {
        args.push(
            '-object', 'memory-backend-ram,id=vmem0,share=on,size=128M',
            '-device', 'cxl-rp,port=2,bus=pcie.0,id=type3_port,chassis=0,slot=4',
            '-device', 'cxl-type3,bus=type3_port,volatile-memdev=vmem0,id=cxl-vmem0'
        );
    }

    return args;
}

Module['arguments'] = buildQemuArguments();
window.CXL_WEB_CONFIG.arguments = Module['arguments'];
window.CXL_WEB_CONFIG.command = Module['arguments'].map((arg) => {
    return /\\s/.test(arg) ? JSON.stringify(arg) : arg;
}).join(' ');
Module['locateFile'] = function(path, prefix) {
    return CXL_WEB_CONFIG.assetBase + path;
};
Module['mainScriptUrlOrBlob'] = CXL_WEB_CONFIG.assetBase + 'qemu-system-i386.js';
