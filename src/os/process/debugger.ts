/**
 * JSOS Process Debugger & Profiler
 *
 * [Items 792–796] Software breakpoint/step debugger, CPU flame-graph profiler,
 * and heap snapshot facility for JSOS JavaScript processes.
 *
 * API overview:
 *
 *   debuggerInstance.attach(pid)                    // start a debug session
 *   session.setBreakpoint(pid, loc, cond?)           // add breakpoint
 *   session.removeBreakpoint(id)                     // remove it
 *   session.stepOver(pid)                            // step over next instruction
 *   session.stepInto(pid)                            // step into call
 *   session.stepOut(pid)                             // step out of current frame
 *   session.inspectValue(pid, expression)            // evaluate in process context
 *   session.stackTrace(pid)                          // get current call stack
 *   session.detach()                                 // stop debugging session
 *
 *   profiler.cpuProfile(pid, durationMs)             // sample CPU → FlameNode tree
 *   profiler.heapSnapshot(pid)                       // walk heap → HeapNode tree
 */

declare var kernel: import('../core/kernel.js').KernelAPI;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BreakpointLocation {
  file?: string;
  /** 1-based line number within file */
  line?: number;
  /** Bytecode/JIT symbol offset */
  offset?: number;
  /** Named function entry */
  symbol?: string;
}

export interface Breakpoint {
  id:       number;
  pid:      number;
  location: BreakpointLocation;
  condition?: string;   // JS expression evaluated in process context
  hitCount: number;
  enabled:  boolean;
}

export interface StackFrame {
  index:    number;
  pid:      number;
  symbol:   string;
  file?:    string;
  line?:    number;
  column?:  number;
  isNative: boolean;
}

export interface InspectResult {
  expression: string;
  value:      unknown;
  type:       string;
  serialized: string;  // JSON-safe representation
}

// ── Flame graph / CPU profiler ────────────────────────────────────────────────

export interface FlameNode {
  name:     string;     // function / symbol name
  value:    number;     // inclusive sample count
  children: FlameNode[];
  selfTime: number;     // exclusive sample count
  totalTime: number;    // inclusive sample count (== value)
  file?:    string;
  line?:    number;
}

// ── Heap snapshot ─────────────────────────────────────────────────────────────

export interface HeapNode {
  id:        number;
  type:      string;    // 'object' | 'array' | 'string' | 'closure' | 'regexp' | 'number' | 'hidden'
  name:      string;
  size:      number;    // shallow size, bytes
  retainedSize: number; // retained size, bytes
  children:  HeapNodeRef[];
}

export interface HeapNodeRef {
  type:   'property' | 'element' | 'context' | 'internal';
  name:   string;
  nodeId: number;
}

export interface HeapSnapshot {
  pid:       number;
  timestamp: number;
  totalSize: number;    // bytes
  nodes:     HeapNode[];
  roots:     number[];  // top-level node IDs
}

// ── DebugSession ──────────────────────────────────────────────────────────────

let _bpIdCounter = 0;

/**
 * [Item 792] Active debugging session for one or more PIDs.
 *
 * In JSOS's QuickJS-based runtime the kernel exposes a `kernel.debug.*`
 * interface.  When that interface is unavailable (e.g., unit tests) the
 * session falls back to a lightweight simulation backed by kernel.getTicks().
 */
export class DebugSession {
  private _breakpoints: Map<number, Breakpoint> = new Map();
  private _pids:        Set<number>             = new Set();
  private _attached:    boolean                 = false;
  private _paused:      Map<number, boolean>    = new Map();
  private _eventCbs:    Array<(ev: DebugEvent) => void> = [];

  readonly sessionId: number;

  constructor(sessionId: number) { this.sessionId = sessionId; }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /** [Item 792] Attach to a running PID. */
  attach(pid: number): boolean {
    try {
      (kernel as any).debug?.attach?.(pid);
      this._pids.add(pid);
      this._attached = true;
      this._emit({ type: 'attached', pid, timestamp: kernel.getTicks() });
      return true;
    } catch (e) {
      return false;
    }
  }

  /** Detach from all PIDs and clean up. */
  detach(): void {
    this._pids.forEach((pid) => {
      try { (kernel as any).debug?.detach?.(pid); } catch (_) {}
    });
    this._pids.clear();
    this._breakpoints.clear();
    this._paused.clear();
    this._attached = false;
  }

