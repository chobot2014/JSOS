/**
 * JSOS EditorApp — canvas-based text editor for WM (framebuffer) mode.
 *
 * When a framebuffer is active, typing edit() opens this as a WM window
 * instead of the VGA text-mode editor.  Key events arrive via onKey()
 * callbacks (non-blocking) so the WM event loop is never stalled.
 *
 * All editing logic mirrors editor.ts exactly; the only differences are
 * the rendering target (Canvas pixels via defaultFont) and I/O model
 * (event-driven vs. blocking waitKeyEx loop).
 */

import {
  os, Colors, defaultFont,
  type Canvas, type App, type WMWindow, type KeyEvent, type MouseEvent,
} from '../../core/sdk.js';

// ── Canvas colour constants (ARGB) ─────────────────────────────────────────
const C_BG       = 0xFF111111;
const C_TEXT     = 0xFFCCCCCC;
const C_TILDE    = 0xFF555555;
const C_CURSOR   = 0xFF2288FF;
const C_STA_BG   = 0xFF173455;
const C_STA_FG   = 0xFFFFFFFF;
const C_HINT_BG  = 0xFF003A3A;
const C_HINT_FG  = 0xFF44FFFF;
const C_WARN_FG  = 0xFFFFCC44;

const CHAR_W = 8;
const CHAR_H = 8;

type EditorMode = 'edit' | 'saveas';

// ── EditorApp ──────────────────────────────────────────────────────────────

export class EditorApp implements App {
  readonly name = 'Editor';

  private _lines: string[];
  private _curRow  = 0;
  private _curCol  = 0;
  private _viewTop = 0;
  private _modified   = false;
  private _savedPath: string;
  private _clipboard  = '';
  private _message    = '';
  private _isWarn     = false;
  private _mode: EditorMode = 'edit';
  private _promptBuf  = '';
  private _confirmQuit = false;   // true = next Ctrl+Q quits

  private _win: WMWindow | null = null;
  private _winId = -1;
  private _dirty = true;

  private _cols     = 80;
  private _editRows = 23;

  constructor(filePath?: string) {
    this._savedPath = filePath || '';
    var content = filePath ? (os.fs.read(filePath) || '') : '';
    content = content.replace(/\r/g, '');
    this._lines = content.split('\n');
    if (this._lines.length === 0) this._lines = [''];
  }

  onMount(win: WMWindow): void {
    this._win   = win;
    this._winId = win.id;
    this._cols     = Math.floor(win.canvas.width  / CHAR_W);
    this._editRows = Math.floor(win.canvas.height / CHAR_H) - 2;
    if (this._editRows < 1) this._editRows = 1;
    this._dirty = true;
  }

  onUnmount(): void { this._win = null; this._winId = -1; }
  onMouse(_ev: MouseEvent): void { /* no-op */ }

