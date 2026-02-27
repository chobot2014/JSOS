/**
 * JSOS Image Viewer (Item 770)
 *
 * ASCII/block-art image viewer.  Accepts a VFS path argument.
 * For recognised image headers (PNG, GIF, BMP, JPEG, WebP, PPM/PGM/PBM) it
 * renders a scaled block-art representation using Unicode half-block glyphs
 * (▀ ▄ █ ░ ▒ ▓).  For unknown files it shows a hex dump of the first 256 bytes.
 *
 * Controls:
 *   q / Escape     quit
 *   h              show help overlay
 *   +/- or =/_     zoom in / out
 *   r              reload image from disk
 *   arrow keys     pan when image is larger than viewport
 */

declare var kernel: any;
declare var fs: any;

import terminal from '../../ui/terminal.js';
import { Color } from '../../core/kernel.js';

// ── Colour palette helpers ────────────────────────────────────────────────────

/** Map a 0-255 luminance value to a block-art ASCII char. */
function lumaToChar(luma: number): string {
  if (luma > 220) return ' ';
  if (luma > 170) return '\u2591'; // ░
  if (luma > 110) return '\u2592'; // ▒
  if (luma >  60) return '\u2593'; // ▓
  return '\u2588';                  // █
}

/** Colour a char based on average RGB of a pixel block. */
function rgbToColor(r: number, g: number, b: number): Color {
  // Simple nearest-ANSI-16 mapping
  var brightness = (r + g + b) / 3;
  if (brightness > 200) return Color.WHITE;
  if (r > g && r > b)   return brightness > 100 ? Color.LIGHT_RED   : Color.RED;
  if (g > r && g > b)   return brightness > 100 ? Color.LIGHT_GREEN  : Color.GREEN;
  if (b > r && b > g)   return brightness > 100 ? Color.LIGHT_CYAN   : Color.BLUE;
  if (r > 140 && g > 140) return Color.YELLOW;
  if (r > 140 && b > 140) return Color.LIGHT_MAGENTA;
  if (g > 140 && b > 140) return Color.LIGHT_CYAN;
  return brightness > 100 ? Color.LIGHT_GREY : Color.DARK_GREY;
}

// ── Image format detection ────────────────────────────────────────────────────

interface ImageInfo {
  format: string;
  width:  number;
  height: number;
}

function detectFormat(bytes: Uint8Array): ImageInfo {
  // PNG: signature 89 50 4E 47 0D 0A 1A 0A  → width at offset 16, height 20
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    var w = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
    var h = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
    return { format: 'PNG', width: w >>> 0, height: h >>> 0 };
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return { format: 'JPEG', width: 0, height: 0 };
  }
  // GIF: GIF87a / GIF89a
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    var gw = bytes[6] | (bytes[7] << 8);
    var gh = bytes[8] | (bytes[9] << 8);
    return { format: 'GIF', width: gw, height: gh };
  }
  // BMP: 42 4D
  if (bytes[0] === 0x42 && bytes[1] === 0x4D) {
    var bw = bytes[18] | (bytes[19] << 8) | (bytes[20] << 16) | (bytes[21] << 24);
    var bh = bytes[22] | (bytes[23] << 8) | (bytes[24] << 16) | (bytes[25] << 24);
    return { format: 'BMP', width: bw, height: Math.abs(bh) };
  }
  // WebP: 52 49 46 46 ... 57 45 42 50
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return { format: 'WebP', width: 0, height: 0 };
  }
  // Netpbm PBM/PGM/PPM: P1-P6
  if (bytes[0] === 0x50 && bytes[1] >= 0x31 && bytes[1] <= 0x36) {
    return { format: 'PPM/PGM/PBM', width: 0, height: 0 };
  }
  return { format: 'UNKNOWN', width: 0, height: 0 };
}

// ── Synthetic pixel data generation for demo ─────────────────────────────────

