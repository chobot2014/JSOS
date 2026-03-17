/**
 * File Manager  JSOS built-in application.
 *
 * Provides a graphical browser for the virtual and disk filesystems.
 * Uses BaseApp + ListView widget  no lifecycle boilerplate.
 */

import {
  os, Canvas, Colors, BaseApp, ListView,
  type KeyEvent, type MouseEvent,
} from '../../core/sdk.js';
import { EditorApp } from '../editor/index.js';

//  FileManagerApp 

const ROW_H   = 18;
const PADDING = 6;
const BAR_H   = ROW_H + PADDING;   // address bar / status bar height
const SIZE_W  = 72;                 // width reserved for size column

interface Entry { name: string; type: 'file' | 'dir'; size: number }

class FileManagerApp extends BaseApp {
  readonly name = 'File Manager';

  private _cwd     = '/';
  private _entries: Entry[] = [];
  private _list    = new ListView([], { rowH: ROW_H, padding: 4 });

  onInit(): void {
    this._load();
  }

  onKey(ev: KeyEvent): void {
    if (ev.type !== 'down') return;
    switch (ev.key) {
      case 'ArrowUp':
      case 'ArrowDown':
        if (this._list.handleKey(ev.key)) {
          this._list.ensureVisible(this._visRows());
          this.invalidate();
        }
        break;
      case 'Enter':
        this._openSelected();
        break;
      case 'Backspace':
        this._goUp();
        break;
    }
  }

  onMouse(ev: MouseEvent): void {
    if (ev.type !== 'down') return;
    var listY = BAR_H + 2;
    var listH = this.height - listY - BAR_H;
    var row = Math.floor((ev.y - listY) / ROW_H) + this._list.scroll;
    if (row < 0 || row >= this._entries.length) return;

    if (row === this._list.selected) {
      // Second click on same row  open/navigate
      this._openSelected();
    } else {
      this._list.selected = row;
      this.invalidate();
    }
  }

  render(canvas: Canvas): boolean {
    if (!this._dirty) return false;
    this._dirty = false;

    var w = canvas.width;
    var h = canvas.height;
    var listY = BAR_H + 2;
    var listH = h - listY - BAR_H;

    canvas.clear(Colors.EDITOR_BG);

    // Address bar
    canvas.fillRect(0, 0, w, BAR_H, 0xFF1A2A3A);
    canvas.drawText(PADDING, 4, ' ' + this._cwd, Colors.WHITE);
    canvas.drawLine(0, BAR_H, w, BAR_H, 0xFF334455);

    // Column headers
    canvas.fillRect(0, listY - 2, w, ROW_H - 2, 0xFF0F1C2C);
    canvas.drawText(PADDING + 16, listY - 1, 'Name', Colors.YELLOW);
    canvas.drawText(w - SIZE_W,   listY - 1, 'Size', Colors.YELLOW);
    canvas.drawLine(0, listY + ROW_H - 4, w, listY + ROW_H - 4, 0xFF223344);
    listY += ROW_H - 2;
    listH -= ROW_H - 2;

    // File list (raw — we overlay size column ourselves)
    this._list.render(canvas, 0, listY, w - SIZE_W, listH);

    // Right-align size column for each visible row
    var scroll = this._list.scroll;
    var visRows = this._visRows();
    for (var vi = 0; vi < visRows && (scroll + vi) < this._entries.length; vi++) {
      var entry = this._entries[scroll + vi];
      var ry = listY + vi * ROW_H;
      var sizeStr = entry.type === 'dir' ? '<DIR>' : _fmtSize(entry.size);
      var sizeColor = entry.type === 'dir' ? Colors.DARK_GREY : Colors.LIGHT_GREY;
      canvas.drawText(w - SIZE_W, ry + 2, sizeStr, sizeColor);
    }

    // Status bar
    var sel = this._list.selected;
    var selInfo = '';
    if (sel >= 0 && sel < this._entries.length) {
      var e = this._entries[sel];
      selInfo = e.name + (e.type === 'dir' ? '/' : '  ' + _fmtSize(e.size));
    }

    var statusY = h - BAR_H;
    canvas.fillRect(0, statusY, w, BAR_H, 0xFF1A2A3A);
    canvas.drawLine(0, statusY, w, 1, 0xFF334455);
    var hint = '\u2191\u2193 navigate  \u23CE open  \u232b up';
    canvas.drawText(PADDING, statusY + 4, selInfo || (this._entries.length + ' items'), Colors.WHITE);
    canvas.drawText(w - 200, statusY + 4, hint, Colors.DARK_GREY);

    return true;
  }

  //  Helpers 

  private _visRows(): number {
    var listH = this.height - (BAR_H + 2 + ROW_H - 2) - BAR_H;
    return Math.max(1, Math.floor(listH / ROW_H));
  }

  private _goUp(): void {
    if (this._cwd === '/') return;
    var parts = this._cwd.replace(/\/$/, '').split('/');
    parts.pop();
    this._cwd = parts.join('/') || '/';
    this._load();
  }

  private _load(): void {
    this._entries = [];
    try {
      var names = os.fs.list(this._cwd);
      for (var i = 0; i < names.length; i++) {
        var full  = (this._cwd === '/' ? '' : this._cwd) + '/' + names[i];
        var isDir = false;
        var size  = 0;
        try {
          var st = os.fs.stat(full);
          if (st) { isDir = st.isDir; size = st.size; }
        } catch (_) {}
        this._entries.push({ name: names[i], type: isDir ? 'dir' : 'file', size: size });
      }
      this._entries.sort(function(a: Entry, b: Entry) {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      });
    } catch (_) {
      this._entries = [];
    }
    // Rebuild list display strings (name only — size drawn separately)
    var labels: string[] = new Array(this._entries.length);
    for (var j = 0; j < this._entries.length; j++) {
      var icon = this._entries[j].type === 'dir' ? '[/] ' : '    ';
      labels[j] = icon + this._entries[j].name;
    }
    this._list.setItems(labels);
    this._list.selected = -1;
    this.invalidate();
  }

  private _navigate(entry: Entry): void {
    if (entry.type !== 'dir') return;
    this._cwd = (this._cwd === '/' ? '' : this._cwd) + '/' + entry.name;
    this._load();
  }

  private _openSelected(): void {
    var sel = this._list.selected;
    if (sel < 0 || sel >= this._entries.length) return;
    var entry = this._entries[sel];
    if (entry.type === 'dir') {
      this._navigate(entry);
    } else {
      // Open file in editor
      var filePath = (this._cwd === '/' ? '' : this._cwd) + '/' + entry.name;
      var edApp = new EditorApp(filePath);
      var title = 'Edit: ' + entry.name;
      os.wm.openWindow({ title: title, width: 720, height: 480, app: edApp, closeable: true });
    }
  }
}

function _fmtSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes >> 10) + ' KB';
  return (bytes >> 20) + ' MB';
}

export const fileManagerApp = new FileManagerApp();
