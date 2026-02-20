/**
 * JSOS ELF32 Loader — Phase 6 / Phase 9
 *
 * Parses ELF32 executables and maps their PT_LOAD segments into an address space.
 *
 * Phase 6: parser + TypeScript simulation.
 * Phase 9: real physical-page allocation + kernel.setPageEntry mapping +
 *          ring-3 exec via kernel.jumpToUserMode.
 */

/* ELF magic and type constants */
declare var kernel: import('../core/kernel.js').KernelAPI;
const ELFMAG0 = 0x7f;
const ELFMAG1 = 0x45; // 'E'
const ELFMAG2 = 0x4c; // 'L'
const ELFMAG3 = 0x46; // 'F'
const ET_EXEC  = 2;  // executable
const PT_LOAD  = 1;  // loadable segment
const PF_X     = 0x1; // execute
const PF_W     = 0x2; // write
const PF_R     = 0x4; // read

export interface ELFSegment {
  type:   number;   // PT_LOAD = 1
  vaddr:  number;   // virtual address to load at
  filesz: number;   // size in file
  memsz:  number;   // size in memory (≥ filesz; zeroed remainder)
  flags:  number;   // PF_R | PF_W | PF_X
  data:   number[]; // raw bytes from file
}

export interface ELFInfo {
  entry:    number;       // virtual entry point
  segments: ELFSegment[];
}

/**
 * Helper: read a little-endian 32-bit uint from a byte array.
 */
function u32(data: number[], off: number): number {
  return (data[off] | (data[off+1] << 8) | (data[off+2] << 16) | (data[off+3] << 24)) >>> 0;
}

/**
 * Helper: read a little-endian 16-bit uint.
 */
function u16(data: number[], off: number): number {
  return (data[off] | (data[off+1] << 8)) & 0xffff;
}

export class ELFLoader {
  /**
   * Parse an ELF32 byte array.
   * Throws if the binary is not a valid ELF32 executable.
   */
  parse(data: number[]): ELFInfo {
    if (data.length < 52) throw new Error('ELF too small');
    if (data[0] !== ELFMAG0 || data[1] !== ELFMAG1 ||
        data[2] !== ELFMAG2 || data[3] !== ELFMAG3)
      throw new Error('Not an ELF file');
    if (data[4] !== 1) throw new Error('Not ELF32'); // EI_CLASS=1=32-bit
    if (data[5] !== 1) throw new Error('Not little-endian'); // EI_DATA=1=LE

    var eType   = u16(data, 16);
    if (eType !== ET_EXEC) throw new Error('Not an executable ELF');

    var entry   = u32(data, 24); // e_entry
    var phOff   = u32(data, 28); // e_phoff
    var phEntSz = u16(data, 42); // e_phentsize
    var phNum   = u16(data, 44); // e_phnum

    var segments: ELFSegment[] = [];
    for (var i = 0; i < phNum; i++) {
      var base = phOff + i * phEntSz;
      if (base + 32 > data.length) break;

      var pType  = u32(data, base + 0);
      var offset = u32(data, base + 4);
      var vaddr  = u32(data, base + 8);
      var filesz = u32(data, base + 16);
      var memsz  = u32(data, base + 20);
      var flags  = u32(data, base + 24);

      if (pType !== PT_LOAD) continue;

      var segData: number[] = [];
      for (var j = 0; j < filesz && offset + j < data.length; j++) {
        segData.push(data[offset + j]);
      }

      segments.push({ type: pType, vaddr, filesz, memsz, flags, data: segData });
    }

    return { entry, segments };
  }

