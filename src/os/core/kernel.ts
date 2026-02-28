/**
 * JSOS Kernel Bindings
 *
 * TypeScript declarations for the raw platform API exposed by QuickJS.
 * This is the ONLY interface between JavaScript and hardware.
 * All higher-level OS behaviour (terminal, readline, scrollback) is in TypeScript.
 */

/** VGA colour indices (0-15) */
export const enum Color {
  BLACK = 0,
  BLUE = 1,
  GREEN = 2,
  CYAN = 3,
  RED = 4,
  MAGENTA = 5,
  BROWN = 6,
  LIGHT_GREY = 7,
  DARK_GREY = 8,
  LIGHT_BLUE = 9,
  LIGHT_GREEN = 10,
  LIGHT_CYAN = 11,
  LIGHT_RED = 12,
  LIGHT_MAGENTA = 13,
  YELLOW = 14,
  WHITE = 15,
}

export interface MemoryInfo { total: number; free: number; used: number; }
export interface ScreenSize  { width: number; height: number; }
export interface CursorPosition { row: number; col: number; }

export interface KernelColors {
  BLACK: number; BLUE: number; GREEN: number; CYAN: number;
  RED: number; MAGENTA: number; BROWN: number; LIGHT_GREY: number;
  DARK_GREY: number; LIGHT_BLUE: number; LIGHT_GREEN: number;
  LIGHT_CYAN: number; LIGHT_RED: number; LIGHT_MAGENTA: number;
  YELLOW: number; WHITE: number;
}

/**
 * Raw platform API injected by the C kernel into the QuickJS global scope.
 * Only hardware primitives live here  no string formatting, no state.
 */
export interface KernelAPI {
  //  VGA raw cell access 
  /** Write one character at (row, col) with colorByte = (bg<<4)|fg */
  vgaPut(row: number, col: number, ch: string, colorByte: number): void;
  /** Read VGA cell: (colorByte<<8) | charCode */
  vgaGet(row: number, col: number): number;
  /** Write exactly 80 chars to a row; shorter text is space-padded */
  vgaDrawRow(row: number, text: string, colorByte: number): void;
  /** Copy srcRow to dstRow directly in VGA buffer */
  vgaCopyRow(dstRow: number, srcRow: number): void;
  /** Fill a single row with ch + colorByte */
  vgaFillRow(row: number, ch: string, colorByte: number): void;
  /** Fill the entire 8025 VGA buffer */
  vgaFill(ch: string, colorByte: number): void;
  /** Move the hardware blinking cursor */
  vgaSetCursor(row: number, col: number): void;
  /** Hide hardware cursor (entering raw/full-screen mode) */
  vgaHideCursor(): void;
  /** Show hardware cursor */
  vgaShowCursor(): void;
  /** Returns {width: 80, height: 25} */
  getScreenSize(): ScreenSize;
  /** Screen width (80) */
  screenWidth: number;
  /** Screen height (25) */
  screenHeight: number;

  //  Keyboard (raw, no echo) 
  /** Non-blocking poll; returns '' when nothing is ready */
  readKey(): string;
  /** Non-blocking extended poll; checks arrow/special keys first, then char buffer.
   *  Returns {ch, ext} or null when nothing is queued. Use this in WM event loops. */
  readKeyEx(): { ch: string; ext: number } | null;
  /** Blocking; waits for next printable character */
  waitKey(): string;
  /** Blocking; returns {ch, ext}  ext != 0 for special/extended keys */
  waitKeyEx(): { ch: string; ext: number };
  /** Returns true if a keypress is queued */
  hasKey(): boolean;

  //  Timer 
  getTicks(): number;
  getUptime(): number;   /* milliseconds since boot */
  sleep(ms: number): void;

  //  Memory 
  getMemoryInfo(): MemoryInfo;

  //  Port I/O 
  inb(port: number): number;
  outb(port: number, value: number): void;

