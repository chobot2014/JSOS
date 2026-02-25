/**
 * System Monitor — JSOS built-in application.
 *
 * Displays real-time CPU ticks, memory usage, running processes and
 * network statistics.  Refreshes every WM frame when focused.
 */

import { os, Canvas, Colors, type App, type WMWindow, type KeyEvent, type MouseEvent } from '../../core/sdk.js';

declare var kernel: import('../../core/kernel.js').KernelAPI;

// ── Module-scope state ───────────────────────────────────────────────────────

var _win:    WMWindow | null = null;
var _dirty   = true;
var _focused = false;
var _tab     = 0;   // 0=Overview  1=Processes  2=Network

const TAB_LABELS = ['Overview', 'Processes', 'Network'];
const TAB_W      = 80;
const TAB_H      = 22;
const PADDING    = 6;
const ROW_H      = 16;

// ── App implementation ───────────────────────────────────────────────────────

export const systemMonitorApp: App = {
  name: 'System Monitor',

  onMount(win: WMWindow): void {
    _win = win;
    _dirty = true;
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
  },

  onResize(_width: number, _height: number): void {
    _dirty = true;
  },

  onKey(event: KeyEvent): void {
    if (event.type !== 'down') return;
    if (event.key === 'ArrowLeft'  && _tab > 0)                    { _tab--; _dirty = true; }
    if (event.key === 'ArrowRight' && _tab < TAB_LABELS.length - 1){ _tab++; _dirty = true; }
    if (event.key >= '1' && event.key <= '3') {
      var n = parseInt(event.key, 10) - 1;
      if (n !== _tab) { _tab = n; _dirty = true; }
    }
  },

  onMouse(event: MouseEvent): void {
    if (event.type !== 'down') return;
    for (var i = 0; i < TAB_LABELS.length; i++) {
      if (event.x >= i * TAB_W && event.x < (i + 1) * TAB_W &&
          event.y >= 0 && event.y < TAB_H) {
        if (_tab !== i) { _tab = i; _dirty = true; }
        return;
      }
    }
  },

  render(canvas: Canvas): boolean {
    // Always redraw when focused so stats stay live
    if (!_focused && !_dirty) return false;
    _dirty = false;

    var w = canvas.width;
    var h = canvas.height;

    canvas.clear(Colors.EDITOR_BG);

    // ── Tab bar ────────────────────────────────────────────────────────────
    for (var i = 0; i < TAB_LABELS.length; i++) {
      var active = (i === _tab);
      canvas.fillRect(i * TAB_W, 0, TAB_W - 2, TAB_H,
        active ? 0xFF2255AA : 0xFF1A2A3A);
      canvas.drawText(i * TAB_W + 6, 4, TAB_LABELS[i],
        active ? Colors.WHITE : Colors.LIGHT_GREY);
    }
    canvas.drawLine(0, TAB_H, w, TAB_H, 0xFF334455);

    var contentY = TAB_H + 4;

    if (_tab === 0) {
      // ── Overview ──────────────────────────────────────────────────────────
      var ticks  = kernel.getTicks();
      var uptime = Math.floor(ticks / 100);
      var hh     = Math.floor(uptime / 3600);
      var mm     = Math.floor((uptime % 3600) / 60);
      var ss     = uptime % 60;
      var pad    = (n: number) => (n < 10 ? '0' : '') + n;

      var mem    = os.system.memInfo();

      var y = contentY;
      canvas.drawText(PADDING, y, 'Uptime:   ' + hh + ':' + pad(mm) + ':' + pad(ss), Colors.WHITE); y += ROW_H;
      canvas.drawText(PADDING, y, 'Ticks:    ' + ticks, Colors.LIGHT_GREY); y += ROW_H;
      canvas.drawText(PADDING, y, '', 0); y += ROW_H;
      canvas.drawText(PADDING, y, 'Memory', Colors.YELLOW); y += ROW_H;
      canvas.drawText(PADDING, y, '  Total:  ' + (mem.totalBytes >> 10) + ' KB', Colors.WHITE); y += ROW_H;
      canvas.drawText(PADDING, y, '  Used:   ' + (mem.usedBytes  >> 10) + ' KB', Colors.WHITE); y += ROW_H;
      canvas.drawText(PADDING, y, '  Free:   ' + (mem.freeBytes  >> 10) + ' KB', Colors.WHITE); y += ROW_H;

      // Memory bar
      var barW = w - 2 * PADDING;
      var fill = mem.totalBytes > 0 ? Math.floor(barW * mem.usedBytes / mem.totalBytes) : 0;
      canvas.fillRect(PADDING, y, barW, 10, 0xFF223344);
      canvas.fillRect(PADDING, y, fill,  10, 0xFF3399FF);
      canvas.drawRect(PADDING, y, barW, 10, 0xFF445566);
      y += 16;

      canvas.drawText(PADDING, y, '', 0); y += ROW_H;
      canvas.drawText(PADDING, y, 'Processes: ' + os.process.list().length, Colors.WHITE); y += ROW_H;
      canvas.drawText(PADDING, y, 'Disk:      ' + (os.disk.available() ? 'available' : 'none'), Colors.WHITE);

    } else if (_tab === 1) {
      // ── Processes ─────────────────────────────────────────────────────────
      canvas.drawText(PADDING, contentY, 'PID   Name', Colors.YELLOW);
      canvas.drawLine(PADDING, contentY + ROW_H - 2, w - PADDING, contentY + ROW_H - 2, 0xFF334455);

      var procs = os.process.list();
      for (var pi = 0; pi < procs.length && contentY + (pi + 2) * ROW_H < h; pi++) {
        var proc = procs[pi];
        var py   = contentY + (pi + 1) * ROW_H + 4;
        canvas.drawText(PADDING, py,
          String(proc.id).padEnd(6) + (proc.name || '(unnamed)'), Colors.WHITE);
      }
      if (procs.length === 0) {
        canvas.drawText(PADDING, contentY + ROW_H + 4, '(no processes)', Colors.DARK_GREY);
      }

    } else {
      // ── Network ───────────────────────────────────────────────────────────
      canvas.drawText(PADDING, contentY,
        'Network interface stats are surfaced via /proc/net/dev.',
        Colors.LIGHT_GREY);
      canvas.drawText(PADDING, contentY + ROW_H,
        'See the terminal: cat /proc/net/dev',
        Colors.DARK_GREY);
    }

    return true;
  },
};
