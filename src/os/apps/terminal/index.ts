/**
 * JSOS Terminal App — Phase 3
 *
 * Wraps the existing text Terminal + REPL as a WM App so they run in a
 * window when the framebuffer is active.
 *
 * The Terminal renders characters into its sub-Canvas using the BitmapFont
 * instead of into VGA memory.  The REPL logic is unchanged.
 *
 * This app is always resident — its window cannot be fully closed (only
 * minimised). It serves as the OS escape hatch.
 */

import { os, Canvas, Colors, defaultFont, type App, type WMWindow, type KeyEvent, type MouseEvent } from '../../core/sdk.js';
import terminal from '../../ui/terminal.js';
import fs from '../../fs/filesystem.js';

declare var kernel: import('../../core/kernel.js').KernelAPI;

// ── Canvas terminal with scrollback buffer + scrollbar ────────────────────

const CHAR_W = 8;
const CHAR_H = 8;
const SCROLLBAR_W = 10;      // pixels reserved on the right for the scrollbar
const SCROLLBACK_MAX = 2000; // max scrollback lines

/** A single cell in the text buffer. */
interface Cell { ch: number; fg: number; }

function blankCellRow(cols: number, fg: number): Cell[] {
  var row: Cell[] = [];
  for (var i = 0; i < cols; i++) row.push({ ch: 0x20, fg: fg });
  return row;
}

class CanvasTerminal {
  private _canvas:  Canvas;
  private _cols:    number;
  private _rows:    number;
  private _row = 0;
  private _col = 0;
  private _fgColor = Colors.LIGHT_GREY;
  private _bgColor = 0xFF111111;

  // ── Cell buffer (logical screen) ──────────────────────────────────────────
  private _screen: Cell[][] = [];   // current visible rows (length = _rows)

  // ── Scrollback ring buffer ────────────────────────────────────────────────
  private _sb: Cell[][] = [];
  private _sbWrite = 0;
  private _sbCount = 0;

  // ── Scroll view state ────────────────────────────────────────────────────
  private _viewOffset = 0;  // 0 = live; >0 = lines scrolled back

  constructor(canvas: Canvas) {
    this._canvas = canvas;
    this._cols   = Math.floor((canvas.width - SCROLLBAR_W) / CHAR_W);
    this._rows   = Math.floor(canvas.height / CHAR_H);
    for (var r = 0; r < this._rows; r++) {
      this._screen.push(blankCellRow(this._cols, this._fgColor));
    }
    this._canvas.clear(this._bgColor);
  }

  get cols(): number { return this._cols; }
  get rows(): number { return this._rows; }
  get row(): number { return this._row; }
  get col(): number { return this._col; }
  get viewOffset(): number { return this._viewOffset; }
  get scrollbackCount(): number { return this._sbCount; }

  setColor(fg: number): void { this._fgColor = fg; }

  clear(): void {
    this._canvas.clear(this._bgColor);
    this._row = 0;
    this._col = 0;
    this._viewOffset = 0;
    for (var r = 0; r < this._rows; r++) {
      this._screen[r] = blankCellRow(this._cols, this._fgColor);
    }
  }

