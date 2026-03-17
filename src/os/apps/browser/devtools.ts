/**
 * devtools.ts — Browser Developer Tools for JSOS Browser
 *
 * Implements items 797–801 from 1000-things.md:
 *
 *  797. Browser DevTools panel (F12 toggle)
 *  798. Browser DOM inspector (element tree view)
 *  799. Browser network inspector (request/response log)
 *  800. Browser console (JS errors + console.log output)
 *  801. Browser source maps support (decode minified stack traces)
 */

import type { VElement, VDocument } from './dom.js';

// ── DevTools panel toggle — Item 797 ────────────────────────────────────────

/** Available DevTools tabs. */
export type DevToolsTab = 'elements' | 'console' | 'network' | 'sources' | 'performance';

/**
 * [Item 797] DevToolsPanel — toggled open with F12.
 *
 *  The panel hosts four sub-tools: DOM inspector, console, network inspector,
 *  and source viewer.  Each sub-tool is implemented as a separate class below;
 *  `DevToolsPanel` orchestrates them and owns the panel's visible/hidden state.
 */
export class DevToolsPanel {
  private _visible = false;
  private _activeTab: DevToolsTab = 'elements';

  /** Toggle the DevTools panel open/closed. */
  toggle(): void { this._visible = !this._visible; }

  open(tab?: DevToolsTab): void {
    this._visible = true;
    if (tab) this._activeTab = tab;
  }

  close(): void { this._visible = false; }

  get isOpen(): boolean { return this._visible; }
  get activeTab(): DevToolsTab { return this._activeTab; }

  /** Switch to a different tab. */
  selectTab(tab: DevToolsTab): void { this._activeTab = tab; }

  /**
   * Render the DevTools panel as a plain-text summary for the JSOS terminal.
   * A full GUI would use the canvas APIs; this text version is useful for
   * scripted inspection.
   */
  render(doc: VDocument | null, netInspector: NetworkInspector, cons: BrowserConsole): string {
    var lines: string[] = [];
    lines.push('=== DevTools [' + this._activeTab.toUpperCase() + '] ===');

    if (this._activeTab === 'elements' && doc) {
      lines.push(domInspector.inspect(doc.body, 0, 4));
    } else if (this._activeTab === 'console') {
      var entries = cons.entries().slice(-20);
      for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        lines.push('[' + e.level.toUpperCase() + '] ' + e.text);
      }
    } else if (this._activeTab === 'network') {
      var reqs = netInspector.requests().slice(-20);
      for (var j = 0; j < reqs.length; j++) {
        var r = reqs[j];
        lines.push(r.method + ' ' + r.url + ' → ' + r.status + ' (' + r.durationMs + 'ms)');
      }
    }

    return lines.join('\n');
  }
}

export const devToolsPanel = new DevToolsPanel();

// ── DOM Inspector — Item 798 ─────────────────────────────────────────────────

/**
 * [Item 798] DOMInspector — walk a VElement tree and produce a readable,
 * indent-annotated HTML-like representation.  Used by the DevTools Elements
 * panel and by `sys.browser.inspect(selector)` in the REPL.
 */
export class DOMInspector {
  /**
   * Inspect `node` up to `maxDepth` levels deep.
   * Returns a multi-line string like a miniature HTML source view.
   */
  inspect(node: VElement | null, depth = 0, maxDepth = 8): string {
    if (!node || depth > maxDepth) return '';
    var indent = '  '.repeat(depth);
    var tag = node.tagName?.toLowerCase() ?? '#node';

    // Attribute summary
    var attrs = '';
    if (node.id)        attrs += ' id="' + node.id + '"';
    if (node.className) attrs += ' class="' + node.className + '"';

    var children = node.childNodes ?? [];
    var hasChildren = children.length > 0;

    if (!hasChildren) {
      var text = (node.textContent ?? '').slice(0, 40);
      return indent + '<' + tag + attrs + '>' + text + '</' + tag + '>';
    }

    var lines: string[] = [];
    lines.push(indent + '<' + tag + attrs + '>');
    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      if ((child as any).tagName) {
        lines.push(this.inspect(child as VElement, depth + 1, maxDepth));
      } else {
        var ct = ((child as any).textContent ?? '').trim().slice(0, 60);
        if (ct) lines.push(indent + '  ' + ct);
      }
    }
    lines.push(indent + '</' + tag + '>');
    return lines.filter(function(l) { return l.length > 0; }).join('\n');
  }

  /**
   * Find elements matching a CSS selector and return a summary array.
   * Uses `doc.querySelectorAll()`.
   */
  query(doc: VDocument, selector: string): Array<{ tag: string; id: string; class: string; text: string }> {
    var nodes = doc.querySelectorAll(selector);
    return nodes.map(function(n) {
      return {
        tag:   n.tagName?.toLowerCase() ?? '',
        id:    n.id ?? '',
        class: n.className ?? '',
        text:  (n.textContent ?? '').slice(0, 80),
      };
    });
  }
}

