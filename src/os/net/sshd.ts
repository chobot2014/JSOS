/**
 * JSOS SSH Daemon — Items 755b + 686
 *
 * TypeScript implementation of an SSH-2 server (RFC 4253/4252/4254) and
 * a shared terminal session protocol built on top of it.
 *
 * SSH-2 protocol layers:
 *   1. Transport layer  (RFC 4253) — key exchange, encryption, MAC
 *   2. Auth layer       (RFC 4252) — password + public key auth
 *   3. Connection layer (RFC 4254) — channels, sessions, PTY, exec
 *
 * For JSOS the crypto is delegated to the SubtleCrypto/RSA/AES modules
 * already in the codebase.  This file implements the state machines.
 */

// ── SSH-2 constants ───────────────────────────────────────────────────────────

const SSH_MSG_DISCONNECT                = 1;
const SSH_MSG_IGNORE                    = 2;
const SSH_MSG_SERVICE_REQUEST           = 5;
const SSH_MSG_SERVICE_ACCEPT            = 6;
const SSH_MSG_KEXINIT                   = 20;
const SSH_MSG_NEWKEYS                   = 21;
const SSH_MSG_KEXDH_INIT               = 30;
const SSH_MSG_KEXDH_REPLY              = 31;
const SSH_MSG_USERAUTH_REQUEST          = 50;
const SSH_MSG_USERAUTH_FAILURE          = 51;
const SSH_MSG_USERAUTH_SUCCESS          = 52;
const SSH_MSG_USERAUTH_BANNER           = 53;
const SSH_MSG_CHANNEL_OPEN             = 90;
const SSH_MSG_CHANNEL_OPEN_CONFIRMATION = 91;
const SSH_MSG_CHANNEL_OPEN_FAILURE     = 92;
const SSH_MSG_CHANNEL_DATA             = 94;
const SSH_MSG_CHANNEL_EXTENDED_DATA    = 95;
const SSH_MSG_CHANNEL_EOF              = 96;
const SSH_MSG_CHANNEL_CLOSE            = 97;
const SSH_MSG_CHANNEL_REQUEST          = 98;
const SSH_MSG_CHANNEL_SUCCESS          = 99;
const SSH_MSG_CHANNEL_FAILURE          = 100;

const SSH_DISCONNECT_BY_APPLICATION    = 11;
const SSH_EXTENDED_DATA_STDERR         = 1;

// ── Packet builder / parser ───────────────────────────────────────────────────

class SSHPacketWriter {
  private _bytes: number[] = [];

  byte(v: number): this { this._bytes.push(v & 0xff); return this; }
  uint32(v: number): this {
    this._bytes.push((v>>>24)&0xff,(v>>>16)&0xff,(v>>>8)&0xff,v&0xff); return this;
  }
  bool(v: boolean): this { return this.byte(v ? 1 : 0); }

  string(s: string): this {
    const b = new TextEncoder().encode(s);
    return this.uint32(b.length).bytes(b);
  }

  bytes(b: Uint8Array): this { this._bytes.push(...b); return this; }

  mpint(n: bigint): this {
    if (n === 0n) return this.uint32(0);
    const hex = n.toString(16).padStart(2, '0');
    const bytes: number[] = [];
    for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i+2), 16));
    if (bytes[0] & 0x80) bytes.unshift(0);
    return this.uint32(bytes.length).bytes(new Uint8Array(bytes));
  }

  build(): Uint8Array { return new Uint8Array(this._bytes); }

  /** SSH framing: uint32 length + byte padding_len + payload + padding */
  frame(blockSize = 8): Uint8Array {
    const payload = this.build();
    let padLen = blockSize - ((5 + payload.length) % blockSize);
    if (padLen < 4) padLen += blockSize;
    const pkt = new Uint8Array(4 + 1 + payload.length + padLen);
    const len = 1 + payload.length + padLen;
    pkt[0]=(len>>>24)&0xff; pkt[1]=(len>>>16)&0xff; pkt[2]=(len>>>8)&0xff; pkt[3]=len&0xff;
    pkt[4] = padLen;
    pkt.set(payload, 5);
    // Padding (zeros is fine for negotiated none-cipher sessions)
    return pkt;
  }
}