  onKey(event: KeyEvent): void {
    this._dirty = true;
    if (this._mode === 'saveas') { this._handleSaveAsKey(event); return; }

    var wasConfirmQuit = this._confirmQuit;
    this._confirmQuit = false;

    switch (event.key) {
      case 'ArrowUp':
        if (this._curRow > 0) { this._curRow--; this._clampCol(); }
        break;
      case 'ArrowDown':
        if (this._curRow < this._lines.length - 1) { this._curRow++; this._clampCol(); }
        break;
      case 'ArrowLeft':
        if (this._curCol > 0) { this._curCol--; }
        else if (this._curRow > 0) { this._curRow--; this._curCol = this._lines[this._curRow].length; }
        break;
      case 'ArrowRight':
        if (this._curCol < this._lines[this._curRow].length) { this._curCol++; }
        else if (this._curRow < this._lines.length - 1) { this._curRow++; this._curCol = 0; }
        break;
      case 'Home':
        this._curCol = 0;
        break;
      case 'End':
        this._curCol = this._lines[this._curRow].length;
        break;
      case 'PageUp':
        this._curRow = Math.max(0, this._curRow - this._editRows);
        this._clampCol();
        break;
      case 'PageDown':
        this._curRow = Math.min(this._lines.length - 1, this._curRow + this._editRows);
        this._clampCol();
        break;
      case 'Delete':
        if (this._curCol < this._lines[this._curRow].length) {
          this._lines[this._curRow] = this._lines[this._curRow].slice(0, this._curCol) +
                                      this._lines[this._curRow].slice(this._curCol + 1);
          this._modified = true;
        } else if (this._curRow < this._lines.length - 1) {
          this._lines[this._curRow] += this._lines[this._curRow + 1];
          this._lines.splice(this._curRow + 1, 1);
          this._modified = true;
        }
        break;
      case 'Enter':
        var before = this._lines[this._curRow].slice(0, this._curCol);
        var after  = this._lines[this._curRow].slice(this._curCol);
        this._lines[this._curRow] = before;
        this._lines.splice(this._curRow + 1, 0, after);
        this._curRow++;
        this._curCol = 0;
        this._modified = true;
        break;
      case 'Backspace':
        if (this._curCol > 0) {
          this._lines[this._curRow] = this._lines[this._curRow].slice(0, this._curCol - 1) +
                                      this._lines[this._curRow].slice(this._curCol);
          this._curCol--;
          this._modified = true;
        } else if (this._curRow > 0) {
          var prevLen = this._lines[this._curRow - 1].length;
          this._lines[this._curRow - 1] += this._lines[this._curRow];
          this._lines.splice(this._curRow, 1);
          this._curRow--;
          this._curCol = prevLen;
          this._modified = true;
        }
        break;
      case 'Tab':
        var sp = '    ';
        this._lines[this._curRow] = this._lines[this._curRow].slice(0, this._curCol) +
                                    sp + this._lines[this._curRow].slice(this._curCol);
        this._curCol += 4;
        this._modified = true;
        break;
      case 'Escape':
        // ESC — confirm-quit already reset to false above
        break;
      default:
        if (event.ctrl) {
          switch (event.key.toUpperCase()) {
            case 'S':
              this._save();
              break;
            case 'Q':
              if (this._modified && !wasConfirmQuit) {
                this._message = 'Unsaved changes! Press ^Q again to quit.';
                this._isWarn  = true;
                this._confirmQuit = true;
              } else {
                this._close();
              }
              break;
            case 'X':
              this._close();
              break;
            case 'K':
              this._clipboard = this._lines[this._curRow];
              this._lines.splice(this._curRow, 1);
              if (this._lines.length === 0) this._lines = [''];
              if (this._curRow >= this._lines.length) this._curRow = this._lines.length - 1;
              this._curCol = 0;
              this._modified = true;
              this._message  = 'Cut line';
              break;
            case 'U':
              this._lines.splice(this._curRow, 0, this._clipboard);
              this._modified = true;
              this._message  = 'Pasted';
              break;
          }
        } else if (event.ch && event.ch >= ' ') {
          this._lines[this._curRow] = this._lines[this._curRow].slice(0, this._curCol) +
                                      event.ch + this._lines[this._curRow].slice(this._curCol);
          this._curCol++;
          this._modified = true;
        }
        break;
    }
    this._scrollIntoView();
  }

  // ── Render ────────────────────────────────────────────────────────────────

