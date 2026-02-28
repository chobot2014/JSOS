/**
 * pty.ts — Pseudoterminal (PTY) support for JSOS
 *
 * Implements a POSIX-like PTY pair: a master (controller) side and a
 * slave (process) side.  The master simulates the terminal driver
 * (line discipline, echo, SIGINT on Ctrl+C, etc.) while the slave
 * looks like a regular tty to the process running inside it.
 *
 * Items covered:
 *   933. [P2] Pseudoterminals: master/slave PTY pair for TUI app embedding
 *
 * Usage:
 *   const { master, slave } = openPty({ echo: true, cols: 80, rows: 24 });
 *   // Write to master to simulate terminal input
 *   master.write('hello\n');
 *   // Read from master to get process output
 *   master.onData(chunk => process.stdout.write(chunk));
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PtyOptions {
  /** Enable echo of input back to master. Default true. */
  echo?:   boolean;
  /** Enable canonical (line-buffered) mode. Default true. */
  canon?:  boolean;
  /** Terminal columns. Default 80. */
  cols?:   number;
  /** Terminal rows. Default 24. */
  rows?:   number;
  /** Terminal name (appears in /dev/pts/<name>). Auto-assigned if omitted. */
  name?:   string;
}

export interface WinSize {
  cols: number;
  rows: number;
}

type PtyDataHandler = (data: string) => void;

// ─── PtyLineDiscipline ────────────────────────────────────────────────────────

/**
 * Minimal line discipline: handles echo, Ctrl+C → SIGINT, Ctrl+D → EOF,
 * Backspace, line buffering in canonical mode.
 */
class PtyLineDiscipline {
  echo:     boolean;
  canon:    boolean;

  private _lineBuf   = '';
  private _readBuf   = '';
  private _sigHandlers: Array<(sig: string) => void> = [];
  private _dataHandlers: PtyDataHandler[] = [];

  constructor(echo: boolean, canon: boolean) {
    this.echo  = echo;
    this.canon = canon;
  }

  /** Feed raw bytes from master (keyboard input). */
  input(data: string): string {
    var out = '';  // chars to echo back to master
    for (var i = 0; i < data.length; i++) {
      var ch = data[i];
      var cc = data.charCodeAt(i);

      if (cc === 3)  { this._fireSig('SIGINT');  continue; }  // Ctrl+C
      if (cc === 26) { this._fireSig('SIGTSTP'); continue; }  // Ctrl+Z
      if (cc === 4)  {                                          // Ctrl+D = EOF
        if (this.canon && this._lineBuf.length === 0) {
          this._flushRead('\x00');  // EOF sentinel
        } else if (this.canon) {
          this._flushRead(this._lineBuf);
          this._lineBuf = '';
        }
        continue;
      }
      if ((cc === 8 || cc === 127) && this.canon) {  // Backspace / Del
        if (this._lineBuf.length > 0) {
          this._lineBuf = this._lineBuf.slice(0, -1);
          if (this.echo) out += '\b \b';
        }
        continue;
      }
      if (this.canon) {
        this._lineBuf += ch;
        if (this.echo) out += ch;
        if (ch === '\n' || ch === '\r') {
          this._flushRead(this._lineBuf);
          this._lineBuf = '';
        }
      } else {
        // Raw mode: pass directly
        if (this.echo) out += ch;
        this._flushRead(ch);
      }
    }
    return out;
  }

  /** Return accumulated read data (consumed by slave.read). */
  readAvail(): string {
    var d = this._readBuf;
    this._readBuf = '';
    return d;
  }

  /** Has data available for the slave to read? */
  get hasData(): boolean { return this._readBuf.length > 0; }

  /** Register handler for slave-side data produced (output from process). */
  onData(fn: PtyDataHandler): void { this._dataHandlers.push(fn); }

  /** Produce output from the slave process toward the master. */
  output(data: string): void {
    for (var i = 0; i < this._dataHandlers.length; i++) this._dataHandlers[i](data);
  }

  /** Register a signal handler. */
  onSignal(fn: (sig: string) => void): void { this._sigHandlers.push(fn); }

  private _fireSig(sig: string): void {
    for (var i = 0; i < this._sigHandlers.length; i++) this._sigHandlers[i](sig);
  }

  private _flushRead(data: string): void {
    this._readBuf += data;
  }
}

