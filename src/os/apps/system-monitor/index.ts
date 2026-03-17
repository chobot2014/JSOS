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
      // Network — parse /proc/net/dev for live Rx/Tx stats
      var y = contentY;

      // Interface status
      var ip  = os.net.getIP();
      var mac = os.net.getMACAddress();
      var up  = os.net.online();

      canvas.drawText(PADDING, y, 'Interface', Colors.YELLOW); y += ROW_H;
      canvas.drawText(PADDING + 8,  y, 'Status:  ' + (up ? 'UP' : 'DOWN'), up ? Colors.GREEN : Colors.RED); y += ROW_H;
      canvas.drawText(PADDING + 8,  y, 'IP:      ' + (ip  || '(none)'), Colors.WHITE); y += ROW_H;
      canvas.drawText(PADDING + 8,  y, 'MAC:     ' + (mac || '(none)'), Colors.LIGHT_GREY); y += ROW_H;

      // Traffic stats from /proc/net/dev
      var raw = os.fs.read('/proc/net/dev');
      if (raw) {
        // Find the eth0 line: "  eth0:  rxBytes rxPkts..."
        var lines = raw.split('\n');
        for (var li = 0; li < lines.length; li++) {
          var parts = lines[li].trim().split(/[:\s]+/).filter(function(s: string) { return s.length > 0; });
          if (parts[0] === 'eth0' && parts.length >= 10) {
            var rxB = parseInt(parts[1],  10);
            var rxP = parseInt(parts[2],  10);
            var txB = parseInt(parts[9],  10);
            var txP = parseInt(parts[10], 10);
            y += 4;
            canvas.drawText(PADDING, y, 'Traffic (eth0)', Colors.YELLOW); y += ROW_H;
            canvas.drawText(PADDING + 8,  y, 'RX:  ' + os.text.bytes(rxB) + '  (' + rxP + ' pkts)', Colors.WHITE); y += ROW_H;
            canvas.drawText(PADDING + 8,  y, 'TX:  ' + os.text.bytes(txB) + '  (' + txP + ' pkts)', Colors.WHITE); y += ROW_H;
            break;
          }
        }
      }

      // Active TCP connections from /proc/net/tcp
      var tcp = os.fs.read('/proc/net/tcp');
      if (tcp) {
        var tcpLines = tcp.split('\n').filter(function(l: string) { return l.trim() && !l.trim().startsWith('sl'); });
        y += 4;
        canvas.drawText(PADDING, y, 'TCP connections: ' + tcpLines.length, Colors.YELLOW);
      }
    }

    return true;
  }
}

export const systemMonitorApp = new SystemMonitorApp();
