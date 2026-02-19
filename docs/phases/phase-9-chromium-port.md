# Phase 9 — Chromium Port

## Goal

Compile Chromium against JSOS system headers, link it with our POSIX layer,
SwiftShader, mbedTLS, and Ozone backend, and produce a single static binary
that boots to a browsing window inside the JSOS window manager.

---

## Prerequisites

All prior phases complete:
- Phase 4: mmap, mprotect, real paging (JIT shader compilation)
- Phase 5: threads (Chromium spawns 20–50 at idle)
- Phase 6: POSIX, fork/exec, pipes, signals, /proc/self/maps, ELF loader
- Phase 7: TCP/IP sockets, TLS
- Phase 8: SwiftShader, DRM/KMS shim

---

## Strategy

Chromium is not patched. We build it with a JSOS target configured via GN
build flags. All adaptation happens in:

1. JSOS POSIX headers (syscall interface Chromium compiles against)
2. JSOS Ozone backend (display/input routing)
3. JSOS platform adapter in SwiftShader and libgbm
4. Any gaps in our POSIX implementation (we fix our layer, never Chromium)

---

## 9a — Build System Integration

### GN Toolchain and Target

```
chromium/
  build/
    config/
      jsos/
        BUILD.gn        toolchain definition
        platform.gni    feature flags
  third_party/
    jsos_sysroot/       JSOS system headers + static libs
      include/          POSIX headers for Chromium to compile against
      lib/              libposix.a, libnet.a, libmbedtls.a, libswiftshader.a
```

`BUILD.gn` defines the `i686-elf-gcc` cross-toolchain targeting JSOS.

### Key GN Build Flags

```gn
# chromium/build/config/jsos/platform.gni
declare_args() {
  target_os                = "jsos"
  target_cpu               = "x86"         # i686 for now; x86_64 in Phase 10

  is_component_build       = false         # static binary only
  is_official_build        = false

  use_ozone                = true
  ozone_platform           = "jsos"
  ozone_platform_jsos      = true

  use_swiftshader          = true
  use_swiftshader_vulkan   = true

  use_alsa                 = false         # no audio in Phase 9
  use_dbus                 = false
  use_udev                 = false
  use_system_libdrm        = false
  use_system_minigbm       = false

  enable_nacl              = false
  use_cups                 = false
  use_gio                  = false
  use_glib                 = false
  use_gtk                  = false
  use_x11                  = false

  v8_target_cpu            = "x86"
  v8_use_snapshot          = true
}
```

### JSOS Sysroot Headers

A set of POSIX-compatible headers that map to our Phase 6 syscall layer.
Key files Chromium's `base/` needs:

```
third_party/jsos_sysroot/include/
  unistd.h       fork, exec, getpid, read, write, close, …
  fcntl.h        open flags, F_* constants
  sys/mman.h     mmap, munmap, mprotect, MAP_*, PROT_*
  sys/stat.h     stat, fstat, S_* constants
  sys/socket.h   socket, bind, connect, AF_*, SOCK_*, …
  netinet/in.h   sockaddr_in, IPPROTO_*
  pthread.h      pthread_create, mutex, condvar — wraps Phase 5 sync
  signal.h       signal, sigaction, sigset_t
  time.h         clock_gettime, CLOCK_REALTIME, CLOCK_MONOTONIC
  dirent.h       readdir, scandir
  errno.h        errno constants
  string.h       memcpy etc (from minimal_libc.c)
  stdlib.h       malloc, free (wraps vmm.brk allocator)
  stdio.h        snprintf, fprintf (writes to fd 2 = stderr → serial log)
```

---

## 9b — Ozone JSOS Platform Backend

Chromium's Ozone layer abstracts display and input. We implement `OzonePlatformJSOS`.

```
chromium/
  ui/
    ozone/
      platform/
        jsos/
          ozone_platform_jsos.cc      platform factory
          jsos_surface_factory.cc     surface creation → DRM/framebuffer
          jsos_event_source.cc        keyboard/mouse → Chromium events
          jsos_window.cc              WM window wrapper
          BUILD.gn
```

### Surface Factory

```cpp
// jsos_surface_factory.cc
class JSOSSurfaceFactory : public SurfaceFactoryOzone {
  std::unique_ptr<SurfaceOzoneCanvas> CreateCanvasWindow(
      gfx::AcceleratedWidget widget) override {
    // Returns a SurfaceOzoneCanvas backed by our DRM fd
  }
  std::unique_ptr<SurfaceOzoneEGL> CreateEGLSurfaceForWidget(
      gfx::AcceleratedWidget widget) override {
    // Returns EGL surface backed by SwiftShader
  }
};
```

### Event Source

```cpp
// jsos_event_source.cc
class JSOSEventSource : public PlatformEventSource {
  void StartProcessingEvents() override {
    // Registers a task that polls kernel.readKey() / kernel.readMouse()
    // and delivers ui::KeyEvent / ui::MouseEvent to Chromium
  }
};
```

