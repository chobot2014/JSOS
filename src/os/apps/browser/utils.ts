import type { ParsedURL, DecodedImage } from './types.js';

// ── URL parser ────────────────────────────────────────────────────────────────

export function parseURL(raw: string): ParsedURL | null {
  raw = raw.trim();
  if (!raw) return null;

  if (raw.startsWith('about:')) {
    return { protocol: 'about', host: '', port: 0, path: raw.slice(6), raw };
  }

  // data:[<mediatype>][;base64],<data>
  if (raw.startsWith('data:')) {
    var comma = raw.indexOf(',');
    if (comma < 0) return null;
    var meta     = raw.slice(5, comma);
    var dataBody = raw.slice(comma + 1);
    var mediaType = meta.replace(/;base64$/, '') || 'text/plain;charset=US-ASCII';
    return { protocol: 'data', host: '', port: 0, path: '', raw,
             dataMediaType: mediaType, dataBody };
  }

  var proto: 'http' | 'https';
  var rest: string;
  if (raw.startsWith('https://'))     { proto = 'https'; rest = raw.slice(8); }
  else if (raw.startsWith('http://')) { proto = 'http';  rest = raw.slice(7); }
  else {
    if (!raw.includes('/')) raw = raw + '/';
    raw = 'https://' + raw;
    proto = 'https'; rest = raw.slice(8);
  }
  var slash    = rest.indexOf('/');
  var hostPort = slash < 0 ? rest : rest.slice(0, slash);
  var path     = slash < 0 ? '/'  : rest.slice(slash) || '/';
  var colon    = hostPort.lastIndexOf(':');
  var host: string;
  var port: number;
  if (colon > 0) {
    host = hostPort.slice(0, colon);
    port = parseInt(hostPort.slice(colon + 1), 10) || (proto === 'https' ? 443 : 80);
  } else {
    host = hostPort;
    port = proto === 'https' ? 443 : 80;
  }
  if (!host) return null;
  return { protocol: proto, host, port, path, raw };
}

// ── URL encoding ──────────────────────────────────────────────────────────────

export function urlEncode(s: string): string {
  var out = '';
  for (var i = 0; i < s.length; i++) {
    var c = s[i];
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
        (c >= '0' && c <= '9') || c === '-' || c === '_' || c === '.' || c === '~') {
      out += c;
    } else if (c === ' ') {
      out += '+';
    } else {
      var code = s.charCodeAt(i);
      out += '%' + (code < 16 ? '0' : '') + code.toString(16).toUpperCase();
    }
  }
  return out;
}

export function encodeFormData(fields: Array<{name: string; value: string}>): number[] {
  var parts: string[] = [];
  for (var i = 0; i < fields.length; i++) {
    parts.push(urlEncode(fields[i].name) + '=' + urlEncode(fields[i].value));
  }
  var str = parts.join('&');
  var out = new Array(str.length);
  for (var j = 0; j < str.length; j++) out[j] = str.charCodeAt(j) & 0xFF;
  return out;
}

// ── BMP image decoder ─────────────────────────────────────────────────────────

export function decodeBMP(bytes: number[]): DecodedImage | null {
  if (bytes.length < 54) return null;
  if (bytes[0] !== 0x42 || bytes[1] !== 0x4D) return null;   // "BM"

  function le32(off: number): number {
    return bytes[off] | (bytes[off+1] << 8) | (bytes[off+2] << 16) | (bytes[off+3] << 24);
  }
  function le16(off: number): number {
    return bytes[off] | (bytes[off+1] << 8);
  }

  var pixOff  = le32(10);
  var bmpW    = le32(18);
  var bmpH    = le32(22);
  var bpp     = le16(28);
  var topDown = false;
  if (bmpH < 0) { bmpH = -bmpH; topDown = true; }

  if (bmpW <= 0 || bmpH <= 0 || bmpW > 4096 || bmpH > 4096) return null;
  if (bpp !== 24 && bpp !== 32) return null;

  var bytesPerPixel = bpp >> 3;
  var rowStride     = (bmpW * bytesPerPixel + 3) & ~3;
  var expectedSize  = pixOff + rowStride * bmpH;
  if (bytes.length < expectedSize) return null;

  var data = new Uint32Array(bmpW * bmpH);
  for (var row = 0; row < bmpH; row++) {
    var srcRow  = topDown ? row : (bmpH - 1 - row);
    var rowOff  = pixOff + srcRow * rowStride;
    var dstRow  = row * bmpW;
    for (var col = 0; col < bmpW; col++) {
      var p = rowOff + col * bytesPerPixel;
      var b = bytes[p];
      var g = bytes[p + 1];
      var r = bytes[p + 2];
      var a = bpp === 32 ? bytes[p + 3] : 0xFF;
      data[dstRow + col] = (a << 24) | (r << 16) | (g << 8) | b;
    }
  }
  return { w: bmpW, h: bmpH, data };
}

// ── PNG dimension reader ──────────────────────────────────────────────────────
// Does not fully decode PNG — only reads the IHDR chunk for width/height,
// so we can display a correctly-sized placeholder for non-BMP images.

export function readPNGDimensions(bytes: number[]): { w: number; h: number } | null {
  // Signature: [137,80,78,71,13,10,26,10]  IHDR at byte 8: 4b len + 4b "IHDR" + 4b W + 4b H
  if (bytes.length < 24) return null;
  if (bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) return null;
  var w = ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0;
  var h = ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>> 0;
  return (w > 0 && h > 0) ? { w, h } : null;
}

// ── Base64 decoder ───────────────────────────────────────────────────────────
// Minimal base64 decode for data: URLs in image src attributes.

var _B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
var _B64MAP: Record<string, number> = {};
(function() {
  for (var i = 0; i < _B64.length; i++) _B64MAP[_B64[i]] = i;
  _B64MAP['='] = 0;
})();

export function decodeBase64(s: string): number[] {
  var out: number[] = [];
  s = s.replace(/[^A-Za-z0-9+/=]/g, '');
  for (var i = 0; i < s.length; i += 4) {
    var b0 = _B64MAP[s[i]]   ?? 0;
    var b1 = _B64MAP[s[i+1]] ?? 0;
    var b2 = _B64MAP[s[i+2]] ?? 0;
    var b3 = _B64MAP[s[i+3]] ?? 0;
    out.push((b0 << 2) | (b1 >> 4));
    if (s[i+2] !== '=') out.push(((b1 & 0xF) << 4) | (b2 >> 2));
    if (s[i+3] !== '=') out.push(((b2 & 0x3) << 6) | b3);
  }
  return out;
}