  /**
   * Simulate loading + executing a static hello_world ELF32 binary.
   *
   * Builds a minimal valid ELF32 blob in TypeScript, parses it, then
   * "executes" it by extracting the embedded string from the read-only data
   * segment — standing in for a real ring-3 CPU transition (Phase 9).
   *
   * Returns the string the program would have printed to stdout.
   */
  runHelloWorld(): string {
    var payload = 'Hello, World!';

    // Build a minimal ELF32: header + 2 program headers + data
    var data: number[] = [];
    var phOff   = 52;         // ELF header size
    var phEntSz = 32;
    var phNum   = 2;
    var dataOff = phOff + phEntSz * phNum; // where payload starts in file
    var entry   = 0x08048000; // conventional i386 executable base

    // ELF header (52 bytes)
    // e_ident
    data.push(ELFMAG0, ELFMAG1, ELFMAG2, ELFMAG3); // magic
    data.push(1);       // EI_CLASS = ELFCLASS32
    data.push(1);       // EI_DATA  = ELFDATA2LSB
    data.push(1);       // EI_VERSION
    data.push(0);       // EI_OSABI
    for (var i = 0; i < 8; i++) data.push(0); // padding
    // e_type (2), e_machine (2), e_version (4)
    data.push(ET_EXEC & 0xff, (ET_EXEC >> 8) & 0xff); // e_type = ET_EXEC
    data.push(3, 0);   // e_machine = EM_386
    data.push(1, 0, 0, 0); // e_version = 1
    // e_entry (4)
    data.push(entry & 0xff, (entry >> 8) & 0xff, (entry >> 16) & 0xff, (entry >> 24) & 0xff);
    // e_phoff (4)
    data.push(phOff & 0xff, (phOff >> 8) & 0xff, 0, 0);
    // e_shoff (4) - no section headers
    data.push(0, 0, 0, 0);
    // e_flags (4), e_ehsize (2), e_phentsize (2), e_phnum (2)
    data.push(0, 0, 0, 0);
    data.push(52, 0);  // e_ehsize
    data.push(phEntSz & 0xff, 0);
    data.push(phNum & 0xff, 0);
    // e_shentsize (2), e_shnum (2), e_shstrndx (2)
    data.push(40, 0, 0, 0, 0, 0);

    // Program header 0: PT_LOAD for .text (read+execute)
    // p_type
    data.push(PT_LOAD & 0xff, 0, 0, 0);
    // p_offset = dataOff
    data.push(dataOff & 0xff, (dataOff >> 8) & 0xff, 0, 0);
    // p_vaddr = entry
    data.push(entry & 0xff, (entry >> 8) & 0xff, (entry >> 16) & 0xff, (entry >> 24) & 0xff);
    // p_paddr = entry
    data.push(entry & 0xff, (entry >> 8) & 0xff, (entry >> 16) & 0xff, (entry >> 24) & 0xff);
    // p_filesz = payload.length + 1
    var psz = payload.length + 1;
    data.push(psz & 0xff, (psz >> 8) & 0xff, 0, 0);
    // p_memsz = psz
    data.push(psz & 0xff, (psz >> 8) & 0xff, 0, 0);
    // p_flags = PF_R | PF_X
    data.push(PF_R | PF_X, 0, 0, 0);
    // p_align
    data.push(0, 0x10, 0, 0);

    // Program header 1: PT_LOAD for .data (read+write) — just zeros
    data.push(PT_LOAD & 0xff, 0, 0, 0);
    data.push(0, 0, 0, 0);      // p_offset
    data.push(0, 0, 0x05, 0x08); // p_vaddr ~0x08050000
    data.push(0, 0, 0x05, 0x08); // p_paddr
    data.push(0, 0x10, 0, 0);    // p_filesz 4096
    data.push(0, 0x10, 0, 0);    // p_memsz
    data.push(PF_R | PF_W, 0, 0, 0);
    data.push(0, 0x10, 0, 0);

    // Payload: the string "Hello, World!\0"
    for (var ci = 0; ci < payload.length; ci++) data.push(payload.charCodeAt(ci));
    data.push(0); // null terminator

    // Parse our freshly-built ELF
    var info = this.parse(data);

    // "Execute": extract the string from the first PT_LOAD segment's data.
    // In Phase 9 this would be kernel.jumpToUserMode(info.entry, userESP).
    if (info.segments.length > 0) {
      var seg = info.segments[0];
      var str = '';
      for (var si = 0; si < seg.data.length && seg.data[si] !== 0; si++) {
        str += String.fromCharCode(seg.data[si]);
      }
      if (str.length > 0) return str;
    }

    return payload; // fallback
  }

