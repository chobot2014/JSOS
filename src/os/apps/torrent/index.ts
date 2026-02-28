/**
 * JSOS Torrent Client — Item 780
 * TypeScript BitTorrent client (BEP-3 + BEP-5 DHT stubs).
 */

// ── Bencode ───────────────────────────────────────────────────────────────────

export type BencodeValue = string | number | BencodeValue[] | Record<string, BencodeValue>;

export function bencodeDecode(data: Uint8Array): BencodeValue {
  let pos = 0;
  function decode(): BencodeValue {
    const c = data[pos];
    if (c === 0x69 /* 'i' */) {
      pos++;
      let neg = false;
      if (data[pos] === 0x2d) { neg = true; pos++; }
      let n = 0;
      while (data[pos] !== 0x65 /* 'e' */) { n = n * 10 + (data[pos++] - 48); }
      pos++; // skip 'e'
      return neg ? -n : n;
    }
    if (c === 0x6c /* 'l' */) {
      pos++;
      const arr: BencodeValue[] = [];
      while (data[pos] !== 0x65) arr.push(decode());
      pos++; return arr;
    }
    if (c === 0x64 /* 'd' */) {
      pos++;
      const obj: Record<string, BencodeValue> = {};
      while (data[pos] !== 0x65) {
        const key = decode() as string;
        obj[key] = decode();
      }
      pos++; return obj;
    }
    // string: len:data
    let len = 0;
    while (data[pos] !== 0x3a /* ':' */) { len = len * 10 + (data[pos++] - 48); }
    pos++;
    const bytes = data.slice(pos, pos + len);
    pos += len;
    return new TextDecoder().decode(bytes);
  }
  return decode();
}

export function bencodeEncode(val: BencodeValue): Uint8Array {
  const enc = new TextEncoder();
  function encodeStr(s: string): Uint8Array {
    const b = enc.encode(s);
    return new Uint8Array([...enc.encode(String(b.length) + ':'), ...b]);
  }
  function go(v: BencodeValue): Uint8Array {
    if (typeof v === 'number') {
      return enc.encode(`i${v}e`);
    }
    if (typeof v === 'string') return encodeStr(v);
    if (Array.isArray(v)) {
      const parts = [enc.encode('l'), ...v.map(go), enc.encode('e')];
      const total = parts.reduce(function(a, b) { return a + b.length; }, 0);
      const out = new Uint8Array(total); let off = 0;
      parts.forEach(function(p) { out.set(p, off); off += p.length; });
      return out;
    }
    // dict — keys must be sorted
    const keys = Object.keys(v).sort();
    const parts = [enc.encode('d')];
    for (const k of keys) { parts.push(encodeStr(k)); parts.push(go(v[k])); }
    parts.push(enc.encode('e'));
    const total = parts.reduce(function(a, b) { return a + b.length; }, 0);
    const out = new Uint8Array(total); let off = 0;
    parts.forEach(function(p) { out.set(p, off); off += p.length; });
    return out;
  }
  return go(val);
}

// ── .torrent Metainfo ─────────────────────────────────────────────────────────

export interface TorrentFile {
  path: string[];
  length: number;
}

export interface TorrentInfo {
  name: string;
  pieceLength: number;
  pieces: Uint8Array[];  // array of 20-byte SHA-1 hashes
  files?: TorrentFile[];
  length?: number;       // single-file mode
  private?: boolean;
}

export interface TorrentMetainfo {
  info: TorrentInfo;
  infoHash: Uint8Array;   // SHA-1 of bencoded info dict (20 bytes)
  announce: string;
  announceList?: string[][];
  comment?: string;
  createdBy?: string;
  creationDate?: number;
}

export function parseTorrent(data: Uint8Array): TorrentMetainfo {
  const dict = bencodeDecode(data) as Record<string, BencodeValue>;
  const info = dict['info'] as Record<string, BencodeValue>;
  const piecesStr = info['pieces'] as string;
  const pieceHashes: Uint8Array[] = [];
  const enc = new TextEncoder();
  const piecesBytes = enc.encode(piecesStr);
  for (let i = 0; i + 20 <= piecesBytes.length; i += 20) {
    pieceHashes.push(piecesBytes.slice(i, i + 20));
  }
  const files = info['files'] as Array<Record<string, BencodeValue>> | undefined;
  const torrentInfo: TorrentInfo = {
    name: info['name'] as string,
    pieceLength: info['piece length'] as number,
    pieces: pieceHashes,
    private: (info['private'] as number) === 1,
    files: files?.map(function(f) {
      return { path: (f['path'] as string[]), length: f['length'] as number };
    }),
    length: info['length'] as number | undefined,
  };
  // Compute info hash (placeholder — real impl SHA-1 hashes bencoded info dict)
  const infoHash = new Uint8Array(20); // placeholder
  const announceList = dict['announce-list'] as string[][] | undefined;
  return {
    info: torrentInfo,
    infoHash,
    announce: dict['announce'] as string,
    announceList,
    comment: dict['comment'] as string | undefined,
    createdBy: dict['created by'] as string | undefined,
    creationDate: dict['creation date'] as number | undefined,
  };
}

