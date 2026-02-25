/**
 * Settings — JSOS built-in application.
 *
 * System configuration panels for display, users, network and storage.
 * Currently provides read-only info panels; write-back will be wired in
 * future phases.
 */

import { os, Canvas, Colors, type App, type WMWindow, type KeyEvent, type MouseEvent } from '../../core/sdk.js';

declare var kernel: import('../../core/kernel.js').KernelAPI;

// ── Module-scope state ───────────────────────────────────────────────────────

var _win:    WMWindow | null = null;
var _dirty   = true;
var _focused = false;
var _panel   = 0;   // 0=Display  1=Users  2=Network  3=Storage

const PANELS = ['Display', 'Users', 'Network', 'Storage'];
const SIDEBAR_W = 90;
const PADDING   = 8;
const ROW_H     = 20;

// ── App implementation ───────────────────────────────────────────────────────

export const settingsApp: App = {
  name: 'Settings',

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
    _dirty = true;
  },

  onResize(_w: number, _h: number): void {
    _dirty = true;
  },

  onKey(event: KeyEvent): void {
    if (event.type !== 'down') return;
    if (event.key === 'ArrowUp'   && _panel > 0)              { _panel--; _dirty = true; }
    if (event.key === 'ArrowDown' && _panel < PANELS.length - 1) { _panel++; _dirty = true; }
  },

  onMouse(event: MouseEvent): void {
    if (event.type !== 'down') return;
    if (event.x < SIDEBAR_W) {
      var row = Math.floor((event.y - PADDING) / ROW_H);
      if (row >= 0 && row < PANELS.length && row !== _panel) {
        _panel = row;
        _dirty = true;
      }
    }
  },

  render(canvas: Canvas): boolean {
    if (!_dirty) return false;
    _dirty = false;

    var w = canvas.width;
    var h = canvas.height;

    canvas.clear(Colors.EDITOR_BG);

    // ── Sidebar ────────────────────────────────────────────────────────────
    canvas.fillRect(0, 0, SIDEBAR_W, h, 0xFF111920);
    for (var i = 0; i < PANELS.length; i++) {
      var py = PADDING + i * ROW_H;
      if (i === _panel) canvas.fillRect(0, py - 2, SIDEBAR_W - 1, ROW_H, 0xFF2255AA);
      canvas.drawText(PADDING, py + 2, PANELS[i],
        i === _panel ? Colors.WHITE : Colors.LIGHT_GREY);
    }
    canvas.drawLine(SIDEBAR_W, 0, SIDEBAR_W, h, 0xFF334455);

    // ── Content area ──────────────────────────────────────────────────────
    var cx = SIDEBAR_W + PADDING;
    var cy = PADDING;

    canvas.drawText(cx, cy, PANELS[_panel] + ' Settings', Colors.YELLOW);
    canvas.drawLine(cx, cy + ROW_H, w - PADDING, cy + ROW_H, 0xFF334455);
    cy += ROW_H + 6;

    if (_panel === 0) {
      // Display
      var mem = os.system.memInfo();
      canvas.drawText(cx, cy, 'Screen width:  ' + os.system.screenWidth(),  Colors.WHITE); cy += ROW_H;
      canvas.drawText(cx, cy, 'Screen height: ' + os.system.screenHeight(), Colors.WHITE); cy += ROW_H;
      canvas.drawText(cx, cy, '', 0); cy += ROW_H;
      canvas.drawText(cx, cy, 'Video memory:  ' + ((mem.totalBytes >> 10) || '?') + ' KB total', Colors.LIGHT_GREY);

    } else if (_panel === 1) {
      // Users
      try {
        var me = os.users.whoami();
        canvas.drawText(cx, cy, 'Current user: ' + me.name, Colors.WHITE); cy += ROW_H;
        canvas.drawText(cx, cy, 'UID:          ' + me.uid,  Colors.WHITE); cy += ROW_H;
        canvas.drawText(cx, cy, 'GID:          ' + me.gid,  Colors.WHITE); cy += ROW_H;
        canvas.drawText(cx, cy, 'Home:         ' + me.home, Colors.LIGHT_GREY);
      } catch (_) {
        canvas.drawText(cx, cy, '(not logged in)', Colors.DARK_GREY);
      }

    } else if (_panel === 2) {
      // Network
      canvas.drawText(cx, cy, 'DHCP / virtio-net', Colors.WHITE); cy += ROW_H;
      canvas.drawText(cx, cy, 'Configuration is via /etc/network', Colors.LIGHT_GREY); cy += ROW_H;
      canvas.drawText(cx, cy, 'See: cat /proc/net/dev in terminal', Colors.DARK_GREY);

    } else {
      // Storage
      var diskOk = os.disk.available();
      canvas.drawText(cx, cy, 'Disk driver:  ' + (diskOk ? 'mounted' : 'not available'), Colors.WHITE); cy += ROW_H;
      if (diskOk) {
        canvas.drawText(cx, cy, 'Root entries:', Colors.LIGHT_GREY); cy += ROW_H;
        var entries = os.disk.list('/');
        for (var ei = 0; ei < entries.length && ei < 8; ei++) {
          canvas.drawText(cx + 8, cy, entries[ei].name, Colors.WHITE); cy += ROW_H;
        }
      } else {
        canvas.drawText(cx, cy, '(start QEMU with -drive to enable disk)', Colors.DARK_GREY);
      }
    }

    return true;
  },
};