  //  Native code execution 
  /** Call a void C/ASM function at the given 32-bit address */
  callNative(addr: number): void;
  /** Call a C/ASM function at addr with up to 3 int32 args; returns int32 */
  callNativeI(addr: number, a0?: number, a1?: number, a2?: number): number;
  /** Read one byte from a physical memory address */
  readMem8(addr: number): number;
  /** Write one byte to a physical memory address */
  writeMem8(addr: number, value: number): void;
  /**
   * Bulk-read `length` bytes from physical address `addr`.
   * Returns an ArrayBuffer copy (max 1 MB), or null on failure.
   */
  readPhysMem(addr: number, length: number): ArrayBuffer | null;
  /** Bulk-write an ArrayBuffer to a physical address. */
  writePhysMem(addr: number, data: ArrayBuffer): void;

  //  System 
  halt(): void;
  reboot(): void;
  /** Evaluate a JS string in the global QuickJS context; returns result as string */
  eval(code: string): string;
  /** Write a string to the serial port (COM1) — appears on QEMU -serial stdio */
  serialPut(s: string): void;
  /** Read one byte from COM1; returns -1 if no data available */
  serialGetchar(): number;

  // ─ ATA block device ─────────────────────────────────────────────────────
  /** Returns true if an ATA drive was detected at boot */
  ataPresent(): boolean;
  /**   * Returns the total number of 512-byte sectors reported by the ATA IDENTIFY
   * command (LBA28 addressable count).  Returns 0 if no drive is present.
   */
  ataSectorCount(): number;
  /**   * Read `sectors` (1-8) sectors starting at `lba`.
   * Returns a flat byte array of length `sectors * 512`, or null on error.
   */
  ataRead(lba: number, sectors: number): number[] | null;
  /**
   * Write `sectors` (1-8) sectors starting at `lba`.
   * `data` must be a flat byte array of exactly `sectors * 512` bytes.
   * Returns true on success.
   */
  ataWrite(lba: number, sectors: number, data: number[]): boolean;

  // ─ Framebuffer (Phase 3) ─────────────────────────────────────────────────
  /**
   * Returns framebuffer info if GRUB negotiated a pixel graphics mode,
   * or null if no framebuffer is available (fallback to VGA text).
   */
  fbInfo(): { width: number; height: number; pitch: number; bpp: number } | null;
  /**
   * Copy pixel data to the framebuffer at (x, y).
   * Fast path: pass a Uint32Array.buffer (ArrayBuffer) for zero-copy memcpy.
   * Legacy path: a plain number[] also works but is ~1000× slower.
   * pixels byte-length (or array length) must equal w * h * 4 (or w * h).
   * No-op if no framebuffer available.
   */
  fbBlit(pixels: ArrayBuffer | number[], x: number, y: number, w: number, h: number): void;

  /**
   * Inject and execute raw x86 machine code.
   * hexBytes: space/comma-separated hex bytes, e.g. "B8 2A 00 00 00 C3" (mov eax,42; ret).
   * Runs as a cdecl void→uint32_t function in ring-0; returns the EAX result.
   * WARNING: no sandboxing — you are executing kernel-mode machine code.
   */
  volatileAsm(hexBytes: string): number;

  // ─ Deferred preemption (Phase 5) ──────────────────────────────────────────
  /**
   * Cooperatively yield to the TypeScript scheduler hook right now.
   * Safe to call from any JS context (WM loop top, busy-wait loops, etc.).
   */
  yield(): void;
  /**
   * Returns how many IRQ0 timer ticks have fired since the last call, then
   * resets the counter to zero.  Use this to decide when to call yield().
   */
  schedTick(): number;

  // ─ Mouse (Phase 3) ───────────────────────────────────────────────────────
  /**
   * Returns the next PS/2 mouse packet, or null if the queue is empty.
   * dx/dy are signed relative motion; buttons is a bitmask (bit0=left, bit1=right, bit2=middle).
   */
  readMouse(): { dx: number; dy: number; buttons: number } | null;

