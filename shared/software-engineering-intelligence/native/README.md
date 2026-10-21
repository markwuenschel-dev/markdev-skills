# Predictive native filesystem helper

This package-private Node-API helper supplies handle-relative filesystem capabilities for derived V9 predictive state. It is not a public API and must not be used for target-repository writes.

Windows x64, using the locally cached Node headers/import library and MSVC Build Tools:

```powershell
pwsh -NoProfile -File skills/shared/software-engineering-intelligence/native/build.ps1
```

The script performs no downloads and writes `native/bin/win32-x64/predictive_native_bootstrap.node` plus `predictive_native_fs.node`. `/Brepro`, deterministic compilation, path mapping, disabled incremental linking, and fixed optimization flags make identical source/toolchain inputs reproducible across checkout roots. The helper embeds the source SHA-256; the loader recomputes it and refuses a stale or mismatched packaged binary.

The bootstrap is the small trusted image-loading boundary and is entered with a fresh `process.dlopen`, never through `require.cache`. It pins its own mapped module, opens and hashes that exact image, and exports the self-image digest. For the helper, it opens every ancestor through exact native handles, denies write/delete sharing on the file, hashes the opened object, and loads it through the stable NT-volume `GLOBALROOT` spelling. Before invoking `napi_register_module_v1`, it uses runtime-resolved `NtAreMappedFilesTheSame` against a read-only mapping of the retained handle to prove that the returned `HMODULE` is the same file object; absence of that Windows primitive fails closed. Both module and file handles remain retained for the process lifetime. Predictive artifacts and their namespace bind the canonical helper identity, including the exact bootstrap and helper image digests; JavaScript never hashes a candidate image pathname and then separately loads it.

POSIX, using the Node installation's local headers (set `NODE_INCLUDE` when they are elsewhere):

```sh
NODE_INCLUDE="${NODE_INCLUDE:-/usr/include/node}"
SOURCE=skills/shared/software-engineering-intelligence/native/predictive_native_fs.cc
SOURCE_SHA256="$(node -e 'const fs=require("node:fs"),c=require("node:crypto");const s=fs.readFileSync(process.argv[1],"utf8").replace(/\r\n?/g,"\n");process.stdout.write(c.createHash("sha256").update(s).digest("hex"))' "$SOURCE")"
ARCH="$(node -p 'process.arch')"
if [ "$(uname -s)" = Darwin ]; then LINK_FLAGS="-bundle -undefined dynamic_lookup"; else LINK_FLAGS="-shared"; fi
mkdir -p "skills/shared/software-engineering-intelligence/native/bin/posix-$ARCH"
c++ -std=c++17 -O2 -fPIC $LINK_FLAGS -DNAPI_VERSION=8 \
  -DPREDICTIVE_SOURCE_SHA256_HEX="$SOURCE_SHA256" \
  -I"$NODE_INCLUDE" \
  "$SOURCE" \
  -o "skills/shared/software-engineering-intelligence/native/bin/posix-$ARCH/predictive_native_fs.node"
```

The POSIX branch opens `/` and every state-root component with `O_DIRECTORY | O_NOFOLLOW`, then uses retained directory descriptors with `openat`, `mkdirat`, and `fstatat` for safe create/list/read operations. Linux and macOS have no conditional `unlinkat` that deletes an already-opened inode only if the directory entry still names it. Therefore the POSIX build refuses predictive publication/deletion with `REFUSED_EXACT_DELETE_UNAVAILABLE`, and the JS loader fails full predictive operation closed outside Windows x64. The Windows branch opens the volume and every descendant with `NtCreateFile` `RootDirectory` plus `FILE_OPEN_REPARSE_POINT`, retaining directory/file handles through exact rollback and deletion.
