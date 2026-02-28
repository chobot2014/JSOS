/**
 * JSOS NFS Client — Item 203
 *
 * NFSv3 client implemented in TypeScript over a UDP/TCP raw socket abstraction.
 * Implements the XDR (eXternal Data Representation) codec and the core
 * NFS procedures needed for read-only filesystem access.
 *
 * RPC/XDR wire format (RFC 1831), NFS v3 (RFC 1813).
 */

import type { FileType, VFSMount } from './filesystem.js';

// ── XDR codec ─────────────────────────────────────────────────────────────────

class XDREncoder {
  private _buf: number[] = [];

  uint32(v: number): this { this._buf.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff); return this; }
  int32(v: number): this { return this.uint32(v >>> 0); }
  uint64(hi: number, lo: number): this { return this.uint32(hi).uint32(lo); }

  opaque(data: Uint8Array): this {
    this.uint32(data.length);
    this._buf.push(...data);
    const pad = (4 - (data.length % 4)) % 4;
    for (let i = 0; i < pad; i++) this._buf.push(0);
    return this;
  }

  string(s: string): this { return this.opaque(new TextEncoder().encode(s)); }
  bool(b: boolean): this { return this.uint32(b ? 1 : 0); }

  build(): Uint8Array { return new Uint8Array(this._buf); }
}

class XDRDecoder {
  private _off = 0;
  constructor(private _data: Uint8Array) {}

  uint32(): number {
    const v = (this._data[this._off] << 24) | (this._data[this._off+1] << 16) | (this._data[this._off+2] << 8) | this._data[this._off+3];
    this._off += 4;
    return v >>> 0;
  }
  int32(): number { return this.uint32() | 0; }
  uint64(): number { const hi = this.uint32(); const lo = this.uint32(); return hi * 0x100000000 + lo; }

  opaque(): Uint8Array {
    const len = this.uint32();
    const data = this._data.slice(this._off, this._off + len);
    this._off += len + ((4 - (len % 4)) % 4);
    return data;
  }

  string(): string { return new TextDecoder().decode(this.opaque()); }
  bool(): boolean { return this.uint32() !== 0; }
  remaining(): number { return this._data.length - this._off; }
}

// ── RPC constants ─────────────────────────────────────────────────────────────

const NFS_PROGRAM  = 100003;
const NFS_VERS     = 3;
const PROC_NULL    = 0;
const PROC_GETATTR = 1;
const PROC_LOOKUP  = 3;
const PROC_READ    = 6;
const PROC_READDIR = 16;
const PROC_READDIRPLUS = 17;

const MOUNT_PROGRAM = 100005;
const MOUNT_VERS    = 3;
const MOUNT_PROC_MNT  = 1;
const MOUNT_PROC_UMNT = 3;

// ── File handle + attributes ──────────────────────────────────────────────────

type NFSFh = Uint8Array;  // opaque (up to 64 bytes for v3)

interface NFSFattr3 {
  type: number;   // 1=REG 2=DIR 3=BLK 4=CHR 5=LNK 6=SOCK 7=FIFO
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  size: number;
  used: number;
  fsid: number;
  fileid: number;
  atime: number;
  mtime: number;
  ctime: number;
}

function xdrFattr3(xdr: XDRDecoder): NFSFattr3 {
  return {
    type:   xdr.uint32(),
    mode:   xdr.uint32(),
    nlink:  xdr.uint32(),
    uid:    xdr.uint32(),
    gid:    xdr.uint32(),
    size:   xdr.uint64(),
    used:   xdr.uint64(),
    /* rdev */ rdev: (xdr.uint32(), xdr.uint32(), 0),
    fsid:   xdr.uint64(),
    fileid: xdr.uint64(),
    atime:  (xdr.uint32(), xdr.uint32(), 0),
    mtime:  (xdr.uint32(), xdr.uint32(), 0),
    ctime:  (xdr.uint32(), xdr.uint32(), 0),
  } as unknown as NFSFattr3;
}

// ── RPC call builder ──────────────────────────────────────────────────────────

let _xid = Math.floor(Math.random() * 0x7fffffff);

