/**
 * JSOS SMB2/CIFS Client — Item 204
 *
 * A TypeScript implementation of the SMB2 client protocol (MS-SMB2).
 * Supports: Negotiate → SessionSetup (anonymous/NTLM stub) → TreeConnect →
 *           Create → Read → QueryDirectory → QueryInfo → Close → TreeDisconnect
 *
 * This is a pure TypeScript implementation; transport is provided by the caller.
 */

import type { FileType, VFSMount } from './filesystem.js';

// ── SMB2 constants ─────────────────────────────────────────────────────────────

const SMB2_MAGIC = 0xfe534d42;   // 0xFE 'S' 'M' 'B'
const SMB2_HEADER_SIZE = 64;

// Commands
const SMB2_NEGOTIATE        = 0x0000;
const SMB2_SESSION_SETUP    = 0x0001;
const SMB2_TREE_CONNECT     = 0x0003;
const SMB2_TREE_DISCONNECT  = 0x0004;
const SMB2_CREATE           = 0x0005;
const SMB2_CLOSE            = 0x0006;
const SMB2_READ             = 0x0008;
const SMB2_QUERY_INFO       = 0x0010;
const SMB2_QUERY_DIRECTORY  = 0x000e;

// Status codes
const STATUS_SUCCESS            = 0x00000000;
const STATUS_BUFFER_OVERFLOW    = 0x80000005;
const STATUS_END_OF_FILE        = 0xc0000011;
const STATUS_NO_MORE_FILES      = 0x80000006;

// Flags
const SMB2_FLAGS_SERVER_TO_REDIR = 0x00000001;

// Dialects
const SMB2_DIALECT_0202 = 0x0202;
const SMB2_DIALECT_0210 = 0x0210;
const SMB2_DIALECT_0300 = 0x0300;

// ── Helpers ───────────────────────────────────────────────────────────────────

function u16le(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off+1] << 8);
}
function u32le(buf: Uint8Array, off: number): number {
  return (buf[off] | (buf[off+1] << 8) | (buf[off+2] << 16) | (buf[off+3] << 24)) >>> 0;
}
function u64le(buf: Uint8Array, off: number): number {
  return u32le(buf, off) + u32le(buf, off+4) * 0x100000000;
}

function w16le(buf: Uint8Array, off: number, v: number) {
  buf[off] = v & 0xff; buf[off+1] = (v >> 8) & 0xff;
}
function w32le(buf: Uint8Array, off: number, v: number) {
  buf[off] = v & 0xff; buf[off+1] = (v>>8)&0xff; buf[off+2] = (v>>16)&0xff; buf[off+3] = (v>>>24)&0xff;
}
function w64le(buf: Uint8Array, off: number, v: number) {
  w32le(buf, off, v >>> 0); w32le(buf, off+4, Math.floor(v / 0x100000000));
}

function utf16le(s: string): Uint8Array {
  const buf = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); buf[i*2] = c & 0xff; buf[i*2+1] = c >> 8; }
  return buf;
}

function fromUtf16le(buf: Uint8Array): string {
  let s = '';
  for (let i = 0; i + 1 < buf.length; i += 2) s += String.fromCharCode(buf[i] | (buf[i+1] << 8));
  return s;
}

// ── SMB2 packet builder/parser ────────────────────────────────────────────────

class SMB2Packet {
  private _messageId = 0;
  private _sessionId = 0;
  private _treeId = 0;

  constructor(
    private _command: number,
    private _statusOrCredits = 0,
    private _flags = 0,
    private _body = new Uint8Array(0),
  ) {}

  build(ctx: { msgId: number; sessionId: number; treeId: number }): Uint8Array {
    const total = SMB2_HEADER_SIZE + this._body.length;
    const buf = new Uint8Array(total);
    w32le(buf, 0, SMB2_MAGIC);
    w16le(buf, 4, SMB2_HEADER_SIZE);  // StructureSize
    w16le(buf, 6, 0);    // CreditCharge
    w32le(buf, 8, 0);    // Status / ChannelSequence
    w16le(buf, 12, this._command);
    w16le(buf, 14, 1);   // CreditRequest
    w32le(buf, 16, this._flags);
    w32le(buf, 20, 0);   // NextCommand
    w64le(buf, 24, ctx.msgId);
    w32le(buf, 32, 0);   // AsyncId / ProcessId
    w32le(buf, 36, ctx.treeId);
    w64le(buf, 40, ctx.sessionId);
    // Signature (zeroed for unauthenticated)
    buf.set(this._body, SMB2_HEADER_SIZE);
    return buf;
  }
}