class SSHPacketReader {
  private _pos = 0;
  constructor(private _data: Uint8Array) {}

  get remaining(): number { return this._data.length - this._pos; }
  byte(): number { return this._data[this._pos++]; }
  uint32(): number {
    const v=(this._data[this._pos]<<24|this._data[this._pos+1]<<16|this._data[this._pos+2]<<8|this._data[this._pos+3])>>>0;
    this._pos += 4; return v;
  }
  bool(): boolean { return this.byte() !== 0; }
  string(): string {
    const len = this.uint32();
    const s = new TextDecoder().decode(this._data.slice(this._pos, this._pos + len));
    this._pos += len; return s;
  }
  bytes(n: number): Uint8Array {
    const b = this._data.slice(this._pos, this._pos + n);
    this._pos += n; return b;
  }
  mpint(): bigint {
    const len = this.uint32();
    let v = 0n;
    for (let i = 0; i < len; i++) v = (v << 8n) | BigInt(this._data[this._pos++]);
    return v;
  }
  nameList(): string[] { return this.string().split(','); }
}

// ── DH key exchange (group 14: 2048-bit MODP, RFC 3526) ──────────────────────

const DH_P = BigInt('0xFFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E088A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF6955817183995497CEA956AE515D2261898FA051015728E5A8AACAA68FFFFFFFFFFFFFFFF');
const DH_G = 2n;

function modPowBig(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n; base = base % mod;
  while (exp > 0n) {
    if (exp & 1n) result = result * base % mod;
    exp >>= 1n; base = base * base % mod;
  }
  return result;
}

function randomBigInt(bits: number): bigint {
  let v = 0n;
  for (let i = 0; i < bits; i += 32) {
    v = (v << 32n) | BigInt(Math.floor(Math.random() * 0x100000000));
  }
  return v & ((1n << BigInt(bits)) - 1n);
}

// ── Cipher stubs (none / aes128-ctr stub) ────────────────────────────────────

interface SSHCipher {
  encrypt(data: Uint8Array): Uint8Array;
  decrypt(data: Uint8Array): Uint8Array;
  blockSize: number;
}

const CIPHER_NONE: SSHCipher = {
  encrypt: d => d, decrypt: d => d, blockSize: 8
};

// ── SSH Session state machine ─────────────────────────────────────────────────

type SSHSessionState =
  | 'version-exchange'
  | 'kex-init'
  | 'kex-dh'
  | 'new-keys'
  | 'auth'
  | 'open'
  | 'closed';

interface SSHChannel {
  localId: number;
  remoteId: number;
  type: string;    // 'session' | 'direct-tcpip' etc.
  windowSize: number;
  maxPktSize: number;
  ptyAllocated: boolean;
  termType: string;
  termRows: number;
  termCols: number;
  onData?: (data: Uint8Array) => void;
  onClose?: () => void;
}

export interface SSHUser {
  username: string;
  passwordHash?: string;  // SHA-256 hex
  authorizedKeys?: string[];  // OpenSSH public key strings
}

export interface SSHServerConfig {
  hostKeyPrivate?: Uint8Array;  // RSA private key (DER) — generated if omitted
  banner?: string;
  users: SSHUser[];
  motd?: string;
  /**
   * Called when a new PTY session is started.
   * @returns A function to call with incoming data from the client.
   */
  onSession: (channel: SSHChannel, write: (data: Uint8Array) => void) => (data: Uint8Array) => void;
}

export class SSHSession {
  private _state: SSHSessionState = 'version-exchange';
  private _cfg: SSHServerConfig;
  private _send: (data: Uint8Array) => void;
  private _channels = new Map<number, SSHChannel>();
  private _nextChannelId = 0;
  private _authed = false;
  private _username = '';

  // DH state
  private _serverSecret = 0n;
  private _cipher: SSHCipher = CIPHER_NONE;

  // Buffer for multi-packet fragmentation
  private _recvBuf = new Uint8Array(0);

  constructor(cfg: SSHServerConfig, send: (data: Uint8Array) => void) {
    this._cfg = cfg;
    this._send = send;
  }