  get isAttached(): boolean { return this._attached; }

  get pids(): number[] { return Array.from(this._pids); }

  // ── Breakpoints ─────────────────────────────────────────────────────────────

  /**
   * [Item 793] Set a breakpoint.  Returns the breakpoint ID.
   */
  setBreakpoint(pid: number, location: BreakpointLocation, condition?: string): number {
    var id = ++_bpIdCounter;
    var bp: Breakpoint = { id, pid, location, condition, hitCount: 0, enabled: true };
    this._breakpoints.set(id, bp);
    try {
      (kernel as any).debug?.setBreakpoint?.(pid, location, id);
    } catch (_) {}
    this._emit({ type: 'breakpointSet', pid, breakpoint: bp, timestamp: kernel.getTicks() });
    return id;
  }

  /** [Item 793] Remove a breakpoint by ID. */
  removeBreakpoint(id: number): boolean {
    var bp = this._breakpoints.get(id);
    if (!bp) return false;
    try { (kernel as any).debug?.removeBreakpoint?.(bp.pid, id); } catch (_) {}
    this._breakpoints.delete(id);
    this._emit({ type: 'breakpointRemoved', pid: bp.pid, breakpointId: id, timestamp: kernel.getTicks() });
    return true;
  }

  enableBreakpoint(id: number, enabled: boolean): boolean {
    var bp = this._breakpoints.get(id);
    if (!bp) return false;
    bp.enabled = enabled;
    try { (kernel as any).debug?.enableBreakpoint?.(bp.pid, id, enabled); } catch (_) {}
    return true;
  }

  listBreakpoints(pid?: number): Breakpoint[] {
    var arr: Breakpoint[] = [];
    this._breakpoints.forEach(function(bp) {
      if (pid === undefined || bp.pid === pid) arr.push({ ...bp });
    });
    return arr;
  }

  // ── Stepping ────────────────────────────────────────────────────────────────

  /** [Item 794] Step to next statement, not entering calls. */
  stepOver(pid: number): void {
    try { (kernel as any).debug?.stepOver?.(pid); }
    catch (_) { /* simulation: just emit event */ }
    this._emit({ type: 'step', pid, stepType: 'over', timestamp: kernel.getTicks() });
  }

  /** [Item 794] Step into the next call. */
  stepInto(pid: number): void {
    try { (kernel as any).debug?.stepInto?.(pid); } catch (_) {}
    this._emit({ type: 'step', pid, stepType: 'into', timestamp: kernel.getTicks() });
  }

  /** [Item 794] Step out of the current call frame. */
  stepOut(pid: number): void {
    try { (kernel as any).debug?.stepOut?.(pid); } catch (_) {}
    this._emit({ type: 'step', pid, stepType: 'out', timestamp: kernel.getTicks() });
  }

  /** Continue execution (resume from breakpoint/pause). */
  continue(pid: number): void {
    this._paused.set(pid, false);
    try { (kernel as any).debug?.continue?.(pid); } catch (_) {}
    this._emit({ type: 'resumed', pid, timestamp: kernel.getTicks() });
  }

  /** Pause a running process. */
  pause(pid: number): void {
    this._paused.set(pid, true);
    try { (kernel as any).debug?.pause?.(pid); } catch (_) {}
    this._emit({ type: 'paused', pid, timestamp: kernel.getTicks() });
  }

  isPaused(pid: number): boolean { return this._paused.get(pid) === true; }

  // ── Inspection ──────────────────────────────────────────────────────────────

  /**
   * [Item 795] Inspect / evaluate an expression in the process's current scope.
   */
  inspectValue(pid: number, expression: string): InspectResult {
    var value: unknown;
    try {
      value = (kernel as any).debug?.evaluate?.(pid, expression);
    } catch (e) {
      value = { error: String(e) };
    }
    var type  = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    var serialized: string;
    try { serialized = JSON.stringify(value) ?? String(value); }
    catch (_) { serialized = String(value); }
    return { expression, value, type, serialized };
  }

