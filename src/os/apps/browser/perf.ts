/**
 * perf.ts — Browser Performance Timeline API
 *
 * Implements the W3C Performance Timeline, Navigation Timing, Resource Timing,
 * User Timing (marks + measures), and PerformanceObserver.
 *
 * Timing source: kernel.getTicks() × 10 gives milliseconds at 100 Hz PIT
 * resolution. For sub-tick interpolation we store a wall δ at creation time.
 */

declare var kernel: import('../../core/kernel.js').KernelAPI;

// ── Entry types ───────────────────────────────────────────────────────────────

export type PerformanceEntryType =
  | 'mark' | 'measure' | 'navigation' | 'resource'
  | 'paint' | 'frame' | 'longtask';

export interface PerformanceEntry {
  readonly name:       string;
  readonly entryType:  PerformanceEntryType;
  readonly startTime:  number;
  readonly duration:   number;
  toJSON(): Record<string, unknown>;
}

export interface PerformanceMark extends PerformanceEntry {
  readonly entryType: 'mark';
  readonly detail:    unknown;
}

export interface PerformanceMeasure extends PerformanceEntry {
  readonly entryType: 'measure';
  readonly detail:    unknown;
}

export interface PerformanceResourceTiming extends PerformanceEntry {
  readonly entryType:       'resource';
  readonly initiatorType:   string;
  readonly fetchStart:      number;
  readonly domainLookupStart: number;
  readonly domainLookupEnd:   number;
  readonly connectStart:    number;
  readonly connectEnd:      number;
  readonly secureConnectionStart: number;
  readonly requestStart:    number;
  readonly responseStart:   number;
  readonly responseEnd:     number;
  readonly transferSize:    number;
  readonly encodedBodySize: number;
  readonly decodedBodySize: number;
}

// ── PerformanceObserver ───────────────────────────────────────────────────────

type PerfObserverCallback = (list: PerformanceObserverEntryList, observer: BrowserPerformanceObserver) => void;

export class PerformanceObserverEntryList {
  private _entries: PerformanceEntry[];
  constructor(entries: PerformanceEntry[]) { this._entries = entries; }
  getEntries(): PerformanceEntry[]                          { return this._entries.slice(); }
  getEntriesByType(t: string): PerformanceEntry[]           { return this._entries.filter(e => e.entryType === t); }
  getEntriesByName(n: string, t?: string): PerformanceEntry[] {
    return this._entries.filter(e => e.name === n && (!t || e.entryType === t));
  }
}

export class BrowserPerformanceObserver {
  private _cb:    PerfObserverCallback;
  private _types: Set<string> = new Set();
  _perf: BrowserPerformance | null = null;

  constructor(cb: PerfObserverCallback) { this._cb = cb; }

  observe(opts: { type?: string; entryTypes?: string[]; buffered?: boolean }): void {
    var types = opts.entryTypes ?? (opts.type ? [opts.type] : []);
    for (var t of types) this._types.add(t);
    if (this._perf) {
      this._perf._registerObserver(this);
      // Deliver buffered entries if requested
      if (opts.buffered) {
        var buffered: PerformanceEntry[] = [];
        for (var t2 of this._types) {
          buffered.push(...this._perf._buffer.filter(e => e.entryType === t2));
        }
        if (buffered.length) {
          try { this._cb(new PerformanceObserverEntryList(buffered), this); } catch (_) {}
        }
      }
    }
  }

  disconnect(): void { if (this._perf) this._perf._unregisterObserver(this); this._types.clear(); }
  takeRecords(): PerformanceEntry[] { return []; }
  _wantsType(t: string): boolean { return this._types.has(t); }
  _deliver(entries: PerformanceEntry[]): void {
    try { this._cb(new PerformanceObserverEntryList(entries), this); } catch (_) {}
  }
}

// ── Main Performance object ───────────────────────────────────────────────────

function _makeEntry(
  name: string,
  type: PerformanceEntryType,
  start: number,
  duration: number,
  extra?: Record<string, unknown>,
): PerformanceEntry {
  var e: any = { name, entryType: type, startTime: start, duration, ...extra };
  e.toJSON = () => ({ name, entryType: type, startTime: start, duration, ...extra });
  return e as PerformanceEntry;
}