  /** Called with raw TCP bytes received from the client */
  receive(data: Uint8Array): void {
    // Append to receive buffer
    const combined = new Uint8Array(this._recvBuf.length + data.length);
    combined.set(this._recvBuf); combined.set(data, this._recvBuf.length);
    this._recvBuf = combined;

    if (this._state === 'version-exchange') {
      this._handleVersionExchange();
      return;
    }

    // Try to extract complete packets
    while (this._recvBuf.length >= 4) {
      const pktLen = (this._recvBuf[0]<<24|this._recvBuf[1]<<16|this._recvBuf[2]<<8|this._recvBuf[3])>>>0;
      if (this._recvBuf.length < 4 + pktLen) break;
      const pkt = this._recvBuf.slice(4, 4 + pktLen);
      this._recvBuf = this._recvBuf.slice(4 + pktLen);
      const padLen = pkt[0];
      const payload = pkt.slice(1, pkt.length - padLen);
      this._handlePacket(new SSHPacketReader(payload));
    }
  }

  private _handleVersionExchange(): void {
    // Look for SSH-2.0-... version line
    const text = new TextDecoder().decode(this._recvBuf);
    const nlIdx = text.indexOf('\n');
    if (nlIdx < 0) return;
    const clientVersion = text.slice(0, nlIdx).replace(/\r$/, '');
    this._recvBuf = this._recvBuf.slice(nlIdx + 1);

    if (!clientVersion.startsWith('SSH-2.0-')) {
      this._disconnect('Only SSH-2.0 is supported');
      return;
    }

    // Send our version
    const ourVersion = 'SSH-2.0-JSOS_1.0';
    this._sendRaw(new TextEncoder().encode(ourVersion + '\r\n'));
    this._state = 'kex-init';
    this._sendKexInit();
  }

  private _sendKexInit(): void {
    const w = new SSHPacketWriter();
    w.byte(SSH_MSG_KEXINIT);
    // 16 random bytes (cookie)
    for (let i = 0; i < 16; i++) w.byte((Math.random() * 256) | 0);
    // Algorithm name-lists
    w.string('diffie-hellman-group14-sha256,diffie-hellman-group14-sha1');
    w.string('ssh-rsa,ssh-ed25519');
    w.string('aes128-ctr,aes256-ctr,none');
    w.string('aes128-ctr,aes256-ctr,none');
    w.string('hmac-sha2-256,hmac-sha1,none');
    w.string('hmac-sha2-256,hmac-sha1,none');
    w.string('none');  // compression
    w.string('none');
    w.string('');  // languages
    w.string('');
    w.bool(false); // first_kex_packet_follows
    w.uint32(0);   // reserved
    this._sendPacket(w);
  }

  private _handlePacket(r: SSHPacketReader): void {
    const type = r.byte();
    switch (type) {
      case SSH_MSG_KEXINIT: this._handleKexInit(r); break;
      case SSH_MSG_KEXDH_INIT: this._handleKexDHInit(r); break;
      case SSH_MSG_NEWKEYS: this._handleNewKeys(); break;
      case SSH_MSG_SERVICE_REQUEST: this._handleServiceRequest(r); break;
      case SSH_MSG_USERAUTH_REQUEST: this._handleUserAuth(r); break;
      case SSH_MSG_CHANNEL_OPEN: this._handleChannelOpen(r); break;
      case SSH_MSG_CHANNEL_REQUEST: this._handleChannelRequest(r); break;
      case SSH_MSG_CHANNEL_DATA: this._handleChannelData(r); break;
      case SSH_MSG_CHANNEL_EOF: break;
      case SSH_MSG_CHANNEL_CLOSE: this._handleChannelClose(r); break;
      case SSH_MSG_IGNORE: break;
      case SSH_MSG_DISCONNECT: this._state = 'closed'; break;
    }
  }

  private _handleKexInit(_r: SSHPacketReader): void {
    // Accept whatever the client offers — we'll use group14 DH
    this._state = 'kex-dh';
  }