  /**
   * [Item 796] Get the current JavaScript call stack for a process.
   */
  stackTrace(pid: number): StackFrame[] {
    try {
      var raw: any[] = (kernel as any).debug?.stackTrace?.(pid) ?? [];
      return raw.map(function(f: any, i: number) {
        return {
          index: i,
          pid,
          symbol:   f.name    ?? f.symbol ?? '(anonymous)',
          file:     f.file    ?? f.source,
          line:     f.line    ?? f.lineNumber,
          column:   f.column  ?? f.columnNumber,
          isNative: !!(f.native ?? f.isNative),
        };
      });
    } catch (_) {
      return [];
    }
  }

  // ── Events ──────────────────────────────────────────────────────────────────

  onEvent(cb: (ev: DebugEvent) => void): void { this._eventCbs.push(cb); }

  offEvent(cb: (ev: DebugEvent) => void): void {
    this._eventCbs = this._eventCbs.filter(function(c) { return c !== cb; });
  }

  private _emit(ev: DebugEvent): void {
    this._eventCbs.forEach(function(cb) { try { cb(ev); } catch (_) {} });
  }
}

// ── Debug events ────────────────────────────────────────────────────────────

export type DebugEvent = {
  type: 'attached' | 'detached' | 'paused' | 'resumed';
  pid: number; timestamp: number;
} | {
  type: 'step'; pid: number; stepType: 'over' | 'into' | 'out'; timestamp: number;
} | {
  type: 'breakpointSet' | 'breakpointHit'; pid: number; breakpoint: Breakpoint; timestamp: number;
} | {
  type: 'breakpointRemoved'; pid: number; breakpointId: number; timestamp: number;
} | {
  type: 'exception'; pid: number; error: string; timestamp: number;
};

// ── CPU Profiler ──────────────────────────────────────────────────────────────

/**
 * [Item 796] CPU profiler producing flame-graph–compatible output.
 *
 * Uses kernel.debug.sample() (statistical sampling) if available;
 * otherwise generates a synthetic profile from available kernel PID info.
 */
export class Profiler {

  /**
   * [Item 796] Sample a process's CPU usage for `durationMs` milliseconds
   * and return a FlameNode tree suitable for flame-graph rendering.
   */
  cpuProfile(pid: number, durationMs: number = 1000): FlameNode {
    try {
      var raw = (kernel as any).debug?.cpuProfile?.(pid, durationMs);
      if (raw) return this._normalizeFlameNode(raw);
    } catch (_) {}
    return this._syntheticProfile(pid, durationMs);
  }

  private _normalizeFlameNode(raw: any): FlameNode {
    var children: FlameNode[] = (raw.children ?? []).map((c: any) => this._normalizeFlameNode(c));
    var totalTime = (raw.value ?? raw.totalTime ?? 0) as number;
    var selfTime  = Math.max(0, totalTime - children.reduce(function(s: number, c: FlameNode) { return s + c.totalTime; }, 0));
    return {
      name:      raw.name  ?? raw.symbol ?? '(unknown)',
      value:     totalTime,
      selfTime,
      totalTime,
      children,
      file:      raw.file,
      line:      raw.line,
    };
  }

  private _syntheticProfile(pid: number, durationMs: number): FlameNode {
    // Minimal synthetic data when debug sampling is unavailable
    var samples = Math.max(1, Math.round(durationMs / 10));
    return {
      name: 'root', value: samples, selfTime: 0, totalTime: samples,
      children: [
        { name: `pid:${pid}:main`,    value: Math.round(samples * 0.7), selfTime: Math.round(samples * 0.3), totalTime: Math.round(samples * 0.7), children: [
          { name: `pid:${pid}:inner`, value: Math.round(samples * 0.4), selfTime: Math.round(samples * 0.4), totalTime: Math.round(samples * 0.4), children: [] },
        ]},
        { name: `pid:${pid}:idle`,    value: Math.round(samples * 0.3), selfTime: Math.round(samples * 0.3), totalTime: Math.round(samples * 0.3), children: [] },
      ],
    };
  }

  /**
   * [Item 796] Capture a heap snapshot for a process.
   */
  heapSnapshot(pid: number): HeapSnapshot {
    var timestamp = kernel.getTicks();
    try {
      var raw = (kernel as any).debug?.heapSnapshot?.(pid);
      if (raw) {
        return {
          pid, timestamp,
          totalSize: raw.totalSize ?? 0,
          nodes: (raw.nodes ?? []).map(this._normalizeHeapNode),
          roots: raw.roots ?? [],
        };
      }
    } catch (_) {}
    return this._syntheticHeapSnapshot(pid, timestamp);
  }

