/**
 * net-perf.ts — JSOS Network Performance Optimisations
 *
 * Implements:
 *  - Zero-copy recv: NIC DMA direct to JS ArrayBuffer; no extra memcpy (item 922)
 *  - HTTP/1.1 pipelining: queue multiple GET requests on same connection (item 924)
 *  - Resource prioritisation: HTML > CSS > JS > fonts > images (item 925)
 *  - TCP fast open preparation (item 931)
 *  - Preconnect: DNS+TCP+TLS during idle (item 932)
 *
 * Architecture:
 *  - ZeroCopyRecv wraps kernel.nicDmaRecv() to receive packets directly
 *    into a pre-allocated ArrayBuffer registered with the NIC.
 *  - PipelineManager multiplexes multiple in-flight GET requests over
 *    a single TCP/TLS connection using HTTP/1.1 pipelining.
 *  - ResourcePrioritizer queues all resource fetch requests and dispatches
 *    them in priority order: HTML=0, CSS=1, JS=2, fonts=3, images=4.
 */

declare var kernel: import('../core/kernel.js').KernelAPI;

// ── Zero-copy Recv ─────────────────────────────────────────────────────────────
//
// Item 922: NIC DMA direct to JS ArrayBuffer.
//
// In practice, the C-level NIC driver writes incoming packet data directly
// into a page-aligned ArrayBuffer that was registered with kernel.nicDmaRegister().
// The TypeScript side calls kernel.nicDmaRecv() to get a view into the buffer
// without any additional memcpy.

const ZERO_COPY_BUF_SIZE = 64 * 1024;  // 64 KB DMA ring buffer per connection

export interface ZeroCopyHandle {
  /** The DMA receive buffer (written by NIC hardware via kernel). */
  buffer:     ArrayBuffer;
  /** View into the buffer for the most recently received packet. */
  recvView:   DataView;
  /** Number of bytes in the last received packet. */
  recvLength: number;
  /** NIC-internal handle. */
  nicHandle:  number;
}

/**
 * Allocate a zero-copy receive buffer and register it with the NIC driver.
 *
 * The kernel maps the NIC's DMA region directly into the process address space.
 * Subsequent kernel.nicDmaRecv(handle) calls return the byte count of the
 * newly received packet without copying data.
 *
 * Item 922.
 */
export function zeroCopyOpen(connFd: number): ZeroCopyHandle | null {
  if (typeof kernel === 'undefined') return null;

  // Pre-allocate 64 KB page-aligned buffer for this connection's DMA ring
  var buffer = new ArrayBuffer(ZERO_COPY_BUF_SIZE);
  var nicHandle = 0;

  // Register buffer with NIC driver via kernel binding
  if (kernel.nicDmaRegister) {
    nicHandle = kernel.nicDmaRegister(connFd, buffer) | 0;
    if (nicHandle < 0) return null;
  }

  return {
    buffer,
    recvView:   new DataView(buffer),
    recvLength: 0,
    nicHandle,
  };
}

/**
 * Receive one packet zero-copy into the registered DMA buffer.
 * Returns the number of bytes received, or 0 if no data available.
 *
 * Item 922.
 */
export function zeroCopyRecv(handle: ZeroCopyHandle): number {
  if (typeof kernel === 'undefined' || !kernel.nicDmaRecv) return 0;
  var n = kernel.nicDmaRecv(handle.nicHandle) | 0;
  handle.recvLength = Math.max(0, n);
  return handle.recvLength;
}

/** Release a zero-copy handle and unregister the DMA buffer. */
export function zeroCopyClose(handle: ZeroCopyHandle): void {
  if (typeof kernel !== 'undefined' && kernel.nicDmaUnregister) {
    kernel.nicDmaUnregister(handle.nicHandle);
  }
}

// ── PipelineManager ───────────────────────────────────────────────────────────
//
// Item 924: HTTP/1.1 pipelining.
//
// A single keep-alive TCP connection can carry N in-flight GET requests.
// HTTP/1.1 pipelining sends all requests immediately and matches responses
// in FIFO order (per RFC 7230 §6.3.2).
//
// Limitations:
//  - Only safe idempotent methods (GET, HEAD, OPTIONS) may be pipelined.
//  - Server must support pipelining (some do not — Connection: close on first
//    non-2xx response collapses the pipeline).