function buildRPCCall(program: number, version: number, procedure: number, body: Uint8Array): Uint8Array {
  const xid = _xid++ >>> 0;
  const head = new XDREncoder()
    .uint32(xid)
    .uint32(0)         // CALL
    .uint32(2)         // RPC version
    .uint32(program)
    .uint32(version)
    .uint32(procedure)
    // AUTH_NULL credentials
    .uint32(0).uint32(0)  // flavor=NULL, len=0
    // AUTH_NULL verifier
    .uint32(0).uint32(0)
    .build();
  const out = new Uint8Array(head.length + body.length);
  out.set(head); out.set(body, head.length);
  return out;
}

// ── NFSMount (VFSMount) ───────────────────────────────────────────────────────

interface NFSConfig {
  /** Hostname or IP of NFS server (used for display/logging) */
  host: string;
  /** Export path on the server, e.g. "/exports/data" */
  exportPath: string;
  /**
   * Transport function.  The caller wires this up to whatever network
   * primitive JSOS provides (UDP, TCP, etc.).
   * Returns the RPC reply body (skipping the 4-byte fragment header) or null on timeout.
   */
  rpc: (call: Uint8Array) => Uint8Array | null;
}

export class NFSClient implements VFSMount {
  readonly writable = false;
  private _cfg: NFSConfig;
  private _rootFh: NFSFh | null = null;
  private _ready = false;
  private _cache = new Map<string, NFSFh>();

  constructor(cfg: NFSConfig) { this._cfg = cfg; }

  // ── RPC helpers ──────────────────────────────────────────────────────────

  private _call(program: number, version: number, proc: number, body: Uint8Array): XDRDecoder | null {
    const call = buildRPCCall(program, version, proc, body);
    const reply = this._cfg.rpc(call);
    if (!reply) return null;
    const xdr = new XDRDecoder(reply);
    const _xid = xdr.uint32();  void _xid;
    const mtype = xdr.uint32(); // 1 = REPLY
    if (mtype !== 1) return null;
    const rstat = xdr.uint32(); // 0 = MSG_ACCEPTED
    if (rstat !== 0) return null;
    xdr.uint32(); xdr.uint32(); // verifier flavor + length
    const astat = xdr.uint32(); // 0 = SUCCESS
    if (astat !== 0) return null;
    return xdr;
  }

  private _encFh(fh: NFSFh): Uint8Array {
    return new XDREncoder().opaque(fh).build();
  }

  // ── MOUNT procedure ──────────────────────────────────────────────────────

  mount(): boolean {
    const body = new XDREncoder().string(this._cfg.exportPath).build();
    const xdr = this._call(MOUNT_PROGRAM, MOUNT_VERS, MOUNT_PROC_MNT, body);
    if (!xdr) return false;
    const status = xdr.uint32();
    if (status !== 0) return false;
    this._rootFh = xdr.opaque();
    this._ready = true;
    this._cache.set('/', this._rootFh);
    return true;
  }

  unmount(): void {
    if (!this._ready) return;
    const body = new XDREncoder().string(this._cfg.exportPath).build();
    this._call(MOUNT_PROGRAM, MOUNT_VERS, MOUNT_PROC_UMNT, body);
    this._ready = false;
    this._rootFh = null;
    this._cache.clear();
  }

  // Required by VFSMount interface (filesystem.ts)
  read(path: string): string | null {
    const data = this.readFile(path);
    return data ? new TextDecoder().decode(data) : null;
  }
  list(path: string): Array<{ name: string; type: FileType; size: number }> {
    return (this.readdir(path) ?? []).map(e => ({ name: e.name, type: e.type as FileType, size: 0 }));
  }
  exists(path: string): boolean { return this.stat(path) !== null; }
  isDirectory(path: string): boolean { return this.stat(path)?.type === 'directory'; }

  // ── Lookup ───────────────────────────────────────────────────────────────