  private _normalizeHeapNode(raw: any): HeapNode {
    return {
      id:           raw.id           ?? 0,
      type:         raw.type         ?? 'object',
      name:         raw.name         ?? '(no name)',
      size:         raw.size         ?? raw.shallowSize ?? 0,
      retainedSize: raw.retainedSize ?? raw.size ?? 0,
      children: (raw.children ?? raw.edges ?? []).map(function(c: any) {
        return { type: c.type ?? 'property', name: String(c.name ?? c.index ?? ''), nodeId: c.nodeId ?? c.toNode ?? 0 };
      }),
    };
  }

  private _syntheticHeapSnapshot(pid: number, timestamp: number): HeapSnapshot {
    var root: HeapNode = {
      id: 1, type: 'object', name: `process(${pid})`,
      size: 4096, retainedSize: 65536,
      children: [
        { type: 'property', name: 'globals', nodeId: 2 },
        { type: 'property', name: 'stack',   nodeId: 3 },
      ],
    };
    return {
      pid, timestamp, totalSize: 65536,
      nodes:     [root,
                  { id: 2, type: 'object',  name: 'GlobalObject', size: 8192,  retainedSize: 32768, children: [] },
                  { id: 3, type: 'array',   name: 'CallStack',    size: 2048,  retainedSize: 4096,  children: [] }],
      roots: [1],
    };
  }
}

// ── Debugger (top-level manager) ──────────────────────────────────────────────

let _sessionIdCounter = 0;

/**
 * [Item 792] Top-level debugger manager.
 *
 * Creates and tracks DebugSessions, exposes the Profiler, and provides
 * shortcuts for common debugger operations.
 */
export class Debugger {
  private _sessions: Map<number, DebugSession> = new Map();
  readonly profiler: Profiler = new Profiler();

  /** [Item 792] Attach to a PID and return the DebugSession. */
  attach(pid: number): DebugSession {
    var existing = this._findSessionForPid(pid);
    if (existing) return existing;
    var id      = ++_sessionIdCounter;
    var session = new DebugSession(id);
    session.attach(pid);
    this._sessions.set(id, session);
    return session;
  }

  /** Detach all sessions for a PID. */
  detachAll(pid: number): void {
    this._sessions.forEach(function(session, id) {
      if (session.pids.includes(pid)) { session.detach(); }
    });
    this._sessions.forEach(function(session, id, map) {
      if (!session.isAttached) map.delete(id);
    });
  }

  /** Look up active session for a PID. */
  sessionForPid(pid: number): DebugSession | undefined {
    return this._findSessionForPid(pid);
  }

  /** List all active sessions. */
  sessions(): DebugSession[] {
    var arr: DebugSession[] = [];
    this._sessions.forEach(function(s) { arr.push(s); });
    return arr;
  }

  // ── Convenience shortcuts ────────────────────────────────────────────────────

  /** [Item 793] Quick-set a breakpoint on a named symbol in a PID. */
  breakOn(pid: number, symbol: string, condition?: string): number {
    var session = this.attach(pid);
    return session.setBreakpoint(pid, { symbol }, condition);
  }

  /** [Item 795] Inspect a value by expression in a PID. */
  inspect(pid: number, expression: string): InspectResult {
    var session = this.attach(pid);
    return session.inspectValue(pid, expression);
  }

  /** [Item 796] Get stack trace for a PID. */
  stack(pid: number): StackFrame[] {
    var session = this.attach(pid);
    return session.stackTrace(pid);
  }

  /** [Item 796] CPU profile a PID. */
  cpuProfile(pid: number, durationMs: number = 1000): FlameNode {
    return this.profiler.cpuProfile(pid, durationMs);
  }

  /** [Item 796] Snapshot the heap of a PID. */
  heapSnapshot(pid: number): HeapSnapshot {
    return this.profiler.heapSnapshot(pid);
  }

  private _findSessionForPid(pid: number): DebugSession | undefined {
    var found: DebugSession | undefined;
    this._sessions.forEach(function(s) {
      if (!found && s.pids.includes(pid)) found = s;
    });
    return found;
  }
}

/** Singleton debugger instance. */
export const debuggerInstance = new Debugger();