  /** Print text at the current cursor position. */
  print(text: string): void {
    if (this._viewOffset !== 0) this.resumeLive();
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (ch === '\n') {
        this._col = 0;
        this._nextLine();
      } else if (ch === '\r') {
        this._col = 0;
      } else if (ch === '\b') {
        if (this._col > 0) {
          this._col--;
          this._screen[this._row][this._col] = { ch: 0x20, fg: this._fgColor };
          this._drawCell(this._row, this._col);
        }
      } else {
        var cell: Cell = { ch: ch.charCodeAt(0) & 0xFF, fg: this._fgColor };
        this._screen[this._row][this._col] = cell;
        this._drawCell(this._row, this._col);
        this._col++;
        if (this._col >= this._cols) {
          this._col = 0;
          this._nextLine();
        }
      }
    }
  }

  println(text: string): void {
    this.print(text + '\n');
  }

  /** Draw a single cell to the canvas. */
  private _drawCell(row: number, col: number): void {
    var c = this._screen[row][col];
    var px = col * CHAR_W;
    var py = row * CHAR_H;
    this._canvas.fillRect(px, py, CHAR_W, CHAR_H, this._bgColor);
    if (c.ch !== 0x20) {
      defaultFont.renderChar(this._canvas, px, py, String.fromCharCode(c.ch), c.fg);
    }
  }

  private _nextLine(): void {
    this._row++;
    if (this._row >= this._rows) {
      this._scrollUp();
    }
  }

  private _scrollUp(): void {
    // Push evicted top row into scrollback ring
    if (this._sb.length < SCROLLBACK_MAX) {
      this._sb.push(this._screen[0].slice());
    } else {
      // Reuse existing slot
      var dst = this._sb[this._sbWrite];
      for (var c = 0; c < this._cols; c++) {
        if (c < dst.length) { dst[c] = this._screen[0][c]; }
        else dst.push({ ch: this._screen[0][c].ch, fg: this._screen[0][c].fg });
      }
    }
    this._sbWrite = (this._sbWrite + 1) % SCROLLBACK_MAX;
    if (this._sbCount < SCROLLBACK_MAX) this._sbCount++;

    // Shift screen rows up
    for (var r = 0; r < this._rows - 1; r++) {
      this._screen[r] = this._screen[r + 1];
    }
    this._screen[this._rows - 1] = blankCellRow(this._cols, this._fgColor);
    this._row = this._rows - 1;

    // Repaint entire screen
    this._repaintAll();
  }

  /** Repaint all visible rows from the cell buffer. */
  private _repaintAll(): void {
    for (var r = 0; r < this._rows; r++) {
      for (var c = 0; c < this._cols; c++) {
        this._drawCell(r, c);
      }
    }
  }

  // ── Scrollback view ───────────────────────────────────────────────────────

  scrollUp(n: number = 3): void {
    if (this._sbCount === 0) return;
    this._viewOffset += n;
    if (this._viewOffset > this._sbCount) this._viewOffset = this._sbCount;
    this._renderScrollbackView();
  }

  scrollDown(n: number = 3): void {
    if (this._viewOffset === 0) return;
    this._viewOffset -= n;
    if (this._viewOffset < 0) this._viewOffset = 0;
    if (this._viewOffset === 0) {
      this._repaintAll();
    } else {
      this._renderScrollbackView();
    }
  }

  resumeLive(): void {
    if (this._viewOffset === 0) return;
    this._viewOffset = 0;
    this._repaintAll();
  }

  /** Render the scrollback view onto the canvas. */
  private _renderScrollbackView(): void {
    for (var r = 0; r < this._rows; r++) {
      var tapeIdx = r + this._sbCount - this._viewOffset;
      if (tapeIdx < 0) {
        // Above the scrollback — blank
        for (var c = 0; c < this._cols; c++) {
          this._canvas.fillRect(c * CHAR_W, r * CHAR_H, CHAR_W, CHAR_H, this._bgColor);
        }
      } else if (tapeIdx < this._sbCount) {
        // From scrollback ring
        var sbAbs = this._sbWrite - this._sbCount + tapeIdx;
        var idx = ((sbAbs % SCROLLBACK_MAX) + SCROLLBACK_MAX) % SCROLLBACK_MAX;
        var sbRow = this._sb[idx];
        for (var c = 0; c < this._cols; c++) {
          var px = c * CHAR_W;
          var py = r * CHAR_H;
          this._canvas.fillRect(px, py, CHAR_W, CHAR_H, this._bgColor);
          if (c < sbRow.length && sbRow[c].ch !== 0x20) {
            defaultFont.renderChar(this._canvas, px, py,
              String.fromCharCode(sbRow[c].ch), sbRow[c].fg);
          }
        }
      } else {
        // From live screen
        var liveR = tapeIdx - this._sbCount;
        if (liveR >= 0 && liveR < this._rows) {
          for (var c = 0; c < this._cols; c++) {
            var cell = this._screen[liveR][c];
            var px2 = c * CHAR_W;
            var py2 = r * CHAR_H;
            this._canvas.fillRect(px2, py2, CHAR_W, CHAR_H, this._bgColor);
            if (cell.ch !== 0x20) {
              defaultFont.renderChar(this._canvas, px2, py2,
                String.fromCharCode(cell.ch), cell.fg);
            }
          }
        }
      }
    }
  }

  // ── Scrollbar rendering ───────────────────────────────────────────────────

  /** Draw the vertical scrollbar on the right edge of the canvas. */
  drawScrollbar(): void {
    var x = this._cols * CHAR_W;     // right edge of text area
    var w = SCROLLBAR_W;
    var h = this._canvas.height;
    var totalLines = this._sbCount + this._rows;

    // Separator line between text area and scrollbar
    this._canvas.fillRect(x, 0, 1, h, 0xFF2A2A3A);

    // Track background
    this._canvas.fillRect(x + 1, 0, w - 1, h, 0xFF161622);

    // Thumb (only when there's scrollback content)
    if (totalLines > this._rows) {
      var ratio = this._rows / totalLines;
      var thumbH = Math.max(16, Math.floor(h * ratio));
      // Position: offset=0 → thumb at bottom, offset=max → thumb at top
      var maxOffset = totalLines - this._rows;
      var scrollFraction = this._viewOffset / maxOffset;
      var thumbY = Math.floor((h - thumbH) * (1 - scrollFraction));

      // Rounded-ish thumb: draw with 1px inset and a subtle gradient look
      this._canvas.fillRect(x + 3, thumbY + 1, w - 5, thumbH - 2, 0xFF3A5070);
      // Thumb highlight (top edge)
      this._canvas.fillRect(x + 3, thumbY + 1, w - 5, 1, 0xFF4A6888);
      // Thumb center grip lines (3 small horizontal lines)
      var gripY = thumbY + Math.floor(thumbH / 2) - 3;
      if (thumbH > 24) {
        for (var gi = 0; gi < 3; gi++) {
          this._canvas.fillRect(x + 5, gripY + gi * 3, w - 9, 1, 0xFF5A7898);
        }
      }
    }
  }

  /** Public repaint – redraws all visible cells from the buffer. */
  repaint(): void { this._repaintAll(); }

  /** Draw (show=true) or erase (show=false) a 2-px underline cursor at the current position. */
  drawCursor(show: boolean): void {
    if (this._viewOffset !== 0) return;  // don't show cursor in scrollback
    var cx = this._col * CHAR_W;
    var cy = this._row * CHAR_H + CHAR_H - 2;
    this._canvas.fillRect(cx, cy, CHAR_W, 2, show ? Colors.LIGHT_GREY : this._bgColor);
  }
}

