/**
 * JSOS Browser — Native TypeScript Browser
 *
 * A fully native browser built entirely in TypeScript, using the JSOS
 * networking stack for real HTTP/HTTPS requests.  No Chromium, no external
 * runtimes — TypeScript IS the browser.
 *
 * Capabilities:
 *   • URL bar with keyboard input
 *   • Back / Forward navigation history
 *   • Real DNS resolution + HTTP/HTTPS fetching via the JSOS net stack
 *   • Basic HTML parser: h1-h6, p, a, ul/ol/li, br, hr, pre, title
 *   • Scrollable content area with clickable links
 *   • Status bar (loading, resolved IP, HTTP status)
 *   • Built-in pages: about:blank, about:jsos, about:history
 */

import { Canvas, Colors, type PixelColor } from '../ui/canvas.js';
import type { App, WMWindow, KeyEvent, MouseEvent } from '../ui/wm.js';
import { dnsResolve } from '../net/dns.js';
import { httpGet, httpsGet } from '../net/http.js';

declare var kernel: import('../core/kernel.js').KernelAPI;

// ── Constants ──────────────────────────────────────────────────────────────

const TOOLBAR_H   = 30;
const STATUSBAR_H = 14;
const CHAR_W      = 8;
const CHAR_H      = 8;
const LINE_H      = 13;  // text line height including leading
const CONTENT_PAD = 8;   // horizontal padding inside content area

const CLR_BG          = 0xFFFFFFFF;
const CLR_TOOLBAR_BG  = 0xFFE8EAED;
const CLR_TOOLBAR_BD  = 0xFFCDCDD3;
const CLR_STATUS_BG   = 0xFFF1F3F4;
const CLR_STATUS_TXT  = 0xFF555555;
const CLR_URL_BG      = 0xFFFFFFFF;
const CLR_URL_FOCUS   = 0xFF1A73E8;
const CLR_BTN_BG      = 0xFFDADCE0;
const CLR_BTN_TXT     = 0xFF333333;
const CLR_LINK        = 0xFF1558D6;
const CLR_LINK_HOV    = 0xFF063099;
const CLR_VISITED     = 0xFF7C1DBF;
const CLR_H1          = 0xFF1A1A1A;
const CLR_H2          = 0xFF222288;
const CLR_BODY        = 0xFF202020;
const CLR_PRE_BG      = 0xFFF6F8FA;
const CLR_PRE_TXT     = 0xFF333333;
const CLR_HR          = 0xFF999999;

// ── Types ──────────────────────────────────────────────────────────────────

type NodeType =
  | 'text' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
  | 'a' | 'hr' | 'li' | 'pre' | 'p-break';

interface RenderNode {
  type:  NodeType;
  text:  string;
  href?: string;
  pre?:  boolean;
}

interface RenderedLine {
  y:      number;
  nodes:  RenderedSpan[];
  lineH:  number;
}

interface RenderedSpan {
  x:       number;
  text:    string;
  color:   PixelColor;
  href?:   string;
}

// ── URL parser ─────────────────────────────────────────────────────────────

interface ParsedURL {
  protocol: 'http' | 'https' | 'about';
  host:     string;
  port:     number;
  path:     string;
  raw:      string;
}

function parseURL(raw: string): ParsedURL | null {
  var url = raw.trim();
  if (!url) return null;

  if (url.startsWith('about:')) {
    return { protocol: 'about', host: '', port: 0, path: url.slice(6), raw: url };
  }
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'http://' + url;
  }
  var isHttps = url.startsWith('https://');
  var rest    = url.slice(isHttps ? 8 : 7);
  var slashI  = rest.indexOf('/');
  var hostPart = slashI < 0 ? rest : rest.slice(0, slashI);
  var path     = slashI < 0 ? '/'  : rest.slice(slashI);

  var colonI = hostPart.indexOf(':');
  var host   = colonI < 0 ? hostPart : hostPart.slice(0, colonI);
  var port   = colonI < 0 ? (isHttps ? 443 : 80)
                           : parseInt(hostPart.slice(colonI + 1), 10);
  if (!host) return null;
  return { protocol: isHttps ? 'https' : 'http', host, port, path, raw: url };
}

// ── HTML tokeniser ─────────────────────────────────────────────────────────

interface HtmlToken {
  kind:  'text' | 'open' | 'close' | 'self';
  tag:   string;
  text:  string;
  attrs: Map<string, string>;
}