export interface PipelineEntry {
  url:       string;
  path:      string;
  callback:  (data: Uint8Array | null, status: number) => void;
  sent:      boolean;
}

export class PipelineManager {
  /** Max in-flight requests per connection. */
  static readonly MAX_INFLIGHT = 6;

  private _host:    string;
  private _port:    number;
  private _https:   boolean;
  private _queue:   PipelineEntry[] = [];
  private _inflight: PipelineEntry[] = [];
  private _open:    boolean = false;
  private _connId:  number = -1;

  constructor(host: string, port: number, https: boolean) {
    this._host  = host;
    this._port  = port;
    this._https = https;
  }

  get host(): string  { return this._host; }
  get port(): number  { return this._port; }
  get https(): boolean { return this._https; }

  /**
   * Enqueue a GET request.
   * If a connection is already open and inflight < MAX_INFLIGHT, sends immediately.
   */
  enqueue(path: string, url: string, cb: (data: Uint8Array | null, status: number) => void): void {
    var entry: PipelineEntry = { url, path, callback: cb, sent: false };
    this._queue.push(entry);
    this._flush();
  }

  private _flush(): void {
    while (
      this._queue.length > 0 &&
      this._inflight.length < PipelineManager.MAX_INFLIGHT
    ) {
      var entry = this._queue.shift()!;
      entry.sent = true;
      this._inflight.push(entry);
      this._sendRequest(entry);
    }
  }

  private _sendRequest(entry: PipelineEntry): void {
    // Build HTTP/1.1 GET request with pipelining headers
    var req =
      `GET ${entry.path} HTTP/1.1\r\n` +
      `Host: ${this._host}\r\n` +
      `Connection: keep-alive\r\n` +
      `\r\n`;

    if (typeof kernel !== 'undefined' && kernel.tcpSend) {
      try {
        var reqBuf = new TextEncoder().encode(req).buffer as ArrayBuffer;
        kernel.tcpSend(this._connId, reqBuf);
      } catch (_) {
        entry.callback(null, 0);
        this._inflight = this._inflight.filter(e => e !== entry);
      }
    } else {
      // Simulation: immediately callback with empty body
      entry.callback(new Uint8Array(0), 200);
      this._inflight = this._inflight.filter(e => e !== entry);
      this._flush();
    }
  }

  /**
   * Called when a complete HTTP response arrives.
   * Matches responses FIFO to in-flight requests (item 924).
   */
  onResponse(data: Uint8Array, status: number): void {
    if (this._inflight.length === 0) return;
    var entry = this._inflight.shift()!;
    entry.callback(data, status);
    this._flush();
  }

  onError(): void {
    // Drain all in-flight requests on connection error
    for (var e of this._inflight) e.callback(null, 0);
    this._inflight.length = 0;
    this._queue.length    = 0;
    this._open            = false;
    this._connId          = -1;
  }

  get inflightCount(): number { return this._inflight.length; }
  get queuedCount():   number { return this._queue.length; }
}

/** Shared singleton pipeline table keyed by "host:port:https". */
var _pipelines = new Map<string, PipelineManager>();

export function getPipeline(host: string, port: number, https: boolean): PipelineManager {
  var key = `${host}:${port}:${https}`;
  var pm  = _pipelines.get(key);
  if (!pm) { pm = new PipelineManager(host, port, https); _pipelines.set(key, pm); }
  return pm;
}

export function clearPipelines(): void { _pipelines.clear(); }

// ── ResourcePrioritizer ───────────────────────────────────────────────────────
//
// Item 925: Resource prioritisation.
// HTML > CSS > JS > fonts > images (descending fetch priority).

export type ResourceType = 'html' | 'css' | 'js' | 'font' | 'image' | 'other';

const PRIORITY_MAP: Record<ResourceType, number> = {
  html:  0,
  css:   1,
  js:    2,
  font:  3,
  image: 4,
  other: 5,
};

