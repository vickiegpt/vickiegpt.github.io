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

copy_kernel_module() {
    rel=$1
    [ -n "${CXL_KERNEL_RELEASE:-}" ] || return 0
    [ -n "${CXL_KERNEL_DIR:-}" ] || return 0
    src="$CXL_KERNEL_DIR/$rel"
    if [ -e "$src" ]; then
        copy_to "$src" "/lib/modules/$CXL_KERNEL_RELEASE/kernel/$rel"
    else
        echo "warning: CXL kernel module missing: $src" >&2
    fi
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
chmod 0755 \
    "$WORKDIR/usr/bin/hpc-status" \
    "$WORKDIR/usr/bin/mpi-local-run" \
    "$WORKDIR/usr/bin/mpi-smoke" \
    "$WORKDIR/usr/bin/mpi-cxl-run" \
    "$WORKDIR/usr/bin/llama-smoke" \
    "$WORKDIR/usr/bin/llama-mpi-smoke" \
    "$WORKDIR/usr/bin/gromacs-cxl-smoke" \
    "$WORKDIR/usr/bin/gromacs-cxl-run" \
    "$WORKDIR/usr/bin/tigon-smoke" \
    "$WORKDIR/usr/bin/tigon-ycsb-tiny" \
    "$WORKDIR/usr/bin/cxlcuda-run" \
    "$WORKDIR/usr/bin/cxl-dax-setup" \
    "$WORKDIR/usr/bin/cxl-type2-test" \
    "$WORKDIR/usr/bin/cxl-type3-test" \
    2>/dev/null || true

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

for cmd in mpirun mpiexec ompi_info prte prterun gmx_mpi gmx timeout ldd strace readelf bash ip ifconfig; do
    copy_command "$cmd"
done
for cmd in cxl daxctl ndctl modprobe insmod depmod lsmod; do
    copy_command "$cmd"
done
if [ -e "$WORKDIR/usr/bin/bash" ] || [ -L "$WORKDIR/usr/bin/bash" ]; then
    mkdir -p "$WORKDIR/bin"
    ln -sf /usr/bin/bash "$WORKDIR/bin/bash"
fi

CXL_KERNEL_DIR=${CXL_KERNEL_DIR:-/home/victoryang00/cxl}
CXL_KERNEL_RELEASE=${CXL_KERNEL_RELEASE:-}
if [ -z "$CXL_KERNEL_RELEASE" ] && [ -e "$CXL_KERNEL_DIR/drivers/cxl/core/cxl_core.ko" ] && command -v modinfo >/dev/null 2>&1; then
    CXL_KERNEL_RELEASE=$(modinfo -F vermagic "$CXL_KERNEL_DIR/drivers/cxl/core/cxl_core.ko" 2>/dev/null | awk 'NR == 1 { print $1 }')
fi
if [ -n "$CXL_KERNEL_RELEASE" ] && [ -d "$CXL_KERNEL_DIR" ]; then
    for ko in \
        drivers/acpi/apei/einj.ko \
        drivers/cxl/core/cxl_core.ko \
        drivers/cxl/cxl_acpi.ko \
        drivers/cxl/cxl_pci.ko \
        drivers/cxl/cxl_port.ko \
        drivers/cxl/cxl_mem.ko \
        drivers/cxl/cxl_pmem.ko \
        drivers/cxl/cxl_cache.ko \
        drivers/cxl/cxl_type2_accel.ko \
        drivers/dax/device_dax.ko \
        drivers/dax/dax_cxl.ko \
        drivers/dax/dax_pmem.ko \
        drivers/dax/hmem/dax_hmem.ko \
        drivers/dax/kmem.ko \
        drivers/perf/cxl_pmu.ko
    do
        copy_kernel_module "$ko"
    done
    if command -v depmod >/dev/null 2>&1; then
        depmod -b "$WORKDIR" "$CXL_KERNEL_RELEASE" 2>/dev/null || true
    fi
else
    echo "warning: unable to infer CXL kernel release from $CXL_KERNEL_DIR" >&2
fi

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

TIGON_DIR=${TIGON_DIR:-/home/victoryang00/CXLMemSim/workloads/tigon}
if [ ! -d "$TIGON_DIR" ] && [ -d /home/victoryang00/hetGPU_new/CXLMemSim/workloads/tigon ]; then
    TIGON_DIR=/home/victoryang00/hetGPU_new/CXLMemSim/workloads/tigon
fi
TIGON_KERNEL_DIR=${TIGON_KERNEL_DIR:-$TIGON_DIR/dependencies/kernel_module}
for name in cxl_init cxl_recover_meta cxl_ivpci.ko; do
    if [ -e "$TIGON_KERNEL_DIR/$name" ]; then
        copy_to "$TIGON_KERNEL_DIR/$name" "/opt/tigon/kernel_module/$name"
    else
        echo "warning: tigon helper missing: $TIGON_KERNEL_DIR/$name" >&2
    fi
done
ln -sf /opt/tigon/kernel_module/cxl_init "$WORKDIR/usr/bin/cxl_init"
ln -sf /opt/tigon/kernel_module/cxl_recover_meta "$WORKDIR/usr/bin/cxl_recover_meta"
for item in bench_ycsb bench_tpcc; do
    if [ -x "$TIGON_DIR/build/$item" ]; then
        copy_to "$TIGON_DIR/build/$item" "/opt/tigon/bin/$item"
    else
        echo "warning: Tigon binary missing: $TIGON_DIR/build/$item" >&2
    fi
done
ln -sf /opt/tigon/bin/bench_ycsb "$WORKDIR/usr/bin/tigon-ycsb"
ln -sf /opt/tigon/bin/bench_tpcc "$WORKDIR/usr/bin/tigon-tpcc"

CXL_CUDA_DIR=${CXL_CUDA_DIR:-/home/victoryang00/CXLMemSim/qemu_integration/guest_libcuda}
if [ -e "$CXL_CUDA_DIR/libcuda.so.1" ]; then
    copy_to "$CXL_CUDA_DIR/libcuda.so.1" /opt/cxlcuda/lib/libcuda.so.1
    ln -sf libcuda.so.1 "$WORKDIR/opt/cxlcuda/lib/libcuda.so"
    mkdir -p "$WORKDIR/usr/lib/x86_64-linux-gnu"
    ln -sf /opt/cxlcuda/lib/libcuda.so.1 "$WORKDIR/usr/lib/x86_64-linux-gnu/libcuda.so.1"
    ln -sf /opt/cxlcuda/lib/libcuda.so "$WORKDIR/usr/lib/x86_64-linux-gnu/libcuda.so"
else
    echo "warning: CXL CUDA shim missing: $CXL_CUDA_DIR/libcuda.so.1" >&2
fi
for name in \
    cuda_test \
    cxl_bar_benchmark \
    cpu_gpu_hitm_benchmark \
    agentic_bias_benchmark \
    rq1_graph_bfs \
    rq2_dir_sizing \
    rq3_bias_kv \
    rq4_alloc_policy \
    rq4_devfrac_sweep
do
    if [ -x "$CXL_CUDA_DIR/$name" ]; then
        copy_to "$CXL_CUDA_DIR/$name" "/opt/cxlcuda/bin/$name"
        ln -sf "/opt/cxlcuda/bin/$name" "$WORKDIR/usr/bin/$name"
    else
        echo "warning: CXL CUDA test missing: $CXL_CUDA_DIR/$name" >&2
    fi
done
ln -sf ../lib/libcuda.so.1 "$WORKDIR/opt/cxlcuda/bin/libcuda.so.1"
ln -sf ../lib/libcuda.so "$WORKDIR/opt/cxlcuda/bin/libcuda.so"

MPI_CXL_SHIM_DIR=${MPI_CXL_SHIM_DIR:-/home/victoryang00/CXLMemSim/workloads/gromacs}
if [ -d "$MPI_CXL_SHIM_DIR" ]; then
    mkdir -p "$WORKDIR/opt/cxlmpi/lib" "$WORKDIR/usr/lib/x86_64-linux-gnu"
    found_mpi_cxl=0
    for so in "$MPI_CXL_SHIM_DIR"/libmpi_cxl_shim*.so; do
        [ -e "$so" ] || [ -L "$so" ] || continue
        copy_to "$so" "/opt/cxlmpi/lib/$(basename "$so")"
        found_mpi_cxl=1
    done
    if [ "$found_mpi_cxl" -eq 1 ]; then
        ln -sf /opt/cxlmpi/lib/libmpi_cxl_shim.so "$WORKDIR/usr/lib/x86_64-linux-gnu/libmpi_cxl_shim.so"
    else
        echo "warning: no MPI CXL shims found in $MPI_CXL_SHIM_DIR" >&2
    fi
else
    echo "warning: MPI CXL shim directory missing: $MPI_CXL_SHIM_DIR" >&2
fi

GROMACS_CXL_DIR=${GROMACS_CXL_DIR:-/home/victoryang00/CXLMemSim/workloads/gromacs}
if [ ! -d "$GROMACS_CXL_DIR" ] && [ -d /home/victoryang00/hetGPU_new/CXLMemSim/workloads/gromacs ]; then
    GROMACS_CXL_DIR=/home/victoryang00/hetGPU_new/CXLMemSim/workloads/gromacs
fi
if [ -d "$GROMACS_CXL_DIR" ]; then
    mkdir -p "$WORKDIR/opt/gromacs-cxl/bin" "$WORKDIR/opt/gromacs-cxl/src"
    MPI_TEST_CFLAGS=${MPI_TEST_CFLAGS:-"-O2 -Wall -march=x86-64 -mtune=generic -mno-avx -mno-avx2 -mno-avx512f"}
    for name in test_mpi_cxl test_p2p test_collectives test_onesided; do
        src="$GROMACS_CXL_DIR/$name.c"
        if [ -f "$src" ] && command -v mpicc >/dev/null 2>&1; then
            copy_to "$src" "/opt/gromacs-cxl/src/$name.c"
            # Browser QEMU commonly exposes a conservative CPU. Build the
            # smoke tests for baseline x86-64 so they do not inherit native
            # AVX/CLWB/etc. codegen from the build host.
            # shellcheck disable=SC2086
            if mpicc $MPI_TEST_CFLAGS -o "$WORKDIR/opt/gromacs-cxl/bin/$name" "$src" -lm; then
                ln -sf "/opt/gromacs-cxl/bin/$name" "$WORKDIR/usr/bin/$name"
            else
                echo "warning: failed to compile GROMACS CXL test: $src" >&2
                rm -f "$WORKDIR/opt/gromacs-cxl/bin/$name"
            fi
        elif [ -x "$GROMACS_CXL_DIR/$name" ]; then
            echo "warning: using prebuilt GROMACS CXL test without generic rebuild: $GROMACS_CXL_DIR/$name" >&2
            copy_to "$GROMACS_CXL_DIR/$name" "/opt/gromacs-cxl/bin/$name"
            ln -sf "/opt/gromacs-cxl/bin/$name" "$WORKDIR/usr/bin/$name"
        else
            echo "warning: GROMACS CXL test source missing or mpicc unavailable: $src" >&2
        fi
    done
    for name in run_gromacs_cxl.sh run_mpi_with_cxl.sh test_dax_sharing.sh; do
        if [ -e "$GROMACS_CXL_DIR/$name" ]; then
            copy_to "$GROMACS_CXL_DIR/$name" "/opt/gromacs-cxl/bin/$name"
        fi
    done
else
    echo "warning: GROMACS CXL workload directory missing: $GROMACS_CXL_DIR" >&2
fi

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
for cmd in mpirun mpiexec mpi-local-run ompi_info prte prterun gmx_mpi gmx gromacs-cxl-smoke gromacs-cxl-run test_mpi_cxl test_p2p test_collectives test_onesided timeout ldd strace readelf bash cxl daxctl ndctl modprobe insmod depmod lsmod cxl-dax-setup llama-cli llama-bench llama-smoke llama-mpi-smoke cxl_init cxl_recover_meta tigon-smoke tigon-ycsb-tiny tigon-ycsb tigon-tpcc mpi-smoke mpi-cxl-run cxlcuda-run cxl-type2-test cxl-type3-test cuda_test cxl_bar_benchmark; do
    if [ -e "$WORKDIR/usr/bin/$cmd" ] || [ -L "$WORKDIR/usr/bin/$cmd" ]; then
        echo "  $cmd"
    fi
done
echo "included CXL kernel release: ${CXL_KERNEL_RELEASE:-none}"
