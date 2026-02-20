# JSOS Sysroot — lib/

Static archives for linking Chromium against JSOS on bare metal.
These are built by the JSOS kernel/OS build system and copied here
before running GN to configure the Chromium build.

## Required Archives

| File              | Built from                          | Description                           |
|-------------------|-------------------------------------|---------------------------------------|
| `libposix.a`      | `src/kernel/ + src/os/core/`        | Phase 6 POSIX syscall layer           |
| `libnet.a`        | `src/os/net/`                       | Phase 7 TCP/IP + DNS + TLS sockets    |
| `libmbedtls.a`    | third-party mbedTLS cross-compiled  | TLS 1.3 for HTTPS (Phase 7)           |
| `libswiftshader.a`| `lib/swiftshader/`                  | Phase 8 SwiftShader Vulkan/GL backend |
| `libgbm_jsos.a`   | `lib/gbm-jsos/`                     | minigbm DRM/GBM shim (Phase 8)        |
| `libjsos_libc.a`  | `src/kernel/minimal_libc.c` + alloc | Minimal libc + malloc (Phase 4 VMM)   |

## Build Commands

Run from the workspace root inside a cross-compilation Docker container
(see `docker/build.Dockerfile`):

```bash
# Build all sysroot archives in one pass:
make -C src/kernel TARGET=sysroot

# Or individually:
make -C src/kernel libposix.a
make -C src/kernel libnet.a
# ... etc

# Copy into place:
cp src/kernel/libposix.a     chromium/third_party/jsos_sysroot/lib/
cp src/kernel/libnet.a       chromium/third_party/jsos_sysroot/lib/
cp src/kernel/libmbedtls.a   chromium/third_party/jsos_sysroot/lib/
cp lib/swiftshader/libswiftshader.a chromium/third_party/jsos_sysroot/lib/
cp lib/gbm-jsos/libgbm_jsos.a       chromium/third_party/jsos_sysroot/lib/
cp src/kernel/libjsos_libc.a chromium/third_party/jsos_sysroot/lib/
```

## Link Order

The archives must appear on the Chromium link line in this order
(later archives can reference earlier ones):

```
-lposix -lnet -lmbedtls -lswiftshader -lgbm_jsos -ljsos_libc
```

This order is enforced by the `jsos_x86` GN toolchain's link tool rule.
See `//build/config/jsos/BUILD.gn` and `//third_party/jsos_sysroot/BUILD.gn`.