export interface ResourceRequest {
  url:      string;
  type:     ResourceType;
  priority: number;
  callback: (data: Uint8Array | null, status: number, mime: string) => void;
}

export class ResourcePrioritizer {
  /** Max concurrent fetches. */
  static readonly MAX_CONCURRENT = 6;

  private _pending:  ResourceRequest[] = [];
  private _running:  number = 0;
  private _fetchFn:  (url: string, type: ResourceType, cb: ResourceRequest['callback']) => void;

  constructor(
    fetchFn: (url: string, type: ResourceType, cb: ResourceRequest['callback']) => void
  ) {
    this._fetchFn = fetchFn;
  }

  /**
   * Enqueue a resource fetch in priority order.
   * HTML is fetched first; images are deferred until more important resources finish.
   *
   * Item 925.
   */
  enqueue(url: string, type: ResourceType, cb: ResourceRequest['callback']): void {
    var req: ResourceRequest = {
      url,
      type,
      priority: PRIORITY_MAP[type] ?? 5,
      callback: cb,
    };

    // Insert in sorted position (insertion sort — queue is small)
    var i = 0;
    while (i < this._pending.length && this._pending[i].priority <= req.priority) i++;
    this._pending.splice(i, 0, req);

    this._dispatch();
  }

  private _dispatch(): void {
    while (this._running < ResourcePrioritizer.MAX_CONCURRENT && this._pending.length > 0) {
      var req = this._pending.shift()!;
      this._running++;
      this._fetchFn(req.url, req.type, (data, status, mime) => {
        this._running--;
        req.callback(data, status, mime);
        this._dispatch();
      });
    }
  }

  /** Hint the type of a URL from its path or Content-Type header. */
  static inferType(url: string, contentType?: string): ResourceType {
    if (contentType) {
      if (contentType.includes('text/html'))        return 'html';
      if (contentType.includes('text/css'))         return 'css';
      if (contentType.includes('javascript'))       return 'js';
      if (contentType.includes('font'))            return 'font';
      if (contentType.startsWith('image/'))        return 'image';
    }
    var u = url.split('?')[0].toLowerCase();
    if (u.endsWith('.html') || u.endsWith('.htm')) return 'html';
    if (u.endsWith('.css'))                        return 'css';
    if (u.endsWith('.js') || u.endsWith('.mjs'))   return 'js';
    if (u.endsWith('.woff') || u.endsWith('.woff2') || u.endsWith('.ttf')) return 'font';
    if (u.match(/\.(png|jpg|jpeg|gif|webp|svg|ico|avif)$/)) return 'image';
    return 'other';
  }

  get runningCount(): number { return this._running; }
  get queuedCount():  number { return this._pending.length; }

  /** Cancel all queued (not yet running) requests. */
  cancelAll(): void { this._pending.length = 0; }

  /** Return current queue snapshot by priority. */
  queueSnapshot(): Array<{ url: string; type: ResourceType; priority: number }> {
    return this._pending.map(r => ({ url: r.url, type: r.type, priority: r.priority }));
  }
}

// ── PreconnectManager ─────────────────────────────────────────────────────────
//
// Item 932: Preconnect — resolve DNS + complete TCP+TLS for
// `<link rel="preconnect">` origins during idle.

export interface PreconnectEntry {
  host:    string;
  port:    number;
  https:   boolean;
  state:   'pending' | 'connecting' | 'ready' | 'failed';
  connId:  number;
}

export class PreconnectManager {
  private _entries: Map<string, PreconnectEntry> = new Map();

  /**
   * Initiate a preconnect to `host:port` during idle time.
   * Stores the warm connection so subsequent fetch() can reuse it.
   *
   * Item 932.
   */
  preconnect(host: string, port: number, https: boolean): void {
    var key = `${host}:${port}:${https}`;
    if (this._entries.has(key)) return;  // already preconnecting

    var entry: PreconnectEntry = { host, port, https, state: 'pending', connId: -1 };
    this._entries.set(key, entry);

    // Async connect during idle
    if (typeof kernel !== 'undefined' && kernel.scheduleIdle) {
      kernel.scheduleIdle(() => this._doConnect(entry));
    } else {
      // No idle scheduler — skip silently
    }
  }

