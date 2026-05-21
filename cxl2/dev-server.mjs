import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const port = Number(process.env.PORT || process.argv[2] || 8789);

const types = new Map([
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.mjs', 'text/javascript; charset=utf-8'],
    ['.css', 'text/css; charset=utf-8'],
    ['.wasm', 'application/wasm'],
    ['.gz', 'application/gzip'],
    ['.cpio', 'application/octet-stream'],
    ['.img', 'application/octet-stream'],
    ['.bin', 'application/octet-stream'],
    ['.data', 'application/octet-stream'],
    ['.png', 'image/png'],
    ['.svg', 'image/svg+xml']
]);

function headers(extra = {}) {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Range, Content-Type',
        'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Length, Content-Range',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Accept-Ranges': 'bytes',
        ...extra
    };
}

function resolvePath(urlPath) {
    let decoded = decodeURIComponent(urlPath.split('?')[0]);
    if (decoded === '/') decoded = '/index.html';
    const filePath = normalize(join(root, decoded));
    if (!filePath.startsWith(root)) return null;
    if (existsSync(filePath) && statSync(filePath).isDirectory()) {
        return join(filePath, 'index.html');
    }
    return filePath;
}

function sendFile(req, res, filePath) {
    if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
        res.writeHead(404, headers({ 'Content-Type': 'text/plain; charset=utf-8' }));
        res.end('not found\n');
        return;
    }

    const stat = statSync(filePath);
    const type = types.get(extname(filePath)) || 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
        const match = String(range).match(/^bytes=(\d*)-(\d*)$/);
        if (!match) {
            res.writeHead(416, headers({ 'Content-Type': 'text/plain; charset=utf-8' }));
            res.end('bad range\n');
            return;
        }
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Number(match[2]) : stat.size - 1;
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= stat.size) {
            res.writeHead(416, headers({ 'Content-Range': `bytes */${stat.size}` }));
            res.end();
            return;
        }
        const safeEnd = Math.min(end, stat.size - 1);
        res.writeHead(206, headers({
            'Content-Type': type,
            'Content-Length': String(safeEnd - start + 1),
            'Content-Range': `bytes ${start}-${safeEnd}/${stat.size}`
        }));
        if (req.method !== 'HEAD') createReadStream(filePath, { start, end: safeEnd }).pipe(res);
        else res.end();
        return;
    }

    res.writeHead(200, headers({
        'Content-Type': type,
        'Content-Length': String(stat.size)
    }));
    if (req.method !== 'HEAD') createReadStream(filePath).pipe(res);
    else res.end();
}

createServer((req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, headers());
        res.end();
        return;
    }
    sendFile(req, res, resolvePath(new URL(req.url, `http://${req.headers.host}`).pathname));
}).listen(port, '127.0.0.1', () => {
    console.log(`CXLMemSim site server: http://127.0.0.1:${port}/cxl2/`);
    console.log(`root: ${root}`);
});