  // ─ Memory map + paging (Phase 4) ─────────────────────────────────────────
  /**
   * Returns the highest usable physical address from the multiboot2 memory map.
   * For a 512 MB QEMU VM this is 0x20000000 (536870912 bytes).
   * Use this to determine total RAM without iterating the full memory map.
   */
  getRamBytes(): number;
  /**
   * Returns the multiboot2 memory map as an array of entries.
   * type: 1=usable, 2=reserved, 3=ACPI reclaimable, 4=ACPI NVS, 5=bad RAM.
   * base/length are 32-bit unsigned values (addresses < 4 GB).
   */
  getMemoryMap(): Array<{ base: number; baseHi: number; length: number; lenHi: number; type: number }>;
  /**
   * Write addr into CR3 (page directory physical address).
   * Side-effect: flushes entire TLB.
   */
  setPDPT(addr: number): void;
  /** Flush the entire non-global TLB by re-writing CR3 to itself. */
  flushTLB(): void;
  /**
   * Write one entry in the kernel's static page directory.
   *   pdIdx: 0-1023 index into the page directory.
   *   ptIdx: 0-1023 index into the page table at pdIdx (ignored for huge pages).
   *   physAddr: physical address (page-aligned).
   *   flags: combination of PageFlag constants.
   * If PageFlag.HUGE is set, a 4 MB page is mapped and ptIdx is ignored.
   */
  setPageEntry(pdIdx: number, ptIdx: number, physAddr: number, flags: number): void;
  /**
   * Enable hardware paging: sets CR4.PSE, loads CR3, sets CR0.PG.
   * Returns true on success; false if the page directory appears empty (safety check).
   * CALL ONLY AFTER setPageEntry() has mapped at least PDE[0].
   */
  enablePaging(): boolean;

  // ─ Scheduler hook + TSS (Phase 5) ────────────────────────────────────────
  /**
   * Register the TypeScript scheduler tick function.
   * The function will be called cooperatively at yield points.
   * It should return the new thread's savedESP (or 0 to keep current).
   */
  registerSchedulerHook(fn: () => number): void;
  /**
   * Update TSS.ESP0 — the kernel stack top for ring-3 → ring-0 transitions.
   * Call this whenever the scheduler switches to a new thread (Phase 6+).
   */
  tssSetESP0(addr: number): void;

  // ─ Process primitives (Phase 6) ───────────────────────────────────────────────
  /**
   * Clone the current page directory.
   * Phase 6 stub: returns 0 (full eager-copy implementation in Phase 9).
   * TypeScript treats the return value as an opaque CR3 handle.
   */
  cloneAddressSpace(): number;
  /**
   * Switch to ring-3 (user mode) at eip with stack pointer esp.
   * Phase 6 stub: no-op (real ring-3 transition added in Phase 9).
   * Never returns when implemented.
   */
  jumpToUserMode(eip: number, esp: number): void;
  /**
   * Read CR2 — the faulting linear address from the last page-fault exception.
   * Called by the TypeScript page-fault handler to identify the bad address.
   */
  getPageFaultAddr(): number;

  // ─ Network (Phase 7) ──────────────────────────────────────────────────────
  /**
   * Probe PCI for a virtio-net device and initialise TX/RX virtqueues.
   * Returns true when a NIC is found and ready; false if no virtio-net present.
   */
  netInit(): boolean;
  /**
   * Send a raw Ethernet frame (without FCS).
   * bytes is a plain number[] from TypeScript; max length 1514.
   */
  netSendFrame(bytes: number[]): void;
  /**
   * Poll the NIC for one received Ethernet frame.
   * Returns null when the RX ring is empty, or a number[] of the frame bytes.
   * Max frame length is 1514 bytes.
   */
  netRecvFrame(): number[] | null;
  /**
   * Returns the NIC's MAC address as a 6-element number[].
   */
  netMacAddress(): number[];
  /**
   * Returns the PCI bus:dev.fn location string (e.g. "00:03.0").
   */
  netPciAddr(): string;
  netDebugRxIdx(): number;
  netDebugInfo(): number;
  netDebugStatus(): number;
  netDebugQueues(): number;