function tokenise(html: string): HtmlToken[] {
  var tokens: HtmlToken[] = [];
  var i = 0;
  var n = html.length;

  function skipWS(): void {
    while (i < n && (html[i] === ' ' || html[i] === '\t' ||
                     html[i] === '\r' || html[i] === '\n')) i++;
  }

  function readAttrValue(): string {
    if (html[i] === '"') {
      i++;
      var s = '';
      while (i < n && html[i] !== '"') s += html[i++];
      if (html[i] === '"') i++;
      return s;
    }
    if (html[i] === "'") {
      i++;
      var s = '';
      while (i < n && html[i] !== "'") s += html[i++];
      if (html[i] === "'") i++;
      return s;
    }
    var s = '';
    while (i < n && html[i] !== '>' && html[i] !== ' ') s += html[i++];
    return s;
  }

  function readTag(): HtmlToken | null {
    i++; // skip '<'
    var close = false;
    if (html[i] === '/') { close = true; i++; }
    if (html[i] === '!' || html[i] === '?') {
      while (i < n && html[i] !== '>') i++;
      if (i < n) i++;
      return null;
    }
    var tag = '';
    while (i < n && html[i] !== '>' && html[i] !== '/' &&
           html[i] !== ' ' && html[i] !== '\t' && html[i] !== '\n') {
      tag += html[i++];
    }
    tag = tag.toLowerCase();
    var attrs = new Map<string, string>();
    skipWS();
    while (i < n && html[i] !== '>' && html[i] !== '/') {
      var name = '';
      while (i < n && html[i] !== '=' && html[i] !== '>'
             && html[i] !== '/' && html[i] !== ' '
             && html[i] !== '\t' && html[i] !== '\n') {
        name += html[i++];
      }
      name = name.toLowerCase().trim();
      skipWS();
      var val = '';
      if (i < n && html[i] === '=') { i++; skipWS(); val = readAttrValue(); }
      if (name) attrs.set(name, val);
      skipWS();
    }
    var self = false;
    if (i < n && html[i] === '/') { self = true; i++; }
    if (i < n && html[i] === '>') i++;
    var kind: 'open' | 'close' | 'self' = close ? 'close' : (self ? 'self' : 'open');
    return { kind, tag, text: '', attrs };
  }

  while (i < n) {
    if (html[i] === '<') {
      var tok = readTag();
      if (tok) tokens.push(tok);
    } else {
      var start = i;
      while (i < n && html[i] !== '<') i++;
      var raw = html.slice(start, i);
      // Decode common HTML entities
      var decoded = raw
        .replace(/&amp;/g,  '&')
        .replace(/&lt;/g,   '<')
        .replace(/&gt;/g,   '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g,  "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_m: string, nc: string) => String.fromCharCode(parseInt(nc, 10)));
      tokens.push({ kind: 'text', tag: '', text: decoded, attrs: new Map() });
    }
  }
  return tokens;
}

// ── HTML parser ─────────────────────────────────────────────────────────────

function parseHTML(html: string): { nodes: RenderNode[]; title: string } {
  var tokens = tokenise(html);
  var nodes:   RenderNode[] = [];
  var title    = '';
  var inTitle  = false;
  var inPre    = false;
  var inHead   = false;
  var inScript = false;
  var inStyle  = false;
  var inLink   = false;
  var linkHref = '';

  var BLOCK_TAGS = new Set([
    'p','div','section','article','main','header','footer','nav','aside',
    'figure','blockquote','form','table','thead','tbody','tr','th','td',
    'address','details','summary',
  ]);

  for (var i = 0; i < tokens.length; i++) {
    var tok = tokens[i];

    if (inScript) { if (tok.kind === 'close' && tok.tag === 'script') inScript = false; continue; }
    if (inStyle)  { if (tok.kind === 'close' && tok.tag === 'style')  inStyle  = false; continue; }

    if (tok.kind === 'open' || tok.kind === 'self') {
      switch (tok.tag) {
        case 'head':   inHead = true;  break;
        case 'body':   inHead = false; break;
        case 'title':  inTitle = true; break;
        case 'script': inScript = true; break;
        case 'style':  inStyle  = true; break;
        case 'h1': nodes.push({ type: 'h1', text: '' }); break;
        case 'h2': nodes.push({ type: 'h2', text: '' }); break;
        case 'h3': nodes.push({ type: 'h3', text: '' }); break;
        case 'h4': nodes.push({ type: 'h4', text: '' }); break;
        case 'h5': nodes.push({ type: 'h5', text: '' }); break;
        case 'h6': nodes.push({ type: 'h6', text: '' }); break;
        case 'pre':    inPre = true;  break;
        case 'br':     nodes.push({ type: 'p-break', text: '' }); break;
        case 'hr':     nodes.push({ type: 'hr',      text: '' }); break;
        case 'a':
          inLink   = true;
          linkHref = tok.attrs.get('href') || '';
          break;
        case 'ul': case 'ol': break;
        case 'li': nodes.push({ type: 'li', text: '' }); break;
        default:
          if (BLOCK_TAGS.has(tok.tag)) nodes.push({ type: 'p-break', text: '' });
          break;
      }
    } else if (tok.kind === 'close') {
      switch (tok.tag) {
        case 'head':  inHead  = false; break;
        case 'title': inTitle = false; break;
        case 'pre':   inPre   = false; break;
        case 'a':     inLink  = false; linkHref = ''; break;
        default:
          if (BLOCK_TAGS.has(tok.tag)) nodes.push({ type: 'p-break', text: '' });
          break;
      }
    } else {
      // text token
      var txt = tok.text;
      if (inTitle) { title += txt.replace(/\s+/g, ' ').trim(); continue; }
      if (inHead)  continue;
      if (!inPre)  txt = txt.replace(/[\r\n\t]+/g, ' ');
      if (!txt.trim() && !inPre) continue;

      if (inPre) {
        var preLines = txt.split('\n');
        for (var pl = 0; pl < preLines.length; pl++) {
          var last = nodes[nodes.length - 1];
          if (last && last.type === 'pre') { last.text += preLines[pl]; }
          else { nodes.push({ type: 'pre', text: preLines[pl], pre: true }); }
          if (pl < preLines.length - 1) nodes.push({ type: 'p-break', text: '' });
        }
        continue;
      }

      if (inLink && linkHref) {
        nodes.push({ type: 'a', text: txt, href: linkHref });
        continue;
      }

      // Append text to open heading node
      var last2 = nodes[nodes.length - 1];
      if (last2 && /^h[1-6]$/.test(last2.type) && last2.text === '') {
        last2.text = txt.trim();
        continue;
      }

      // Append to open li node
      if (last2 && last2.type === 'li' && last2.text === '') {
        last2.text = txt.trim();
        continue;
      }

      nodes.push({ type: 'text', text: txt });
    }
  }
  return { nodes, title };
}

// ── Text wrapper ────────────────────────────────────────────────────────────

function wrapText(text: string, maxChars: number): string[] {
  if (maxChars < 1) maxChars = 1;
  var words = text.split(' ');
  var lines: string[] = [];
  var cur   = '';
  for (var i = 0; i < words.length; i++) {
    var w = words[i];
    if (!w) { if (cur) cur += ' '; continue; }
    var candidate = cur ? cur + ' ' + w : w;
    if (candidate.length <= maxChars) {
      cur = candidate;
    } else {
      if (cur) lines.push(cur);
      while (w.length > maxChars) { lines.push(w.slice(0, maxChars)); w = w.slice(maxChars); }
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

// ── Layout engine ────────────────────────────────────────────────────────────

function layoutNodes(nodes: RenderNode[], contentW: number): RenderedLine[] {
  var lines: RenderedLine[] = [];
  var y    = CONTENT_PAD;
  var maxC = Math.max(8, Math.floor((contentW - CONTENT_PAD * 2) / CHAR_W));

  function flush(spans: RenderedSpan[], lh: number): void {
    if (!spans.length) return;
    lines.push({ y, nodes: spans, lineH: lh });
    y += lh;
  }
  function blank(h: number): void {
    lines.push({ y, nodes: [], lineH: h });
    y += h;
  }

  for (var i = 0; i < nodes.length; i++) {
    var nd = nodes[i];

    if (nd.type === 'p-break') { blank(LINE_H >> 1); continue; }

    if (nd.type === 'hr') {
      lines.push({ y, nodes: [{ x: CONTENT_PAD, text: '', color: CLR_HR }], lineH: 3 });
      y += 8;
      continue;
    }

    if (/^h[1-6]$/.test(nd.type)) {
      var level   = parseInt(nd.type[1], 10);
      var clr     = level === 1 ? CLR_H1 : level === 2 ? CLR_H2 : CLR_BODY;
      var lhHead  = level <= 2 ? LINE_H + 8 : LINE_H + 4;
      if (y > CONTENT_PAD) blank(level <= 2 ? LINE_H : LINE_H >> 1);
      var wrapped = wrapText(nd.text || '(untitled)', maxC);
      for (var wi = 0; wi < wrapped.length; wi++) {
        flush([{ x: CONTENT_PAD, text: wrapped[wi], color: clr }], lhHead);
      }
      blank(level <= 2 ? LINE_H >> 1 : 2);
      continue;
    }

    if (nd.type === 'pre') {
      flush([{ x: CONTENT_PAD, text: (nd.text || '').slice(0, maxC), color: CLR_PRE_TXT }], LINE_H);
      continue;
    }

    if (nd.type === 'li') {
      var liText = '• ' + (nd.text || '');
      var liLines = wrapText(liText, maxC - 1);
      for (var li2 = 0; li2 < liLines.length; li2++) {
        flush([{ x: CONTENT_PAD + 8, text: liLines[li2], color: CLR_BODY }], LINE_H);
      }
      continue;
    }

    if (nd.type === 'a') {
      var linkLines = wrapText(nd.text, maxC - 2);
      for (var ll = 0; ll < linkLines.length; ll++) {
        flush([{ x: CONTENT_PAD, text: linkLines[ll], color: CLR_LINK, href: nd.href }], LINE_H);
      }
      continue;
    }

    // Plain text — gather consecutive text spans
    var textBuf = nd.text;
    var k = i + 1;
    while (k < nodes.length && nodes[k].type === 'text') { textBuf += nodes[k].text; k++; }
    i = k - 1;
    var tlines = wrapText(textBuf.trim(), maxC);
    for (var tl = 0; tl < tlines.length; tl++) {
      flush([{ x: CONTENT_PAD, text: tlines[tl], color: CLR_BODY }], LINE_H);
    }
  }

  return lines;
}

// ── Built-in pages ───────────────────────────────────────────────────────────

function aboutJsosHTML(): string {
  return [
    '<h1>JSOS Browser</h1>',
    '<p>Welcome to the JSOS native TypeScript browser.</p>',
    '<h2>About JSOS</h2>',
    '<p>JSOS is an operating system written entirely in TypeScript.</p>',
    '<p>TypeScript is not a guest in this OS — TypeScript IS the OS.</p>',
    '<h3>Browser</h3>',
    '<p>This browser is built 100% in TypeScript and runs natively on the JSOS kernel.',
    'No Chromium, no external runtimes — just TypeScript all the way down.</p>',
    '<h3>Features</h3>',
    '<ul>',
    '<li>DNS resolution (UDP/RFC 1035) in TypeScript</li>',
    '<li>HTTP and HTTPS requests via the JSOS net stack</li>',
    '<li>HTML parser and renderer (h1-h6, p, a, ul, pre, hr)</li>',
    '<li>Navigation history with Back and Forward</li>',
    '<li>Scrollable content and clickable hyperlinks</li>',
    '</ul>',
    '<h3>Keyboard shortcuts</h3>',
    '<ul>',
    '<li>Enter — navigate to URL in address bar</li>',
    '<li>b/f — Back / Forward (when not in URL bar)</li>',
    '<li>Space — scroll down a page</li>',
    '<li>/ or l — focus URL bar</li>',
    '<li>Esc — unfocus URL bar</li>',
    '</ul>',
    '<a href="about:history">View history</a>',
  ].join('\n');
}

function errorHTML(url: string, reason: string): string {
  return [
    '<h1>Cannot reach this page</h1>',
    '<p>' + url + '</p>',
    '<p>' + reason + '</p>',
    '<a href="about:jsos">JSOS Browser Home</a>',
  ].join('\n');
}

// ── Browser App ───────────────────────────────────────────────────────────────

interface HistoryEntry { url: string; title: string; }

export class BrowserApp implements App {
  readonly name = 'Browser';

  private _win:         WMWindow | null = null;
  private _urlInput     = 'about:jsos';
  private _urlBarFocus  = true;
  private _cursorBlink  = 0;

  private _history:     HistoryEntry[] = [];
  private _histIdx      = -1;
  private _visited      = new Set<string>();

  private _pageTitle    = 'JSOS Browser';
  private _pageURL      = 'about:jsos';
  private _lines:       RenderedLine[] = [];
  private _scrollY      = 0;
  private _maxScrollY   = 0;
  private _loading      = false;
  private _status       = '';
  private _dirty        = true;
  private _hoverHref    = '';

  // Deferred load: set in onKey(), consumed in render()
  private _pendingLoad:      string | null = null;
  private _pendingLoadReady  = false;

  // Redirect tracking — reset on each user-initiated navigation
  private _redirectDepth = 0;

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  onMount(win: WMWindow): void {
    this._win = win;
    this._navigate('about:jsos');
  }

  onUnmount(): void {
    this._win = null;
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  onKey(event: KeyEvent): void {
    var ch = event.ch;
    if (!ch) return;

    if (!this._urlBarFocus) {
      if (event.ext === 0x48) { this._scrollBy(-LINE_H * 3); return; }  // UP
      if (event.ext === 0x50) { this._scrollBy( LINE_H * 3); return; }  // DOWN
      if (ch === ' ')         { this._scrollBy( LINE_H * 8); return; }
      if (ch === 'b' || ch === 'B') { this._goBack();    return; }
      if (ch === 'f' || ch === 'F') { this._goForward(); return; }
      if (ch === '/' || ch === 'l') { this._urlBarFocus = true; this._dirty = true; return; }
      return;
    }

    if (ch === '\n' || ch === '\r') {
      var url = this._urlInput.trim();
      if (url) {
        // Queue a deferred load so render() can show "Loading..." before blocking
        this._pendingLoad      = url;
        this._pendingLoadReady = false;
        this._loading          = true;
        this._dirty            = true;
      }
      return;
    }
    if (ch === '\b') {
      this._urlInput = this._urlInput.slice(0, -1);
    } else if (ch === '\x1b') {
      this._urlBarFocus = false;
    } else if (ch >= ' ') {
      this._urlInput += ch;
    }
    this._dirty = true;
  }

  onMouse(event: MouseEvent): void {
    if (!this._win) return;

    var contentY0 = TOOLBAR_H;
    var contentY1 = this._win.height - STATUSBAR_H;

    if (event.type === 'down') {
      // Back button
      if (event.x >= 4 && event.x <= 25 && event.y >= 5 && event.y <= 24) {
        this._goBack(); return;
      }
      // Forward button
      if (event.x >= 28 && event.x <= 49 && event.y >= 5 && event.y <= 24) {
        this._goForward(); return;
      }
      // Reload button
      if (event.x >= 52 && event.x <= 73 && event.y >= 5 && event.y <= 24) {
        this._reload(); return;
      }
      // URL bar
      if (event.y >= 5 && event.y <= 24 && event.x > 76) {
        this._urlBarFocus = true; this._dirty = true; return;
      }
      // Content area — check for link click
      if (event.y >= contentY0 && event.y < contentY1) {
        var cy = event.y - contentY0 + this._scrollY;
        var href = this._hitTestLink(event.x, cy);
        if (href) { this._navigateLink(href); return; }
        this._urlBarFocus = false;
        this._dirty = true;
      }
    }

    // Update hover link
    if (event.y >= contentY0 && event.y < contentY1) {
      var cy2  = event.y - contentY0 + this._scrollY;
      var newH = this._hitTestLink(event.x, cy2);
      if (newH !== this._hoverHref) { this._hoverHref = newH; this._dirty = true; }
    } else if (this._hoverHref) {
      this._hoverHref = '';
      this._dirty = true;
    }
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  render(canvas: Canvas): void {
    this._cursorBlink++;
    if ((this._cursorBlink & 31) === 0) this._dirty = true;

    // Two-frame deferred load: Frame 1 draws "Loading…" and returns so WM flips
    // the frame to the screen; Frame 2 executes the blocking fetch.
    if (this._pendingLoad !== null) {
      if (!this._pendingLoadReady) {
        // Frame 1 — paint Loading screen now; signal that Frame 2 may fetch
        this._pendingLoadReady = true;
        this._dirty = true;   // ensure we get a Frame 2 render call
        this._drawToolbar(canvas);
        this._drawContent(canvas);
        this._drawStatusBar(canvas);
        return;
      } else {
        // Frame 2 — screen already shows "Loading…", now we can block.
        var pendingURL = this._pendingLoad;
        this._pendingLoad      = null;
        this._pendingLoadReady = false;
        this._navigate(pendingURL);
        // fall through to normal render below
      }
    }

    if (!this._dirty) return;
    this._dirty = false;

    this._drawToolbar(canvas);
    this._drawContent(canvas);
    this._drawStatusBar(canvas);
  }

  private _drawToolbar(canvas: Canvas): void {
    var w = canvas.width;
    canvas.fillRect(0, 0, w, TOOLBAR_H, CLR_TOOLBAR_BG);
    canvas.drawLine(0, TOOLBAR_H - 1, w, TOOLBAR_H - 1, CLR_TOOLBAR_BD);

    // Back button
    canvas.fillRect(4, 5, 22, 20, CLR_BTN_BG);
    canvas.drawText(10, 11, '<', this._histIdx > 0 ? CLR_BTN_TXT : CLR_HR);

    // Forward button
    canvas.fillRect(28, 5, 22, 20, CLR_BTN_BG);
    canvas.drawText(35, 11, '>', this._histIdx < this._history.length - 1 ? CLR_BTN_TXT : CLR_HR);

    // Reload button
    canvas.fillRect(52, 5, 22, 20, CLR_BTN_BG);
    canvas.drawText(58, 11, this._loading ? 'X' : 'R', CLR_BTN_TXT);

    // URL bar
    var urlX  = 76;
    var urlW  = w - urlX - 4;
    var bdrC  = this._urlBarFocus ? CLR_URL_FOCUS : CLR_TOOLBAR_BD;
    canvas.fillRect(urlX, 5, urlW, 20, CLR_URL_BG);
    canvas.drawRect(urlX, 5, urlW, 20, bdrC);

    var display  = this._urlBarFocus ? this._urlInput : this._pageURL;
    var maxChars = Math.max(1, Math.floor((urlW - 8) / CHAR_W));
    var showTxt  = display.length > maxChars ? display.slice(display.length - maxChars) : display;
    canvas.drawText(urlX + 4, 12, showTxt, CLR_BODY);

    // Cursor blink
    if (this._urlBarFocus && (this._cursorBlink >> 4) % 2 === 0) {
      var cx = urlX + 4 + showTxt.length * CHAR_W;
      if (cx <= urlX + urlW - 4) canvas.fillRect(cx, 10, 1, CHAR_H, CLR_BODY);
    }
  }

  private _drawContent(canvas: Canvas): void {
    var w  = canvas.width;
    var ch = canvas.height - TOOLBAR_H - STATUSBAR_H;
    var y0 = TOOLBAR_H;

    canvas.fillRect(0, y0, w, ch, CLR_BG);

    if (this._loading) {
      canvas.drawText(CONTENT_PAD, y0 + 20, 'Loading  ' + this._pageURL + ' ...', CLR_STATUS_TXT);
      return;
    }

    for (var i = 0; i < this._lines.length; i++) {
      var line  = this._lines[i];
      var lineY = line.y - this._scrollY;
      if (lineY + line.lineH < 0) continue;
      if (lineY > ch)             break;

      var absY = y0 + lineY;

      // HR (sentinel: lineH=3, single empty node)
      if (line.lineH === 3 && line.nodes.length === 1 && line.nodes[0].text === '') {
        canvas.fillRect(CONTENT_PAD, absY + 1, w - CONTENT_PAD * 2, 1, CLR_HR);
        continue;
      }

      // Pre background
      if (line.nodes.length > 0 && line.nodes[0].color === CLR_PRE_TXT) {
        canvas.fillRect(0, absY - 1, w, line.lineH + 1, CLR_PRE_BG);
      }

      for (var j = 0; j < line.nodes.length; j++) {
        var span = line.nodes[j];
        if (!span.text) continue;
        var clr = span.href
            ? (this._visited.has(span.href) ? CLR_VISITED
               : span.href === this._hoverHref ? CLR_LINK_HOV : CLR_LINK)
            : span.color;
        canvas.drawText(span.x, absY, span.text, clr);
        if (span.href) {
          canvas.drawLine(span.x, absY + CHAR_H,
                          span.x + span.text.length * CHAR_W, absY + CHAR_H, clr);
        }
      }
    }

    // Scrollbar
    if (this._maxScrollY > 0 && ch > 0) {
      var trackH  = ch - 4;
      var thumbH  = Math.max(12, Math.floor(trackH * ch / (ch + this._maxScrollY)));
      var thumbY0 = Math.floor((trackH - thumbH) * this._scrollY / this._maxScrollY);
      canvas.fillRect(w - 6, y0 + 2, 4, trackH, CLR_TOOLBAR_BG);
      canvas.fillRect(w - 6, y0 + 2 + thumbY0, 4, thumbH, CLR_BTN_BG);
    }
  }

  private _drawStatusBar(canvas: Canvas): void {
    var w  = canvas.width;
    var y0 = canvas.height - STATUSBAR_H;
    canvas.fillRect(0, y0, w, STATUSBAR_H, CLR_STATUS_BG);
    canvas.drawLine(0, y0, w, y0, CLR_TOOLBAR_BD);
    var txt = this._hoverHref
        ? 'Link: ' + this._hoverHref
        : this._status || this._pageTitle;
    var maxC = Math.floor((w - 8) / CHAR_W);
    canvas.drawText(4, y0 + 3, txt.slice(0, maxC), CLR_STATUS_TXT);
  }

  // ── Navigation ────────────────────────────────────────────────────────────

  private _navigate(url: string): void {
    this._redirectDepth = 0;   // reset on every user-initiated navigation
    this._histIdx++;
    this._history.splice(this._histIdx);
    this._history.push({ url, title: url });
    this._load(url);
  }

  private _navigateLink(href: string): void {
    var resolved = this._resolveHref(href);
    this._visited.add(resolved);
    this._navigate(resolved);
  }

  private _resolveHref(href: string): string {
    if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('about:')) {
      return href;
    }
    if (href.startsWith('//')) return 'http:' + href;
    if (href.startsWith('/')) {
      var p = parseURL(this._pageURL);
      if (!p) return href;
      var portSuffix = (p.protocol === 'http' && p.port === 80) ||
                       (p.protocol === 'https' && p.port === 443) ? '' : ':' + p.port;
      return p.protocol + '://' + p.host + portSuffix + href;
    }
    return this._pageURL.replace(/\/[^/]*$/, '/') + href;
  }

  private _goBack(): void {
    if (this._histIdx <= 0) return;
    this._histIdx--;
    this._load(this._history[this._histIdx].url);
  }

  private _goForward(): void {
    if (this._histIdx >= this._history.length - 1) return;
    this._histIdx++;
    this._load(this._history[this._histIdx].url);
  }

  private _reload(): void {
    this._load(this._pageURL);
  }

  private _scrollBy(delta: number): void {
    this._scrollY = Math.max(0, Math.min(this._maxScrollY, this._scrollY + delta));
    this._dirty = true;
  }

  private _hitTestLink(x: number, cy: number): string {
    for (var i = 0; i < this._lines.length; i++) {
      var line = this._lines[i];
      if (cy >= line.y && cy < line.y + line.lineH) {
        for (var j = 0; j < line.nodes.length; j++) {
          var span = line.nodes[j];
          if (span.href && x >= span.x && x <= span.x + span.text.length * CHAR_W) {
            return span.href;
          }
        }
      }
    }
    return '';
  }

  // ── HTTP fetch + layout ───────────────────────────────────────────────────

  private _load(rawURL: string): void {
    this._pageURL    = rawURL;
    this._urlInput   = rawURL;
    this._loading    = true;
    this._scrollY    = 0;
    this._hoverHref  = '';
    this._status     = 'Loading...';
    this._dirty      = true;

    if (this._histIdx >= 0 && this._histIdx < this._history.length) {
      this._history[this._histIdx].url = rawURL;
    }

    var parsed = parseURL(rawURL);
    if (!parsed) { this._showError(rawURL, 'Invalid URL'); return; }

    // Built-in pages
    if (parsed.protocol === 'about') {
      var html = '';
      switch (parsed.path) {
        case 'blank':   html = ''; break;
        case 'jsos':    html = aboutJsosHTML(); break;
        case 'history': html = this._historyHTML(); break;
        default:        html = errorHTML(rawURL, 'Unknown about: page'); break;
      }
      this._showHTML(html, parsed.path, rawURL);
      return;
    }

    // DNS
    this._status = 'Resolving ' + parsed.host + '...';
    this._dirty  = true;

    var ip: string | null = null;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(parsed.host)) {
      ip = parsed.host;
    } else {
      try { ip = dnsResolve(parsed.host); } catch (_e) { ip = null; }
    }

    if (!ip) {
      this._showError(rawURL, 'DNS lookup failed for ' + parsed.host);
      return;
    }

    kernel.serialPut('[browser] ' + parsed.host + ' -> ' + ip + '\n');
    this._status = 'Connecting to ' + ip + '...';
    this._dirty  = true;

    // Fetch
    var resp: import('../net/http.js').HttpResponse | null = null;
    try {
      if (parsed.protocol === 'https') {
        var tlsResult = httpsGet(parsed.host, ip, parsed.port, parsed.path);
        if (!tlsResult.tlsOk) kernel.serialPut('[browser] TLS handshake failed\n');
        resp = tlsResult.response;
      } else {
        resp = httpGet(parsed.host, ip, parsed.port, parsed.path);
      }
    } catch (_e2) { resp = null; }

    if (!resp) {
      this._showError(rawURL, 'Connection failed: ' + ip + ':' + parsed.port);
      return;
    }

    kernel.serialPut('[browser] HTTP ' + resp.status + ' ' + resp.body.length + 'B\n');

    // Follow 3xx redirects (up to 5 hops)
    if (resp.status >= 300 && resp.status < 400) {
      var loc = resp.headers.get('location') || '';
      if (loc && this._redirectDepth < 5) {
        this._redirectDepth++;
        kernel.serialPut('[browser] redirect ' + this._redirectDepth + ' -> ' + loc + '\n');
        this._load(this._resolveHref(loc));
        return;
      } else if (loc) {
        this._showError(rawURL, 'Too many redirects'); return;
      }
    }

    if (resp.status < 200 || resp.status >= 400) {
      this._showError(rawURL, 'HTTP ' + resp.status + ' error'); return;
    }

    // Decode body
    var bodyStr = '';
    for (var bi = 0; bi < resp.body.length; bi++) {
      bodyStr += String.fromCharCode(resp.body[bi] & 0x7f);
    }

    var ct = resp.headers.get('content-type') || 'text/html';
    if (ct.indexOf('text/html') >= 0 || ct.indexOf('application/xhtml') >= 0) {
      this._showHTML(bodyStr, '', rawURL);
    } else {
      this._showPlainText(bodyStr, rawURL);
    }
    this._status = 'HTTP ' + resp.status + '  ' + ip;
  }

  private _showHTML(html: string, fallbackTitle: string, url: string): void {
    var r = parseHTML(html);
    this._layoutPage(r.nodes, r.title || fallbackTitle || url, url);
  }

  private _showPlainText(text: string, url: string): void {
    var nodes: RenderNode[] = text.split('\n').map(l => ({ type: 'pre' as NodeType, text: l, pre: true }));
    this._layoutPage(nodes, url, url);
  }

  private _showError(url: string, reason: string): void {
    kernel.serialPut('[browser] error: ' + reason + '\n');
    var r = parseHTML(errorHTML(url, reason));
    this._layoutPage(r.nodes, 'Error', url);
    this._status = reason;
  }

  private _layoutPage(nodes: RenderNode[], title: string, url: string): void {
    this._loading   = false;
    this._pageTitle = title;
    this._pageURL   = url;
    this._urlInput  = url;
    this._scrollY   = 0;

    var w       = this._win ? this._win.canvas.width : 800;
    this._lines = layoutNodes(nodes, w);

    var contentH = this._win ? this._win.canvas.height - TOOLBAR_H - STATUSBAR_H : 600;
    var last     = this._lines[this._lines.length - 1];
    var totalH   = last ? last.y + last.lineH + CONTENT_PAD : 0;
    this._maxScrollY = Math.max(0, totalH - contentH);

    if (this._histIdx >= 0 && this._histIdx < this._history.length) {
      this._history[this._histIdx].title = title;
    }
    this._dirty = true;
  }

  private _historyHTML(): string {
    if (!this._history.length) return '<h1>History</h1><p>No pages visited yet.</p>';
    var lines = ['<h1>Browsing History</h1><ul>'];
    for (var i = this._history.length - 1; i >= 0; i--) {
      var e = this._history[i];
      lines.push('<li><a href="' + e.url + '">' + (e.title || e.url) + '</a></li>');
    }
    lines.push('</ul>');
    return lines.join('\n');
  }
}

export const browserApp = new BrowserApp();
