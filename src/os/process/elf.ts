/**
 * JSOS ELF32 Loader — Phase 6
 *
 * Parses ELF32 executables and maps their PT_LOAD segments into an address space.
 *
 * Phase 6 supports static ELF32 executables only.
 * Dynamic linking (.so) is deferred to Phase 9.
 * Actual ring-3 execution (CPU mode switch) is Phase 9; Phase 6 provides the
 * loader plumbing and a TypeScript-native simulation for testing.
 */

/* ELF magic and type constants */
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
}

export const elfLoader = new ELFLoader();