  private _lookup(dirFh: NFSFh, name: string): NFSFh | null {
    const body = new XDREncoder()
      .opaque(dirFh)
      .string(name)
      .build();
    const xdr = this._call(NFS_PROGRAM, NFS_VERS, PROC_LOOKUP, body);
    if (!xdr) return null;
    const status = xdr.uint32();
    if (status !== 0) return null;
    return xdr.opaque();
  }

  private _resolveFh(path: string): NFSFh | null {
    if (this._cache.has(path)) return this._cache.get(path)!;
    const parts = path.replace(/^\//, '').split('/').filter(Boolean);
    let fh = this._rootFh!;
    let current = '/';
    for (const part of parts) {
      current = current + (current.endsWith('/') ? '' : '/') + part;
      if (this._cache.has(current)) { fh = this._cache.get(current)!; continue; }
      const next = this._lookup(fh, part);
      if (!next) return null;
      this._cache.set(current, next);
      fh = next;
    }
    return fh;
  }

  // ── GETATTR ──────────────────────────────────────────────────────────────

  private _getattr(fh: NFSFh): NFSFattr3 | null {
    const xdr = this._call(NFS_PROGRAM, NFS_VERS, PROC_GETATTR, this._encFh(fh));
    if (!xdr) return null;
    const status = xdr.uint32();
    if (status !== 0) return null;
    return xdrFattr3(xdr);
  }

  // ── Public VFSMount API ───────────────────────────────────────────────────

  readdir(path: string): { name: string; type: FileType }[] | null {
    if (!this._ready) return null;
    const fh = this._resolveFh(path);
    if (!fh) return null;
    const body = new XDREncoder()
      .opaque(fh)
      .uint64(0, 0)      // cookie = 0
      .uint64(0, 0)      // cookieverf = 0
      .uint32(4096)      // count
      .build();
    const xdr = this._call(NFS_PROGRAM, NFS_VERS, PROC_READDIR, body);
    if (!xdr) return null;
    const status = xdr.uint32();
    if (status !== 0) return null;
    // dir_attributes (post_op_attr) — skip
    if (xdr.bool()) xdrFattr3(xdr);
    xdr.uint64(); // cookieverf
    const entries: { name: string; type: FileType }[] = [];
    while (xdr.uint32() === 1) {  // value_follows
      xdr.uint64(); // fileid
      const name = xdr.string();
      xdr.uint64(); // cookie
      entries.push({ name, type: 'file' }); // type refined by stat()
    }
    return entries;
  }

  stat(path: string): { size: number; type: FileType; mode: number } | null {
    if (!this._ready) return null;
    const fh = this._resolveFh(path);
    if (!fh) return null;
    const attr = this._getattr(fh);
    if (!attr) return null;
    const type: FileType = attr.type === 2 ? 'directory' : attr.type === 1 ? 'file' : 'file';
    return { size: attr.size, type, mode: attr.mode };
  }

  readFile(path: string): Uint8Array | null {
    if (!this._ready) return null;
    const fh = this._resolveFh(path);
    if (!fh) return null;
    const attr = this._getattr(fh);
    if (!attr) return null;
    const size = attr.size;
    const chunks: Uint8Array[] = [];
    const READ_SIZE = 32768;
    let offset = 0;
    while (offset < size) {
      const body = new XDREncoder()
        .opaque(fh)
        .uint64(0, offset)
        .uint32(Math.min(READ_SIZE, size - offset))
        .build();
      const xdr = this._call(NFS_PROGRAM, NFS_VERS, PROC_READ, body);
      if (!xdr) return null;
      if (xdr.uint32() !== 0) return null;
      // post_op_attr
      if (xdr.bool()) xdrFattr3(xdr);
      const count = xdr.uint32();
      const _eof = xdr.bool(); void _eof;
      const data = xdr.opaque();
      chunks.push(data.slice(0, count));
      offset += count;
      if (_eof) break;
    }
    const result = new Uint8Array(size);
    let pos = 0;
    for (const c of chunks) { result.set(c, pos); pos += c.length; }
    return result;
  }
}

/** Factory: create and mount an NFS filesystem */
export function nfsMount(cfg: NFSConfig): NFSClient | null {
  const client = new NFSClient(cfg);
  return client.mount() ? client : null;
}