### Window

```cpp
// jsos_window.cc
class JSOSWindow : public PlatformWindow {
  // Wraps our WM window — forwards SetBounds, Show, Hide, etc.
  // to the TypeScript WindowManager via C calls
};
```

---

## 9c — base/ POSIX Audit

Chromium's `base/` library uses the following categories. Each is audited
against our Phase 6 implementation:

| Category | Key calls | Phase 6 status |
|---|---|---|
| File I/O | open, read, write, pread, pwrite, fstat | ✅ |
| Directory | opendir, readdir, scandir, mkdir, rmdir | ✅ |
| Processes | fork, execve, waitpid, kill, getpid | ✅ |
| Memory | mmap, munmap, mprotect, madvise | ✅ (madvise: no-op) |
| Threads | pthread_create, mutex, condvar, once | ✅ (via Phase 5) |
| Signals | sigaction, pthread_sigmask | ✅ |
| Time | clock_gettime, gettimeofday, nanosleep | ✅ |
| Sockets | socket, connect, bind, epoll | ✅ (Phase 7) |
| /proc | /proc/self/maps, /proc/self/status | ✅ |
| Locale | setlocale, nl_langinfo | stub (return "C") |
| iconv | character encoding | stub (UTF-8 pass-through) |
| dl | dlopen, dlsym | N/A (static build) |

Gaps discovered during the audit are fixed in our POSIX layer. **Chromium
source is never modified.**

---

## 9d — Sandbox Disabled

Chromium's Linux sandbox uses `seccomp-bpf` and Linux namespaces — neither
exists on JSOS v1.

Launch flags for initial boot:

```
--no-sandbox
--disable-gpu-sandbox
--disable-setuid-sandbox
--in-process-gpu           # no separate GPU process
--single-process           # optional: collapse browser+renderer for debugging
```

JSOS address-space sandbox (Phase 10) will eventually provide equivalent
isolation using our own VMM and signal handling.

---

## 9e — Static Link

The final deliverable is one ELF32 binary on the FAT16 disk.

### Link Order

```
chromium_binary:
  chromium_browser_main   Chromium's main()
  base/ net/ ui/ content/ chrome/
  ozone_jsos              our Ozone backend (9b)
  jsos_posix.a            our POSIX layer (Phase 6)
  jsos_net.a              our sockets/TCP/TLS (Phase 7)
  swiftshader.a           Google SwiftShader (Phase 8)
  mbedtls.a               TLS (Phase 7)
  gbm_jsos.a              GBM shim (Phase 8)
  jsos_libc.a             minimal libc (minimal_libc.c + allocator)
```

Stripped binary size estimate: ~200 MB. This is loaded by the Phase 6 ELF
loader from the FAT16 disk. For an image larger than the default FAT16
partition, the ATA driver handles the extended addressing — FAT16 supports
up to 2 GB with 32KB clusters.

### Launch Sequence

```typescript
// init.ts — Phase 9 service:
const chromiumService: ServiceDefinition = {
  name: 'chromium',
  description: 'Chromium web browser',
  dependencies: ['networking', 'display'],
  start: async () => {
    const win = wm.createWindow({
      title: 'Chromium',
      x: 0, y: 0,
      width: screenWidth,
      height: screenHeight - TASKBAR_HEIGHT,
      app: new ChromiumApp(),
    })
    await processManager.exec('/disk/chromium', [
      '--no-sandbox', '--ozone-platform=jsos',
      '--use-gl=swiftshader',
    ])
  },
}
```

---

## New Files in This Phase

```
chromium/build/config/jsos/
  BUILD.gn
  platform.gni

chromium/ui/ozone/platform/jsos/
  ozone_platform_jsos.cc / .h
  jsos_surface_factory.cc / .h
  jsos_event_source.cc / .h
  jsos_window.cc / .h
  BUILD.gn

chromium/third_party/jsos_sysroot/
  include/       (POSIX headers — see 9a)
  lib/           (static archives)

src/os/apps/chromium-app.ts    ChromiumApp implements App for WM
```

---

## Test Oracle

```
[SERIAL] ELF loader: loaded chromium (204MB)
[SERIAL] Chromium: initialising Ozone JSOS platform
[SERIAL] Chromium: SwiftShader device created
[SERIAL] Chromium: DRM surface acquired
[SERIAL] Chromium: browser window created
[SERIAL] Chromium: navigating to about:blank
[SERIAL] Chromium: first paint complete
```

Visual: browser window visible in JSOS window manager. Address bar shows
`about:blank`. Clicking it allows typing a URL.

---

## What Phase 9 Does NOT Do

- ❌ No sandbox (Phase 10)
- ❌ No multi-process renderer (enable gradually after stability)
- ❌ No hardware GPU (SwiftShader only)
- ❌ No WebRTC (audio — Phase 10)
- ❌ No Widevine / DRM content
- ❌ No extensions API