interface SMB2Header {
  magic: number;
  command: number;
  status: number;
  flags: number;
  messageId: number;
  sessionId: number;
  treeId: number;
}

function parseHeader(buf: Uint8Array): SMB2Header | null {
  if (buf.length < SMB2_HEADER_SIZE) return null;
  if (u32le(buf, 0) !== SMB2_MAGIC) return null;
  return {
    magic:     u32le(buf, 0),
    command:   u16le(buf, 12),
    status:    u32le(buf, 8),
    flags:     u32le(buf, 16),
    messageId: u64le(buf, 24),
    treeId:    u32le(buf, 36),
    sessionId: u64le(buf, 40),
  };
}

// ── SMB Client ────────────────────────────────────────────────────────────────

interface SMBConfig {
  /** UNC path: \\server\share  (e.g. "\\fileserver\data") */
  unc: string;
  /** Username (optional — empty for anonymous) */
  username?: string;
  /** Password (optional) */
  password?: string;
  /**
   * Transport: send SMB2 bytes and receive reply.
   * Must handle TCP framing (4-byte big-endian length prefix).
   */
  rpc: (request: Uint8Array) => Uint8Array | null;
}

export class SMBClient implements VFSMount {
  readonly writable = false;
  private _cfg: SMBConfig;
  private _msgId = 1;
  private _sessionId = 0;
  private _treeId = 0;
  private _dialect = 0;
  private _ready = false;
  private _server = '';
  private _share = '';

  constructor(cfg: SMBConfig) {
    this._cfg = cfg;
    // Parse UNC: \\server\share
    const m = cfg.unc.match(/^\\\\([^\\]+)\\(.+)$/);
    if (m) { this._server = m[1]; this._share = m[2]; }
  }

  private _send(body: Uint8Array): Uint8Array | null {
    const ctx = { msgId: this._msgId++, sessionId: this._sessionId, treeId: this._treeId };
    void ctx;  // header assembled in full packet below
    return this._cfg.rpc(body);
  }

  private _buildNegotiate(): Uint8Array {
    const dialects = [SMB2_DIALECT_0202, SMB2_DIALECT_0210, SMB2_DIALECT_0300];
    const body = new Uint8Array(36 + dialects.length * 2);
    w16le(body, 0, 65);   // StructureSize
    w16le(body, 2, dialects.length);
    dialects.forEach((d, i) => w16le(body, 8 + i * 2, d));
    const full = new Uint8Array(SMB2_HEADER_SIZE + body.length);
    w32le(full, 0, SMB2_MAGIC);
    w16le(full, 4, SMB2_HEADER_SIZE);
    w16le(full, 12, SMB2_NEGOTIATE);
    w16le(full, 14, 1);   // credits
    w64le(full, 24, this._msgId++);
    full.set(body, SMB2_HEADER_SIZE);
    return full;
  }