export class BrowserPerformance {
  /** Kernel tick at which this Performance object was created (page start). */
  private _originTick: number;
  /** Buffer of all entries recorded since page start. */
  _buffer: PerformanceEntry[] = [];
  /** Registered observers. */
  private _observers: BrowserPerformanceObserver[] = [];

  // Navigation Timing 2 fields (populated on page load)
  navigationStart       = 0;
  fetchStart            = 0;
  domainLookupStart     = 0;
  domainLookupEnd       = 0;
  connectStart          = 0;
  connectEnd            = 0;
  requestStart          = 0;
  responseStart         = 0;
  responseEnd           = 0;
  domLoading            = 0;
  domInteractive        = 0;
  domContentLoadedEventStart = 0;
  domContentLoadedEventEnd   = 0;
  domComplete           = 0;
  loadEventStart        = 0;
  loadEventEnd          = 0;

  constructor() {
    this._originTick = typeof kernel !== 'undefined' ? (kernel.getTicks ? kernel.getTicks() : 0) : 0;
  }

  // ── Core timing ────────────────────────────────────────────────────────────

  now(): number {
    if (typeof kernel !== 'undefined' && kernel.getTicks) {
      return (kernel.getTicks() - this._originTick) * 10;
    }
    return Date.now();
  }

  timeOrigin: number = Date.now();

  // ── User Timing ────────────────────────────────────────────────────────────

  mark(name: string, opts?: { startTime?: number; detail?: unknown }): PerformanceMark {
    var ts = opts?.startTime ?? this.now();
    var e  = _makeEntry(name, 'mark', ts, 0, { detail: opts?.detail ?? null }) as PerformanceMark;
    this._buffer.push(e);
    this._notify([e]);
    return e;
  }

  measure(
    name: string,
    startOrOpts?: string | { start?: string | number; end?: string | number; duration?: number; detail?: unknown },
    endMark?: string,
  ): PerformanceMeasure {
    var start = 0; var end = this.now();

    if (typeof startOrOpts === 'string') {
      var sm = this._buffer.find(e => e.entryType === 'mark' && e.name === startOrOpts);
      start = sm ? sm.startTime : 0;
      if (endMark) {
        var em = this._buffer.find(e => e.entryType === 'mark' && e.name === endMark);
        end = em ? em.startTime : this.now();
      }
    } else if (startOrOpts && typeof startOrOpts === 'object') {
      if (typeof startOrOpts.start === 'number')       start = startOrOpts.start;
      else if (typeof startOrOpts.start === 'string') {
        var sm2 = this._buffer.find(e => e.entryType === 'mark' && e.name === (startOrOpts as any).start);
        start = sm2 ? sm2.startTime : 0;
      }
      if (typeof startOrOpts.end === 'number')         end = startOrOpts.end;
      else if (typeof startOrOpts.end === 'string') {
        var em2 = this._buffer.find(e => e.entryType === 'mark' && e.name === (startOrOpts as any).end);
        end = em2 ? em2.startTime : this.now();
      }
      if (typeof startOrOpts.duration === 'number')    end = start + startOrOpts.duration;
    }

    var e = _makeEntry(name, 'measure', start, end - start, { detail: (startOrOpts as any)?.detail ?? null }) as PerformanceMeasure;
    this._buffer.push(e);
    this._notify([e]);
    return e;
  }

  clearMarks(name?: string): void {
    if (name) this._buffer = this._buffer.filter(e => !(e.entryType === 'mark' && e.name === name));
    else      this._buffer = this._buffer.filter(e => e.entryType !== 'mark');
  }

  clearMeasures(name?: string): void {
    if (name) this._buffer = this._buffer.filter(e => !(e.entryType === 'measure' && e.name === name));
    else      this._buffer = this._buffer.filter(e => e.entryType !== 'measure');
  }

  // ── Entry query ────────────────────────────────────────────────────────────

  getEntries():                       PerformanceEntry[] { return this._buffer.slice(); }
  getEntriesByType(t: string):        PerformanceEntry[] { return this._buffer.filter(e => e.entryType === t); }
  getEntriesByName(n: string, t?: string): PerformanceEntry[] {
    return this._buffer.filter(e => e.name === n && (!t || e.entryType === t));
  }

  // ── Resource Timing ────────────────────────────────────────────────────────