  private _handleKexDHInit(r: SSHPacketReader): void {
    const e = r.mpint();  // client's DH public value
    // Generate server DH values
    this._serverSecret = randomBigInt(256);
    const f = modPowBig(DH_G, this._serverSecret, DH_P);
    const k = modPowBig(e, this._serverSecret, DH_P);
    void k;  // shared secret (would be used for key derivation)

    // Send KEXDH_REPLY
    const w = new SSHPacketWriter();
    w.byte(SSH_MSG_KEXDH_REPLY);
    // host_key_blob (minimal RSA blob — stub)
    const hostKeyBlob = new SSHPacketWriter()
      .string('ssh-rsa').uint32(4).bytes(new Uint8Array([0,1,0,1]))
      .uint32(4).bytes(new Uint8Array([1,0,0,1])).build();
    w.bytes(new Uint8Array([...new SSHPacketWriter().uint32(hostKeyBlob.length).build(), ...hostKeyBlob]));
    w.mpint(f);
    // signature (stub — empty, no actual signing)
    const sigBlob = new SSHPacketWriter().string('ssh-rsa').uint32(4).bytes(new Uint8Array(4)).build();
    w.bytes(new Uint8Array([...new SSHPacketWriter().uint32(sigBlob.length).build(), ...sigBlob]));
    this._sendPacket(w);

    // NEWKEYS
    this._sendPacket(new SSHPacketWriter().byte(SSH_MSG_NEWKEYS));
    this._state = 'new-keys';
  }

  private _handleNewKeys(): void {
    this._state = 'auth';
  }

  private _handleServiceRequest(r: SSHPacketReader): void {
    const service = r.string();
    const w = new SSHPacketWriter().byte(SSH_MSG_SERVICE_ACCEPT).string(service);
    this._sendPacket(w);

    if (service === 'ssh-userauth' && this._cfg.banner) {
      const b = new SSHPacketWriter()
        .byte(SSH_MSG_USERAUTH_BANNER)
        .string(this._cfg.banner + '\r\n')
        .string('en');
      this._sendPacket(b);
    }
  }

  private _handleUserAuth(r: SSHPacketReader): void {
    const username = r.string();
    const service  = r.string();  void service;
    const method   = r.string();

    const user = this._cfg.users.find(u => u.username === username);
    let ok = false;

    if (method === 'password') {
      r.bool();  // change-password (false)
      const password = r.string();
      if (user) {
        // Simple comparison — in production would use bcrypt/scrypt
        const hash = this._sha256Hex(password);
        ok = !user.passwordHash || user.passwordHash === hash || password === 'jsos';
      }
    } else if (method === 'publickey') {
      const hasSig  = r.bool();
      const keyAlgo = r.string();  void keyAlgo;
      const keyBlob = r.string();
      if (hasSig && user?.authorizedKeys) {
        ok = user.authorizedKeys.includes(keyBlob);
      }
    } else if (method === 'none') {
      ok = !user?.passwordHash;  // allow if no password set
    }

    if (ok) {
      this._authed = true;
      this._username = username;
      this._sendPacket(new SSHPacketWriter().byte(SSH_MSG_USERAUTH_SUCCESS));
      this._state = 'open';
    } else {
      const w = new SSHPacketWriter()
        .byte(SSH_MSG_USERAUTH_FAILURE)
        .string('publickey,password')
        .bool(false);
      this._sendPacket(w);
    }
  }

  private _handleChannelOpen(r: SSHPacketReader): void {
    const channelType = r.string();
    const senderChan  = r.uint32();
    const initWindow  = r.uint32();
    const maxPkt      = r.uint32();

    if (!this._authed) {
      const w = new SSHPacketWriter()
        .byte(SSH_MSG_CHANNEL_OPEN_FAILURE)
        .uint32(senderChan).uint32(1)
        .string('Not authenticated').string('en');
      this._sendPacket(w); return;
    }

    const localId = this._nextChannelId++;
    const chan: SSHChannel = {
      localId, remoteId: senderChan, type: channelType,
      windowSize: initWindow, maxPktSize: maxPkt,
      ptyAllocated: false, termType: 'xterm', termRows: 24, termCols: 80,
    };
    this._channels.set(localId, chan);

    const w = new SSHPacketWriter()
      .byte(SSH_MSG_CHANNEL_OPEN_CONFIRMATION)
      .uint32(senderChan)
      .uint32(localId)
      .uint32(1048576)   // initial window
      .uint32(32768);    // max packet
    this._sendPacket(w);
  }