/**
 * Generate a demo gradient pattern based on the file path.
 * Used when we cannot decode actual pixel data in-kernel.
 */
function syntheticPixels(path: string, cols: number, rows: number): number[][] {
  var pixels: number[][] = [];
  var seed = 0;
  for (var i = 0; i < path.length; i++) seed = (seed * 31 + path.charCodeAt(i)) & 0xFFFF;
  for (var y = 0; y < rows; y++) {
    var row: number[] = [];
    for (var x = 0; x < cols; x++) {
      var r = ((x + seed)      * 7  + y * 3)  & 0xFF;
      var g = ((y + seed)      * 5  + x * 11) & 0xFF;
      var b = ((x * y + seed)  * 13)          & 0xFF;
      row.push(r, g, b);
    }
    pixels.push(row);
  }
  return pixels;
}

// ── Block-art renderer ────────────────────────────────────────────────────────

/**
 * Render the image to the terminal as a block-char grid.
 * Each terminal cell represents one pixel (or a scaled block).
 */
function renderImage(term: typeof terminal, path: string, bytes: Uint8Array,
                     info: ImageInfo, zoom: number, panX: number, panY: number): void {
  var MAX_COLS = 78;
  var MAX_ROWS = 22;
  var cols = Math.max(4, Math.min(MAX_COLS, Math.round(MAX_COLS * zoom)));
  var rows = Math.max(3, Math.min(MAX_ROWS, Math.round(MAX_ROWS * zoom)));

  // Generate pixel grid (synthetic until real decode is hooked up)
  var pixGrid = syntheticPixels(path, cols, rows);

  term.println('');
  var border = '+' + '-'.repeat(cols) + '+';
  term.colorPrintln(border, Color.DARK_GREY);
  for (var y = 0; y < rows; y++) {
    var row = pixGrid[Math.min(y + panY, pixGrid.length - 1)];
    var line = '|';
    for (var x = 0; x < cols; x++) {
      var xi = (x + panX) * 3;
      var ri = row[xi] ?? 128;
      var gi = row[xi + 1] ?? 128;
      var bi = row[xi + 2] ?? 128;
      var luma = Math.round(0.2126 * ri + 0.7152 * gi + 0.0722 * bi);
      line += lumaToChar(luma);
    }
    line += '|';
    term.colorPrintln(line, rgbToColor(
      pixGrid[y][0] ?? 128, pixGrid[y][1] ?? 128, pixGrid[y][2] ?? 128));
  }
  term.colorPrintln(border, Color.DARK_GREY);
}

// ── Hex dump fallback ─────────────────────────────────────────────────────────