export const domInspector = new DOMInspector();

// ── Network Inspector — Item 799 ─────────────────────────────────────────────

/** A captured HTTP request/response pair. */
export interface NetworkEntry {
  id:         number;
  method:     string;
  url:        string;
  status:     number;
  statusText: string;
  /** Request headers (lowercase names). */
  reqHeaders: Record<string, string>;
  /** Response headers (lowercase names). */
  resHeaders: Record<string, string>;
  /** Response body size in bytes. */
  bodyBytes:  number;
  /** Total round-trip time in milliseconds. */
  durationMs: number;
  /** Monotonic start timestamp (ms). */
  startTs:    number;
  /** Was the response served from cache? */
  fromCache:  boolean;
}

/**
 * [Item 799] NetworkInspector — log and inspect all HTTP requests made by
 * the browser.  The `BrowserApp` calls `netInspector.record(...)` after each
 * fetch completes.  The DevTools network panel reads back `requests()`.
 */
export class NetworkInspector {
  private _entries: NetworkEntry[] = [];
  private _nextId = 1;
  enabled = true;

  /** Record a completed request. */
  record(entry: Omit<NetworkEntry, 'id'>): NetworkEntry {
    if (!this.enabled) return { ...entry, id: 0 };
    var full: NetworkEntry = { id: this._nextId++, ...entry };
    this._entries.push(full);
    // Cap at 1000 entries
    if (this._entries.length > 1000) this._entries.shift();
    return full;
  }

  /** Return all captured entries (newest last). */
  requests(): NetworkEntry[] { return this._entries.slice(); }

  /** Filter by URL substring. */
  filter(urlSubstring: string): NetworkEntry[] {
    return this._entries.filter(function(e) { return e.url.indexOf(urlSubstring) !== -1; });
  }

  /** Summary statistics. */
  stats(): { count: number; totalBytes: number; avgDurationMs: number; fromCacheCount: number } {
    var count = this._entries.length;
    var totalBytes = 0; var totalMs = 0; var cached = 0;
    for (var i = 0; i < count; i++) {
      totalBytes += this._entries[i].bodyBytes;
      totalMs    += this._entries[i].durationMs;
      if (this._entries[i].fromCache) cached++;
    }
    return { count, totalBytes, avgDurationMs: count > 0 ? totalMs / count : 0, fromCacheCount: cached };
  }

  clear(): void { this._entries = []; }
}

export const netInspector = new NetworkInspector();

// ── Browser Console — Item 800 ───────────────────────────────────────────────

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface ConsoleEntry {
  level:   ConsoleLevel;
  text:    string;
  /** JS stack trace if available (error level). */
  stack?:  string;
  /** Monotonic timestamp (ms since DevTools was created). */
  ts:      number;
}

/**
 * [Item 800] BrowserConsole — captures console.log / console.error output
 * and JS exceptions thrown in page scripts.  The DevTools console tab reads
 * from `entries()`.
 *
 *  `BrowserConsole.intercept()` patches the page's `console` object after
 *  each navigation so output is recorded here rather than (only) emitted to
 *  the JSOS terminal.
 */
export class BrowserConsole {
  private _entries: ConsoleEntry[] = [];
  private _epoch = Date.now();
  enabled = true;

  /** Append a console entry. */
  append(level: ConsoleLevel, text: string, stack?: string): void {
    if (!this.enabled) return;
    this._entries.push({ level, text, stack, ts: Date.now() - this._epoch });
    if (this._entries.length > 2000) this._entries.shift();
  }

  /** Record an uncaught JS exception. */
  recordError(err: Error | string): void {
    var msg = err instanceof Error ? err.message : String(err);
    var stack = err instanceof Error ? (err.stack ?? '') : '';
    this.append('error', msg, stack);
  }

  /** Return all entries. */
  entries(): ConsoleEntry[] { return this._entries.slice(); }

  /** Return only entries at or above a minimum severity. */
  filter(minLevel: ConsoleLevel): ConsoleEntry[] {
    var order: ConsoleLevel[] = ['debug', 'log', 'info', 'warn', 'error'];
    var minIdx = order.indexOf(minLevel);
    return this._entries.filter(function(e) { return order.indexOf(e.level) >= minIdx; });
  }

  clear(): void { this._entries = []; }

  /**
   * Intercept a console object (from a JS sandbox context) so its output
   * is forwarded to this BrowserConsole.
   */
  intercept(consoleObj: Record<string, Function>): void {
    var bc = this;
    (['log', 'info', 'warn', 'error', 'debug'] as ConsoleLevel[]).forEach(function(level) {
      var orig = consoleObj[level]?.bind(consoleObj);
      consoleObj[level] = function(...args: unknown[]) {
        var text = args.map(function(a) {
          return typeof a === 'object' ? JSON.stringify(a) : String(a);
        }).join(' ');
        bc.append(level, text);
        if (orig) orig(...args);
      };
    });
  }
}

