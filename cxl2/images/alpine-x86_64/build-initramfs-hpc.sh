#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BASE_ARCHIVE="${BASE_ARCHIVE:-$SCRIPT_DIR/initramfs-shell.cpio}"
OUT_ARCHIVE="${OUT_ARCHIVE:-$SCRIPT_DIR/initramfs-hpc.cpio}"
WORKDIR=$(mktemp -d "$SCRIPT_DIR/.initramfs-hpc-work.XXXXXX")
STATE_DIR=$(mktemp -d "$SCRIPT_DIR/.initramfs-hpc-state.XXXXXX")

cleanup() {
    rm -rf "$WORKDIR" "$STATE_DIR"
}
trap cleanup EXIT

copy_one() {
    src=$1
    [ -e "$src" ] || [ -L "$src" ] || return 0
    case "$src" in
        /*) ;;
        *) return 0 ;;
    esac
    dst="$WORKDIR$src"
    mkdir -p "$(dirname "$dst")"
    rm -rf "$dst"
    cp -a "$src" "$dst"
}

copy_path() {
    src=$1
    [ -e "$src" ] || [ -L "$src" ] || return 0
    copy_one "$src"
    while [ -L "$src" ]; do
        target=$(readlink "$src")
        case "$target" in
            /*) src=$target ;;
            *) src=$(readlink -m "$(dirname "$src")/$target") ;;
        esac
        copy_one "$src"
    done
}

copy_tree() {
    src=$1
    [ -d "$src" ] || return 0
    (cd / && find "${src#/}" -xdev -print | cpio -pdm "$WORKDIR" >/dev/null)
}

copy_pkg_path() {
    src=$1
    case "$src" in
        /usr/share/doc/*|/usr/share/man/*|/usr/share/lintian/*|/usr/share/locale/*) return 0 ;;
    esac
    if [ -d "$src" ] && [ ! -L "$src" ]; then
        mkdir -p "$WORKDIR$src"
    else
        copy_path "$src"
    fi
}

copy_command() {
    name=$1
    path=$(command -v "$name" 2>/dev/null || true)
    [ -n "$path" ] || return 0
    copy_path "$path"
}

copy_to() {
    src=$1
    dst=$2
    [ -e "$src" ] || return 0
    mkdir -p "$(dirname "$WORKDIR$dst")"
    cp -a "$src" "$WORKDIR$dst"
}

normalize_usrmerge() {
    mkdir -p "$WORKDIR/usr/lib" "$WORKDIR/usr/lib64" "$WORKDIR/usr/lib/x86_64-linux-gnu"

    if [ -d "$WORKDIR/lib" ] && [ ! -L "$WORKDIR/lib" ]; then
        (cd "$WORKDIR/lib" && find . -mindepth 1 -print | cpio -pdm "$WORKDIR/usr/lib" >/dev/null)
        rm -rf "$WORKDIR/lib"
    fi
    ln -s usr/lib "$WORKDIR/lib"

    if [ -d "$WORKDIR/lib64" ] && [ ! -L "$WORKDIR/lib64" ]; then
        (cd "$WORKDIR/lib64" && find . -mindepth 1 -print | cpio -pdm "$WORKDIR/usr/lib64" >/dev/null)
        rm -rf "$WORKDIR/lib64"
    fi
    ln -s usr/lib64 "$WORKDIR/lib64"

    if [ -e /lib/x86_64-linux-gnu/ld-linux-x86-64.so.2 ]; then
        copy_to /lib/x86_64-linux-gnu/ld-linux-x86-64.so.2 /usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2
        ln -sf ../lib/x86_64-linux-gnu/ld-linux-x86-64.so.2 "$WORKDIR/usr/lib64/ld-linux-x86-64.so.2"
    fi
}

collect_elf_deps_once() {
    libs_file="$STATE_DIR/libs"
    : > "$libs_file"
    find "$WORKDIR" -type f -print | while IFS= read -r file; do
        if file -b "$file" 2>/dev/null | grep -q 'ELF'; then
            ldd "$file" 2>/dev/null | awk '
                /=> \// { print $3; next }
                /^\// { print $1; next }
            ' >> "$libs_file" || true
        fi
    done
    sort -u "$libs_file" | while IFS= read -r lib; do
        [ -n "$lib" ] || continue
        case "$lib" in
            "$WORKDIR"/*)
                continue
                ;;
        esac
        [ -e "$lib" ] || [ -L "$lib" ] || continue
        if [ ! -e "$WORKDIR$lib" ] && [ ! -L "$WORKDIR$lib" ]; then
            echo "$lib" >> "$STATE_DIR/new-libs"
        fi
        copy_path "$lib"
    done
}

trim_runtime_tree() {
    rm -rf \
        "$WORKDIR$WORKDIR" \
        "$WORKDIR/usr/include" \
        "$WORKDIR/usr/share/bash-completion" \
        "$WORKDIR/usr/share/doc-base" \
        "$WORKDIR/usr/lib/x86_64-linux-gnu/openmpi/include" \
        "$WORKDIR/usr/lib/x86_64-linux-gnu/pmix2/include" \
        "$WORKDIR/usr/lib/x86_64-linux-gnu/libgromacs_d.so"* \
        "$WORKDIR/usr/lib/x86_64-linux-gnu/libgromacs_mpi_d.so"*
}

strip_copied_elfs() {
    command -v strip >/dev/null 2>&1 || return 0
    find "$WORKDIR" -type f -print | while IFS= read -r file; do
        case "$file" in
            *.ko) continue ;;
        esac
        if file -b "$file" 2>/dev/null | grep -q 'ELF'; then
            strip --strip-unneeded "$file" 2>/dev/null || true
        fi
    done
}

cd "$WORKDIR"
cpio -idum < "$BASE_ARCHIVE" >/dev/null

if [ -d "$SCRIPT_DIR/initramfs-hpc.d" ]; then
    (cd "$SCRIPT_DIR/initramfs-hpc.d" && find . -print | cpio -pdm "$WORKDIR" >/dev/null)
fi
chmod 0755 "$WORKDIR/usr/bin/hpc-status" "$WORKDIR/usr/bin/mpi-smoke" 2>/dev/null || true

mkdir -p "$WORKDIR/etc/profile.d" "$WORKDIR/root" "$WORKDIR/opt" "$WORKDIR/usr/bin"
printf 'root:x:0:0:root:/root:/bin/sh\n' > "$WORKDIR/etc/passwd"
printf 'root:x:0:\n' > "$WORKDIR/etc/group"
printf 'hosts: files dns\npasswd: files\ngroup: files\n' > "$WORKDIR/etc/nsswitch.conf"
printf '127.0.0.1 localhost\n' > "$WORKDIR/etc/hosts"
printf 'nameserver 1.1.1.1\n' > "$WORKDIR/etc/resolv.conf"

HPC_PACKAGES=${HPC_PACKAGES:-"openmpi-bin openmpi-common libopenmpi40 gromacs gromacs-data libgromacs10"}
for pkg in $HPC_PACKAGES; do
    if dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q 'install ok installed'; then
        dpkg -L "$pkg" | while IFS= read -r path; do
            [ -n "$path" ] && copy_pkg_path "$path"
        done
    else
        echo "warning: package not installed: $pkg" >&2
    fi
done

for dir in \
    /usr/lib/x86_64-linux-gnu/openmpi \
    /usr/lib/x86_64-linux-gnu/pmix2 \
    /usr/share/openmpi \
    /usr/share/gromacs
do
    copy_tree "$dir"
done

for cmd in mpirun mpiexec ompi_info prte prterun gmx_mpi gmx timeout ldd strace readelf; do
    copy_command "$cmd"
done

LLAMA_DIR=${LLAMA_DIR:-/home/victoryang00/hetGPU_new/CXLMemSim/workloads/llama.cpp}
if [ -x "$LLAMA_DIR/main" ]; then
    copy_to "$LLAMA_DIR/main" /opt/llama.cpp/main
    ln -sf /opt/llama.cpp/main "$WORKDIR/usr/bin/llama-cli"
else
    echo "warning: llama.cpp main is not built at $LLAMA_DIR/main" >&2
fi
if [ -x "$LLAMA_DIR/llama-bench" ]; then
    copy_to "$LLAMA_DIR/llama-bench" /opt/llama.cpp/llama-bench
    ln -sf /opt/llama.cpp/llama-bench "$WORKDIR/usr/bin/llama-bench"
else
    echo "warning: llama-bench is not built at $LLAMA_DIR/llama-bench" >&2
fi

TIGON_KERNEL_DIR=${TIGON_KERNEL_DIR:-/home/victoryang00/hetGPU_new/CXLMemSim/workloads/tigon/dependencies/kernel_module}
for name in cxl_init cxl_recover_meta cxl_ivpci.ko; do
    if [ -e "$TIGON_KERNEL_DIR/$name" ]; then
        copy_to "$TIGON_KERNEL_DIR/$name" "/opt/tigon/kernel_module/$name"
    else
        echo "warning: tigon helper missing: $TIGON_KERNEL_DIR/$name" >&2
    fi
done
ln -sf /opt/tigon/kernel_module/cxl_init "$WORKDIR/usr/bin/cxl_init"
ln -sf /opt/tigon/kernel_module/cxl_recover_meta "$WORKDIR/usr/bin/cxl_recover_meta"

pass=1
while [ "$pass" -le 8 ]; do
    : > "$STATE_DIR/new-libs"
    collect_elf_deps_once
    [ -s "$STATE_DIR/new-libs" ] || break
    pass=$((pass + 1))
done

find "$WORKDIR" -type d -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
find "$WORKDIR" -type f \( -name '*.a' -o -name '*.la' \) -delete 2>/dev/null || true
trim_runtime_tree
strip_copied_elfs
normalize_usrmerge

cd "$WORKDIR"
find . -print | LC_ALL=C sort | cpio -o -H newc > "$OUT_ARCHIVE"
gzip -c "$OUT_ARCHIVE" > "$OUT_ARCHIVE.gz"

echo "rebuilt $OUT_ARCHIVE"
du -h "$OUT_ARCHIVE" "$OUT_ARCHIVE.gz"
echo "included commands:"
for cmd in mpirun mpiexec ompi_info prte prterun gmx_mpi gmx timeout ldd strace readelf llama-cli llama-bench cxl_init cxl_recover_meta mpi-smoke; do
    if [ -e "$WORKDIR/usr/bin/$cmd" ] || [ -L "$WORKDIR/usr/bin/$cmd" ]; then
        echo "  $cmd"
    fi
done
