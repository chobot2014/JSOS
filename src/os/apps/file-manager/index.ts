/**
 * File Manager — JSOS built-in application.
 *
 * Provides a graphical browser for the virtual and disk file systems.
 * Implements the full App interface contract (including optional hooks).
 */

import { os, Canvas, Colors, type App, type WMWindow, type KeyEvent, type MouseEvent } from '../../core/sdk.js';

declare var kernel: import('../../core/kernel.js').KernelAPI;

// ── Module-scope state ───────────────────────────────────────────────────────

var _win:     WMWindow | null = null;
var _dirty    = true;
var _focused  = false;
var _cwd      = '/';
var _entries: Array<{ name: string; type: 'file' | 'dir' }> = [];
var _selected = -1;
var _scroll   = 0;

const ROW_H   = 18;
const PADDING = 6;

// ── Helpers ──────────────────────────────────────────────────────────────────

function _refresh(): void {
  _entries = [];
  try {
    var names = os.fs.readdir(_cwd);
    for (var i = 0; i < names.length; i++) {
      var full = (_cwd === '/' ? '' : _cwd) + '/' + names[i];
      var isDir = false;
      try { isDir = os.fs.isDirectory(full); } catch (_) {}
      _entries.push({ name: names[i], type: isDir ? 'dir' : 'file' });
    }
    _entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
  } catch (_) {
    _entries = [];
  }
  _selected = -1;
  _dirty = true;
}

function _navigate(entry: { name: string; type: 'file' | 'dir' }): void {
  if (entry.type !== 'dir') return;
  if (entry.name === '..') {
    var parts = _cwd.replace(/\/$/, '').split('/');
    parts.pop();
    _cwd = parts.join('/') || '/';
  } else {
    _cwd = (_cwd === '/' ? '' : _cwd) + '/' + entry.name;
  }
  _scroll = 0;
  _refresh();
}

// ── App implementation ───────────────────────────────────────────────────────

export const fileManagerApp: App = {
  name: 'File Manager',

  onMount(win: WMWindow): void {
    _win = win;
    _dirty = true;
    _refresh();
  },

  onUnmount(): void {
    _win = null;
    _focused = false;
  },

  onFocus(): void {
    _focused = true;
    _dirty = true;
  },

  onBlur(): void {
    _focused = false;
    _dirty = true;
  },

  onResize(width: number, height: number): void {
    _dirty = true;
  },

  onKey(event: KeyEvent): void {
    if (event.type !== 'down') return;
    switch (event.key) {
      case 'ArrowUp':
        if (_selected > 0) { _selected--; _dirty = true; }
        break;
      case 'ArrowDown':
        if (_selected < _entries.length - 1) { _selected++; _dirty = true; }
        break;
      case 'Enter':
        if (_selected >= 0 && _selected < _entries.length) {
          _navigate(_entries[_selected]);
        }
        break;
      case 'Backspace':
        _navigate({ name: '..', type: 'dir' });
        break;
    }
  },

  onMouse(event: MouseEvent): void {
    if (!_win) return;
    if (event.type === 'down') {
      var row = Math.floor((event.y - PADDING) / ROW_H) + _scroll;
      if (row >= 0 && row < _entries.length) {
        if (row === _selected) {
          // Double-click emulation: second click on same row navigates
          _navigate(_entries[row]);
        } else {
          _selected = row;
          _dirty = true;
        }
      }
    }
  },

  render(canvas: Canvas): boolean {
    if (!_dirty) return false;
    _dirty = false;

    var w = canvas.width;
    var h = canvas.height;

    // Background
    canvas.clear(Colors.EDITOR_BG);

    // Address bar
    canvas.fillRect(0, 0, w, ROW_H + PADDING, 0xFF1A2A3A);
    canvas.drawText(PADDING, 4, 'Path: ' + _cwd, Colors.LIGHT_GREY);

    // File list
    var listY = ROW_H + PADDING + 2;
    var visRows = Math.floor((h - listY) / ROW_H);

    // Clamp scroll
    if (_scroll > _entries.length - visRows) _scroll = Math.max(0, _entries.length - visRows);

    for (var i = 0; i < visRows && (_scroll + i) < _entries.length; i++) {
      var idx = _scroll + i;
      var ent = _entries[idx];
      var y   = listY + i * ROW_H;

      if (idx === _selected) {
        canvas.fillRect(0, y, w, ROW_H, 0xFF2255AA);
      }

      var icon  = ent.type === 'dir' ? '[D] ' : '    ';
      var color = ent.type === 'dir' ? 0xFFAADDFF : Colors.WHITE;
      canvas.drawText(PADDING, y + 2, icon + ent.name, color);
    }

    // Status bar
    canvas.fillRect(0, h - ROW_H, w, ROW_H, 0xFF1A2A3A);
    canvas.drawText(PADDING, h - ROW_H + 4,
      _entries.length + ' item(s)  |  \u2191\u2193 navigate  \u23CE open  \u232b up',
      Colors.DARK_GREY);

    return true;
  },
};
