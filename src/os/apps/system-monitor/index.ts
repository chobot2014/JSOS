/**
 * System Monitor  JSOS built-in application.
 *
 * Displays real-time CPU ticks, memory usage, running processes and
 * network statistics.  Refreshes every WM frame when focused.
 * Uses BaseApp + TabBar + ProgressBar widgets  no lifecycle boilerplate.
 */

import {
  os, Canvas, Colors, BaseApp, TabBar, ProgressBar,
  type KeyEvent, type MouseEvent,
} from '../../core/sdk.js';

//  SystemMonitorApp 

const PADDING = 6;
const ROW_H   = 16;

class SystemMonitorApp extends BaseApp {
  readonly name = 'System Monitor';

  private _tabs = new TabBar(['Overview', 'Processes', 'Network'], { tabW: 80, tabH: 22 });

  onKey(ev: KeyEvent): void {
    if (ev.type !== 'down') return;
    if (this._tabs.handleKey(ev.key)) this.invalidate();
  }

  onMouse(ev: MouseEvent): void {
    if (ev.type !== 'down') return;
    if (this._tabs.handleClick(ev.x, ev.y)) this.invalidate();
  }

  render(canvas: Canvas): boolean {
    // Always redraw when focused so live stats stay current
    if (!this._focused && !this._dirty) return false;
    this._dirty = false;

    var w = canvas.width;
    var h = canvas.height;

    canvas.clear(Colors.EDITOR_BG);

    // Tab bar
    this._tabs.render(canvas, 0, 0, w);
    var contentY = this._tabs.height + 4;
    var tab = this._tabs.selected;

    if (tab === 0) {
      // Overview
      var ticks  = os.system.ticks();
      var upMs   = os.time.uptime();
      var mem    = os.system.memory();

      var y = contentY;
      canvas.drawText(PADDING, y, 'Uptime:   ' + os.time.duration(upMs), Colors.WHITE);      y += ROW_H;
      canvas.drawText(PADDING, y, 'Ticks:    ' + ticks,                  Colors.LIGHT_GREY); y += ROW_H;
      y += ROW_H;
      canvas.drawText(PADDING, y, 'Memory', Colors.YELLOW); y += ROW_H;
      canvas.drawText(PADDING, y, '  Total:  ' + os.text.bytes(mem.total), Colors.WHITE); y += ROW_H;
      canvas.drawText(PADDING, y, '  Used:   ' + os.text.bytes(mem.used),  Colors.WHITE); y += ROW_H;
      canvas.drawText(PADDING, y, '  Free:   ' + os.text.bytes(mem.free),  Colors.WHITE); y += ROW_H;

      // Memory bar
      var frac = mem.total > 0 ? mem.used / mem.total : 0;
      ProgressBar.render(canvas, PADDING, y, w - 2 * PADDING, 10, frac, {
        fgColor: 0xFF3399FF, bgColor: 0xFF223344, bdColor: 0xFF445566,
      });
      y += 16;

      y += ROW_H;
      canvas.drawText(PADDING, y, 'Processes: ' + os.process.all().length, Colors.WHITE);     y += ROW_H;
      canvas.drawText(PADDING, y, 'Disk:      ' + (os.disk.available() ? 'available' : 'none'), Colors.WHITE);

    } else if (tab === 1) {
      // Processes
      canvas.drawText(PADDING, contentY, 'PID    Name                 State', Colors.YELLOW);
      canvas.drawLine(PADDING, contentY + ROW_H - 2, w - PADDING, contentY + ROW_H - 2, 0xFF334455);

      var procs = os.process.all();
      for (var pi = 0; pi < procs.length && contentY + (pi + 2) * ROW_H < h; pi++) {
        var proc = procs[pi];
        var py   = contentY + (pi + 1) * ROW_H + 4;
        canvas.drawText(PADDING, py,
          String(proc.pid).padEnd(7) + (proc.name || '(unnamed)').padEnd(21) + (proc.state || ''),
          Colors.WHITE);
      }
      if (procs.length === 0) {
        canvas.drawText(PADDING, contentY + ROW_H + 4, '(no processes)', Colors.DARK_GREY);
      }

    } else {
      // Network
      canvas.drawText(PADDING, contentY,
        'Network interface stats are surfaced via /proc/net/dev.',
        Colors.LIGHT_GREY);
      canvas.drawText(PADDING, contentY + ROW_H,
        'See the terminal: cat /proc/net/dev',
        Colors.DARK_GREY);
    }

    return true;
  }
}

export const systemMonitorApp = new SystemMonitorApp();