  private _buildSessionSetup(): Uint8Array {
    // NTLM NEGOTIATE_MESSAGE (Type 1) stub — anonymous
    const ntlmToken = new Uint8Array([
      0x4e,0x54,0x4c,0x4d,0x53,0x53,0x50,0x00,  // "NTLMSSP\0"
      0x01,0x00,0x00,0x00,                        // MessageType = 1 (NEGOTIATE)
      0x02,0x02,0x00,0x00,                        // Negotiate flags
      0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,  // DomainName (none)
      0x00,0x00,0x00,0x00, 0x00,0x00,0x00,0x00,  // Workstation (none)
    ]);
    // Session setup request body
    const secOff = SMB2_HEADER_SIZE + 25;
    const body = new Uint8Array(25 + ntlmToken.length);
    w16le(body, 0, 25);   // StructureSize
    body[2] = 0;          // Flags
    body[3] = 0;          // SecurityMode = 0 (no signing required by client)
    w32le(body, 4, 0);    // Capabilities
    w32le(body, 8, 0);    // Channel
    w16le(body, 12, secOff);   // SecurityBufferOffset
    w16le(body, 14, ntlmToken.length);
    w64le(body, 16, 0);   // PreviousSessionId
    body.set(ntlmToken, 25);
    const full = new Uint8Array(SMB2_HEADER_SIZE + body.length);
    w32le(full, 0, SMB2_MAGIC); w16le(full, 4, SMB2_HEADER_SIZE);
    w16le(full, 12, SMB2_SESSION_SETUP); w16le(full, 14, 1);
    w64le(full, 24, this._msgId++); w64le(full, 40, 0);
    full.set(body, SMB2_HEADER_SIZE);
    return full;
  }

  private _buildTreeConnect(): Uint8Array {
    const path = utf16le('\\\\' + this._server + '\\' + this._share);
    const body = new Uint8Array(8 + path.length);
    w16le(body, 0, 9);
    const pathOff = SMB2_HEADER_SIZE + 8;
    w16le(body, 4, pathOff); w16le(body, 6, path.length);
    body.set(path, 8);
    const full = new Uint8Array(SMB2_HEADER_SIZE + body.length);
    w32le(full, 0, SMB2_MAGIC); w16le(full, 4, SMB2_HEADER_SIZE);
    w16le(full, 12, SMB2_TREE_CONNECT); w16le(full, 14, 1);
    w64le(full, 24, this._msgId++); w64le(full, 40, this._sessionId);
    full.set(body, SMB2_HEADER_SIZE);
    return full;
  }

  mount(): boolean {
    // 1. Negotiate
    const negReply = this._send(this._buildNegotiate());
    if (!negReply) return false;
    const negHdr = parseHeader(negReply);
    if (!negHdr || negHdr.status !== STATUS_SUCCESS) return false;
    this._dialect = u16le(negReply, SMB2_HEADER_SIZE + 4);

    // 2. Session setup
    const setupReply = this._send(this._buildSessionSetup());
    if (!setupReply) return false;
    const setupHdr = parseHeader(setupReply);
    // STATUS_MORE_PROCESSING_REQUIRED = 0xc0000016 is normal for NTLM Type 2
    if (!setupHdr) return false;
    this._sessionId = setupHdr.sessionId;

    // 3. Tree connect
    const treeReply = this._send(this._buildTreeConnect());
    if (!treeReply) return false;
    const treeHdr = parseHeader(treeReply);
    if (!treeHdr || treeHdr.status !== STATUS_SUCCESS) return false;
    this._treeId = treeHdr.treeId;

    this._ready = true;
    return true;
  }

  unmount(): void {
    if (!this._ready) return;
    // TreeDisconnect
    const body = new Uint8Array(4); w16le(body, 0, 4);
    const full = new Uint8Array(SMB2_HEADER_SIZE + 4);
    w32le(full, 0, SMB2_MAGIC); w16le(full, 4, SMB2_HEADER_SIZE);
    w16le(full, 12, SMB2_TREE_DISCONNECT); w16le(full, 14, 1);
    w64le(full, 24, this._msgId++); w64le(full, 40, this._sessionId);
    w32le(full, 36, this._treeId); full.set(body, SMB2_HEADER_SIZE);
    this._send(full);
    this._ready = false;
  }

  // Required by VFSMount interface (filesystem.ts)
  read(path: string): string | null {
    const raw = this.readFile(path);
    return raw ? new TextDecoder().decode(raw) : null;
  }
  list(path: string): Array<{ name: string; type: FileType; size: number }> {
    return (this.readdir(path) ?? []).map(e => ({ name: e.name, type: (e.type ?? 'file') as FileType, size: 0 }));
  }
  exists(path: string): boolean {
    return this.stat(path) !== null;
  }
  isDirectory(path: string): boolean {
    return this.stat(path)?.type === 'directory';
  }