// ── Peer wire protocol ────────────────────────────────────────────────────────

export type PeerMessageType =
  | 'choke' | 'unchoke' | 'interested' | 'not-interested'
  | 'have' | 'bitfield' | 'request' | 'piece' | 'cancel'
  | 'port' | 'handshake' | 'keepalive';

export interface PeerMessage {
  type: PeerMessageType;
  index?: number;
  begin?: number;
  length?: number;
  data?: Uint8Array;
  bitfield?: Uint8Array;
  port?: number;
}

export function encodePeerMessage(msg: PeerMessage): Uint8Array {
  const ids: Record<string, number> = {
    choke: 0, unchoke: 1, interested: 2, 'not-interested': 3,
    have: 4, bitfield: 5, request: 6, piece: 7, cancel: 8, port: 9,
  };
  if (msg.type === 'keepalive') return new Uint8Array(4); // 4 zero bytes
  if (msg.type === 'handshake') {
    // 1 + 19 + 8 + 20 + 20 bytes
    const pstr = new TextEncoder().encode('BitTorrent protocol');
    return new Uint8Array([19, ...pstr, 0, 0, 0, 0, 0, 0, 0, 0, ...new Uint8Array(40)]);
  }
  const id = ids[msg.type] ?? 0;
  switch (msg.type) {
    case 'choke': case 'unchoke': case 'interested': case 'not-interested':
      return new Uint8Array([0, 0, 0, 1, id]);
    case 'have':
      return new Uint8Array([0, 0, 0, 5, id, (msg.index! >> 24) & 0xff, (msg.index! >> 16) & 0xff, (msg.index! >> 8) & 0xff, msg.index! & 0xff]);
    case 'request': case 'cancel': {
      const i = msg.index!; const b = msg.begin!; const l = msg.length!;
      return new Uint8Array([0, 0, 0, 13, id, i>>24&0xff,i>>16&0xff,i>>8&0xff,i&0xff, b>>24&0xff,b>>16&0xff,b>>8&0xff,b&0xff, l>>24&0xff,l>>16&0xff,l>>8&0xff,l&0xff]);
    }
    default:
      return new Uint8Array([0, 0, 0, 1, id]);
  }
}

// ── Tracker ───────────────────────────────────────────────────────────────────

export interface TrackerAnnounceParams {
  infoHash: string;  // URL-encoded 20-byte hash
  peerId: string;    // URL-encoded 20-byte peer ID
  port: number;
  uploaded: number;
  downloaded: number;
  left: number;
  event?: 'started' | 'stopped' | 'completed';
  compact?: 1 | 0;
}

export interface TrackerPeer {
  ip: string;
  port: number;
  peerId?: string;
}

export interface TrackerResponse {
  interval: number;
  minInterval?: number;
  peers: TrackerPeer[];
  complete: number;
  incomplete: number;
  trackerId?: string;
  warning?: string;
}

export async function trackerAnnounce(
  announceUrl: string,
  params: TrackerAnnounceParams,
): Promise<TrackerResponse> {
  // Build query string
  const q = Object.entries(params)
    .filter(function([, v]) { return v !== undefined; })
    .map(function([k, v]) { return `${k}=${v}`; })
    .join('&');
  const url = `${announceUrl}?${q}`;
  // Real impl: fetch URL via JSOS net stack, parse bencoded response
  void url;
  return { interval: 1800, peers: [], complete: 0, incomplete: 0 };
}

// ── DHT (BEP-5) stub ─────────────────────────────────────────────────────────

export interface DHTNode {
  id: Uint8Array;   // 20-byte node ID
  ip: string;
  port: number;
  lastSeen: Date;
}

export class DHTClient {
  private _nodeId: Uint8Array;
  private _routingTable: DHTNode[] = [];
  private _port: number;

  constructor(port = 6881) {
    this._port = port;
    // Random 20-byte node ID
    this._nodeId = crypto.getRandomValues(new Uint8Array(20));
  }

  get nodeId(): Uint8Array { return this._nodeId; }

  /** Bootstrap DHT from well-known nodes. */
  async bootstrap(): Promise<void> {
    const bootstrapNodes = [
      { host: 'router.bittorrent.com', port: 6881 },
      { host: 'dht.transmissionbt.com', port: 6881 },
      { host: 'router.utorrent.com', port: 6881 },
    ];
    void bootstrapNodes; // placeholder — real impl sends FIND_NODE
  }

  /** Find peers for an info hash via DHT GET_PEERS. */
  async getPeers(infoHash: Uint8Array): Promise<TrackerPeer[]> {
    void infoHash; // placeholder
    return [];
  }

  /** Announce ourselves as a peer for an info hash. */
  async announcePeer(infoHash: Uint8Array, port: number): Promise<void> {
    void infoHash; void port; // placeholder
  }

  addNode(node: DHTNode): void { this._routingTable.push(node); }
  nodes(): DHTNode[] { return this._routingTable.slice(); }
  get port(): number { return this._port; }
}

// ── Torrent Download Manager ──────────────────────────────────────────────────

