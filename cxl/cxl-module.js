if (typeof Module === 'undefined') {
    Module = {};
}

const CXL_WEB_CONFIG = (() => {
    const params = new URLSearchParams(location.search);
    const validProfiles = new Set(['all', 'type1', 'type2', 'type3']);
    const profile = validProfiles.has(params.get('cxl')) ? params.get('cxl') : 'all';
    const backend = params.get('hetgpu') || 'webgpu';
    return { profile, backend };
})();

window.CXL_WEB_CONFIG = CXL_WEB_CONFIG;

function createRangeBackedFile(mod, parent, name, url) {
    const FS = mod.FS;
    const chunkSize = 4 * 1024 * 1024;
    const maxChunks = 64;
    const chunks = new Map();

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

    const node = FS.createFile(parent, name, null, true, false);
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
        write() {
            throw new FS.ErrnoError(63);
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
    createRangeBackedFile(mod, '/remote', 'bzImage', '/about/bzImage');
    createRangeBackedFile(mod, '/remote', 'qemu.img', '/about/qemu.img');
});

function profileHas(name) {
    return CXL_WEB_CONFIG.profile === 'all' || CXL_WEB_CONFIG.profile === name;
}

function buildQemuArguments() {
    const type3Enabled = profileHas('type3');
    const append = [
        'console=ttyS0',
        'root=/dev/vda',
        'rw',
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
        '-L', '/pack-rom/',
        '-nic', 'none',
        '-kernel', '/remote/bzImage',
        '-append', append,
        '-drive', 'id=test,file=/remote/qemu.img,format=raw,if=none,readonly=on',
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
    return '/cxl/images/alpine-x86_64/' + path;
};
Module['mainScriptUrlOrBlob'] = '/cxl/images/alpine-x86_64/out.js'
