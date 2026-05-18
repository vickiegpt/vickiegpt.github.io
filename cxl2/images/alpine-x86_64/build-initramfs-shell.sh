#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ARCHIVE="$SCRIPT_DIR/initramfs-shell.cpio"
WORKDIR=$(mktemp -d "$SCRIPT_DIR/.initramfs-work.XXXXXX")

cleanup() {
    rm -rf "$WORKDIR"
}
trap cleanup EXIT

cd "$WORKDIR"
cpio -idum < "$ARCHIVE" >/dev/null

cp "$SCRIPT_DIR/initramfs-shell.init" "$WORKDIR/init"
chmod 0755 "$WORKDIR/init"

if [ -d "$SCRIPT_DIR/initramfs-shell.d" ]; then
    (cd "$SCRIPT_DIR/initramfs-shell.d" && find . -print | cpio -pdm "$WORKDIR" >/dev/null)
fi

chmod 0755 "$WORKDIR/bin/lspci" "$WORKDIR/bin/findmnt"

for applet in \
    awk basename blkid cut date dd df dirname false free head hexdump hostname \
    kill ln lsmod mountpoint printf ps pwd readlink rm rmdir sed seq stty \
    sync tail tee timeout touch tr true umount wc xargs yes
do
    [ -e "$WORKDIR/bin/$applet" ] || ln -s busybox "$WORKDIR/bin/$applet"
done

find . -print | LC_ALL=C sort | cpio -o -H newc > "$ARCHIVE"
gzip -c "$ARCHIVE" > "$ARCHIVE.gz"

echo "rebuilt $ARCHIVE"