// VGA colour-index (0-15) → ARGB pixel colour for CanvasTerminal
const VGA_TO_ARGB: number[] = [
  Colors.BLACK,     0xFF0000AA,        Colors.GREEN,       Colors.CYAN,
  Colors.RED,       Colors.MAGENTA,    Colors.ORANGE,      Colors.LIGHT_GREY,
  Colors.DARK_GREY, 0xFF5555FF,        Colors.LIGHT_GREEN, Colors.LIGHT_CYAN,
  Colors.LIGHT_RED, 0xFFFF55FF,        Colors.YELLOW,      Colors.WHITE,
];

// ── Autocomplete helpers ──────────────────────────────────────────────────

const AC_MAX_VISIBLE = 8;    // max items visible in the popup
const AC_POPUP_W = 180;      // popup width in pixels
const AC_ITEM_H = 12;        // height of each autocomplete item in pixels
const AC_PAD_X = 2;          // horizontal padding inside popup
const AC_PAD_Y = 3;          // vertical padding inside popup
const AC_ICON_W = 12;        // width reserved for the type icon column
const AC_BG      = 0xFF1C1C2E;  // popup background (dark blue-grey)
const AC_SEL     = 0xFF2A4A7A;  // selected item background
const AC_BORDER  = 0xFF3A5580;  // popup border
const AC_DIVIDER = 0xFF2A3040;  // subtle line between items
const AC_TEXT    = 0xFFBBBBCC;  // normal item text
const AC_TEXT_HI = Colors.WHITE; // selected item text
const AC_TYPE_FN  = 0xFFDDCC55; // function icon colour
const AC_TYPE_OBJ = 0xFF55BBDD; // object icon colour
const AC_TYPE_STR = 0xFF88CC88; // string icon colour
const AC_TYPE_NUM = 0xFF88BBEE; // number icon colour
const AC_HINT     = 0xFF666688; // signature hint text colour