export const browserConsole = new BrowserConsole();

// ── Source Maps — Item 801 ───────────────────────────────────────────────────

/** A single source-map entry mapping a generated position to an original one. */
export interface SourceMapEntry {
  generatedLine:   number;
  generatedColumn: number;
  originalSource:  string;
  originalLine:    number;
  originalColumn:  number;
  name?:           string;
}

/**
 * [Item 801] SourceMapDecoder — decode V3 source maps stored as JSON.
 *
 *  The decoder handles the VLQ-encoded `mappings` field and allows
 *  `resolve(url, line, col)` lookups so minified stack traces from page
 *  scripts can be translated to readable filename:line:col references.
 *
 *  Note: only the source-map index data structures are implemented here;
 *  full VLQ decode is deferred to an inline helper (`_decodeVLQ`).
 */
export class SourceMapDecoder {
  /** url → parsed SourceMapEntry[] */
  private _maps: Map<string, SourceMapEntry[]> = new Map();

  /** Parse and register a raw source-map JSON string for `url`. */
  register(url: string, sourceMapJson: string): void {
    try {
      var sm = JSON.parse(sourceMapJson);
      var entries = this._decodeMappings(sm);
      this._maps.set(url, entries);
    } catch (_) {}
  }

  /** Remove source map for a URL (e.g. after navigation). */
  unregister(url: string): void { this._maps.delete(url); }

  /**
   * Resolve (url, generatedLine, generatedCol) → original position.
   * Returns null when no source map is registered or no mapping found.
   */
  resolve(url: string, line: number, col: number): SourceMapEntry | null {
    var entries = this._maps.get(url);
    if (!entries || entries.length === 0) return null;

    // Binary search for closest entry at (line, col)
    var lo = 0; var hi = entries.length - 1; var best: SourceMapEntry | null = null;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      var e = entries[mid];
      if (e.generatedLine < line || (e.generatedLine === line && e.generatedColumn <= col)) {
        best = e;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return best;
  }

  /**
   * Decode a minified stack-trace string, replacing generated positions with
   * original source positions where maps are available.
   */
  decodeStack(stack: string): string {
    var lines = stack.split('\n');
    var decoder = this;
    return lines.map(function(line) {
      // Match "at Function (url:line:col)" patterns
      var m = line.match(/\(([^:)]+):(\d+):(\d+)\)/);
      if (!m) return line;
      var url = m[1]; var ln = parseInt(m[2]); var col = parseInt(m[3]);
      var orig = decoder.resolve(url, ln, col);
      if (!orig) return line;
      var label = orig.name ? orig.name + ' ' : '';
      return line.replace(
        '(' + url + ':' + ln + ':' + col + ')',
        '(' + label + orig.originalSource + ':' + orig.originalLine + ':' + orig.originalColumn + ')',
      );
    }).join('\n');
  }

  /** Naïve VLQ decoder — handles only the subset needed for source maps. */
  private _decodeVLQ(s: string): number[] {
    var BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var result: number[] = [];
    var i = 0;
    while (i < s.length) {
      var value = 0; var shift = 0; var done = false;
      while (!done) {
        var digit = BASE64.indexOf(s[i++]);
        if (digit < 0) break;
        done  = (digit & 32) === 0;
        value = value | ((digit & 31) << shift);
        shift += 5;
      }
      result.push((value & 1) ? -(value >> 1) : (value >> 1));
    }
    return result;
  }

  /** Decode source-map v3 mappings string into sorted SourceMapEntry[]. */
  private _decodeMappings(sm: { sources?: string[]; names?: string[]; mappings?: string }): SourceMapEntry[] {
    var sources  = sm.sources  ?? [];
    var names    = sm.names    ?? [];
    var mappings = sm.mappings ?? '';

    var entries: SourceMapEntry[] = [];
    var genLine = 1; var srcIdx = 0; var srcLine = 1; var srcCol = 1; var nameIdx = 0;

    var lines = mappings.split(';');
    for (var li = 0; li < lines.length; li++) {
      var genCol = 1;
      var segs = lines[li].split(',');
      for (var si = 0; si < segs.length; si++) {
        if (!segs[si]) continue;
        var fields = this._decodeVLQ(segs[si]);
        genCol   += (fields[0] ?? 0);
        srcIdx   += (fields[1] ?? 0);
        srcLine  += (fields[2] ?? 0);
        srcCol   += (fields[3] ?? 0);
        nameIdx  += (fields[4] ?? 0);
        if (fields.length >= 4) {
          entries.push({
            generatedLine:   genLine,
            generatedColumn: genCol,
            originalSource:  sources[srcIdx] ?? '',
            originalLine:    srcLine,
            originalColumn:  srcCol,
            name:            fields.length >= 5 ? (names[nameIdx] ?? undefined) : undefined,
          });
        }
      }
      genLine++;
    }
    return entries;
  }
}

export const sourceMapDecoder = new SourceMapDecoder();