// ─── PtyMaster ────────────────────────────────────────────────────────────────

/** Controller (master) side of a PTY. */
export class PtyMaster {
  private _disc: PtyLineDiscipline;
  private _slave: PtySlave;
  private _closed = false;
  private _onDataHandlers: PtyDataHandler[] = [];

  constructor(disc: PtyLineDiscipline, slave: PtySlave) {
    this._disc  = disc;
    this._slave = slave;
    // Slave output → master data handlers
    disc.onData((d) => {
      for (var i = 0; i < this._onDataHandlers.length; i++) this._onDataHandlers[i](d);
    });
  }

  /** Write data to the PTY as if typed at a keyboard. */
  write(data: string): void {
    if (this._closed) return;
    var echoed = this._disc.input(data);
    if (echoed) {
      for (var i = 0; i < this._onDataHandlers.length; i++) this._onDataHandlers[i](echoed);
    }
  }

  /** Register handler for data produced by the slave process. */
  onData(fn: PtyDataHandler): void { this._onDataHandlers.push(fn); }

  /** Register handler for signals (SIGINT, SIGTSTP) from line discipline. */
  onSignal(fn: (sig: string) => void): void { this._disc.onSignal(fn); }

  /** Resize the terminal window. */
  resize(cols: number, rows: number): void {
    this._slave._winSize = { cols, rows };
  }

  /** Close the master, signalling HUP to the slave side. */
  close(): void {
    if (this._closed) return;
    this._closed = true;
    this._disc.onSignal(() => {});
    for (var i = 0; i < this._onDataHandlers.length; i++) this._onDataHandlers[i]('\x00');  // HUP sentinel
  }

  get isClosed(): boolean { return this._closed; }
}

// ─── PtySlave ─────────────────────────────────────────────────────────────────

/** Process (slave) side of a PTY — looks like a tty to the child process. */
export class PtySlave {
  /** Path in /dev/pts/<name>. */
  readonly devPath: string;
  _winSize: WinSize;

  private _disc:   PtyLineDiscipline;
  private _closed  = false;

  constructor(disc: PtyLineDiscipline, name: string, winSize: WinSize) {
    this._disc   = disc;
    this.devPath  = '/dev/pts/' + name;
    this._winSize = winSize;
  }

  /** Write output from the process (goes to master onData handlers). */
  write(data: string): void {
    if (this._closed) return;
    this._disc.output(data);
  }

  /**
   * Read available input (typed at master, processed by line discipline).
   * Returns '' if nothing available.
   */
  read(): string {
    return this._disc.readAvail();
  }

  /** True when data is waiting to be read. */
  get readable(): boolean { return this._disc.hasData; }

  /** Current terminal size. */
  get winSize(): WinSize { return { ...this._winSize }; }

  /** Close slave end. */
  close(): void { this._closed = true; }

  get isClosed(): boolean { return this._closed; }
}

// ─── openPty ──────────────────────────────────────────────────────────────────

var _ptySeq = 0;

/** Registry of all open PTY slaves (keyed by devPath). */
const _ptyRegistry = new Map<string, PtySlave>();

/**
 * Open a new PTY pair.
 *
 * @returns An object with `.master` (controller) and `.slave` (process side).
 */
export function openPty(opts: PtyOptions = {}): { master: PtyMaster; slave: PtySlave } {
  var echo  = opts.echo  !== false;
  var canon = opts.canon !== false;
  var cols  = opts.cols  ?? 80;
  var rows  = opts.rows  ?? 24;
  var name  = opts.name  ?? String(_ptySeq++);

  var disc   = new PtyLineDiscipline(echo, canon);
  var slave  = new PtySlave(disc, name, { cols, rows });
  var master = new PtyMaster(disc, slave);

  _ptyRegistry.set(slave.devPath, slave);
  return { master, slave };
}

/** Look up an open PTY slave by /dev/pts/<name> path. */
export function getPty(devPath: string): PtySlave | null {
  return _ptyRegistry.get(devPath) ?? null;
}

/** List all open PTY paths. */
export function listPtys(): string[] {
  return Array.from(_ptyRegistry.keys());
}

/** Close and deregister a PTY slave. */
export function closePty(slave: PtySlave): void {
  slave.close();
  _ptyRegistry.delete(slave.devPath);
}