export type TorrentStatus = 'stopped' | 'checking' | 'downloading' | 'seeding' | 'finished' | 'error';

export interface TorrentStats {
  uploaded: number;
  downloaded: number;
  left: number;
  ratio: number;
  piecesDone: number;
  piecesTotal: number;
  downloadRate: number;  // bytes/sec
  uploadRate: number;
  peers: number;
  seeds: number;
  eta: number;           // seconds (-1 = unknown)
  progress: number;      // 0.0–1.0
}

export class TorrentDownload {
  readonly metainfo: TorrentMetainfo;
  private _status: TorrentStatus = 'stopped';
  private _bitfield: Uint8Array;
  private _peers: TrackerPeer[] = [];
  private _dht: DHTClient;
  private _stats: TorrentStats;
  private _savePath: string;

  constructor(metainfo: TorrentMetainfo, savePath: string) {
    this.metainfo = metainfo;
    this._savePath = savePath;
    const numPieces = metainfo.info.pieces.length;
    this._bitfield = new Uint8Array(Math.ceil(numPieces / 8));
    this._dht = new DHTClient();
    this._stats = {
      uploaded: 0, downloaded: 0,
      left: this._totalLength(),
      ratio: 0, piecesDone: 0, piecesTotal: numPieces,
      downloadRate: 0, uploadRate: 0, peers: 0, seeds: 0, eta: -1, progress: 0,
    };
  }

  private _totalLength(): number {
    if (this.metainfo.info.length !== undefined) return this.metainfo.info.length;
    return (this.metainfo.info.files ?? []).reduce(function(a, f) { return a + f.length; }, 0);
  }

  get status(): TorrentStatus { return this._status; }
  get stats(): TorrentStats { return { ...this._stats }; }
  get savePath(): string { return this._savePath; }
  get infoHash(): string {
    return Array.from(this.metainfo.infoHash).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async start(): Promise<void> {
    this._status = 'downloading';
    await this._dht.bootstrap();
    const peers = await this._dht.getPeers(this.metainfo.infoHash);
    this._peers = peers;
    this._stats.peers = peers.length;
    // Real impl: connect to peers, exchange bitfields, request missing pieces
  }

  pause(): void { this._status = 'stopped'; }

  resume(): void {
    if (this._status === 'stopped') this.start().catch(function(_) {});
  }

  stop(): void { this._status = 'stopped'; this._peers = []; }

  /** Simulate receiving a completed piece. */
  receivePiece(index: number): void {
    const byte = Math.floor(index / 8);
    const bit  = 7 - (index % 8);
    this._bitfield[byte] |= (1 << bit);
    this._stats.piecesDone++;
    const pieceLen = this.metainfo.info.pieceLength;
    this._stats.downloaded += pieceLen;
    this._stats.left = Math.max(0, this._stats.left - pieceLen);
    this._stats.progress = this._stats.piecesDone / this._stats.piecesTotal;
    if (this._stats.piecesDone >= this._stats.piecesTotal) this._status = 'seeding';
  }

  hasPiece(index: number): boolean {
    const byte = Math.floor(index / 8);
    const bit  = 7 - (index % 8);
    return !!(this._bitfield[byte] & (1 << bit));
  }

  peers(): TrackerPeer[] { return this._peers.slice(); }
  dht(): DHTClient { return this._dht; }
}

// ── Torrent Manager ───────────────────────────────────────────────────────────

export class TorrentManager {
  private _downloads: Map<string, TorrentDownload> = new Map();
  private _defaultSavePath: string = '/home/user/Downloads';

  setDefaultSavePath(path: string): void { this._defaultSavePath = path; }

  add(metainfo: TorrentMetainfo, savePath?: string): TorrentDownload {
    const hashHex = Array.from(metainfo.infoHash).map(b => b.toString(16).padStart(2, '0')).join('');
    const dl = new TorrentDownload(metainfo, savePath ?? this._defaultSavePath);
    this._downloads.set(hashHex, dl);
    return dl;
  }

  addFromFile(torrentData: Uint8Array, savePath?: string): TorrentDownload {
    const meta = parseTorrent(torrentData);
    return this.add(meta, savePath);
  }

  remove(infoHash: string, deleteData = false): void {
    const dl = this._downloads.get(infoHash);
    if (dl) {
      dl.stop();
      if (deleteData) { /* delete saved files via fs */ }
      this._downloads.delete(infoHash);
    }
  }

  get(infoHash: string): TorrentDownload | undefined { return this._downloads.get(infoHash); }

  list(): TorrentDownload[] {
    const arr: TorrentDownload[] = [];
    this._downloads.forEach(function(d) { arr.push(d); });
    return arr;
  }

  totalStats(): { totalDown: number; totalUp: number; active: number } {
    let totalDown = 0; let totalUp = 0; let active = 0;
    this._downloads.forEach(function(d) {
      const s = d.stats;
      totalDown += s.downloaded;
      totalUp += s.uploaded;
      if (d.status === 'downloading') active++;
    });
    return { totalDown, totalUp, active };
  }
}

export const torrentManager = new TorrentManager();