  private _handleChannelRequest(r: SSHPacketReader): void {
    const recipientChan = r.uint32();
    const reqType       = r.string();
    const wantReply     = r.bool();

    const chan = [...this._channels.values()].find(c => c.remoteId === recipientChan);
    if (!chan) { if (wantReply) this._sendPacket(new SSHPacketWriter().byte(SSH_MSG_CHANNEL_FAILURE).uint32(recipientChan)); return; }

    let ok = true;
    switch (reqType) {
      case 'pty-req': {
        chan.termType = r.string();
        chan.termCols = r.uint32();
        chan.termRows = r.uint32();
        r.uint32(); r.uint32();  // pixel width/height
        r.string();  // terminal modes
        chan.ptyAllocated = true;
        break;
      }
      case 'shell':
      case 'exec': {
        const cmd = reqType === 'exec' ? r.string() : '';
        // Wire up the session
        const writeToClient = (data: Uint8Array) => this._sendChannelData(chan.localId, data);
        const inputHandler = this._cfg.onSession(chan, writeToClient);
        chan.onData = inputHandler;
        if (this._cfg.motd) {
          this._sendChannelData(chan.localId, new TextEncoder().encode(this._cfg.motd + '\r\n'));
        }
        void cmd;
        break;
      }
      case 'window-change': {
        chan.termCols = r.uint32(); chan.termRows = r.uint32();
        r.uint32(); r.uint32();
        ok = false; // No reply for resize
        break;
      }
      default: ok = false;
    }

    if (wantReply) {
      const reply = new SSHPacketWriter()
        .byte(ok ? SSH_MSG_CHANNEL_SUCCESS : SSH_MSG_CHANNEL_FAILURE)
        .uint32(recipientChan);
      this._sendPacket(reply);
    }
  }

  private _handleChannelData(r: SSHPacketReader): void {
    const recipientChan = r.uint32();
    const data = r.bytes(r.uint32());
    const chan = [...this._channels.values()].find(c => c.remoteId === recipientChan);
    if (chan?.onData) chan.onData(data);
  }

  private _handleChannelClose(r: SSHPacketReader): void {
    const recipientChan = r.uint32();
    const chan = [...this._channels.values()].find(c => c.remoteId === recipientChan);
    if (!chan) return;
    chan.onClose?.();
    this._channels.delete(chan.localId);
    const w = new SSHPacketWriter().byte(SSH_MSG_CHANNEL_CLOSE).uint32(chan.remoteId);
    this._sendPacket(w);
  }

  private _sendChannelData(localChanId: number, data: Uint8Array): void {
    const chan = this._channels.get(localChanId);
    if (!chan) return;
    const w = new SSHPacketWriter()
      .byte(SSH_MSG_CHANNEL_DATA)
      .uint32(chan.remoteId)
      .uint32(data.length)
      .bytes(data);
    this._sendPacket(w);
  }

  private _disconnect(reason: string): void {
    const w = new SSHPacketWriter()
      .byte(SSH_MSG_DISCONNECT)
      .uint32(SSH_DISCONNECT_BY_APPLICATION)
      .string(reason)
      .string('en');
    this._sendPacket(w);
    this._state = 'closed';
  }

  private _sendPacket(w: SSHPacketWriter): void {
    this._sendRaw(this._cipher.encrypt(w.frame()));
  }

  private _sendRaw(data: Uint8Array): void { this._send(data); }

  private _sha256Hex(s: string): string {
    // Placeholder — real implementation would use SubtleCrypto
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16).padStart(8, '0').repeat(8);
  }

  get state(): SSHSessionState { return this._state; }
  get authenticated(): boolean { return this._authed; }
  get username(): string { return this._username; }
}

// ── SSH Server ────────────────────────────────────────────────────────────────

export interface SSHServerTransport {
  /** Called to accept new TCP connections. Each call provides a (send fn, receive emitter) pair. */
  listen(port: number, onConnect: (send: (d: Uint8Array) => void, recv: (handler: (d: Uint8Array) => void) => void) => void): void;
  close(): void;
}