  render(canvas: Canvas): boolean {
    if (!this._dirty) return false;
    this._dirty = false;

    var cols     = this._cols;
    var editRows = this._editRows;
    var statusY  = editRows * CHAR_H;
    var hintY    = (editRows + 1) * CHAR_H;

    // ── Content rows ────────────────────────────────────────────────────────
    for (var r = 0; r < editRows; r++) {
      var docRow = this._viewTop + r;
      var y = r * CHAR_H;
      canvas.fillRect(0, y, canvas.width, CHAR_H, C_BG);

      if (docRow < this._lines.length) {
        var line     = this._lines[docRow];
        var isCurRow = (docRow === this._curRow);

        for (var c = 0; c < cols && c < line.length; c++) {
          if (isCurRow && c === this._curCol) {
            canvas.fillRect(c * CHAR_W, y, CHAR_W, CHAR_H, C_CURSOR);
            defaultFont.renderChar(canvas, c * CHAR_W, y, line[c], C_BG);
          } else {
            defaultFont.renderChar(canvas, c * CHAR_W, y, line[c], C_TEXT);
          }
        }
        // Cursor at/past end of line
        if (isCurRow && this._curCol >= line.length) {
          var cx = this._curCol < cols ? this._curCol : cols - 1;
          canvas.fillRect(cx * CHAR_W, y, 2, CHAR_H, C_CURSOR);
        }
      } else {
        defaultFont.renderChar(canvas, 0, y, '~', C_TILDE);
      }
    }

    // ── Status bar ──────────────────────────────────────────────────────────
    canvas.fillRect(0, statusY, canvas.width, CHAR_H, C_STA_BG);
    var fname   = this._savedPath || '[No File]';
    var modMark = this._modified ? '[+] ' : '';
    var posStr  = ' L' + (this._curRow + 1) + ':C' + (this._curCol + 1) + ' ';
    var titleStr = ' Edit: ' + modMark + fname;
    var pad = cols - titleStr.length - posStr.length;
    var statusLine = titleStr;
    for (var si = 0; si < pad; si++) statusLine += ' ';
    statusLine = (statusLine + posStr).slice(0, cols);
    for (var sc = 0; sc < statusLine.length; sc++) {
      defaultFont.renderChar(canvas, sc * CHAR_W, statusY, statusLine[sc], C_STA_FG);
    }

    // ── Hint / message bar ──────────────────────────────────────────────────
    canvas.fillRect(0, hintY, canvas.width, CHAR_H, C_HINT_BG);
    var hint: string;
    var hintColor = C_HINT_FG;
    if (this._mode === 'saveas') {
      hint      = ' Save as: ' + this._promptBuf + '_';
      hintColor = C_STA_FG;
    } else if (this._message) {
      hint      = ' ' + this._message;
      hintColor = this._isWarn ? C_WARN_FG : C_HINT_FG;
      this._message = '';
      this._isWarn  = false;
    } else {
      hint = ' ^S Save  ^Q Quit  ^X Force-quit  ^K Cut  ^U Paste  Arrows/PgUp/Dn';
    }
    hint = hint.slice(0, cols);
    for (var hc = 0; hc < hint.length; hc++) {
      defaultFont.renderChar(canvas, hc * CHAR_W, hintY, hint[hc], hintColor);
    }

    return true;
  }

  // ── Key handlers ──────────────────────────────────────────────────────────

  private _handleSaveAsKey(event: KeyEvent): void {
    switch (event.key) {
      case 'Enter':
        if (this._promptBuf) {
          this._savedPath = this._promptBuf;
          this._promptBuf = '';
          this._mode = 'edit';
          this._doSave();
        } else {
          this._promptBuf = '';
          this._mode = 'edit';
          this._message = 'Save cancelled.';
        }
        break;
      case 'Escape':
        this._promptBuf = '';
        this._mode = 'edit';
        this._message = 'Save cancelled.';
        break;
      case 'Backspace':
        if (this._promptBuf.length > 0) this._promptBuf = this._promptBuf.slice(0, -1);
        break;
      default:
        if (!event.ctrl && event.ch && event.ch >= ' ') this._promptBuf += event.ch;
        break;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private _save(): void {
    if (this._savedPath) { this._doSave(); }
    else { this._mode = 'saveas'; this._promptBuf = ''; }
  }

  private _doSave(): void {
    if (os.fs.write(this._savedPath, this._lines.join('\n'))) {
      this._modified = false;
      this._message  = 'Saved: ' + this._savedPath;
    } else {
      this._message = 'ERROR: could not write ' + this._savedPath;
      this._isWarn  = true;
    }
  }

  private _close(): void {
    if (this._winId !== -1) os.wm.closeWindow(this._winId);
  }

  private _clampCol(): void {
    var len = this._lines[this._curRow].length;
    if (this._curCol > len) this._curCol = len;
  }

  private _scrollIntoView(): void {
    if (this._curRow < this._viewTop) this._viewTop = this._curRow;
    if (this._curRow >= this._viewTop + this._editRows)
      this._viewTop = this._curRow - this._editRows + 1;
    if (this._viewTop < 0) this._viewTop = 0;
  }
}
