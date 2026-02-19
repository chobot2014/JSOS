/**
 * JSOS Browser App — Phase 3 stub
 *
 * A minimal browser shell that renders an address bar and placeholder content.
 * Phase 7 (networking) wires real HTTP fetching.
 * Phase 9 (Chromium port) replaces this with a full browser.
 */

import { Canvas, Colors } from '../ui/canvas.js';
import type { App, WMWindow, KeyEvent, MouseEvent } from '../ui/wm.js';

export class BrowserApp implements App {
  readonly name = 'Browser';
  private _win:  WMWindow | null = null;
  private _url = 'about:blank';
  private _urlBarFocused = true;
  private _urlInput = '';

  onMount(win: WMWindow): void {
    this._win = win;
    this._render(win.canvas);
  }

  onUnmount(): void {
    this._win = null;
  }

  onKey(event: KeyEvent): void {
    if (!this._win) return;
    var ch = event.ch;
    if (!ch || ch.length === 0) return;

    if (this._urlBarFocused) {
      if (ch === '\n' || ch === '\r') {
        this._url = this._urlInput || 'about:blank';
        this._urlInput = this._url;
        this._render(this._win.canvas);
      } else if (ch === '\b') {
        this._urlInput = this._urlInput.slice(0, -1);
      } else if (ch >= ' ') {
        this._urlInput += ch;
      }
    }
  }

  onMouse(_event: MouseEvent): void { /* future: URL bar click, link click */ }

  render(canvas: Canvas): void {
    this._render(canvas);
  }

  private _render(canvas: Canvas): void {
    canvas.clear(Colors.WHITE);

    // URL bar
    var barH = 28;
    canvas.fillRect(0, 0, canvas.width, barH, 0xFFEEEEEE);
    canvas.drawRect(0, 0, canvas.width, barH, 0xFFCCCCCC);
    canvas.fillRect(60, 4, canvas.width - 70, barH - 8, Colors.WHITE);
    canvas.drawRect(60, 4, canvas.width - 70, barH - 8, 0xFF9999AA);
    canvas.drawText(64, 10, this._urlInput || this._url, Colors.BLACK);

    // Back/forward buttons
    canvas.fillRect(4, 6, 16, 16, 0xFFDDDDDD);
    canvas.drawText(6, 8, '<', 0xFF444444);
    canvas.fillRect(24, 6, 16, 16, 0xFFDDDDDD);
    canvas.drawText(26, 8, '>', 0xFF444444);
    canvas.fillRect(44, 6, 12, 16, 0xFFDDDDDD);
    canvas.drawText(46, 8, 'R', 0xFF444444);

    // Content area
    canvas.fillRect(0, barH, canvas.width, canvas.height - barH, Colors.WHITE);
    if (this._url === 'about:blank') {
      canvas.drawText(20, barH + 30, 'JSOS Browser', 0xFF333399);
      canvas.drawText(20, barH + 50, 'Networking (Phase 7) required for web browsing.', 0xFF666666);
    } else {
      canvas.drawText(20, barH + 30, 'Loading: ' + this._url, 0xFF666666);
      canvas.drawText(20, barH + 50, '(HTTP stack not yet wired \u2014 see Phase 7)', 0xFF999999);
    }
  }
}

export const browserApp = new BrowserApp();