  recordResource(
    name: string,
    initiatorType: string,
    timings: {
      fetchStart?:      number;
      dnsStart?:        number;
      dnsEnd?:          number;
      connectStart?:    number;
      connectEnd?:      number;
      tlsStart?:        number;
      requestStart?:    number;
      responseStart?:   number;
      responseEnd?:     number;
      transferSize?:    number;
      encodedBodySize?: number;
      decodedBodySize?: number;
    },
  ): void {
    var fs = timings.fetchStart ?? this.now();
    var re = timings.responseEnd ?? this.now();
    var e  = _makeEntry(name, 'resource', fs, re - fs, {
      initiatorType,
      fetchStart:             fs,
      domainLookupStart:      timings.dnsStart      ?? fs,
      domainLookupEnd:        timings.dnsEnd        ?? fs,
      connectStart:           timings.connectStart  ?? fs,
      connectEnd:             timings.connectEnd    ?? fs,
      secureConnectionStart:  timings.tlsStart      ?? 0,
      requestStart:           timings.requestStart  ?? fs,
      responseStart:          timings.responseStart ?? fs,
      responseEnd:            re,
      transferSize:           timings.transferSize    ?? 0,
      encodedBodySize:        timings.encodedBodySize ?? 0,
      decodedBodySize:        timings.decodedBodySize ?? 0,
    }) as PerformanceResourceTiming;
    this._buffer.push(e);
    this._notify([e]);
  }

  // ── Frame / paint timing ───────────────────────────────────────────────────

  recordFrame(startTime: number, duration: number): void {
    var e = _makeEntry('frame', 'frame', startTime, duration);
    this._buffer.push(e);
    this._notify([e]);
  }

  recordPaint(name: 'first-paint' | 'first-contentful-paint', startTime: number): void {
    var e = _makeEntry(name, 'paint', startTime, 0);
    this._buffer.push(e);
    this._notify([e]);
  }

  // ── Observer management ────────────────────────────────────────────────────

  _registerObserver(obs: BrowserPerformanceObserver): void {
    if (!this._observers.includes(obs)) { obs._perf = this; this._observers.push(obs); }
  }

  _unregisterObserver(obs: BrowserPerformanceObserver): void {
    var i = this._observers.indexOf(obs);
    if (i >= 0) this._observers.splice(i, 1);
  }

  private _notify(entries: PerformanceEntry[]): void {
    for (var obs of this._observers) {
      var matching = entries.filter(e => obs._wantsType(e.entryType));
      if (matching.length) obs._deliver(matching);
    }
  }

  // ── Navigation timing compat (Level 1 API) ────────────────────────────────

  get timing(): Record<string, number> {
    var t = this.timeOrigin;
    return {
      navigationStart: t,
      fetchStart:              t + this.fetchStart,
      domainLookupStart:       t + this.domainLookupStart,
      domainLookupEnd:         t + this.domainLookupEnd,
      connectStart:            t + this.connectStart,
      connectEnd:              t + this.connectEnd,
      requestStart:            t + this.requestStart,
      responseStart:           t + this.responseStart,
      responseEnd:             t + this.responseEnd,
      domLoading:              t + this.domLoading,
      domInteractive:          t + this.domInteractive,
      domContentLoadedEventStart: t + this.domContentLoadedEventStart,
      domContentLoadedEventEnd:   t + this.domContentLoadedEventEnd,
      domComplete:             t + this.domComplete,
      loadEventStart:          t + this.loadEventStart,
      loadEventEnd:            t + this.loadEventEnd,
    };
  }

  get navigation(): { type: number; redirectCount: number } {
    return { type: 0, redirectCount: 0 };
  }

  // JSON serialisable
  toJSON(): Record<string, unknown> {
    return { timeOrigin: this.timeOrigin, timing: this.timing };
  }

  // ── Chrome-specific memory API (non-standard, widely used) ────────────────
  readonly memory = {
    /** Estimated JS heap size in bytes */
    get usedJSHeapSize(): number {
      return (typeof (globalThis as any).__jsHeapUsed === 'number') ? (globalThis as any).__jsHeapUsed : 32 * 1024 * 1024;
    },
    get totalJSHeapSize(): number {
      return (typeof (globalThis as any).__jsHeapTotal === 'number') ? (globalThis as any).__jsHeapTotal : 64 * 1024 * 1024;
    },
    get jsHeapSizeLimit(): number { return 512 * 1024 * 1024; },
  };
}