/** Get tab-completion candidates for the current input buffer. */
function _getCompletions(buf: string): string[] {
  // ── Filesystem path inside a string literal ──────────────────────────────
  var pathM = buf.match(/(['"])(\/?[^'"]*?)([^/]*)$/);
  if (pathM) {
    var quote    = pathM[1];
    var pathDir  = pathM[2];
    var pathFile = pathM[3];
    var rawBefore = buf.slice(0, buf.lastIndexOf(quote));
    var singles = (rawBefore.match(/'/g) || []).length;
    var doubles = (rawBefore.match(/"/g) || []).length;
    if ((quote === "'" && singles % 2 === 0) ||
        (quote === '"' && doubles % 2 === 0)) {
      var dirToList = pathDir || '/';
      if (!dirToList.startsWith('/')) {
        dirToList = fs.cwd().replace(/\/?$/, '/') + dirToList;
      }
      var entries: Array<{ name: string; type: string }>;
      try { entries = (fs.ls(dirToList) as Array<{ name: string; type: string }>) || []; } catch(_) { entries = []; }
      var results: string[] = [];
      for (var ei = 0; ei < entries.length; ei++) {
        var ent = entries[ei];
        if (ent.name.indexOf(pathFile) === 0) {
          results.push(quote + pathDir + ent.name + (ent.type === 'directory' ? '/' : ''));
        }
      }
      return results.sort();
    }
  }

  // ── Identifier / property completion ─────────────────────────────────────
  var m = buf.match(/[\w$][\w$.]*$/);
  var prefix = m ? m[0] : '';
  if (!prefix) return [];

  var g = globalThis as any;
  var dot = prefix.lastIndexOf('.');

  if (dot === -1) {
    var keys: string[] = [];
    for (var k in g) {
      if (k.indexOf(prefix) === 0) keys.push(k);
    }
    return keys.sort();
  } else {
    var objExpr = prefix.slice(0, dot);
    var propPfx = prefix.slice(dot + 1);
    var obj: any;
    // Try to resolve the object expression via dot-splitting
    var parts = objExpr.split('.');
    obj = g;
    for (var pi = 0; pi < parts.length; pi++) {
      if (obj == null) return [];
      obj = obj[parts[pi]];
    }
    if (obj == null) return [];
    var keys2: string[] = [];
    for (var k2 in obj) {
      if (k2.indexOf(propPfx) === 0) keys2.push(objExpr + '.' + k2);
    }
    // Also include own-property names from the prototype chain
    try {
      var ownKeys = Object.getOwnPropertyNames(obj);
      for (var oi = 0; oi < ownKeys.length; oi++) {
        var ok = ownKeys[oi];
        if (ok.indexOf(propPfx) === 0 && keys2.indexOf(objExpr + '.' + ok) === -1) {
          keys2.push(objExpr + '.' + ok);
        }
      }
    } catch (_) {}
    return keys2.sort();
  }
}

/** Get the type label for a completion candidate (for icon display). */
function _getCompletionType(name: string): string {
  try {
    var g = globalThis as any;
    var dot = name.lastIndexOf('.');
    var val: any;
    if (dot === -1) {
      val = g[name];
    } else {
      var parts = name.split('.');
      val = g;
      for (var i = 0; i < parts.length; i++) {
        if (val == null) return '?';
        val = val[parts[i]];
      }
    }
    if (typeof val === 'function') return 'fn';
    if (typeof val === 'object' && val !== null) return 'obj';
    if (typeof val === 'string') return 'str';
    if (typeof val === 'number') return 'num';
    if (typeof val === 'boolean') return 'bool';
    return typeof val;
  } catch (_) { return '?'; }
}

/** Extract a brief function signature. */
function _getFnSignature(name: string): string {
  try {
    var g = globalThis as any;
    var parts = name.split('.');
    var val: any = g;
    for (var i = 0; i < parts.length; i++) {
      if (val == null) return '';
      val = val[parts[i]];
    }
    if (typeof val !== 'function') return '';
    var src = val.toString();
    var sm = src.match(/^(?:async\s+)?(?:function\s*\w*\s*)?\(([^)]*)\)/);
    if (!sm) sm = src.match(/^(?:async\s+)?(\([^)]*\))\s*=>/);
    var params = sm ? (sm[1] || sm[0]) : '';
    return '(' + params + ')';
  } catch (_) { return ''; }
}

// ── TerminalApp ────────────────────────────────────────────────────────────

export class TerminalApp implements App {
  readonly name = 'Terminal';
  private _term: CanvasTerminal | null = null;
  private _win:  WMWindow | null = null;
  private _inputBuf = '';
  private _dirty = true;   // track whether canvas has been modified
  private _blinkMs  = 0;   // accumulated ms since last cursor phase change
  private _blinkOn  = true; // current cursor visibility state
  private _lastTick = 0;   // kernel.getTicks() at last render call

  // ── Input history (items 642–644) ─────────────────────────────────────────
  private _history:    string[] = [];   // oldest at index 0
  private _historyPos: number   = -1;  // -1 = no traversal, 0..n-1 = browsing
  private _historyDraft = '';          // saved live input while browsing

  // ── Autocomplete state ────────────────────────────────────────────────────
  private _acVisible = false;
  private _acItems: string[] = [];
  private _acSelected = 0;
  private _acScroll = 0;        // scroll offset within the completion list

  onMount(win: WMWindow): void {
    this._win  = win;
    this._term = new CanvasTerminal(win.canvas);
    this._dirty = true;
    this._loadHistory();
    this._printWelcome();
    this._printPrompt();
  }

  onUnmount(): void {
    this._term = null;
    this._win  = null;
  }

  onKey(event: KeyEvent): void {
    if (!this._term) return;
    var ch  = event.ch;
    var key = event.key;
    this._dirty = true;
    // Reset cursor blink phase on keystroke so cursor is immediately visible
    this._blinkMs = 0;
    this._blinkOn = true;

    // ── Scrollback: PgUp / PgDown ──────────────────────────────────────────
    if (key === 'PageUp') {
      this._term.scrollUp(this._term.rows - 1);
      this._dismissAC();
      return;
    }
    if (key === 'PageDown') {
      this._term.scrollDown(this._term.rows - 1);
      this._dismissAC();
      return;
    }

    // ── Autocomplete navigation ────────────────────────────────────────────
    if (this._acVisible) {
      if (key === 'ArrowUp') {
        this._acSelected = Math.max(0, this._acSelected - 1);
        // Scroll popup if selection moves above visible area
        if (this._acSelected < this._acScroll) this._acScroll = this._acSelected;
        return;
      }
      if (key === 'ArrowDown') {
        this._acSelected = Math.min(this._acItems.length - 1, this._acSelected + 1);
        // Scroll popup if selection moves below visible area
        if (this._acSelected >= this._acScroll + AC_MAX_VISIBLE) {
          this._acScroll = this._acSelected - AC_MAX_VISIBLE + 1;
        }
        return;
      }
      if (key === 'Escape') {
        this._dismissAC();
        return;
      }
      if (ch === '\t' || (ch === '\n' || ch === '\r')) {
        // Accept current completion
        this._acceptCompletion();
        return;
      }
    }

    // ── History navigation (items 642–643) ─────────────────────────────────
    if (key === 'ArrowUp') {
      this._dismissAC();
      if (this._history.length === 0) return;
      if (this._historyPos < 0) {
        // Start browsing: save the current draft
        this._historyDraft = this._inputBuf;
        this._historyPos   = this._history.length - 1;
      } else if (this._historyPos > 0) {
        this._historyPos--;
      }
      this._replaceInput(this._history[this._historyPos]);
      return;
    }
    if (key === 'ArrowDown') {
      this._dismissAC();
      if (this._historyPos < 0) return;
      if (this._historyPos < this._history.length - 1) {
        this._historyPos++;
        this._replaceInput(this._history[this._historyPos]);
      } else {
        // Reached the bottom — restore draft
        this._historyPos = -1;
        this._replaceInput(this._historyDraft);
      }
      return;
    }

    // Any non-arrow input exits history browsing mode
    this._historyPos = -1;

    // ── Standard terminal shortcuts ────────────────────────────────────────
    if (event.ctrl) {
      if (ch === '\x03' || key === 'c' || key === 'C') {
        // Ctrl+C — cancel current input
        this._dismissAC();
        this._term.setColor(Colors.DARK_GREY);
        this._term.print('^C');
        this._term.setColor(Colors.LIGHT_GREY);
        this._term.print('\n');
        this._inputBuf = '';
        this._historyPos = -1;
        this._printPrompt();
        return;
      }
      if (ch === '\x15' || key === 'u' || key === 'U') {
        // Ctrl+U — erase entire input line
        this._dismissAC();
        for (var ci = 0; ci < this._inputBuf.length; ci++) this._term.print('\b');
        this._inputBuf = '';
        return;
      }
      if (ch === '\x0C' || key === 'l' || key === 'L') {
        // Ctrl+L — clear screen and reprint prompt
        this._dismissAC();
        this._term.clear();
        this._printPrompt();
        this._term.print(this._inputBuf);
        return;
      }
    }

    if (ch === '\n' || ch === '\r') {
      this._dismissAC();
      this._term.print('\n');
      var cmd = this._inputBuf.trim();
      this._eval(cmd);
      // Push to history (skip empty and duplicate of last entry)
      if (cmd && (this._history.length === 0 || this._history[this._history.length - 1] !== cmd)) {
        this._history.push(cmd);
        if (this._history.length > 500) this._history.shift();  // cap history size
        this._saveHistory();
      }
      this._inputBuf = '';
      this._printPrompt();
    } else if (ch === '\b') {
      if (this._inputBuf.length > 0) {
        this._inputBuf = this._inputBuf.slice(0, -1);
        this._term.print('\b');
        this._updateAC();
      }
    } else if (ch === '\t') {
      // Tab without AC visible — trigger completion
      this._updateAC();
      if (this._acItems.length === 1) {
        this._acceptCompletion();
      } else if (!this._acVisible && this._acItems.length > 0) {
        this._acVisible = true;
        this._acSelected = 0;
        this._acScroll = 0;
      }
    } else if (ch === '\x1b') {
      this._dismissAC();
    } else if (ch >= ' ') {
      this._inputBuf += ch;
      this._term.print(ch);
      this._updateAC();
    }
  }

  // ── Autocomplete logic ──────────────────────────────────────────────────

  /** Update the autocomplete list based on current input. */
  private _updateAC(): void {
    if (this._inputBuf.length < 2) { this._dismissAC(); return; }
    var items = _getCompletions(this._inputBuf);
    if (items.length === 0 || (items.length === 1 && items[0] === this._inputBuf)) {
      this._dismissAC();
      return;
    }
    this._acItems = items.slice(0, 50); // cap at 50 candidates
    this._acSelected = 0;
    this._acScroll = 0;
    this._acVisible = true;
  }

  /** Dismiss the autocomplete popup and repaint the area it occupied. */
  private _dismissAC(): void {
    var wasVisible = this._acVisible;
    this._acVisible = false;
    this._acItems = [];
    this._acSelected = 0;
    this._acScroll = 0;
    // Repaint underlying terminal cells so the old popup doesn't ghost
    if (wasVisible && this._term) {
      this._term.repaint();
      this._term.drawScrollbar();
    }
  }

  /** Accept the currently selected completion. */
  private _acceptCompletion(): void {
    if (!this._term || this._acItems.length === 0) return;
    var full = this._acItems[this._acSelected];
    // Find the prefix being completed
    var m = this._inputBuf.match(/[\w$][\w$.]*$/);
    var partial = m ? m[0] : '';
    var suffix = full.slice(partial.length);
    // Erase current input and reprint with the completion
    for (var i = 0; i < this._inputBuf.length; i++) this._term.print('\b');
    this._inputBuf = this._inputBuf.slice(0, this._inputBuf.length - partial.length) + full;
    this._term.print(this._inputBuf);
    this._dismissAC();
  }

  /** Render the autocomplete popup overlay. */
  private _renderAC(): void {
    if (!this._acVisible || !this._term || !this._win) return;
    var canvas = this._win.canvas;
    var term = this._term;

    // Position popup below the cursor
    var cursorPx = term.col * CHAR_W;
    var cursorPy = (term.row + 1) * CHAR_H + 2;  // small gap below cursor

    var visibleCount = Math.min(this._acItems.length, AC_MAX_VISIBLE);
    var popupH = visibleCount * AC_ITEM_H + AC_PAD_Y * 2;
    var popupW = AC_POPUP_W;
    var hasMiniSB = this._acItems.length > AC_MAX_VISIBLE;
    var miniSBW = hasMiniSB ? 6 : 0;

    // Flip above cursor if not enough room below
    if (cursorPy + popupH > canvas.height) {
      cursorPy = term.row * CHAR_H - popupH - 2;
      if (cursorPy < 0) cursorPy = 0;
    }
    // Clamp horizontally
    if (cursorPx + popupW > canvas.width - SCROLLBAR_W) {
      cursorPx = canvas.width - SCROLLBAR_W - popupW;
      if (cursorPx < 0) cursorPx = 0;
    }

    var x = cursorPx;
    var y = cursorPy;

    // ── Drop shadow (1px offset) ────────────────────────────────────────
    canvas.fillRect(x + 2, y + 2, popupW, popupH, 0xCC000000);

    // ── Background + border ─────────────────────────────────────────────
    canvas.fillRect(x, y, popupW, popupH, AC_BG);
    canvas.drawRect(x, y, popupW, popupH, AC_BORDER);

    // ── Items ────────────────────────────────────────────────────────────
    var textAreaW = popupW - AC_PAD_X * 2 - AC_ICON_W - miniSBW;
    var maxChars = Math.floor(textAreaW / 8);

    for (var i = 0; i < visibleCount; i++) {
      var idx = i + this._acScroll;
      if (idx >= this._acItems.length) break;
      var item = this._acItems[idx];
      var iy = y + AC_PAD_Y + i * AC_ITEM_H;
      var isSelected = idx === this._acSelected;

      // Selected item highlight
      if (isSelected) {
        canvas.fillRect(x + 1, iy, popupW - 2 - miniSBW, AC_ITEM_H, AC_SEL);
      }

      // Subtle divider between items (skip first)
      if (i > 0 && !isSelected && idx !== this._acSelected + 1) {
        canvas.fillRect(x + AC_PAD_X + AC_ICON_W, iy, textAreaW, 1, AC_DIVIDER);
      }

      // ── Type icon: single character on a coloured pill ──────────────
      var type = _getCompletionType(item);
      var iconColor = type === 'fn'  ? AC_TYPE_FN :
                      type === 'obj' ? AC_TYPE_OBJ :
                      type === 'str' ? AC_TYPE_STR :
                      type === 'num' ? AC_TYPE_NUM :
                      0xFF777788;
      var iconCh = type === 'fn'  ? 'f' :
                   type === 'obj' ? 'o' :
                   type === 'str' ? 's' :
                   type === 'num' ? 'n' :
                   type === 'bool' ? 'b' : '?';
      // Icon background pill
      var pillBg = isSelected ? 0xFF1A1A2E : 0xFF252535;
      canvas.fillRect(x + AC_PAD_X + 1, iy + 2, 9, 8, pillBg);
      canvas.drawText(x + AC_PAD_X + 2, iy + 2, iconCh, iconColor);

      // ── Item name ──────────────────────────────────────────────────────
      var displayName = item;
      var lastDot = item.lastIndexOf('.');
      if (lastDot !== -1) displayName = item.slice(lastDot + 1);
      if (displayName.length > maxChars) displayName = displayName.slice(0, maxChars - 2) + '..';

      var nameX = x + AC_PAD_X + AC_ICON_W + 2;
      var nameY = iy + 2;
      canvas.drawText(nameX, nameY, displayName, isSelected ? AC_TEXT_HI : AC_TEXT);

      // ── Function signature hint (selected row only) ────────────────
      if (isSelected && type === 'fn') {
        var sig = _getFnSignature(item);
        if (sig) {
          var sigMaxChars = maxChars - displayName.length - 1;
          if (sigMaxChars > 4) {
            var sigTrunc = sig.length > sigMaxChars ? sig.slice(0, sigMaxChars - 2) + '..' : sig;
            canvas.drawText(nameX + (displayName.length + 1) * 8, nameY, sigTrunc, AC_HINT);
          }
        }
      }
    }

    // ── Mini scrollbar inside popup ──────────────────────────────────────
    if (hasMiniSB) {
      var sbX = x + popupW - miniSBW;
      var sbY = y + AC_PAD_Y;
      var sbH = popupH - AC_PAD_Y * 2;
      // Track
      canvas.fillRect(sbX, sbY, miniSBW - 1, sbH, 0xFF252535);
      // Thumb
      var ratio = AC_MAX_VISIBLE / this._acItems.length;
      var thumbH = Math.max(6, Math.floor(sbH * ratio));
      var maxScroll = this._acItems.length - AC_MAX_VISIBLE;
      var thumbY = sbY + Math.floor((sbH - thumbH) * (this._acScroll / maxScroll));
      canvas.fillRect(sbX + 1, thumbY, miniSBW - 3, thumbH, 0xFF5577AA);
    }
  }

  /** Erase the current input on screen and replace with newVal. */
  private _replaceInput(newVal: string): void {
    if (!this._term) return;
    // Erase existing input with backspaces
    for (var i = 0; i < this._inputBuf.length; i++) this._term.print('\b');
    // Print new value
    this._inputBuf = newVal;
    this._term.print(newVal);
  }

  /** Load history from persistent storage (/home/.repl_history). */
  private _loadHistory(): void {
    try {
      var raw = os.fs.read('/home/.repl_history');
      if (raw) {
        var lines = raw.split('\n').filter(function(l: string) { return l.trim().length > 0; });
        this._history = lines.slice(-500);
        this._historyPos = -1;
      }
    } catch (_) {}
  }

  /** Save history to persistent storage (/home/.repl_history). */
  private _saveHistory(): void {
    try {
      os.fs.write('/home/.repl_history', this._history.join('\n'));
    } catch (_) {}
  }

  onMouse(event: MouseEvent): void {
    if (!this._term) return;
    this._dirty = true;

    // ── Scrollbar drag: click on scrollbar area to jump ────────────────────
    var sbX = this._term.cols * CHAR_W + 1;
    if (event.type === 'click' && event.x >= sbX) {
      var totalLines = this._term.scrollbackCount + this._term.rows;
      if (totalLines > this._term.rows) {
        var fraction = event.y / (this._win?.canvas.height || 1);
        var targetOffset = Math.floor((1 - fraction) * (totalLines - this._term.rows));
        targetOffset = Math.max(0, Math.min(this._term.scrollbackCount, targetOffset));
        if (targetOffset === 0) {
          this._term.resumeLive();
        } else {
          // Use scrollUp/scrollDown to reach the target
          this._term.resumeLive();
          this._term.scrollUp(targetOffset);
        }
      }
      return;
    }

    // ── Click outside autocomplete popup → dismiss it ──────────────────
    if (event.type === 'click' && this._acVisible) {
      this._dismissAC();
      // Don't return — allow click-through for hyperlinks etc.
    }

    // [Item 673] OSC 8 hyperlink click: map pixel → VGA cell, look up link
    if (event.type === 'click') {
      var col = Math.floor(event.x / CHAR_W);
      var row = Math.floor(event.y / CHAR_H);
      var url = terminal.getLinkAt(row, col);
      if (url) {
        // Open URL in browser app if available
        try { (os as any).browser?.navigate(url); } catch (_) {}
      }
    }
  }

  render(_canvas: Canvas): boolean {
    // Cursor blink using kernel ticks (1000 Hz = 1 ms/tick); no VGA I/O in
    // graphic mode. Toggle cursor every 500 ms and mark dirty so the WM
    // composites a new frame even when no keys have been pressed.
    var now = kernel.getTicks();
    if (this._lastTick === 0) this._lastTick = now;
    this._blinkMs += now - this._lastTick;
    this._lastTick = now;
    if (this._blinkMs >= 500) {
      this._blinkMs = 0;
      this._blinkOn = !this._blinkOn;
      this._dirty = true;
    }
    if (!this._dirty) return false;
    this._dirty = false;
    if (this._term) {
      this._term.drawCursor(this._blinkOn);
      this._term.drawScrollbar();
      this._renderAC();
    }
    return true;
  }

  private _printWelcome(): void {
    if (!this._term) return;
    this._term.setColor(Colors.CYAN);
    this._term.println('JSOS Terminal (windowed mode)');
    this._term.setColor(Colors.DARK_GREY);
    this._term.println('Type JavaScript. Enter to evaluate.');
    this._term.println('PgUp/PgDown to scroll. Tab for autocomplete.');
    this._term.println('');
    this._term.setColor(Colors.LIGHT_GREY);
  }

  private _printPrompt(): void {
    if (!this._term) return;
    this._term.setColor(Colors.LIGHT_GREEN);
    this._term.print('js> ');
    this._term.setColor(Colors.WHITE);
  }

  private _eval(code: string): void {
    if (!this._term || !code) return;
    const term = this._term;

    // Temporarily redirect the global terminal singleton → this CanvasTerminal
    // so commands like help(), ls(), clear() etc. print here instead of VGA memory.
    const saved = {
      print:        (terminal as any).print.bind(terminal),
      println:      (terminal as any).println.bind(terminal),
      colorPrint:   (terminal as any).colorPrint.bind(terminal),
      colorPrintln: (terminal as any).colorPrintln.bind(terminal),
      setColor:     (terminal as any).setColor.bind(terminal),
      clear:        (terminal as any).clear.bind(terminal),
    };

    // Track the "persistent" foreground colour (set by setColor / reset after colorPrint).
    // Mirrors the VGA terminal's push/pop colour behaviour.
    let curColor = Colors.LIGHT_GREY;

    (terminal as any).print        = (s: string)             => { term.setColor(curColor); term.print(s); };
    (terminal as any).println      = (s: string = '')        => { term.setColor(curColor); term.println(s); };
    (terminal as any).colorPrint   = (s: string, c: number)  => {
      term.setColor(VGA_TO_ARGB[c & 15] ?? Colors.LIGHT_GREY); term.print(s);
      term.setColor(curColor);   // restore persistent colour after, like the VGA terminal does
    };
    (terminal as any).colorPrintln = (s: string, c: number)  => {
      term.setColor(VGA_TO_ARGB[c & 15] ?? Colors.LIGHT_GREY); term.println(s);
      term.setColor(curColor);   // restore persistent colour after
    };
    (terminal as any).setColor     = (fg: number, _bg?: number) => {
      curColor = VGA_TO_ARGB[fg & 15] ?? Colors.LIGHT_GREY;
      term.setColor(curColor);
    };
    (terminal as any).clear        = () => { term.clear(); };

    // Same IIFE-sentinel eval as evalAndPrint() in repl.ts
    const exprWrapped =
      '(function(){' +
      'var __r=(' + code + ');' +
      'if(__r===undefined)return"__JSOS_UNDEF__";' +
      'if(__r===null)return"null";' +
      'if(__r instanceof Error)return String(__r);' +
      'if(__r&&typeof __r.__jsos_print__==="function"){__r.__jsos_print__();return"__JSOS_PRINTED__";}' +
      'if(typeof __r==="object")return JSON.stringify(__r,null,2);' +
      'return String(__r);' +
      '})()';

    let result = '';
    try {
      result = kernel.eval(exprWrapped);
      // Statement syntax (var/function/for/if …) — re-eval directly
      if (result.indexOf('SyntaxError') === 0) {
        result = kernel.eval(code);
      }
    } finally {
      // Always restore — even if eval throws
      (terminal as any).print        = saved.print;
      (terminal as any).println      = saved.println;
      (terminal as any).colorPrint   = saved.colorPrint;
      (terminal as any).colorPrintln = saved.colorPrintln;
      (terminal as any).setColor     = saved.setColor;
      (terminal as any).clear        = saved.clear;
    }

    if (result === '__JSOS_PRINTED__') return;                        // pretty-printer ran
    if (result === '__JSOS_UNDEF__' || result === 'undefined') return; // void return

    // Colour-code the result the same way the text-mode REPL does
    term.setColor(
      result === 'null'                                                      ? Colors.DARK_GREY   :
      result === 'true' || result === 'false'                                ? Colors.YELLOW      :
      result.indexOf('Error:') !== -1                                        ? Colors.LIGHT_RED   :
      result.length > 0 && result[0] === '"'                                 ? Colors.LIGHT_GREEN :
      result !== 'Infinity' && result !== '-Infinity' &&
        result !== 'NaN' && !isNaN(Number(result))                           ? Colors.LIGHT_CYAN  :
      Colors.WHITE
    );
    term.println(result);
    term.setColor(Colors.LIGHT_GREY);
  }
}

export const terminalApp = new TerminalApp();

// ── Terminal Tabs (Item 654) ──────────────────────────────────────────────────

/** A lightweight record for one terminal tab. */
interface TerminalTab {
  id: number;
  title: string;
  inputBuf: string;
  history: string[];
  historyPos: number;
}

/**
 * [Item 654] TerminalTabManager — manages multiple independent terminal
 * tabs.  Ctrl+T opens a new tab, Ctrl+W closes the active tab, and
 * Ctrl+Tab / Ctrl+Shift+Tab cycle through open tabs.
 *
 * Each tab gets its own input buffer and command history so switching back
 * and forth does not clobber the user's work-in-progress.
 */
export class TerminalTabManager {
  private _tabs: TerminalTab[] = [];
  private _activeId: number    = 0;
  private _nextId: number      = 1;

  constructor() { this._newTab(); }       // always starts with one tab

  /** Number of open tabs. */
  get count(): number { return this._tabs.length; }

  /** ID of the currently active tab. */
  get activeId(): number { return this._activeId; }

  /** Open a fresh tab and make it active. */
  openTab(): TerminalTab {
    var tab = this._newTab();
    return tab;
  }

  /** Close the tab with `id`.  Switches to the previous tab when possible.
   *  Ignored when only one tab is open. */
  closeTab(id: number): void {
    if (this._tabs.length <= 1) return;
    var idx = this._tabs.findIndex(function(t) { return t.id === id; });
    if (idx === -1) return;
    this._tabs.splice(idx, 1);
    if (this._activeId === id) {
      var nextIdx = Math.max(0, idx - 1);
      this._activeId = this._tabs[nextIdx].id;
    }
  }

  /** Activate the next tab (wraps around). */
  nextTab(): TerminalTab {
    var idx = this._tabs.findIndex((t) => t.id === this._activeId);
    var nextIdx = (idx + 1) % this._tabs.length;
    this._activeId = this._tabs[nextIdx].id;
    return this._tabs[nextIdx];
  }

  /** Activate the previous tab (wraps around). */
  prevTab(): TerminalTab {
    var idx = this._tabs.findIndex((t) => t.id === this._activeId);
    var prevIdx = (idx - 1 + this._tabs.length) % this._tabs.length;
    this._activeId = this._tabs[prevIdx].id;
    return this._tabs[prevIdx];
  }

  /** Return the active tab record. */
  activeTab(): TerminalTab {
    return this._tabs.find((t) => t.id === this._activeId)!;
  }

  /** Return a shallow copy of all tab records (for rendering a tab bar). */
  listTabs(): TerminalTab[] { return this._tabs.slice(); }

  /** Rename a tab. */
  renameTab(id: number, title: string): void {
    var tab = this._tabs.find(function(t) { return t.id === id; });
    if (tab) tab.title = title;
  }

  /** Handle a key event; returns `true` when the key was consumed. */
  handleKey(key: string, ctrlKey: boolean): boolean {
    if (!ctrlKey) return false;
    if (key === 't' || key === 'T') { this.openTab();  return true; }
    if (key === 'w' || key === 'W') { this.closeTab(this._activeId); return true; }
    if (key === 'Tab')              { this.nextTab();  return true; }
    return false;
  }

  private _newTab(): TerminalTab {
    var tab: TerminalTab = {
      id: this._nextId++,
      title: 'Terminal ' + this._tabs.length,
      inputBuf: '',
      history: [],
      historyPos: -1,
    };
    this._tabs.push(tab);
    this._activeId = tab.id;
    return tab;
  }
}

export const terminalTabManager = new TerminalTabManager();