  // ── File operations ───────────────────────────────────────────────────────

  private _open(path: string, isDir: boolean): Uint8Array | null {
    const nameBuf = utf16le(path.replace(/\//g, '\\').replace(/^\\/,''));
    const body = new Uint8Array(57 + nameBuf.length);
    w16le(body, 0, 57);  // StructureSize
    w32le(body, 4, 0x00000001);  // DesiredAccess = GENERIC_READ
    w32le(body, 12, isDir ? 0x00000001 : 0x00000080); // FileAttributes
    w32le(body, 16, 0x00000003);  // ShareAccess = READ|WRITE
    w32le(body, 20, 1);  // CreateDisposition = FILE_OPEN
    w32le(body, 24, isDir ? 0x00200021 : 0x00000060);  // CreateOptions
    const nameOff = SMB2_HEADER_SIZE + 57;
    w16le(body, 45, nameOff); w16le(body, 47, nameBuf.length);
    body.set(nameBuf, 57);
    const full = new Uint8Array(SMB2_HEADER_SIZE + body.length);
    w32le(full, 0, SMB2_MAGIC); w16le(full, 4, SMB2_HEADER_SIZE);
    w16le(full, 12, SMB2_CREATE); w16le(full, 14, 1);
    w64le(full, 24, this._msgId++); w64le(full, 40, this._sessionId);
    w32le(full, 36, this._treeId); full.set(body, SMB2_HEADER_SIZE);
    const reply = this._send(full);
    if (!reply) return null;
    const hdr = parseHeader(reply);
    if (!hdr || hdr.status !== STATUS_SUCCESS) return null;
    return reply.slice(SMB2_HEADER_SIZE + 4, SMB2_HEADER_SIZE + 4 + 16); // FileId (16 bytes)
  }

  private _close(fileId: Uint8Array): void {
    const body = new Uint8Array(24);
    w16le(body, 0, 24); body.set(fileId, 8);
    const full = new Uint8Array(SMB2_HEADER_SIZE + 24);
    w32le(full, 0, SMB2_MAGIC); w16le(full, 4, SMB2_HEADER_SIZE);
    w16le(full, 12, SMB2_CLOSE); w16le(full, 14, 1);
    w64le(full, 24, this._msgId++); w64le(full, 40, this._sessionId);
    w32le(full, 36, this._treeId); full.set(body, SMB2_HEADER_SIZE);
    this._send(full);
  }

  readdir(path: string): { name: string; type: FileType }[] | null {
    if (!this._ready) return null;
    const fileId = this._open(path || '\\', true);
    if (!fileId) return null;
    const entries: { name: string; type: FileType }[] = [];
    // QUERY_DIRECTORY
    const pattern = utf16le('*');
    const body = new Uint8Array(33 + pattern.length);
    w16le(body, 0, 33); body[2] = 1; /* FileInformationClass = FileIdBothDirectoryInformation */
    /* Actually use FileNamesInformation = 12 for simplicity */ body[2] = 12;
    body[3] = 0x01;  // RESTART_SCANS
    body.set(fileId, 4); w64le(body, 20, 0);
    const searchOff = SMB2_HEADER_SIZE + 33;
    w16le(body, 26, searchOff); w16le(body, 28, pattern.length);
    w32le(body, 30, 65536);
    body.set(pattern, 33);
    const full = new Uint8Array(SMB2_HEADER_SIZE + body.length);
    w32le(full, 0, SMB2_MAGIC); w16le(full, 4, SMB2_HEADER_SIZE);
    w16le(full, 12, SMB2_QUERY_DIRECTORY); w16le(full, 14, 1);
    w64le(full, 24, this._msgId++); w64le(full, 40, this._sessionId);
    w32le(full, 36, this._treeId); full.set(body, SMB2_HEADER_SIZE);
    const reply = this._send(full);
    if (reply) {
      const hdr = parseHeader(reply);
      if (hdr && (hdr.status === STATUS_SUCCESS || hdr.status === STATUS_BUFFER_OVERFLOW)) {
        let off = SMB2_HEADER_SIZE + 9; // StructureSize + OutputBufferOffset
        const outputOff = u16le(reply, SMB2_HEADER_SIZE + 2);
        const outputLen = u32le(reply, SMB2_HEADER_SIZE + 4);
        off = outputOff;
        let p = 0;
        while (p < outputLen) {
          const next = u32le(reply, off + p);
          const fnLen = u32le(reply, off + p + 4);
          const nameBytes = reply.slice(off + p + 8, off + p + 8 + fnLen);
          const name = fromUtf16le(nameBytes);
          if (name && name !== '.' && name !== '..') entries.push({ name, type: 'file' });
          if (next === 0) break;
          p += next;
        }
      }
    }
    this._close(fileId);
    return entries;
  }

  stat(path: string): { size: number; type: FileType; mode: number } | null {
    if (!this._ready) return null;
    const fileId = this._open(path, false);
    if (!fileId) {
      // Try as dir
      const dId = this._open(path, true);
      if (!dId) return null;
      this._close(dId);
      return { size: 0, type: 'directory', mode: 0o755 };
    }
    // QueryInfo for FileStandardInformation (class 5)
    const body = new Uint8Array(41);
    w16le(body, 0, 41); body[2] = 1; body[3] = 5; // FileInfoClass = FileStandardInformation
    body.set(fileId, 8); w32le(body, 24, 24); // OutputBufferLen
    const full = new Uint8Array(SMB2_HEADER_SIZE + 41);
    w32le(full, 0, SMB2_MAGIC); w16le(full, 4, SMB2_HEADER_SIZE);
    w16le(full, 12, SMB2_QUERY_INFO); w16le(full, 14, 1);
    w64le(full, 24, this._msgId++); w64le(full, 40, this._sessionId);
    w32le(full, 36, this._treeId); full.set(body, SMB2_HEADER_SIZE);
    const reply = this._send(full);
    let size = 0;
    if (reply) {
      const hdr = parseHeader(reply);
      if (hdr && hdr.status === STATUS_SUCCESS) {
        const outOff = u16le(reply, SMB2_HEADER_SIZE + 2);
        size = u64le(reply, outOff + 8);  // EndOfFile
      }
    }
    this._close(fileId);
    return { size, type: 'file', mode: 0o644 };
  }

  readFile(path: string): Uint8Array | null {
    if (!this._ready) return null;
    const fileId = this._open(path, false);
    if (!fileId) return null;
    const chunks: Uint8Array[] = [];
    let offset = 0;
    const READ_SIZE = 65536;
    while (true) {
      const body = new Uint8Array(49);
      w16le(body, 0, 49); w32le(body, 2, READ_SIZE);
      w64le(body, 6, offset);
      body.set(fileId, 14);
      const full = new Uint8Array(SMB2_HEADER_SIZE + 49);
      w32le(full, 0, SMB2_MAGIC); w16le(full, 4, SMB2_HEADER_SIZE);
      w16le(full, 12, SMB2_READ); w16le(full, 14, 1);
      w64le(full, 24, this._msgId++); w64le(full, 40, this._sessionId);
      w32le(full, 36, this._treeId); full.set(body, SMB2_HEADER_SIZE);
      const reply = this._send(full);
      if (!reply) break;
      const hdr = parseHeader(reply);
      if (!hdr) break;
      if (hdr.status === STATUS_END_OF_FILE) break;
      if (hdr.status !== STATUS_SUCCESS) break;
      const dataOff = u16le(reply, SMB2_HEADER_SIZE + 2);
      const dataLen = u32le(reply, SMB2_HEADER_SIZE + 4);
      if (dataLen === 0) break;
      chunks.push(reply.slice(dataOff, dataOff + dataLen));
      offset += dataLen;
    }
    this._close(fileId);
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const result = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) { result.set(c, pos); pos += c.length; }
    return result;
  }
}

/** Factory: parse UNC path and create an SMB client */
export function smbConnect(cfg: SMBConfig): SMBClient | null {
  const client = new SMBClient(cfg);
  return client.mount() ? client : null;
}

export const smbClient = { connect: smbConnect };