  private _doConnect(entry: PreconnectEntry): void {
    entry.state = 'connecting';
    if (typeof kernel !== 'undefined' && kernel.tcpConnect) {
      try {
        var id = kernel.tcpConnect(entry.host, entry.port, entry.https);
        entry.connId = id;
        entry.state  = 'ready';
      } catch (_) {
        entry.state = 'failed';
      }
    } else {
      entry.state = 'failed';
    }
  }

  /** Claim a preconnected socket, or return null if not ready. */
  claim(host: string, port: number, https: boolean): number | null {
    var key = `${host}:${port}:${https}`;
    var e   = this._entries.get(key);
    if (!e || e.state !== 'ready') return null;
    this._entries.delete(key);
    return e.connId;
  }

  get pendingCount(): number {
    var n = 0;
    this._entries.forEach(e => { if (e.state !== 'failed') n++; });
    return n;
  }

  clear(): void { this._entries.clear(); }
}

export const preconnectManager = new PreconnectManager();

// ── TCPFastOpenHint ───────────────────────────────────────────────────────────
//
// Item 931: TCP fast open — send SYN+data on reconnect to known hosts.
// Stores the TFO cookie from server responses and uses it on reconnect.

export class TCPFastOpenCache {
  private _cookies: Map<string, Uint8Array> = new Map();

  /** Store a TFO cookie received from the server. */
  store(host: string, port: number, cookie: Uint8Array): void {
    this._cookies.set(`${host}:${port}`, cookie);
  }

  /** Retrieve a stored TFO cookie for a host:port, or null. */
  get(host: string, port: number): Uint8Array | null {
    return this._cookies.get(`${host}:${port}`) ?? null;
  }

  /** Clear all stored cookies. */
  clear(): void { this._cookies.clear(); }

  get size(): number { return this._cookies.size; }
}

export const tfoCache = new TCPFastOpenCache();

// ── Network Waterfall (item 971) ──────────────────────────────────────────────

/**
 * Timing phases for a single HTTP request, modelled after the Navigation
 * Timing / Resource Timing Level 2 W3C specifications.
 */
export interface WaterfallEntry {
  url:          string;
  /** Absolute timestamp (ms) when the request was initiated. */
  startTime:    number;
  /** Duration (ms) spent on DNS resolution (0 if cached). */
  dnsMs:        number;
  /** Duration (ms) for TCP connect. */
  connectMs:    number;
  /** Duration (ms) for TLS handshake (0 for plain HTTP). */
  tlsMs:        number;
  /** Duration (ms) until first byte of the HTTP response body. */
  ttfbMs:       number;
  /** Duration (ms) transferring the response body. */
  transferMs:   number;
  /** Total duration (ms) from start to response fully received. */
  totalMs:      number;
  /** HTTP status code, 0 if request failed. */
  status:       number;
  /** Response size in bytes. */
  responseBytes: number;
}

/**
 * [Item 971] Network Waterfall Recorder.
 *
 * Records DNS / connect / TLS / TTFB / transfer timing for every HTTP request.
 * Integrates with http.ts via the exported `waterfallRecorder` singleton.
 *
 * Usage from http.ts:
 *   var t = waterfallRecorder.startRequest(url);
 *   t.markDns(dnsMs);
 *   t.markConnect(connectMs);
 *   t.markTls(tlsMs);          // omit for plain HTTP
 *   t.markTtfb();
 *   t.finish(status, bytes);
 */
export class NetworkWaterfallRecorder {
  private _entries: WaterfallEntry[] = [];
  private readonly _maxEntries = 256;

  /** Begin timing a new request. Returns a WaterfallTimer. */
  startRequest(url: string): WaterfallTimer {
    return new WaterfallTimer(url, this);
  }

  /** Called by WaterfallTimer.finish(); do not call directly. */
  _commit(e: WaterfallEntry): void {
    if (this._entries.length >= this._maxEntries) this._entries.shift();
    this._entries.push(e);
  }