  // ─ Multi-process pool (Phase 10) ───────────────────────────────────
  /** Allocate a new isolated QuickJS runtime slot. Returns id 0-7, or -1 if all 8 are taken. */
  procCreate(): number;
  /** Evaluate code in child runtime synchronously. Returns result string or 'Error:...'. */
  procEval(id: number, code: string): string;
  /**
   * Time-limited eval. Aborts after maxMs milliseconds via QuickJS interrupt handler.
   * Returns: 'done:<result>' | 'timeout' | 'error:<message>'.  maxMs ≤ 0 = unlimited.
   */
  procEvalSlice(id: number, code: string, maxMs: number): string;
  /** Pump the child's pending async/Promise job queue. Returns jobs-run count. */
  procTick(id: number): number;
  /** Push a string message into child inbox ring buffer. Returns false if full (8 slots). */
  procSend(id: number, msg: string): boolean;
  /** Pop a string message from child outbox. Returns null when empty. */
  procRecv(id: number): string | null;
  /** Free a child runtime and release the slot. */
  procDestroy(id: number): void;
  /** Returns true if the slot is live. */
  procAlive(id: number): boolean;
  /** List all live child process slots: [{id, inboxCount, outboxCount}]. */
  procList(): Array<{ id: number; inboxCount: number; outboxCount: number }>;

  // ─ Shared memory buffers (Phase 10) ────────────────────────────────
  /**
   * Allocate a shared BSS buffer (max 256 KB). Returns id 0-7, or -1 if all 8 slots are taken.
   * The same physical memory is accessible from any runtime via sharedBufferOpen(id).
   */
  sharedBufferCreate(size: number): number;
  /**
   * Get an ArrayBuffer view of shared slot id. Zero-copy — same physical bytes.
   * Callable from both parent runtime and child kernel.sharedBufferOpen(id).
   * Returns null if the id is invalid or unallocated.
   */
  sharedBufferOpen(id: number): ArrayBuffer | null;
  /** Release a shared buffer slot (bytes stay in BSS until reused). */
  sharedBufferRelease(id: number): void;
  /** Returns the byte size allocated for a shared buffer slot, or 0. */
  sharedBufferSize(id: number): number;

  // ─ JIT compiler primitives (Phase 11) ─────────────────────────────────────
  /**
   * Allocate `size` bytes of execute+read+write memory from the 256 KB JIT pool.
   * Allocations are 16-byte aligned. Returns a physical address (uint32), or 0 on failure.
   * There is no free — pool is bump-allocated. Max single allocation: 64 KB.
   */
  jitAlloc(size: number): number;
  /**
   * Copy machine code bytes into a JIT allocation.
   * `addr` must have been returned by jitAlloc().
   * `bytes` may be a plain number[] or an ArrayBuffer (fast path, zero memcpy overhead).
   */
  jitWrite(addr: number, bytes: number[] | ArrayBuffer): void;
  /**
   * Call a JIT-compiled cdecl function at `addr` with up to 4 int32 arguments.
   * Returns the int32 result (EAX). Pass 0 for unused arguments.
   * WARNING: executes kernel-mode machine code with no sandboxing.
   */
  jitCallI(addr: number, a0?: number, a1?: number, a2?: number, a3?: number): number;
  /**
   * Call a JIT-compiled cdecl function at `addr` with up to 8 int32 arguments.
   * Required for functions with 5–8 parameters (e.g. fillRect, blitAlphaRect).
   * Returns the int32 result (EAX). Pass 0 for unused arguments.
   */
  jitCallI8(addr: number,
    a0?: number, a1?: number, a2?: number, a3?: number,
    a4?: number, a5?: number, a6?: number, a7?: number): number;
  /**
   * Call a JIT-compiled float64 function at `addr` (x87 double-cdecl ABI).
   * Produced by FloatJITCompiler. All args and return value are IEEE-754 doubles.
   * Use QJSJITHook.getFloatAddr(bcAddr) to obtain the native address.
   */
  jitCallF4(addr: number, a0?: number, a1?: number, a2?: number, a3?: number): number;
  /**
   * Returns the number of bytes currently consumed in the 8 MB main JIT pool.
   * Useful for budget checks and debugging.  Pool capacity = 8,388,608 bytes.
   */
  jitUsedBytes(): number;
  /**
   * Reset the main JIT pool bump pointer to zero, reclaiming all 8 MB.
   * The TypeScript QJSJITHook is responsible for clearing all live
   * jit_native_ptr fields before calling this (to prevent stale call targets).
   * Returns the number of bytes reclaimed.
   */
  jitMainReset(): number;
  /**
   * Return the physical (linear) address of a JS ArrayBuffer's backing store.
   * QuickJS uses reference-counting (not a moving GC), so the pointer is stable
   * for the buffer's lifetime.  Returns 0 if the value is not an ArrayBuffer.
   *
   * JSOS-specific: allows JIT-compiled native code to read/write TypedArray data
   * (canvas pixel buffers, audio, etc.) without a copy.
   */
  physAddrOf(ab: ArrayBuffer): number;
  /**
   * Return uint32 physical addresses of C helper functions callable from JIT'd x86 code.
   * The returned addresses can be loaded into ECX and invoked via `CALL ECX` (cdecl).
   * - `getPropI32`: jit_js_getprop_i32(obj_ptr: uint32, atom: uint32) → int32
   * - `setPropI32`: jit_js_setprop_i32(obj_ptr: uint32, atom: uint32, val: int32)
   * - `callFn`:    jit_js_call_fn(fn_ptr: uint32, a0..a3: int32, argc: int32) → int32
   */
  jitHelperAddrs(): { getPropI32: number; setPropI32: number; callFn: number };