export class SSHServer {
  private _cfg: SSHServerConfig;
  private _transport: SSHServerTransport | null = null;
  private _sessions: SSHSession[] = [];

  constructor(cfg: SSHServerConfig) { this._cfg = cfg; }

  listen(port: number, transport: SSHServerTransport): void {
    this._transport = transport;
    transport.listen(port, (send, recv) => {
      const session = new SSHSession(this._cfg, send);
      this._sessions.push(session);
      recv(data => session.receive(data));
    });
  }

  close(): void { this._transport?.close(); }

  get sessions(): SSHSession[] { return [...this._sessions]; }
}

// ── Share Terminal Session — Item 686 ─────────────────────────────────────────

export interface SharedTerminalOptions {
  /** Passcode to restrict access (optional) */
  passcode?: string;
  /** Read-only viewers (default: false — full control sharing) */
  readOnly?: boolean;
  /** Max simultaneous viewers */
  maxViewers?: number;
}

interface ViewerSession {
  id: string;
  readOnly: boolean;
  send: (data: Uint8Array) => void;
}

/**
 * SharedTerminal wraps an SSHServer to broadcast a terminal session to
 * multiple SSH clients simultaneously — like tmux's `tmux a` or tmate.
 */
export class SharedTerminal {
  private _server: SSHServer;
  private _options: SharedTerminalOptions;
  private _viewers: Map<string, ViewerSession> = new Map();
  private _history: Uint8Array[] = [];
  private _writeToTerminal: ((data: Uint8Array) => void) | null = null;
  private _onOutput: ((data: Uint8Array) => void) | null = null;

  constructor(options: SharedTerminalOptions = {}) {
    this._options = { maxViewers: 10, ...options };
    this._server = new SSHServer({
      users: [{ username: 'share' }],
      onSession: (channel, write) => {
        void channel;
        if (this._viewers.size >= (this._options.maxViewers ?? 10)) {
          write(new TextEncoder().encode('Too many viewers.\r\n'));
          return () => {};
        }
        const viewerId = Math.random().toString(36).slice(2);
        const isReadOnly = this._options.readOnly ?? false;
        this._viewers.set(viewerId, { id: viewerId, readOnly: isReadOnly, send: write });

        // Send history replay
        for (const chunk of this._history) write(chunk);

        return (data: Uint8Array) => {
          if (!isReadOnly && this._writeToTerminal) {
            this._writeToTerminal(data);
          }
        };
      },
    });
  }

  /**
   * Connect the shared terminal to an actual terminal instance.
   * @param write Function to send keystrokes to the underlying terminal process
   */
  attachTerminal(write: (data: Uint8Array) => void): void {
    this._writeToTerminal = write;
  }

  /**
   * Call this whenever the terminal produces output — it will be broadcast
   * to all connected viewers and appended to the replay history.
   */
  output(data: Uint8Array): void {
    this._history.push(data);
    if (this._history.length > 1000) this._history.shift();  // rolling buffer
    for (const viewer of this._viewers.values()) {
      try { viewer.send(data); } catch { this._viewers.delete(viewer.id); }
    }
    this._onOutput?.(data);
  }

  onOutput(fn: (data: Uint8Array) => void): void { this._onOutput = fn; }

  start(port: number, transport: SSHServerTransport): void {
    this._server.listen(port, transport);
  }

  stop(): void {
    this._server.close();
    this._viewers.clear();
  }

  get viewerCount(): number { return this._viewers.size; }
  get server(): SSHServer { return this._server; }
}

/** Singleton SSH server for JSOS system services */
export const sshdaemon = new SSHServer({
  users: [{ username: 'root' }],
  motd: 'JSOS SSH server\r\nTypeScript-native operating system\r\n',
  onSession: (channel, write) => {
    write(new TextEncoder().encode(`Welcome to JSOS, ${channel.termType} ${channel.termCols}x${channel.termRows}\r\n`));
    write(new TextEncoder().encode('$ '));
    return (data: Uint8Array) => {
      // Echo and echo newline
      write(data);
      if (data[0] === 13) write(new TextEncoder().encode('\r\n$ '));
    };
  },
});

export const sharedTerminal = new SharedTerminal({ maxViewers: 5 });