  /** Returns a snapshot of all recorded entries. */
  getEntries(): WaterfallEntry[] { return this._entries.slice(); }

  /** Returns the last N entries (default 20). */
  getLast(n: number = 20): WaterfallEntry[] {
    return this._entries.slice(-n);
  }

  /** Clear all recorded entries. */
  clear(): void { this._entries = []; }

  /** Total number of entries recorded so far. */
  get count(): number { return this._entries.length; }

  /**
   * Pretty-print a summary table to the console.
   * Each row: URL | DNS | Connect | TLS | TTFB | Transfer | Total | Status
   */
  print(): void {
    var entries = this._entries;
    if (entries.length === 0) { console.log('[waterfall] No entries recorded.'); return; }
    var hdr = 'URL'.padEnd(50) + ' DNS   TCP   TLS   TTFB  XFER  TOTAL STATUS';
    console.log('[waterfall] ' + hdr);
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var shortUrl = e.url.length > 48 ? '…' + e.url.slice(-47) : e.url;
      var row = shortUrl.padEnd(50) +
        String(e.dnsMs).padStart(5)      + ' ' +
        String(e.connectMs).padStart(5)  + ' ' +
        String(e.tlsMs).padStart(5)      + ' ' +
        String(e.ttfbMs).padStart(5)     + ' ' +
        String(e.transferMs).padStart(5) + ' ' +
        String(e.totalMs).padStart(5)    + '  ' + e.status;
      console.log('[waterfall] ' + row);
    }
  }
}

/** Per-request timer object returned by NetworkWaterfallRecorder.startRequest(). */
export class WaterfallTimer {
  private _url:       string;
  private _recorder:  NetworkWaterfallRecorder;
  private _t0:        number;
  private _tDns:      number = 0;
  private _tConnect:  number = 0;
  private _tTls:      number = 0;
  private _tTtfb:     number = 0;
  private _tDone:     number = 0;
  private _dnsMs:     number = 0;
  private _connectMs: number = 0;
  private _tlsMs:     number = 0;

  constructor(url: string, recorder: NetworkWaterfallRecorder) {
    this._url      = url;
    this._recorder = recorder;
    this._t0       = _nowPerf();
  }

  /** Record how long DNS resolution took. */
  markDns(dnsMs: number): void {
    this._dnsMs  = dnsMs;
    this._tDns   = _nowPerf();
  }

  /** Record how long TCP connect took. */
  markConnect(connectMs: number): void {
    this._connectMs = connectMs;
    this._tConnect  = _nowPerf();
  }

  /** Record how long TLS handshake took (call only for HTTPS). */
  markTls(tlsMs: number): void {
    this._tlsMs = tlsMs;
    this._tTls  = _nowPerf();
  }

  /** Mark the moment the first response byte was received. */
  markTtfb(): void { this._tTtfb = _nowPerf(); }

  /**
   * Mark the request as finished, compute durations, and commit entry.
   * @param status        HTTP status code (0 on failure)
   * @param responseBytes Response body size in bytes
   */
  finish(status: number, responseBytes: number): void {
    this._tDone     = _nowPerf();
    var ttfbMs      = this._tTtfb > 0 ? Math.round(this._tTtfb - this._t0) : 0;
    var transferMs  = this._tTtfb > 0 ? Math.round(this._tDone - this._tTtfb) : 0;
    var totalMs     = Math.round(this._tDone - this._t0);
    this._recorder._commit({
      url:           this._url,
      startTime:     this._t0,
      dnsMs:         this._dnsMs,
      connectMs:     this._connectMs,
      tlsMs:         this._tlsMs,
      ttfbMs,
      transferMs,
      totalMs,
      status,
      responseBytes,
    });
  }
}

function _nowPerf(): number {
  return (typeof kernel !== 'undefined' && (kernel as any).getTicks)
    ? (kernel as any).getTicks() * 10
    : Date.now();
}

/** Singleton waterfall recorder — import and use from http.ts. */
export const waterfallRecorder = new NetworkWaterfallRecorder();