  // ─ Step 3: QuickJS internal struct offsets ─────────────────────────────────
  /**
   * Returns a frozen object describing the byte offsets of fields in the
   * JSFunctionBytecode struct used by the JSOS-patched QuickJS build.
   * Used by QJSBytecodeReader in qjs-jit.ts to interpret live GC objects.
   */
  qjsOffsets(): {
    gcHeaderSize: number;  /** size of GCObjectHeader prefix                   */
    objShape:     number;  /** offset of JSShape* field                        */
    objSize:      number;  /** offset of proto JSValue (8-byte pair on 32-bit) */
    callCount:    number;  /** offset of call_count uint32 (Step-5 field)      */
    jitNativePtr: number;  /** offset of jit_native_ptr void* (Step-5 field)   */
    bcBuf:        number;  /** offset of byte_code_buf uint8*                  */
    bcLen:        number;  /** offset of byte_code_len int                     */
    funcName:     number;  /** offset of func_name JSAtom                      */
    argCount:     number;  /** offset of arg_count uint16                      */
    varCount:     number;  /** offset of var_count uint16                      */
    stackSize:    number;  /** offset of stack_size uint16                     */
    cpoolPtr:     number;  /** offset of cpool JSValue*                        */
    cpoolCount:   number;  /** offset of cpool_count uint16                    */
    structSize:   number;  /** total sizeof(JSFunctionBytecode)                */
  };

  // ─ Step 5: QJS JIT hook + per-process JIT management ──────────────────────
  /**
   * Install the TypeScript JIT compiler callback.
   * callback(bcAddr, spAddr, argc) → 1 if native code was installed, else 0.
   */
  setJITHook(callback: (bcAddr: number, spAddr: number, argc: number) => number): void;
  /**
   * Write `nativeAddr` into the jit_native_ptr field of the JSFunctionBytecode
   * at `bcAddr` so QuickJS dispatches the compiled version on the next call.
   */
  setJITNative(bcAddr: number, nativeAddr: number): void;
  /**
   * Return and consume the next pending JIT compilation address for child
   * process `id`.  Returns 0 if no compilation is pending.
   */
  procPendingJIT(id: number): number;
  /**
   * Allocate `size` bytes from the per-process 512 KB JIT slab for child `id`.
   * Returns the physical address of the allocation, or 0 on failure.
   */
  jitProcAlloc(id: number, size: number): number;

