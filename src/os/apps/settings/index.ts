/**
 * Settings  JSOS built-in application.
 *
 * System configuration panels for display, users, network and storage.
 * Uses BaseApp + Sidebar widget so there is no lifecycle boilerplate.
 */

import {
  os, Canvas, Colors, BaseApp, Sidebar, drawSection, drawRow,
  type KeyEvent, type MouseEvent,
} from '../../core/sdk.js';

//  SettingsApp 

const PANELS  = ['Display', 'Users', 'Network', 'Storage'];
const PADDING = 8;
const ROW_H   = 20;

class SettingsApp extends BaseApp {
  readonly name = 'Settings';

  private _sidebar = new Sidebar(PANELS, { width: 90, rowH: ROW_H, padding: PADDING });

  onKey(ev: KeyEvent): void {
    if (ev.type !== 'down') return;
    if (this._sidebar.handleKey(ev.key)) this.invalidate();
  }

  onMouse(ev: MouseEvent): void {
    if (ev.type !== 'down') return;
    if (this._sidebar.handleClick(ev.x, ev.y)) this.invalidate();
  }

  render(canvas: Canvas): boolean {
    if (!this._dirty) return false;
    this._dirty = false;

    var w = canvas.width;
    var h = canvas.height;
    var panel = this._sidebar.selected;

    canvas.clear(Colors.EDITOR_BG);

    // Sidebar
    this._sidebar.render(canvas, h);

    // Content area
    var cx = this._sidebar.width + PADDING;
    var cy = PADDING;

    cy = drawSection(canvas, cx, cy, w - cx - PADDING,
                     PANELS[panel] + ' Settings', Colors.YELLOW, ROW_H);

    if (panel === 0) {
      // Display
      var mem = os.system.memory();
      cy = drawRow(canvas, cx, cy, 'Screen width:',  String(os.system.screenWidth()),  Colors.WHITE, Colors.LIGHT_GREY, ROW_H, cx + 130);
      cy = drawRow(canvas, cx, cy, 'Screen height:', String(os.system.screenHeight()), Colors.WHITE, Colors.LIGHT_GREY, ROW_H, cx + 130);
      cy += ROW_H;
      drawRow(canvas, cx, cy, 'Video memory:',
              ((mem.total >> 10) || '?') + ' KB total',
              Colors.LIGHT_GREY, Colors.LIGHT_GREY, ROW_H, cx + 130);

    } else if (panel === 1) {
      // Users
      try {
        var me = os.users.whoami();
        cy = drawRow(canvas, cx, cy, 'Current user:', me.name,       Colors.WHITE,       Colors.LIGHT_GREY, ROW_H, cx + 130);
        cy = drawRow(canvas, cx, cy, 'UID:',          String(me.uid), Colors.WHITE,       Colors.LIGHT_GREY, ROW_H, cx + 130);
        cy = drawRow(canvas, cx, cy, 'GID:',          String(me.gid), Colors.WHITE,       Colors.LIGHT_GREY, ROW_H, cx + 130);
        drawRow(canvas, cx, cy,      'Home:',          me.home,        Colors.LIGHT_GREY, Colors.LIGHT_GREY, ROW_H, cx + 130);
      } catch (_) {
        canvas.drawText(cx, cy, '(not logged in)', Colors.DARK_GREY);
      }

    } else if (panel === 2) {
      // Network
      var netIP  = os.net.getIP();
      var netMAC = os.net.getMACAddress();
      var netUp  = os.net.online();
      cy = drawRow(canvas, cx, cy, 'Status:',    netUp ? 'Online' : 'Offline',          Colors.WHITE, netUp ? 0xFF44FF44 : 0xFFFF4444, ROW_H, cx + 130);
      cy = drawRow(canvas, cx, cy, 'IP:',        netIP  || '(none)',                    Colors.WHITE, Colors.LIGHT_GREY, ROW_H, cx + 130);
      cy = drawRow(canvas, cx, cy, 'MAC:',       netMAC || '(none)',                    Colors.WHITE, Colors.LIGHT_GREY, ROW_H, cx + 130);
      cy = drawRow(canvas, cx, cy, 'Interface:', 'eth0 (virtio-net)',                   Colors.LIGHT_GREY, Colors.LIGHT_GREY, ROW_H, cx + 130);
      cy = drawRow(canvas, cx, cy, 'Config:',    '/etc/network',                        Colors.LIGHT_GREY, Colors.LIGHT_GREY, ROW_H, cx + 130);
      // Traffic from /proc/net/dev
      var netRaw = os.fs.read('/proc/net/dev');
      if (netRaw) {
        var netLines = netRaw.split('\n');
        for (var nli = 0; nli < netLines.length; nli++) {
          var nParts = netLines[nli].trim().split(/[:\s]+/).filter(function(s: string) { return s.length > 0; });
          if (nParts[0] === 'eth0' && nParts.length >= 10) {
            cy = drawRow(canvas, cx, cy, 'RX:', os.text.bytes(parseInt(nParts[1], 10)), Colors.WHITE, Colors.LIGHT_GREY, ROW_H, cx + 130);
            cy = drawRow(canvas, cx, cy, 'TX:', os.text.bytes(parseInt(nParts[9], 10)), Colors.WHITE, Colors.LIGHT_GREY, ROW_H, cx + 130);
            break;
          }
        }
      }

    } else {
      // Storage
      var diskOk = os.disk.available();
      cy = drawRow(canvas, cx, cy, 'Disk driver:', diskOk ? 'mounted' : 'not available',
                   Colors.WHITE, Colors.LIGHT_GREY, ROW_H, cx + 130);
      if (diskOk) {
        canvas.drawText(cx, cy, 'Root entries:', Colors.LIGHT_GREY); cy += ROW_H;
        var entries = os.disk.list('/');
        for (var ei = 0; ei < entries.length && ei < 8; ei++) {
          canvas.drawText(cx + 8, cy, entries[ei].name, Colors.WHITE);
          cy += ROW_H;
        }
      } else {
        canvas.drawText(cx, cy, '(start QEMU with -drive to enable disk)',
                        Colors.DARK_GREY);
      }
    }

    return true;
  }
}

export const settingsApp = new SettingsApp();
