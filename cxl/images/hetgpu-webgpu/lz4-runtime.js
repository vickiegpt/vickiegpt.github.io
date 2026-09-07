(function() {
    if (typeof Module === 'undefined') {
        Module = {};
    }

    function assert(check, message) {
        if (!check) {
            throw new Error(message || 'LZ4 preload assertion failed');
        }
    }

    function uncompress(input, output, startIndex, endIndex) {
        startIndex = startIndex || 0;
        endIndex = endIndex || input.length;

        for (let i = startIndex, j = 0; i < endIndex;) {
            const token = input[i++];
            let literalsLength = token >> 4;
            if (literalsLength > 0) {
                let length = literalsLength + 240;
                while (length === 255) {
                    length = input[i++];
                    literalsLength += length;
                }
                const end = i + literalsLength;
                while (i < end) {
                    output[j++] = input[i++];
                }
                if (i === endIndex) {
                    return j;
                }
            }

            const offset = input[i++] | (input[i++] << 8);
            if (offset === 0) {
                return j;
            }
            if (offset > j) {
                return -(i - 2);
            }

            let matchLength = token & 15;
            let length = matchLength + 240;
            while (length === 255) {
                length = input[i++];
                matchLength += length;
            }

            let position = j - offset;
            const end = j + matchLength + 4;
            while (j < end) {
                output[j++] = output[position++];
            }
        }

        return output.length;
    }

    function splitPath(filename) {
        const normalized = filename.replace(/\/+$/, '');
        const slash = normalized.lastIndexOf('/');
        return {
            dir: slash <= 0 ? '/' : normalized.slice(0, slash),
            name: normalized.slice(slash + 1)
        };
    }

    function ensurePath(FS, dir) {
        if (!dir || dir === '/') {
            return;
        }

        let current = '';
        for (const part of dir.split('/').filter(Boolean)) {
            current += '/' + part;
            if (!FS.analyzePath(current).exists) {
                FS.mkdir(current);
            }
        }
    }

    const LZ4 = {
        FILE_MODE: 33279,
        CHUNK_SIZE: 2048,
        codec: {
            uncompress
        },

        loadPackage(pack) {
            const FS = Module['FS'];
            assert(FS, 'Module.FS is not ready for LZ4 preload');

            const compressedData = pack['compressedData'];
            assert(compressedData, 'compressedData is required');
            assert(
                compressedData['cachedIndexes'].length === compressedData['cachedChunks'].length,
                'invalid LZ4 cache metadata'
            );

            for (let i = 0; i < compressedData['cachedIndexes'].length; i++) {
                compressedData['cachedIndexes'][i] = -1;
                compressedData['cachedChunks'][i] = compressedData['data'].subarray(
                    compressedData['cachedOffset'] + i * LZ4.CHUNK_SIZE,
                    compressedData['cachedOffset'] + (i + 1) * LZ4.CHUNK_SIZE
                );
                assert(compressedData['cachedChunks'][i].length === LZ4.CHUNK_SIZE, 'bad LZ4 cache chunk');
            }

            pack['metadata'].files.forEach((file) => {
                const path = splitPath(file.filename);
                ensurePath(FS, path.dir);
                const parent = FS.analyzePath(path.dir).object;
                LZ4.createNode(FS, parent, path.name, LZ4.FILE_MODE, {
                    compressedData,
                    start: file.start,
                    end: file.end
                });
            });
        },

        createNode(FS, parent, name, mode, contents) {
            const node = FS.createNode(parent, name, mode);
            node.mode = mode;
            node.node_ops = LZ4.node_ops;
            node.stream_ops = LZ4.stream_ops;
            node.timestamp = new Date().getTime();
            node.size = contents.end - contents.start;
            node.contents = contents;
            if (parent) {
                parent.contents[name] = node;
            }
            return node;
        },

        node_ops: {
            getattr(node) {
                return {
                    dev: 1,
                    ino: node.id,
                    mode: node.mode,
                    nlink: 1,
                    uid: 0,
                    gid: 0,
                    rdev: 0,
                    size: node.size,
                    atime: new Date(node.timestamp),
                    mtime: new Date(node.timestamp),
                    ctime: new Date(node.timestamp),
                    blksize: 4096,
                    blocks: Math.ceil(node.size / 4096)
                };
            },
            setattr(node, attr) {
                if (attr.mode !== undefined) {
                    node.mode = attr.mode;
                }
                if (attr.timestamp !== undefined) {
                    node.timestamp = attr.timestamp;
                }
            },
            lookup() {
                throw new (Module['FS'].ErrnoError)(44);
            },
            mknod() {
                throw new (Module['FS'].ErrnoError)(63);
            },
            rename() {
                throw new (Module['FS'].ErrnoError)(63);
            },
            unlink() {
                throw new (Module['FS'].ErrnoError)(63);
            },
            rmdir() {
                throw new (Module['FS'].ErrnoError)(63);
            },
            readdir() {
                throw new (Module['FS'].ErrnoError)(63);
            },
            symlink() {
                throw new (Module['FS'].ErrnoError)(63);
            }
        },

        stream_ops: {
            read(stream, buffer, offset, length, position) {
                const available = Math.min(length, stream.node.size - position);
                if (available <= 0) {
                    return 0;
                }

                const contents = stream.node.contents;
                const compressedData = contents.compressedData;
                let written = 0;
                while (written < available) {
                    const start = contents.start + position + written;
                    const desired = available - written;
                    const chunkIndex = Math.floor(start / LZ4.CHUNK_SIZE);
                    const compressedStart = compressedData['offsets'][chunkIndex];
                    const compressedSize = compressedData['sizes'][chunkIndex];
                    let currentChunk;

                    if (compressedData['successes'][chunkIndex]) {
                        const found = compressedData['cachedIndexes'].indexOf(chunkIndex);
                        if (found >= 0) {
                            currentChunk = compressedData['cachedChunks'][found];
                        } else {
                            compressedData['cachedIndexes'].pop();
                            compressedData['cachedIndexes'].unshift(chunkIndex);
                            currentChunk = compressedData['cachedChunks'].pop();
                            compressedData['cachedChunks'].unshift(currentChunk);
                            const compressed = compressedData['data'].subarray(
                                compressedStart,
                                compressedStart + compressedSize
                            );
                            const originalSize = LZ4.codec.uncompress(compressed, currentChunk);
                            if (chunkIndex < compressedData['successes'].length - 1) {
                                assert(originalSize === LZ4.CHUNK_SIZE, 'bad LZ4 chunk size');
                            }
                        }
                    } else {
                        currentChunk = compressedData['data'].subarray(
                            compressedStart,
                            compressedStart + LZ4.CHUNK_SIZE
                        );
                    }

                    const startInChunk = start % LZ4.CHUNK_SIZE;
                    const endInChunk = Math.min(startInChunk + desired, LZ4.CHUNK_SIZE);
                    buffer.set(currentChunk.subarray(startInChunk, endInChunk), offset + written);
                    written += endInChunk - startInChunk;
                }

                return written;
            },
            write() {
                throw new (Module['FS'].ErrnoError)(29);
            },
            llseek(stream, offset, whence) {
                let position = offset;
                if (whence === 1) {
                    position += stream.position;
                } else if (whence === 2 && Module['FS'].isFile(stream.node.mode)) {
                    position += stream.node.size;
                }
                if (position < 0) {
                    throw new (Module['FS'].ErrnoError)(28);
                }
                return position;
            }
        }
    };

    Module['LZ4'] = Module['LZ4'] || LZ4;
})();