  // ─ FPU / SSE context save & restore (item 147) ───────────────────────────
  /**
   * Allocate a 512-byte, 16-byte-aligned physical buffer for FXSAVE/FXRSTOR.
   * Returns the physical address, or 0 on OOM.
   * The caller must keep this address alive for the lifetime of the process.
   */
  fpuAllocState(): number;
  /**
   * Execute `FXSAVE` into the 512-byte buffer at `physAddr`.
   * `physAddr` must be 16-byte aligned (returned by `fpuAllocState()`).
   * Returns `true` on success, `false` if the address is invalid/unaligned.
   */
  fpuSave(physAddr: number): boolean;
  /**
   * Execute `FXRSTOR` from the 512-byte buffer at `physAddr`.
   * `physAddr` must be 16-byte aligned (returned by `fpuAllocState()`).
   * Returns `true` on success, `false` if the address is invalid/unaligned.
   */
  fpuRestore(physAddr: number): boolean;

  // Phase A/B: child process render surface + infrastructure

  /** Return a view of the BSS render slab for child process `id` (width×height×4 bytes). */
  getProcRenderBuffer(id: number): ArrayBuffer;

  /** Set the render surface dimensions for child process `id` (call before procEval). */
  procSetDimensions(id: number, w: number, h: number): void;

  /**
   * Register the TypeScript FS bridge object so child runtimes can perform
   * file I/O via the main-runtime's filesystem implementation.
   */
  registerChildFSBridge(bridge: {
    readFile(path: string): string | null;
    writeFile(path: string, content: string): boolean;
    readDir(path: string): string;   // JSON array of names
    exists(path: string): boolean;
    stat(path: string): string | null; // JSON object or null
  }): void;

  /** JSON-encode `ev` and push it into the child's event queue. */
  procSendEvent(id: number, ev: object): void;

  /** Dequeue the next window-management command from child process `id`. */
  procDequeueWindowCommand(id: number): { type: string; [k: string]: any } | null;

  /** Fire any expired timers for child process `id` (call after procTick). */
  serviceTimers(id: number): void;

  // ─ Disk I/O (item 177) ────────────────────────────────────────────────────
  /**
   * Read a 512-byte sector from disk `diskId` at sector number `sectorNo`.
   * Returns a Uint8Array of length 512, or an empty Uint8Array on error.
   * diskId: 0 = primary ATA (same as ataRead), 1 = secondary, etc.
   */
  readDiskSector(diskId: number, sectorNo: number): Uint8Array;

  // ─ Initramfs (item 168) ───────────────────────────────────────────────────
  /**
   * Return the embedded CPIO initramfs image as an ArrayBuffer, or null if
   * no initramfs was embedded in the kernel binary.
   */
  getInitramfs(): ArrayBuffer | null;

  // ─ Zero-copy NIC DMA (item 922) ──────────────────────────────────────────
  /**
   * Register `buffer` as a DMA target for connection `connFd`.
   * Returns an opaque NIC handle used by nicDmaRecv / nicDmaUnregister.
   */
  nicDmaRegister(connFd: number, buffer: ArrayBuffer): number;
  /**
   * Receive data into the previously registered DMA buffer.
   * Returns the number of bytes received, or 0 if no data is available.
   */
  nicDmaRecv(nicHandle: number): number;
  /** Unregister the DMA buffer for `nicHandle`. */
  nicDmaUnregister(nicHandle: number): void;

  // ─ TCP primitives (item 924 / 932) ────────────────────────────────────────
  /**
   * Send `data` on connection `connFd`.
   * Zero-copy path: an ArrayBuffer is passed directly to the kernel TX ring.
   */
  tcpSend(connFd: number, data: ArrayBuffer): void;
  /**
   * Open a new TCP connection to `host:port`.
   * `https` = true wraps in TLS.
   * Returns a connection file descriptor (>= 0) or -1 on failure.
   * Non-blocking: caller should poll or await completion via event.
   */
  tcpConnect(host: string, port: number, https: boolean): number;

