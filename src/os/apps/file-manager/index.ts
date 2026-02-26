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

//  FileManagerApp 

const ROW_H   = 18;
const PADDING = 6;
const BAR_H   = ROW_H + PADDING;   // address bar / status bar height

interface Entry { name: string; type: 'file' | 'dir' }

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
        this._navigate({ name: '..', type: 'dir' });
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
    canvas.drawText(PADDING, 4, 'Path: ' + this._cwd, Colors.LIGHT_GREY);
    canvas.drawLine(0, BAR_H, w, BAR_H, 0xFF334455);

    // File list
    this._list.render(canvas, 0, listY, w, listH);

    // Status bar
    var statusY = h - BAR_H;
    canvas.fillRect(0, statusY, w, BAR_H, 0xFF1A2A3A);
    canvas.drawLine(0, statusY, w, 1, 0xFF334455);
    canvas.drawText(PADDING, statusY + 4,
      this._entries.length + ' item(s)  \u2191\u2193 navigate  \u23CE open  \u232b up',
      Colors.DARK_GREY);

    return true;
  }

  //  Helpers 

  private _visRows(): number {
    var listH = this.height - (BAR_H + 2) - BAR_H;
    return Math.max(1, Math.floor(listH / ROW_H));
  }

  private _load(): void {
    this._entries = [];
    try {
      var names = os.fs.list(this._cwd);
      for (var i = 0; i < names.length; i++) {
        var full  = (this._cwd === '/' ? '' : this._cwd) + '/' + names[i];
        var isDir = false;
        try { isDir = os.fs.isDir(full); } catch (_) {}
        this._entries.push({ name: names[i], type: isDir ? 'dir' : 'file' });
      }
      this._entries.sort(function(a: Entry, b: Entry) {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
      });
    } catch (_) {
      this._entries = [];
    }
    // Rebuild list display strings
    var labels: string[] = new Array(this._entries.length);
    for (var j = 0; j < this._entries.length; j++) {
      labels[j] = (this._entries[j].type === 'dir' ? '[D] ' : '    ') + this._entries[j].name;
    }
    this._list.setItems(labels);
    this.invalidate();
  }

  private _navigate(entry: Entry): void {
    if (entry.type !== 'dir') return;
    if (entry.name === '..') {
      var parts = this._cwd.replace(/\/$/, '').split('/');
      parts.pop();
      this._cwd = parts.join('/') || '/';
    } else {
      this._cwd = (this._cwd === '/' ? '' : this._cwd) + '/' + entry.name;
    }
    this._load();
  }

  private _openSelected(): void {
    var sel = this._list.selected;
    if (sel >= 0 && sel < this._entries.length) {
      this._navigate(this._entries[sel]);
    }
  }
}

export const fileManagerApp = new FileManagerApp();