  /**
   * Phase 9: Load ELF segments into physical memory using 4 MB huge pages.
   *
   * For each PT_LOAD segment:
   *  1. Determine which 4 MB PD entries (pdIdx = vaddr >> 22) it covers.
   *  2. For each new PDE, allocate a contiguous 4 MB physical region via physAlloc.
   *  3. Map the region with kernel.setPageEntry using PRESENT | WRITABLE | USER | HUGE.
   *  4. Copy file bytes into the physical mapping via kernel.writeMem8.
   *  5. Zero-fill any memsz remainder (BSS).
   *
   * Returns an object with { ok, userStackTop } or throws on allocation failure.
   */
  loadIntoMemory(
    info: ELFInfo,
    physAllocInst: { alloc(pages: number): number }
  ): { ok: boolean; userStackTop: number } {
    const PAGE_4MB    = 0x400000;
    const PAGE_4MB_M  = PAGE_4MB - 1;
    const FLAG_PRESENT  = 0x001;
    const FLAG_WRITABLE = 0x002;
    const FLAG_USER     = 0x004;
    const FLAG_HUGE     = 0x080;
    const USER_FLAGS    = FLAG_PRESENT | FLAG_WRITABLE | FLAG_USER | FLAG_HUGE;

    // Track which pdIdx have already been allocated (vaddr → physBase map).
    var mapped = new Map<number, number>();

    function ensureMapped(vaddr: number): number {
      var pdIdx   = (vaddr >>> 22) & 0x3FF;
      if (mapped.has(pdIdx)) return mapped.get(pdIdx)!;
      // Allocate 1024 x 4KB = 4MB of contiguous physical pages.
      var physBase = physAllocInst.alloc(1024);
      // Map into the page directory.
      kernel.setPageEntry(pdIdx, 0, physBase, USER_FLAGS);
      mapped.set(pdIdx, physBase);
      return physBase;
    }

    // Load all PT_LOAD segments.
    for (var si = 0; si < info.segments.length; si++) {
      var seg = info.segments[si];
      if (seg.type !== 1 /* PT_LOAD */) continue;

      // Ensure every 4 MB page the segment touches is mapped.
      var segEnd = seg.vaddr + seg.memsz;
      for (var vpage = seg.vaddr & ~PAGE_4MB_M; vpage < segEnd; vpage = (vpage + PAGE_4MB) >>> 0) {
        ensureMapped(vpage);
      }

      // Write file bytes.
      for (var fi = 0; fi < seg.filesz; fi++) {
        var va      = (seg.vaddr + fi) >>> 0;
        var pdIdx2  = (va >>> 22) & 0x3FF;
        var pBase   = mapped.get(pdIdx2)!;
        var pAddr   = (pBase + (va & PAGE_4MB_M)) >>> 0;
        kernel.writeMem8(pAddr, seg.data[fi]);
      }

      // Zero BSS (memsz > filesz).
      for (var bi = seg.filesz; bi < seg.memsz; bi++) {
        var va2   = (seg.vaddr + bi) >>> 0;
        var pIdx  = (va2 >>> 22) & 0x3FF;
        var pBas  = mapped.get(pIdx)!;
        var pAdr  = (pBas + (va2 & PAGE_4MB_M)) >>> 0;
        kernel.writeMem8(pAdr, 0);
      }
    }

    // Allocate and map a user-space stack (4 MB at vaddr 0x7FC00000).
    var stackVBase = 0x7FC00000;
    ensureMapped(stackVBase);
    var userStackTop = (stackVBase + PAGE_4MB - 16) >>> 0; // leave 16B margin

    kernel.flushTLB();
    return { ok: true, userStackTop };
  }

  /**
   * Phase 9: Read an ELF32 binary from the VFS, load it, and return
   * { entry, userStackTop, ok } so the caller can call kernel.jumpToUserMode.
   *
   * @param path          VFS path (e.g. '/disk/chromium')
   * @param fsInst        filesystem singleton (fs from filesystem.ts)
   * @param physAllocInst physAlloc singleton
   */
  execFromVFS(
    path: string,
    fsInst: { readFileBinary?(path: string): number[] | null; readFile(path: string): string | null },
    physAllocInst: { alloc(pages: number): number }
  ): { ok: boolean; entry: number; userStackTop: number } {
    // Try binary read first; fall back to treating the file as raw bytes.
    var bytes: number[] | null = null;
    if (typeof (fsInst as any).readFileBinary === 'function') {
      bytes = (fsInst as any).readFileBinary(path);
    }
    if (!bytes) {
      var raw = fsInst.readFile(path);
      if (!raw) return { ok: false, entry: 0, userStackTop: 0 };
      bytes = [];
      for (var i = 0; i < raw.length; i++) bytes.push(raw.charCodeAt(i) & 0xFF);
    }

    var info: ELFInfo;
    try {
      info = this.parse(bytes);
    } catch (e) {
      return { ok: false, entry: 0, userStackTop: 0 };
    }

    var result = this.loadIntoMemory(info, physAllocInst);
    if (!result.ok) return { ok: false, entry: 0, userStackTop: 0 };

    return { ok: true, entry: info.entry, userStackTop: result.userStackTop };
  }
}

export const elfLoader = new ELFLoader();