  // ─ Idle scheduler (item 932) ─────────────────────────────────────────────
  /**
   * Schedule `fn` to run the next time the system is idle (no runnable processes).
   * The callback is called at most once; re-register to run again.
   */
  scheduleIdle(fn: () => void): void;

  // ─ Hardware RNG (item 348) ───────────────────────────────────────────────
  /**
   * Read one 32-bit hardware-random word via the RDRAND CPU instruction.
   * Retries up to 10 times (Intel recommendation); falls back to a TSC-derived
   * value if RDRAND is unavailable or exhausted.
   * @returns Unsigned 32-bit integer in range [0, 2^32 − 1].
   */
  rdrand(): number;

  // ─ Audio hardware drivers (items 825–827) ────────────────────────────────
  /** AC97: set sample rate. */
  ac97SetRate?(hz: number): void;
  /** AC97: set master volume (0-100). */
  ac97SetVolume?(vol: number): void;
  /** AC97: DMA write — `ptr` is an ArrayBuffer, `len` is byte length. */
  ac97WriteBuffer?(ptr: ArrayBuffer, len: number): void;
  /** Intel HDA: open a PCM output stream. Returns stream ID or -1. */
  hdaOpenStream?(sampleRate: number, channels: number, bitsPerSample: number): number;
  /** Intel HDA: write PCM data to an open stream. */
  hdaWriteStream?(streamId: number, ptr: ArrayBuffer, len: number): void;
  /** Intel HDA: close an open stream. */
  hdaCloseStream?(streamId: number): void;
  /** Virtio-sound: open a PCM output stream. Returns stream ID or -1. */
  virtioSoundOpen?(sampleRate: number, channels: number): number;
  /** Virtio-sound: write PCM data to a stream. */
  virtioSoundWrite?(streamId: number, ptr: ArrayBuffer, len: number): void;
  /** Virtio-sound: close a stream. */
  virtioSoundClose?(streamId: number): void;

  // ─ Real-time clock / wall clock (NTP items) ──────────────────────────────
  /**
   * Read the hardware RTC.
   * Returns `{ unix: number }` where `unix` is Unix epoch seconds, or null if unavailable.
   */
  rtcRead?(): { unix: number } | null;
  /** Set the OS wall-clock epoch (Unix seconds). */
  setWallClock?(epoch: number): void;
  /** Get the OS wall-clock epoch (Unix seconds, tracking from last NTP sync or RTC). */
  getWallClock?(): number;

  //  Constants 
  colors: KernelColors;
  KEY_UP: number;    KEY_DOWN: number;   KEY_LEFT: number;  KEY_RIGHT: number;
  KEY_HOME: number;  KEY_END: number;    KEY_PAGEUP: number; KEY_PAGEDOWN: number;
  KEY_DELETE: number;
  KEY_F1: number; KEY_F2: number; KEY_F3: number;  KEY_F4: number;
  KEY_F5: number; KEY_F6: number; KEY_F7: number;  KEY_F8: number;
  KEY_F9: number; KEY_F10: number; KEY_F11: number; KEY_F12: number;
}

declare var kernel: KernelAPI;

/**
 * Page table entry flag constants for use with kernel.setPageEntry().
 * These match the i686 hardware PTE/PDE bit definitions.
 */
export namespace PageFlag {
  export const PRESENT       = 0x001;  /** Page is present in memory */
  export const WRITABLE      = 0x002;  /** Page is writable */
  export const USER          = 0x004;  /** Accessible from ring 3 (user mode) */
  export const WRITE_THROUGH = 0x008;  /** Write-through caching */
  export const NO_CACHE      = 0x010;  /** Disable caching for this page */
  export const ACCESSED      = 0x020;  /** Set by CPU on first access */
  export const DIRTY         = 0x040;  /** Set by CPU on first write */
  export const HUGE          = 0x080;  /** 4 MB page (PS bit in PDE; requires CR4.PSE) */
  export const GLOBAL        = 0x100;  /** Not flushed from TLB on CR3 write */
}