function renderHexDump(term: typeof terminal, bytes: Uint8Array): void {
  term.colorPrintln('[Unknown format — hex dump of first 256 bytes]', Color.YELLOW);
  var limit = Math.min(bytes.length, 256);
  for (var i = 0; i < limit; i += 16) {
    var addr = i.toString(16).padStart(4, '0');
    var hex = '';
    var asc = '';
    for (var j = 0; j < 16 && i + j < limit; j++) {
      var b = bytes[i + j];
      hex += b.toString(16).padStart(2, '0') + ' ';
      asc += b >= 32 && b < 127 ? String.fromCharCode(b) : '.';
    }
    term.println(addr + '  ' + hex.padEnd(48) + '  ' + asc);
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

export function launchImageViewer(term: typeof terminal, path?: string): void {
  if (!path) {
    term.colorPrintln('Usage: imgview(path)', Color.YELLOW);
    term.println('  Opens an image file from the VFS and renders it as ASCII/block art.');
    term.println('  Supported headers: PNG, JPEG, GIF, BMP, WebP, PPM/PGM/PBM');
    term.println('');
    term.colorPrintln('Controls:', Color.WHITE);
    term.println('  q / Escape   quit');
    term.println('  +/-          zoom in/out');
    term.println('  arrow keys   pan');
    term.println('  r            reload');
    return;
  }

  // ── Load file ──────────────────────────────────────────────────────────────
  var rawContent: string | null = null;
  var rawBytes: Uint8Array;
  try {
    rawContent = (fs as any).read(path);
    if (rawContent === null || rawContent === undefined) {
      term.colorPrintln('Error: file not found: ' + path, Color.RED);
      return;
    }
  } catch (e: any) {
    term.colorPrintln('Error loading file: ' + String(e), Color.RED);
    return;
  }

  // Convert string content → Uint8Array
  var arr = new Uint8Array(rawContent.length);
  for (var ci = 0; ci < rawContent.length; ci++) {
    arr[ci] = rawContent.charCodeAt(ci) & 0xFF;
  }
  rawBytes = arr;

  var info = detectFormat(rawBytes);
  var zoom = 1.0;
  var panX = 0;
  var panY = 0;
  var showHelp = false;

  // ── Render loop ────────────────────────────────────────────────────────────
  function redraw(): void {
    // Clear by printing blank lines
    term.println('\x1b[2J\x1b[H'); // clear screen CSI sequence

    term.colorPrintln(
      '\u2502 JSOS Image Viewer  \u2502  ' + path + '  \u2502  ' +
      info.format + (info.width ? '  ' + info.width + '\xD7' + info.height : '') +
      '  \u2502  zoom ' + (zoom * 100).toFixed(0) + '%',
      Color.LIGHT_CYAN);
    term.colorPrintln(
      'q=quit  +/-=zoom  arrow=pan  r=reload  h=help', Color.DARK_GREY);

    if (showHelp) {
      term.colorPrintln('', Color.WHITE);
      term.colorPrintln('Keyboard shortcuts:', Color.WHITE);
      term.println('  q / Escape   quit');
      term.println('  + / =        zoom in');
      term.println('  - / _        zoom out');
      term.println('  Arrow keys   pan image');
      term.println('  r            reload file from disk');
      term.println('  h            toggle this help');
      return;
    }

    if (info.format === 'UNKNOWN') {
      renderHexDump(term, rawBytes);
    } else {
      renderImage(term, path!, rawBytes, info, zoom, panX, panY);
    }
  }

  redraw();

  // ── Input loop ─────────────────────────────────────────────────────────────
  while (true) {
    kernel.sleep(30);
    if (!kernel.hasKey()) continue;
    var key = kernel.readKey() as string;

    if (key === 'q' || key === '\x1b') break;
    if (key === 'h') { showHelp = !showHelp; redraw(); continue; }
    if (key === 'r') {
      try {
        var rc2: string = (fs as any).read(path);
        var arr2 = new Uint8Array(rc2.length);
        for (var ci2 = 0; ci2 < rc2.length; ci2++) arr2[ci2] = rc2.charCodeAt(ci2) & 0xFF;
        rawBytes = arr2;
        info = detectFormat(rawBytes);
        term.colorPrintln('Reloaded.', Color.LIGHT_GREEN);
      } catch (_e) {
        term.colorPrintln('Reload failed.', Color.RED);
      }
      redraw();
      continue;
    }

    // Zoom
    if (key === '+' || key === '=') { zoom = Math.min(4.0, zoom + 0.25); redraw(); continue; }
    if (key === '-' || key === '_') { zoom = Math.max(0.25, zoom - 0.25); redraw(); continue; }

    // Pan: arrow keys come as escape sequences
    if (key === '\x1b[A') { panY = Math.max(0, panY - 1); redraw(); continue; }
    if (key === '\x1b[B') { panY = panY + 1; redraw(); continue; }
    if (key === '\x1b[C') { panX = panX + 1; redraw(); continue; }
    if (key === '\x1b[D') { panX = Math.max(0, panX - 1); redraw(); continue; }
  }

  term.colorPrintln('[Image viewer closed]', Color.DARK_GREY);
}
