/**
 * JSOS Browser — Native TypeScript HTML browser
 *
 * Source is split into focused modules:
 *   constants.ts  — layout/color/widget constants
 *   types.ts      — all TypeScript interfaces
 *   css.ts        — CSS color + inline-style parsing
 *   utils.ts      — URL parsing, encoding, BMP/PNG decode, base64
 *   html.ts       — HTML tokeniser + parser (with CSS support)
 *   layout.ts     — flowSpans word-wrap + layoutNodes block engine
 *   pages.ts      — about: page generators, JSON viewer
 *   index.ts      — BrowserApp class (this file)
 */

import {
  os, Canvas, pumpCursor,
  type App, type WMWindow, type KeyEvent, type MouseEvent, type FetchResponse,
} from '../../core/sdk.js';

import {
  TOOLBAR_H, STATUSBAR_H, FINDBAR_H, CHAR_W, CHAR_H, LINE_H, CONTENT_PAD, TAB_BAR_H,
  CLR_TOOLBAR_BG, CLR_TOOLBAR_BD, CLR_STATUS_BG, CLR_STATUS_TXT,
  CLR_URL_BG, CLR_URL_FOCUS, CLR_BTN_BG, CLR_BTN_TXT, CLR_BODY, CLR_BG,
  CLR_LINK, CLR_LINK_HOV, CLR_VISITED, CLR_HR, CLR_INPUT_BD, CLR_INPUT_BG,
  CLR_INPUT_TXT, CLR_INPUT_FOCUS, CLR_BTN_SUB_BG, CLR_BTN_SUB_TXT,
  CLR_BTN_RST_BG, CLR_CHECK_FILL, CLR_IMG_PH_BG, CLR_IMG_PH_BD, CLR_IMG_PH_TXT,
  CLR_SEL_BG, CLR_SEL_ARROW, CLR_FIND_BG, CLR_FIND_MATCH, CLR_FIND_CUR,
  CLR_FIND_TXT, CLR_FIND_BD, CLR_CODE_BG, CLR_MARK_BG, CLR_PRE_BG,
  CLR_QUOTE_BAR, CLR_QUOTE_BG, CLR_DEL, WIDGET_INPUT_H, WIDGET_BTN_H,
  WIDGET_CHECK_SZ, WIDGET_SELECT_H,
} from './constants.js';

import type {
  HistoryEntry, PositionedWidget, FormState, DecodedImage,
  RenderedLine, RenderedSpan,
} from './types.js';

import { parseURL, urlEncode, encodeFormData, decodeBMP, readPNGDimensions, decodeBase64 } from './utils.js';
import { parseHTML, parseHTMLFromTokens, tokenise } from './html.js';
import { parseStylesheet, buildSheetIndex, type CSSRule, type RuleIndex, resetCSSVars, setViewport, flushCSSMatchCache, getCSSMatchCacheStats } from './stylesheet.js';
import { decodePNG }    from './img-png.js';
import { decodeJPEG }   from './img-jpeg.js';
import { layoutNodes }  from './layout.js';
import { aboutJsosHTML, aboutJstestHTML, errorHTML, jsonViewerHTML } from './pages.js';
import { createPageJS, getBlobURLContent, type PageJS } from './jsruntime.js';
import { JITBrowserEngine } from './jit-browser.js';
import { flushAllCaches } from './cache.js';
import { renderGradientCSS } from './gradient.js';
import { parseCSP, type CSPPolicy } from './csp.js';
import { TileRenderer, textAtlas } from './render.js';

// ── Box-shadow parser ─────────────────────────────────────────────────────────
interface _BoxShadowLayer {
  offsetX: number; offsetY: number; blur: number; spread: number;
  color: number;   // ARGB
  inset: boolean;
}
var _boxShadowCache = new Map<string, _BoxShadowLayer[]>();
function _parseBoxShadow(css: string): _BoxShadowLayer[] {
  var cached = _boxShadowCache.get(css);
  if (cached) return cached;
  var out: _BoxShadowLayer[] = [];
  // Split on commas that are NOT inside parens (e.g. rgb(…))
  var parts: string[] = [];
  var depth = 0, cur = '';
  for (var _ci = 0; _ci < css.length; _ci++) {
    var _ch = css[_ci];
    if      (_ch === '(') { depth++; cur += _ch; }
    else if (_ch === ')') { depth--; cur += _ch; }
    else if (_ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; }
    else cur += _ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  for (var _pi = 0; _pi < parts.length; _pi++) {
    var p = parts[_pi].trim();
    var inset = false;
    if (p.startsWith('inset ')) { inset = true; p = p.slice(6).trim(); }
    // Extract colour: anything starting with # or rgb/rgba/hsl or a named colour
    var colorVal = 0xFF000000; // default black opaque
    // Try to strip a trailing colour token or a leading one
    p = p.replace(/(?:rgba?\([^)]+\)|hsla?\([^)]+\)|#[0-9a-fA-F]+|transparent)/g, (m) => {
      // Parse colour
      if (m === 'transparent') { colorVal = 0x00000000; return ''; }
      if (m.startsWith('#')) {
        var hex = m.slice(1);
        if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
        if (hex.length === 6) colorVal = 0xFF000000 | parseInt(hex, 16);
        else if (hex.length === 8) {
          // CSS #RRGGBBAA
          var _rr = parseInt(hex.slice(0,2), 16);
          var _gg = parseInt(hex.slice(2,4), 16);
          var _bb = parseInt(hex.slice(4,6), 16);
          var _aa = parseInt(hex.slice(6,8), 16);
          colorVal = (_aa << 24) | (_rr << 16) | (_gg << 8) | _bb;
        }
      } else if (m.startsWith('rgb')) {
        var nums = m.match(/[\d.]+/g) || [];
        var _r2 = parseInt(nums[0]||'0');
        var _g2 = parseInt(nums[1]||'0');
        var _b2 = parseInt(nums[2]||'0');
        var _a2 = nums[3] !== undefined ? Math.round(parseFloat(nums[3]) * 255) : 255;
        colorVal = (_a2 << 24) | (_r2 << 16) | (_g2 << 8) | _b2;
      }
      return '';
    });
    // Remaining tokens should be length values
    var lens = p.trim().split(/\s+/).filter(s => s.length > 0);
    var offsetX = parseFloat(lens[0] || '0');
    var offsetY = parseFloat(lens[1] || '0');
    var blur    = parseFloat(lens[2] || '0');
    var spread  = parseFloat(lens[3] || '0');
    out.push({ offsetX, offsetY, blur, spread, color: colorVal, inset });
  }
  _boxShadowCache.set(css, out);
  return out;
}

// ── TabState — per-tab browseable snapshot ────────────────────────────────────

interface TabState {
  url:           string;
  title:         string;
  history:       HistoryEntry[];
  histIdx:       number;
  pageLines:     RenderedLine[];
  widgets:       PositionedWidget[];
  scrollY:       number;
  maxScrollY:    number;
  loading:       boolean;
  status:        string;
  hoverHref:     string;
  forms:         FormState[];
  focusedWidget: number;
  imgCache:      Map<string, DecodedImage | null>;
  imgsFetching:  boolean;
  pageJS:        PageJS | null;
  jsStartMs:     number;
  pageSource:    string;
  pageBaseURL:   string;
  // Favicon (item 628)
  favicon?:        string;
  faviconData?:    Uint32Array | null;
  faviconW?:       number;
  faviconH?:       number;
  faviconScaled?:  Uint32Array;   // 8×8 pre-scaled favicon for per-frame blit (computed once)
  // Background image map: URL → decoded pixels (item 386)
  bgImageMap:    Map<string, DecodedImage | null>;
}

// ── BrowserApp ────────────────────────────────────────────────────────────────

export class BrowserApp implements App {
  readonly name = 'Browser';

  private _win:           WMWindow | null = null;
  private _urlInput       = 'about:jsos';
  private _urlBarFocus    = true;
  private _urlCursorPos   = 0;
  private _urlScrollOff   = 0;
  private _urlAllSelected = false;
  private _cursorBlink    = 0;
  private _hoverBtn       = -1;

  private _history:       HistoryEntry[] = [];
  private _histIdx        = -1;
  private _visited        = new Set<string>();
  private _bookmarks:     HistoryEntry[] = [];

  private _pageTitle   = 'JSOS Browser';
  private _pageURL     = 'about:jsos';
  private _pageSource  = '';
  private _pageBaseURL = '';    // from <base href> in current page
  private _pageLines:  RenderedLine[] = [];
  /** Cached indices of sticky-positioned lines (avoids O(n) scan per frame). */
  private _stickyIndices: number[] = [];
  private _scrollY     = 0;
  private _maxScrollY  = 0;
  private _loading     = false;
  private _status      = '';
  private _dirty       = true;
  private _damage: { x: number; y: number; w: number; h: number } | null = null;  // item 2.4

  // ── Tile-dirty render cache (Phase 3) ──────────────────────────────────────
  /** TileRenderer for background content layer (64×64 tile grid). */
  private _tileRenderer: TileRenderer | null = null;
  private _tileVpW = 0;
  private _tileVpH = 0;
  /** Monotonic counter bumped whenever _pageLines is replaced. */
  private _contentVersion  = 0;
  /** _contentVersion at the time _tileRenderer last painted. */
  private _tileContentVer  = -1;
  /** _scrollY at the time _tileRenderer last painted. */
  private _tileScrollY     = -9999;

  private _hoverHref   = '';
  private _hoverElId   = '';  // JS-element currently under the mouse pointer
  private _focusedWidgetName = '';  // name of currently JS-focused widget for blur tracking;

  // Form / widget state
  private _forms:         FormState[]         = [];
  private _widgets:       PositionedWidget[]  = [];
  private _focusedWidget  = -1;

  // Image cache: maps src URL → decoded image (null = fetch failed / unsupported)
  private _imgCache    = new Map<string, DecodedImage | null>();
  private _imgsFetching = false;
  // Background-image cache: URL → decoded (item 386)
  private _bgImageMap  = new Map<string, DecodedImage | null>();
  // Cached tiled background-image buffers keyed by 'url:w:h'
  private _bgTileCache = new Map<string, Uint32Array>();
  // Reusable RGBA→BGRA canvas pixel buffer
  private _canvasPixelBuf: Uint32Array | null = null;
  // External CSS cache: URL → parsed CSSRule[] (avoids re-fetch on same-site navigation)
  private _cssCache    = new Map<string, CSSRule[]>();
  // Inline style cache: joined <style> text → parsed CSSRule[] (avoids re-parsing same inline CSS)
  private _inlineStyleCache = new Map<string, CSSRule[]>();

  // Find in page
  private _findMode  = false;
  private _findQuery = '';
  private _findHits: Array<{ lineIdx: number; spanIdx: number }> = [];
  private _findCur   = 0;

  // Scrollbar drag
  private _scrollbarDragging = false;

  // Async fetch coroutine id
  private _fetchCoroId = -1;

  // URL bar autocomplete (item 632)
  private _urlSuggestions: HistoryEntry[] = [];
  private _urlSuggestIdx  = -1;  // -1 = none selected; 0..n-1 = highlighted row

  // Reader mode (item 634)
  private _readerMode     = false;

  // JavaScript runtime for the current page (null if page has no scripts)
  private _pageJS: PageJS | null = null;
  private _jsStartMs = 0;
  // Content Security Policy for the current page (null if no CSP header)
  private _cspPolicy: CSPPolicy | null = null;

  // ── Tabs ───────────────────────────────────────────────────────────────────
  private _tabs:    TabState[] = [];
  private _curTab   = 0;

  private _makeBlankTab(url: string): TabState {
    return {
      url, title: url, history: [{ url, title: url }], histIdx: 0,
      pageLines: [], widgets: [], scrollY: 0, maxScrollY: 0,
      loading: false, status: '', hoverHref: '', forms: [],
      focusedWidget: -1, imgCache: new Map(), imgsFetching: false,
      pageJS: null, jsStartMs: 0, pageSource: '', pageBaseURL: '',
      bgImageMap: new Map(),
    };
  }

  private _saveTab(): void {
    if (!this._tabs.length) return;
    this._tabs[this._curTab] = {
      url: this._pageURL, title: this._pageTitle,
      history: this._history, histIdx: this._histIdx,
      pageLines: this._pageLines, widgets: this._widgets,
      scrollY: this._scrollY, maxScrollY: this._maxScrollY,
      loading: this._loading, status: this._status,
      hoverHref: this._hoverHref, forms: this._forms,
      focusedWidget: this._focusedWidget,
      imgCache: this._imgCache, imgsFetching: this._imgsFetching,
      pageJS: this._pageJS, jsStartMs: this._jsStartMs,
      pageSource: this._pageSource, pageBaseURL: this._pageBaseURL,
      favicon: this._tabs[this._curTab]?.favicon,
      faviconData: this._tabs[this._curTab]?.faviconData,
      faviconW: this._tabs[this._curTab]?.faviconW,
      faviconH: this._tabs[this._curTab]?.faviconH,
      bgImageMap: this._bgImageMap,
    };
  }

  private _loadTab(idx: number): void {
    var t = this._tabs[idx];
    this._pageURL = t.url; this._pageTitle = t.title;
    this._history = t.history; this._histIdx = t.histIdx;
    this._pageLines = t.pageLines; this._widgets = t.widgets;
    this._rebuildStickyIndex();
    this._contentVersion++;          // Phase 3: invalidate tile cache on tab switch
    this._scrollY = t.scrollY; this._maxScrollY = t.maxScrollY;
    this._loading = t.loading; this._status = t.status;
    this._hoverHref = t.hoverHref; this._forms = t.forms;
    this._focusedWidget = t.focusedWidget;
    this._imgCache = t.imgCache; this._imgsFetching = t.imgsFetching;
    this._pageJS = t.pageJS; this._jsStartMs = t.jsStartMs;
    this._pageSource = t.pageSource; this._pageBaseURL = t.pageBaseURL;
    this._bgImageMap = t.bgImageMap ?? new Map();
  }

  private _newTabAction(url = 'about:blank'): void {
    if (this._tabs.length >= 8) return;  // max 8 tabs
    this._saveTab();
    this._tabs.push(this._makeBlankTab(url));
    this._curTab = this._tabs.length - 1;
    this._loadTab(this._curTab);
    this._navigate(url);
    this._dirty = true;
  }

  private _switchTabAction(idx: number): void {
    if (idx < 0 || idx >= this._tabs.length || idx === this._curTab) return;
    this._saveTab();
    this._curTab = idx;
    this._loadTab(idx);
    this._dirty = true;
  }

  private _closeTabAction(idx: number): void {
    if (this._tabs.length <= 1) return;
    if (this._tabs[idx]?.pageJS) { this._tabs[idx]!.pageJS!.dispose(); }
    this._tabs.splice(idx, 1);
    if (this._curTab >= this._tabs.length) this._curTab = this._tabs.length - 1;
    this._loadTab(this._curTab);
    this._dirty = true;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  onMount(win: WMWindow): void {
    os.debug.log('[browser] onMount start');
    this._win = win;
    // Phase 3.2: pre-warm glyph atlas so TileRenderer has fast char lookup on first paint.
    if (!textAtlas.ready) textAtlas.init(CHAR_W, CHAR_H);
    // Start with a blank page; user can navigate to any URL via the address bar
    var _startURL = 'about:blank';
    this._tabs = [this._makeBlankTab(_startURL)];
    this._curTab = 0;
    this._loadTab(0);
    this._navigate(_startURL);
    os.debug.log('[browser] onMount done');
  }

  onUnmount(): void {
    for (var ti = 0; ti < this._tabs.length; ti++) {
      if (this._tabs[ti].pageJS) this._tabs[ti].pageJS!.dispose();
    }
    if (this._pageJS) { this._pageJS.dispose(); this._pageJS = null; }
    this._win = null;
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  onKey(event: KeyEvent): void {
    var ch  = event.ch;
    var ext = event.ext;

    // Find bar
    if (this._findMode) {
      if (ch === '\x1b') { this._clearFind(); return; }
      if (ch === '\n' || ch === '\r') { this._cycleFind(1); return; }
      if (ch === 'n') { this._cycleFind(1);  return; }
      if (ch === 'N') { this._cycleFind(-1); return; }
      if (ch === '\b') { this._findQuery = this._findQuery.slice(0, -1); }
      else if (ch >= ' ') { this._findQuery += ch; }
      this._doFind(); this._dirty = true; return;
    }

    // Focused form widget
    if (this._focusedWidget >= 0) {
      var fw = this._widgets[this._focusedWidget];
      if (fw && this._handleWidgetKey(fw, ch, ext)) return;
    }

    // URL bar
    if (this._urlBarFocus) {
      if (ch === '\x0c') {
        this._urlInput = ''; this._urlCursorPos = 0; this._urlScrollOff = 0;
        this._urlAllSelected = false; this._urlSuggestions = []; this._urlSuggestIdx = -1;
        this._dirty = true; return;
      }
      if (ch === '\n' || ch === '\r') {
        this._urlAllSelected = false;
        // If a suggestion is selected, navigate to it (item 632)
        if (this._urlSuggestIdx >= 0 && this._urlSuggestIdx < this._urlSuggestions.length) {
          var sugUrl = this._urlSuggestions[this._urlSuggestIdx]!.url;
          this._urlSuggestions = []; this._urlSuggestIdx = -1;
          this._urlBarFocus = false;
          this._navigate(sugUrl);
          return;
        }
        var raw = this._urlInput.trim();
        this._urlSuggestions = []; this._urlSuggestIdx = -1;
        if (raw) { this._urlBarFocus = false; this._navigate(raw); }
        return;
      }
      if (ch === '\x1b') {
        this._urlBarFocus = false; this._urlAllSelected = false;
        this._urlSuggestions = []; this._urlSuggestIdx = -1;
        this._dirty = true; return;
      }
      if (ext) {
        this._urlAllSelected = false;
        if (ext === 0x48) {
          // Up arrow — move suggestion selection up (item 632)
          if (this._urlSuggestions.length > 0) {
            this._urlSuggestIdx = this._urlSuggestIdx <= 0
              ? this._urlSuggestions.length - 1
              : this._urlSuggestIdx - 1;
            this._urlInput = this._urlSuggestions[this._urlSuggestIdx]!.url;
            this._urlCursorPos = this._urlInput.length;
            this._dirty = true; return;
          }
        } else if (ext === 0x50) {
          // Down arrow — move suggestion selection down (item 632)
          if (this._urlSuggestions.length > 0) {
            this._urlSuggestIdx = this._urlSuggestIdx >= this._urlSuggestions.length - 1
              ? 0
              : this._urlSuggestIdx + 1;
            this._urlInput = this._urlSuggestions[this._urlSuggestIdx]!.url;
            this._urlCursorPos = this._urlInput.length;
            this._dirty = true; return;
          }
        } else if (ext === 0x4B) { this._urlCursorPos = Math.max(0, this._urlCursorPos - 1); }
        else if (ext === 0x4D) { this._urlCursorPos = Math.min(this._urlInput.length, this._urlCursorPos + 1); }
        else if (ext === 0x47) { this._urlCursorPos = 0; this._urlScrollOff = 0; }
        else if (ext === 0x4F) { this._urlCursorPos = this._urlInput.length; }
        this._dirty = true; return;
      }
      if (ch === '\b') {
        if (this._urlAllSelected) {
          this._urlInput = ''; this._urlCursorPos = 0;
          this._urlScrollOff = 0; this._urlAllSelected = false;
        } else if (this._urlCursorPos > 0) {
          this._urlInput = this._urlInput.slice(0, this._urlCursorPos - 1) +
                           this._urlInput.slice(this._urlCursorPos);
          this._urlCursorPos--;
          this._urlScrollOff = Math.min(this._urlScrollOff, this._urlCursorPos);
        }
        this._urlSuggestIdx = -1;
        this._urlSuggestions = this._computeURLSuggestions(this._urlInput);
        this._dirty = true; return;
      }
      if (ch >= ' ') {
        if (this._urlAllSelected) {
          this._urlInput = ch; this._urlCursorPos = 1;
          this._urlScrollOff = 0; this._urlAllSelected = false;
        } else {
          this._urlInput = this._urlInput.slice(0, this._urlCursorPos) + ch +
                           this._urlInput.slice(this._urlCursorPos);
          this._urlCursorPos++;
        }
        this._urlSuggestIdx = -1;
        this._urlSuggestions = this._computeURLSuggestions(this._urlInput);
        this._dirty = true; return;
      }
      return;
    }

    // Tab — cycle form widgets
    if (ch === '\t') { this._cycleFocusedWidget(1); return; }

    // Scroll / navigate
    if (ext) {
      if (ext === 0x48) { this._scrollBy(-LINE_H * 3);        return; }
      if (ext === 0x50) { this._scrollBy( LINE_H * 3);        return; }
      if (ext === 0x4B) { this._goBack();                      return; }
      if (ext === 0x4D) { this._goForward();                   return; }
      if (ext === 0x49) { this._scrollBy(-this._contentH());   return; }
      if (ext === 0x51) { this._scrollBy( this._contentH());   return; }
      if (ext === 0x47) { this._scrollBy(-this._maxScrollY);   return; }
      if (ext === 0x4F) { this._scrollBy( this._maxScrollY);   return; }
    }

    if (ch === '\x0c') {
      this._urlBarFocus = true; this._urlInput = this._pageURL;
      this._urlCursorPos = this._urlInput.length; this._urlScrollOff = 0;
      this._urlAllSelected = true; this._dirty = true; return;
    }
    if (ch === '\x12') { this._reload(); return; }
    if (ch === '\x04') { this._addBookmark(); return; }
    if (ch === '\x06') { this._openFind(); return; }
    if (ch === '\x14') { this._newTabAction(); return; }                     // Ctrl+T
    if (ch === '\x17') { this._closeTabAction(this._curTab); return; }       // Ctrl+W
    if (ch === '\x09' && event.ctrl) {                                       // Ctrl+Tab
      this._switchTabAction((this._curTab + 1) % this._tabs.length); return;
    }

    if (ch === ' ')           { this._scrollBy(this._contentH()); return; }
    if (ch === 'b' || ch === 'B') { this._goBack();    return; }
    if (ch === 'f' || ch === 'F') { this._goForward(); return; }
    if (ch === 'r') { this._reload();     return; }
    if (ch === 'R') { this._hardReload(); return; }  // Shift+R = hard reload (item 624)
    if (ch === '/' || ch === 'l') {
      this._urlBarFocus = true; this._urlInput = this._pageURL;
      this._urlCursorPos = this._urlInput.length; this._urlScrollOff = 0;
      this._urlAllSelected = true; this._dirty = true; return;
    }
  }

  onMouse(event: MouseEvent): void {
    if (!this._win) return;

    var contentY0 = TAB_BAR_H + TOOLBAR_H;
    var contentY1 = this._win.height - STATUSBAR_H - (this._findMode ? FINDBAR_H : 0);
    var sbX       = this._win.width - 12;

    // Tab bar click handling
    if (event.type === 'down' && event.y >= 0 && event.y < TAB_BAR_H) {
      var nTabs = this._tabs.length;
      var newBtnW = 22;
      var tabAreaW = (this._win?.width || 800) - newBtnW;
      var tabW = nTabs > 0 ? Math.min(160, Math.max(60, Math.floor(tabAreaW / nTabs))) : tabAreaW;
      var clickedTab = Math.floor(event.x / tabW);
      if (clickedTab >= 0 && clickedTab < nTabs) {
        var clsX = clickedTab * tabW + tabW - 14;
        if (event.x >= clsX && event.x < clsX + 10) {
          this._closeTabAction(clickedTab); return;
        }
        this._switchTabAction(clickedTab); return;
      }
      // New tab button
      if (event.x >= nTabs * tabW) { this._newTabAction(); return; }
      return;
    }

    // Toolbar hover
    if (event.y >= TAB_BAR_H + 5 && event.y <= TAB_BAR_H + 24) {
      var hb = -1;
      if      (event.x >= 4  && event.x <= 25) hb = 0;
      else if (event.x >= 28 && event.x <= 49) hb = 1;
      else if (event.x >= 52 && event.x <= 73) hb = 2;
      if (hb !== this._hoverBtn) { this._hoverBtn = hb; this._dirty = true; }
    } else if (this._hoverBtn !== -1) {
      this._hoverBtn = -1; this._dirty = true;
    }

    // Scrollbar drag
    if (event.type === 'up') this._scrollbarDragging = false;
    if (this._scrollbarDragging && event.type === 'move') {
      var chh0  = contentY1 - contentY0;
      var frac0 = (event.y - contentY0) / chh0;
      this._scrollY = Math.round(frac0 * this._maxScrollY);
      this._scrollY = Math.max(0, Math.min(this._maxScrollY, this._scrollY));
      this._dirty = true; return;
    }

    if (event.type === 'down') {
      // Toolbar buttons
      if (event.y >= TAB_BAR_H + 5 && event.y <= TAB_BAR_H + 24) {
        if (event.x >= 4  && event.x <= 25) { this._goBack();    return; }
        if (event.x >= 28 && event.x <= 49) { this._goForward(); return; }
        if (event.x >= 52 && event.x <= 73) { this._reload();    return; }
        var winW = this._win!.width;
        // Print button (item 635)
        if (event.x >= winW - 56 && event.x < winW - 28) { this._printPage(); return; }
        // Reader mode button (item 634)
        if (event.x >= winW - 28) { this._toggleReaderMode(); return; }
        if (event.x > 76) {
          var urlX  = 76;
          var urlW  = winW - urlX - 56 - 4;
          var maxCh = Math.max(1, Math.floor((urlW - 8) / CHAR_W));
          this._urlInput       = this._pageURL;
          this._urlBarFocus    = true;
          this._urlAllSelected = true;
          this._urlCursorPos   = this._urlInput.length;
          this._urlScrollOff   = Math.max(0, this._urlInput.length - maxCh);
          // Check if click landed on an autocomplete suggestion row (item 632)
          var dropY = TAB_BAR_H + TOOLBAR_H;
          if (this._urlSuggestions.length > 0 && event.y >= dropY) {
            var rowH  = LINE_H + 4;
            var relY  = event.y - dropY;
            var rcIdx = Math.floor(relY / rowH);
            if (rcIdx >= 0 && rcIdx < this._urlSuggestions.length) {
              var sugEntry = this._urlSuggestions[rcIdx]!;
              this._urlSuggestions = []; this._urlSuggestIdx = -1;
              this._urlBarFocus = false;
              this._navigate(sugEntry.url);
              return;
            }
          }
          this._urlSuggestIdx = -1;
          this._urlSuggestions = this._computeURLSuggestions(this._urlInput);
          this._dirty = true; return;
        }
      }

      // Scrollbar click
      if (this._maxScrollY > 0 && event.x >= sbX &&
          event.y >= contentY0 && event.y < contentY1) {
        this._scrollbarDragging = true;
        var chh  = contentY1 - contentY0;
        var frac = (event.y - contentY0) / chh;
        this._scrollY = Math.round(frac * this._maxScrollY);
        this._scrollY = Math.max(0, Math.min(this._maxScrollY, this._scrollY));
        this._dirty = true; return;
      }

      if (event.y >= contentY0 && event.y < contentY1) {
        var cy = event.y - contentY0 + this._scrollY;
        var cx = event.x;

        var widgetIdx = this._hitTestWidget(cx, cy);
        if (widgetIdx >= 0) { this._handleWidgetClick(widgetIdx, cx, cy); return; }

        var hitSpan = this._hitTestLinkFull(cx, cy);  // item 636: use full span for download info
        if (hitSpan && hitSpan.href) {
          if (hitSpan.download) {
            // <a download> — save resource to disk instead of navigating (item 636)
            this._urlBarFocus = false;
            this._downloadURL(hitSpan.href, hitSpan.download);
            return;
          }
          var resolved = this._resolveHref(hitSpan.href);
          this._visited.add(resolved);
          this._urlBarFocus = false;
          this._navigate(resolved);
          return;
        }
        // Dispatch JS click for spans that belong to an element with a click handler.
        // Use _hitTestAnySpan to find elId-only spans that _hitTestLinkFull skips.
        var hitAny = hitSpan || this._hitTestAnySpan(cx, cy);
        if (hitAny && hitAny.elId) {
          if (this._pageJS) this._pageJS.fireClick(hitAny.elId);
          return;
        }

        if (this._focusedWidget >= 0) {
          // Fire blur on whatever had focus before clicking blank canvas.
          var blurWp = this._widgets[this._focusedWidget];
          if (blurWp && blurWp.name && this._pageJS) { this._pageJS.fireBlur(blurWp.name); this._focusedWidgetName = ''; }
          this._focusedWidget = -1; this._dirty = true;
        }
        if (this._urlBarFocus) {
          this._urlBarFocus = false; this._urlAllSelected = false;
          this._urlSuggestions = []; this._urlSuggestIdx = -1;
          this._dirty = true;
        } else {
          this._dirty = true;
        }
      }
    }

    // Hover — update hoverHref / hoverElId, set CSS cursor (items 415/416)
    if (event.y >= contentY0 && event.y < contentY1) {
      var cy2  = event.y - contentY0 + this._scrollY;
      var newH = this._hitTestLink(event.x, cy2);
      if (newH !== this._hoverHref) {
        this._hoverHref = newH;
        os.wm.setCursor(newH ? 'pointer' : 'default');
        this._dirty = true;
      }
      // Fire mouseover/mouseenter/mouseleave for JS-bound elements under cursor.
      var hoverSpan2 = !newH ? this._hitTestAnySpan(event.x, cy2) : null;
      var newElId    = hoverSpan2?.elId || '';
      if (newElId !== this._hoverElId) {
        if (this._hoverElId && this._pageJS) {
          this._pageJS.fireMouse(this._hoverElId, 'mouseleave');
          this._pageJS.fireMouse(this._hoverElId, 'mouseout');
        }
        this._hoverElId = newElId;
        if (newElId && this._pageJS) {
          this._pageJS.fireMouse(newElId, 'mouseover');
          this._pageJS.fireMouse(newElId, 'mouseenter');
        }
        if (!newH) os.wm.setCursor(newElId ? 'pointer' : 'default');
      }
    } else if (this._hoverHref || this._hoverElId) {
      this._hoverHref = '';
      if (this._hoverElId) {
        if (this._pageJS) { this._pageJS.fireMouse(this._hoverElId, 'mouseleave'); this._pageJS.fireMouse(this._hoverElId, 'mouseout'); }
        this._hoverElId = '';
      }
      os.wm.setCursor('default');
      this._dirty = true;
    }
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  // Per-frame logic tick — called by WM BEFORE composite, separate from render.
  // Drives JS timers, RAF, transitions, animations, child IPC — all the
  // expensive logic that doesn't need to happen inside the rendering pass.
  tick(): void {
    if (this._pageJS) {
      var nowMs = Date.now() - this._jsStartMs;
      this._pageJS.tick(nowMs);
    }
  }

  render(canvas: Canvas): boolean {
    // Cursor blink drives dirty only when URL bar / widget focused
    if (this._urlBarFocus || this._focusedWidget >= 0) {
      var prevPhase = (this._cursorBlink >> 4) & 1;
      this._cursorBlink++;
      if (((this._cursorBlink >> 4) & 1) !== prevPhase) this._dirty = true;
    }
    if (!this._dirty) return false;
    this._dirty = false;

    this._drawTabBar(canvas);
    this._drawToolbar(canvas);
    this._drawContent(canvas);           // reads this._damage before clearing
    this._damage = null;                 // clear damage rect after content used it (item 2.4)
    this._drawStatusBar(canvas);
    if (this._findMode) this._drawFindBar(canvas);
    return true;
  }

  private _contentH(): number {
    if (!this._win) return 400;
    return this._win.height - TAB_BAR_H - TOOLBAR_H - STATUSBAR_H - (this._findMode ? FINDBAR_H : 0);
  }

  private _drawTabBar(canvas: Canvas): void {
    var w    = canvas.width;
    var nTabs = this._tabs.length;
    canvas.fillRect(0, 0, w, TAB_BAR_H, CLR_TOOLBAR_BG);
    canvas.drawLine(0, TAB_BAR_H - 1, w, TAB_BAR_H - 1, CLR_TOOLBAR_BD);

    var newBtnW = 22;
    var tabAreaW = w - newBtnW;
    var tabW = nTabs > 0 ? Math.min(160, Math.max(60, Math.floor(tabAreaW / nTabs))) : tabAreaW;

    for (var ti = 0; ti < nTabs; ti++) {
      var tx      = ti * tabW;
      var isAct   = ti === this._curTab;
      var tabBg   = isAct ? CLR_BG : CLR_TOOLBAR_BG;
      canvas.fillRect(tx, 1, tabW - 1, TAB_BAR_H - 1, tabBg);
      if (isAct) {
        // Active tab: erase bottom border to merge with content area
        canvas.fillRect(tx, TAB_BAR_H - 1, tabW - 1, 1, CLR_BG);
      }
      // Left border
      canvas.fillRect(tx, 1, 1, TAB_BAR_H - 2, CLR_TOOLBAR_BD);
      // Right border  
      canvas.fillRect(tx + tabW - 1, 1, 1, TAB_BAR_H - 2, CLR_TOOLBAR_BD);

      var t       = this._tabs[ti];
      var label   = t.loading ? 'Loading...' : (t.title || t.url || 'New Tab');
      var maxCh   = Math.max(1, Math.floor((tabW - 20) / CHAR_W));
      var display = label.length > maxCh ? label.slice(0, maxCh - 1) + '\u2026' : label;
      var txtClr  = isAct ? CLR_BTN_TXT : CLR_STATUS_TXT;

      // Draw favicon (item 628): 8×8 scaled icon before label text
      var labelX = tx + 4;
      if (t.faviconData && t.faviconW && t.faviconH) {
        var fSz = 8;
        // Cache the scaled 8×8 favicon once to avoid per-frame pixel-loop overhead
        if (!t.faviconScaled) {
          var _ftmp = new Uint32Array(fSz * fSz);
          for (var _fr = 0; _fr < fSz; _fr++) {
            for (var _fc = 0; _fc < fSz; _fc++) {
              var _fsr = Math.floor(_fr * t.faviconH! / fSz);
              var _fsc = Math.floor(_fc * t.faviconW! / fSz);
              _ftmp[_fr * fSz + _fc] = t.faviconData![_fsr * t.faviconW! + _fsc] ?? 0;
            }
          }
          t.faviconScaled = _ftmp;
        }
        canvas.blitPixelsDirect(t.faviconScaled, fSz, fSz, tx + 4, 5);
        labelX = tx + 4 + fSz + 3;
        maxCh  = Math.max(1, Math.floor((tabW - 20 - fSz - 3) / CHAR_W));
        display = label.length > maxCh ? label.slice(0, maxCh - 1) + '\u2026' : label;
      }
      canvas.drawText(labelX, 7, display, txtClr);

      // Close button (×)
      var clsX = tx + tabW - 14;
      canvas.drawText(clsX, 7, 'x', txtClr);
    }

    // New tab button (+)
    var ntx = nTabs * tabW;
    canvas.fillRect(ntx, 1, newBtnW, TAB_BAR_H - 2, CLR_TOOLBAR_BG);
    canvas.drawText(ntx + 6, 7, '+', CLR_BTN_TXT);
  }

  private _drawToolbar(canvas: Canvas): void {
    var w   = canvas.width;
    var tbY = TAB_BAR_H;  // toolbar top Y offset
    canvas.fillRect(0, tbY, w, TOOLBAR_H, CLR_TOOLBAR_BG);
    canvas.drawLine(0, tbY + TOOLBAR_H - 1, w, tbY + TOOLBAR_H - 1, CLR_TOOLBAR_BD);

    // Back button
    canvas.fillRect(4, tbY + 5, 22, 20, this._hoverBtn === 0 ? 0xFFC4C6CA : CLR_BTN_BG);
    canvas.drawText(10, tbY + 11, '<', this._histIdx > 0 ? CLR_BTN_TXT : CLR_HR);

    // Forward button
    canvas.fillRect(28, tbY + 5, 22, 20, this._hoverBtn === 1 ? 0xFFC4C6CA : CLR_BTN_BG);
    canvas.drawText(35, tbY + 11, '>', this._histIdx < this._history.length - 1 ? CLR_BTN_TXT : CLR_HR);

    // Reload/Stop button
    canvas.fillRect(52, tbY + 5, 22, 20, this._hoverBtn === 2 ? 0xFFC4C6CA : CLR_BTN_BG);
    canvas.drawText(58, tbY + 11, this._loading ? 'X' : 'R', CLR_BTN_TXT);

    // URL bar
    var urlX = 76;
    var pBtnW  = 28; // print button width (item 635)
    var rdBtnW = 28; // reader mode button width
    var urlW = w - urlX - pBtnW - rdBtnW - 4;
    canvas.fillRect(urlX, tbY + 5, urlW, 20, CLR_URL_BG);
    canvas.drawRect(urlX, tbY + 5, urlW, 20, this._urlBarFocus ? CLR_URL_FOCUS : CLR_TOOLBAR_BD);

    var display  = this._urlBarFocus ? this._urlInput : this._pageURL;
    var maxChars = Math.max(1, Math.floor((urlW - 8) / CHAR_W));

    if (this._urlBarFocus) {
      if (this._urlCursorPos < this._urlScrollOff) {
        this._urlScrollOff = this._urlCursorPos;
      } else if (this._urlCursorPos > this._urlScrollOff + maxChars) {
        this._urlScrollOff = this._urlCursorPos - maxChars;
      }
      var showTxt = display.slice(this._urlScrollOff, this._urlScrollOff + maxChars);
      if (this._urlAllSelected) {
        canvas.fillRect(urlX + 2, tbY + 7, urlW - 4, 16, CLR_URL_FOCUS);
        canvas.drawText(urlX + 4, tbY + 12, showTxt, 0xFFFFFFFF);
      } else {
        canvas.drawText(urlX + 4, tbY + 12, showTxt, CLR_BODY);
      }
      if ((this._cursorBlink >> 4) % 2 === 0) {
        var ccx = urlX + 4 + (this._urlCursorPos - this._urlScrollOff) * CHAR_W;
        if (ccx >= urlX + 2 && ccx <= urlX + urlW - 4) {
          canvas.fillRect(ccx, tbY + 10, 1, CHAR_H, this._urlAllSelected ? 0xFFFFFFFF : CLR_BODY);
        }
      }
    } else {
      var showTxt2 = display.length > maxChars ? display.slice(display.length - maxChars) : display;
      canvas.drawText(urlX + 4, tbY + 12, showTxt2, CLR_BODY);
    }

    // Autocomplete dropdown (item 632) — drawn below URL bar when suggestions are available
    if (this._urlBarFocus && this._urlSuggestions.length > 0) {
      var dropX  = urlX;
      var dropY  = tbY + TOOLBAR_H;   // just below the toolbar
      var dropW  = urlW;
      var rowH   = LINE_H + 4;
      var dropH  = rowH * this._urlSuggestions.length;
      // Background + border
      canvas.fillRect(dropX, dropY, dropW, dropH, CLR_URL_BG);
      canvas.drawRect(dropX, dropY, dropW, dropH, CLR_TOOLBAR_BD);
      for (var si = 0; si < this._urlSuggestions.length; si++) {
        var ry   = dropY + si * rowH;
        var sug  = this._urlSuggestions[si]!;
        var isHl = si === this._urlSuggestIdx;
        if (isHl) canvas.fillRect(dropX + 1, ry, dropW - 2, rowH - 1, CLR_URL_FOCUS);
        var hlClr = isHl ? 0xFFFFFFFF : CLR_BODY;
        // Show title + url (truncated)
        var sugLabel = sug.title ? sug.title + '  ' + sug.url : sug.url;
        var maxSugCh = Math.max(1, Math.floor((dropW - 8) / CHAR_W));
        if (sugLabel.length > maxSugCh) sugLabel = sugLabel.slice(0, maxSugCh - 1) + '\u2026';
        canvas.drawText(dropX + 4, ry + 4, sugLabel, hlClr);
      }
    }

    // Print button (item 635)
    var ptX  = w - pBtnW - rdBtnW;
    canvas.fillRect(ptX, tbY + 5, pBtnW - 2, 20, CLR_BTN_BG);
    canvas.drawRect(ptX, tbY + 5, pBtnW - 2, 20, CLR_TOOLBAR_BD);
    canvas.drawText(ptX + 4, tbY + 11, 'Pt', CLR_BTN_TXT);

    // Reader mode button (item 634) — toggles reader view
    var rdX   = w - rdBtnW;
    var rdBg  = this._readerMode ? CLR_URL_FOCUS : CLR_BTN_BG;
    var rdClr = this._readerMode ? 0xFFFFFFFF    : CLR_BTN_TXT;
    canvas.fillRect(rdX, tbY + 5, rdBtnW - 2, 20, rdBg);
    canvas.drawRect(rdX, tbY + 5, rdBtnW - 2, 20, CLR_TOOLBAR_BD);
    canvas.drawText(rdX + 4, tbY + 11, 'Rd', rdClr);
  }

  private _drawContent(canvas: Canvas): void {
    var w  = canvas.width;
    var ch = this._contentH();
    var y0 = TAB_BAR_H + TOOLBAR_H;

    // ── Phase 3.1: Tile-dirty partial repaint ────────────────────────────────
    // Initialise (or resize) the TileRenderer when the viewport dimensions change.
    if (!this._tileRenderer || this._tileVpW !== w || this._tileVpH !== ch) {
      this._tileRenderer = new TileRenderer(w, ch);
      this._tileVpW = w; this._tileVpH = ch;
      // Force full repaint after resize.
      this._tileContentVer = -1;
    }
    var _tr  = this._tileRenderer;
    var _dmg = this._damage;

    // Check whether the content layer is truly clean (no layout change, no scroll, no damage).
    var _contentSame = (
      this._contentVersion === this._tileContentVer &&
      this._scrollY        === this._tileScrollY    &&
      _dmg === null
    );
    if (_contentSame) {
      // Only chrome (toolbar/URL bar) or focused-widget cursor changed — text lines are
      // untouched. Redraw widgets only (they clear their own background) and return.
      this._drawWidgets(canvas, y0, ch);
      return;
    }

    // Mark the right set of tiles dirty before painting.
    if (_dmg !== null) {
      // Partial update: only tiles overlapping the damage rect need repainting.
      _tr.compositor.tileDirty.markRectDirty(_dmg.x, _dmg.y - y0, _dmg.w, _dmg.h);
    } else {
      // Full repaint (new page, scroll, resize).
      _tr.compositor.tileDirty.markAllDirty();
    }

    // ── Set canvas clip to damage area (when present) to avoid over-drawing ─
    var _savedClip = canvas.saveClipRect();
    if (_dmg !== null) {
      canvas.setClipRect(_dmg.x, _dmg.y, _dmg.w, _dmg.h);
      canvas.fillRect(_dmg.x, _dmg.y, _dmg.w, _dmg.h, CLR_BG);
    } else {
      canvas.fillRect(0, y0, w, ch, CLR_BG);
    }

    if (this._loading) {
      canvas.drawText(CONTENT_PAD, y0 + 20, 'Loading  ' + this._pageURL + ' ...', CLR_STATUS_TXT);
      canvas.restoreClipRect(_savedClip);
      this._tileContentVer = this._contentVersion;
      this._tileScrollY    = this._scrollY;
      return;
    }

    // Damage rect bounds in absolute canvas coordinates — used to skip off-damage lines.
    var _dmgY1 = _dmg !== null ? _dmg.y         : y0;
    var _dmgY2 = _dmg !== null ? _dmg.y + _dmg.h : y0 + ch;

    // Binary-search to the first visible line
    var _lines = this._pageLines;
    var _sv    = this._scrollY;
    var _lo = 0, _hi = _lines.length;
    while (_lo < _hi) {
      var _mid = (_lo + _hi) >> 1;
      if (_lines[_mid].y + _lines[_mid].lineH < _sv) _lo = _mid + 1;
      else _hi = _mid;
    }
    // Clip stack for overflow:hidden containers (item 3.10)
    var _clipStack: Array<{endY: number; saved: ReturnType<typeof canvas.saveClipRect>}> = [];
    for (var i = _lo; i < _lines.length; i++) {
      var line  = _lines[i];
      var lineY = line.y - _sv;
      if (lineY > ch) break;
      var absY = y0 + lineY;
      // position:sticky: clamp absY so element sticks to viewport threshold when approached
      if (line.stickyTop !== undefined && lineY < line.stickyTop) {
        absY = y0 + line.stickyTop;
      }
      var lineBot = absY + (line.lineH || CHAR_H);
      // Phase 3.1: skip lines entirely outside the damage rect (saves draw calls).
      if (_dmg !== null) {
        if (lineBot < _dmgY1) continue;  // line is above the damage strip
        if (absY   > _dmgY2) break;      // line is below the damage strip — done
      }
      // Pop expired overflow:hidden clips
      while (_clipStack.length > 0 && absY > _clipStack[_clipStack.length - 1].endY) {
        canvas.restoreClipRect(_clipStack.pop()!.saved);
      }

      if (line.hrLine) {
        canvas.fillRect(CONTENT_PAD, absY + 1, w - CONTENT_PAD * 2, 1, CLR_HR); continue;
      }

      // ── Box decoration — border-radius, borders, box-shadow (Tier 3.7 / 4.2) ──
      if (line.boxDeco) {
        var deco   = line.boxDeco;
        var decoX  = deco.x;
        var decoY  = absY - 1;
        var decoW  = deco.w;
        var decoH  = deco.h;
        var decoR  = deco.borderRadius || 0;

        // 1. Box-shadow (behind element)
        if (deco.boxShadow) {
          var _shLayers = _parseBoxShadow(deco.boxShadow);
          for (var _sli = 0; _sli < _shLayers.length; _sli++) {
            var _sl = _shLayers[_sli];
            if (_sl.inset) continue; // inset shadows unsupported for now
            var _slA = (_sl.color >>> 24) & 0xFF;
            if (_sl.blur > 0 && _slA > 0) {
              // Approximate blur by drawing 3 progressively-larger translucent rects
              for (var _bk = 3; _bk >= 1; _bk--) {
                var _bSpr  = _sl.blur * _bk / 3;
                var _bAlph = Math.round(_slA * (1 - _bk / 4)) >>> 0;
                var _bClr  = (_sl.color & 0x00FFFFFF) | (_bAlph << 24);
                canvas.fillRect(
                  Math.round(decoX + _sl.offsetX - _bSpr + _sl.spread),
                  Math.round(decoY + _sl.offsetY - _bSpr + _sl.spread),
                  Math.round(decoW + _bSpr * 2),
                  Math.round(decoH + _bSpr * 2),
                  _bClr,
                );
              }
            } else {
              // No blur — solid shadow rect
              canvas.fillRect(
                Math.round(decoX + _sl.offsetX + _sl.spread),
                Math.round(decoY + _sl.offsetY + _sl.spread),
                decoW, decoH,
                _sl.color,
              );
            }
          }
        }

        // 2. Background fill with border-radius (skip the plain fillRect below for this line)
        if (decoR > 0) {
          if (deco.bgColor !== undefined) {
            canvas.fillRoundRect(decoX, decoY, decoW, decoH, decoR, deco.bgColor);
          }
          // gradient background handled below via line.bgGradient (which is already set on the line)
        } else {
          // No rounding — let the existing bgColor/bgGradient handling below paint normally
          // (boxDeco still enables border + shadow without forcing rounded corners)
        }

        // 3. Border outline
        if (deco.borderWidth && deco.borderWidth > 0 && deco.borderColor !== undefined) {
          var _brd = deco.borderWidth;
          canvas.drawRoundRect(decoX, decoY, decoW, decoH, decoR, deco.borderColor);
          for (var _bi = 1; _bi < _brd; _bi++) {
            canvas.drawRoundRect(
              decoX + _bi, decoY + _bi,
              decoW - _bi * 2, decoH - _bi * 2,
              Math.max(0, decoR - _bi),
              deco.borderColor,
            );
          }
        }
        // overflow:hidden: push canvas clip rect so children are clipped to this box (item 3.10)
        if (deco.overflowHidden) {
          var _savedClip = canvas.saveClipRect();
          canvas.setClipRect(decoX, decoY, decoW, decoH);
          _clipStack.push({ endY: decoY + decoH, saved: _savedClip });
        }
      }

      if (line.bgColor) {
        // Skip full-width fill when boxDeco already painted a rounded background
        if (!(line.boxDeco && (line.boxDeco.borderRadius || 0) > 0)) {
          canvas.fillRect(0, absY - 1, w, line.lineH + 1, line.bgColor);
        }
      }
      if (line.bgGradient) {
        var _gx  = line.boxDeco ? line.boxDeco.x : 0;
        var _gw  = line.boxDeco ? line.boxDeco.w : w;
        renderGradientCSS(canvas, _gx, absY - 1, _gw, line.lineH + 1, line.bgGradient);
      }
      // CSS background-image url() tile (item 386)
      if (line.bgImageUrl) {
        var _bgDec = this._bgImageMap.get(line.bgImageUrl);
        if (_bgDec && _bgDec.data) {
          var _bw = _bgDec.w, _bh = _bgDec.h;
          var _bHh = line.lineH + 1;
          // Cache the tiled block to avoid per-frame allocation
          var _bgKey = line.bgImageUrl + ':' + w + ':' + _bHh;
          var _blk = this._bgTileCache.get(_bgKey);
          if (!_blk || _blk.length !== _bHh * w) {
            _blk = new Uint32Array(_bHh * w);
            for (var _br = 0; _br < _bHh; _br++) {
              var _bsr = _br % _bh;
              var _roff = _br * w;
              for (var _bc = 0; _bc < w; _bc++) {
                _blk[_roff + _bc] = _bgDec.data[_bsr * _bw + (_bc % _bw)] ?? 0;
              }
            }
            this._bgTileCache.set(_bgKey, _blk);
          }
          canvas.blitPixelsDirect(_blk, w, _bHh, 0, absY - 1);
        }
      }
      if (line.quoteBg) {
        canvas.fillRect(0, absY - 1, w, line.lineH + 1, CLR_QUOTE_BG);
        canvas.fillRect(CONTENT_PAD, absY - 1, 3, line.lineH + 1, CLR_QUOTE_BAR);
      }
      if (line.preBg) {
        canvas.fillRect(0, absY - 1, w, line.lineH + 1, CLR_PRE_BG);
      }

      for (var j = 0; j < line.nodes.length; j++) {
        var span = line.nodes[j];
        if (!span.text) continue;
        var clr = span.color;
        if (span.href) {
          clr = this._visited.has(span.href) ? CLR_VISITED
              : span.href === this._hoverHref ? CLR_LINK_HOV : CLR_LINK;
        }
        var sc  = span.fontScale || 1;
        var sCW = CHAR_W * sc;
        var sCH = CHAR_H * sc;
        if (span.codeBg) canvas.fillRect(span.x - 1, absY - 1, span.text.length * sCW + 2, sCH + 2, CLR_CODE_BG);
        if (span.mark)   canvas.fillRect(span.x, absY - 1, span.text.length * sCW, sCH + 2, CLR_MARK_BG);
        if (span.searchHit) {
          var hc = span.hitIdx === this._findCur ? CLR_FIND_CUR : CLR_FIND_MATCH;
          canvas.fillRect(span.x, absY - 1, span.text.length * sCW, sCH + 2, hc);
        }
        if (sc > 1) {
          canvas.drawTextScaled(span.x, absY, span.text, clr, sc);
          if (span.bold)   canvas.drawTextScaled(span.x + sc, absY, span.text, clr, sc);
          if (span.italic) canvas.drawTextScaled(span.x + Math.floor(sc / 2), absY, span.text, clr, sc);
        } else {
          // Italic: draw text twice with a 1-px horizontal offset at the top half
          // to simulate a forward slant (item 433)
          if (span.italic) {
            canvas.drawText(span.x + 1, absY, span.text, clr);
            canvas.drawText(span.x,     absY + Math.floor(CHAR_H / 2), span.text, clr);
          } else {
            canvas.drawText(span.x, absY, span.text, clr);
          }
          if (span.bold) canvas.drawText(span.x + 1, absY, span.text, clr);
        }
        if (span.href)      canvas.drawLine(span.x, absY + sCH, span.x + span.text.length * sCW, absY + sCH, clr);
        if (span.underline) canvas.drawLine(span.x, absY + sCH, span.x + span.text.length * sCW, absY + sCH, clr);
        if (span.del) {
          var mY = absY + Math.floor(sCH / 2);
          canvas.drawLine(span.x, mY, span.x + span.text.length * sCW, mY, CLR_DEL);
        }
      }
    }

    // Clean up any remaining overflow:hidden clip rects
    while (_clipStack.length > 0) { canvas.restoreClipRect(_clipStack.pop()!.saved); }

    // ── Sticky second pass — paint "stuck" sticky elements on top of main content
    // An element is "stuck" when it has scrolled past its natural flow position
    // (line.y < scrollY) — it needs to render at y0 + stickyTop instead.
    // Uses cached _stickyIndices to avoid O(n) scan of all lines.
    for (var _stpI = 0; _stpI < this._stickyIndices.length; _stpI++) {
      var _stpLine = _lines[this._stickyIndices[_stpI]];
      var _stpLineY = _stpLine.y - _sv;
      if (_stpLineY >= _stpLine.stickyTop) continue; // in natural position, already painted
      var _stpAbsY = y0 + _stpLine.stickyTop;
      if (_stpAbsY + (_stpLine.lineH || CHAR_H) < y0 || _stpAbsY >= y0 + ch) continue;
      // Paint background to occlude content that scrolled beneath the sticky element
      if (_stpLine.bgColor !== undefined) {
        canvas.fillRect(0, _stpAbsY - 1, w, (_stpLine.lineH || LINE_H) + 1, _stpLine.bgColor);
      } else {
        canvas.fillRect(0, _stpAbsY - 1, w, (_stpLine.lineH || LINE_H) + 1, CLR_BG);
      }
      if (_stpLine.bgGradient) {
        renderGradientCSS(canvas, 0, _stpAbsY - 1, w, (_stpLine.lineH || LINE_H) + 1, _stpLine.bgGradient);
      }
      // Paint text spans
      for (var _stpJ = 0; _stpJ < _stpLine.nodes.length; _stpJ++) {
        var _stpSp = _stpLine.nodes[_stpJ];
        if (!_stpSp.text) continue;
        var _stpClr = _stpSp.color;
        if (_stpSp.href) {
          _stpClr = this._visited.has(_stpSp.href) ? CLR_VISITED
                  : _stpSp.href === this._hoverHref ? CLR_LINK_HOV : CLR_LINK;
        }
        var _stpSc = _stpSp.fontScale || 1;
        var _stpCW = CHAR_W * _stpSc;
        var _stpCH = CHAR_H * _stpSc;
        if (_stpSc > 1) {
          canvas.drawTextScaled(_stpSp.x, _stpAbsY, _stpSp.text, _stpClr, _stpSc);
          if (_stpSp.bold) canvas.drawTextScaled(_stpSp.x + _stpSc, _stpAbsY, _stpSp.text, _stpClr, _stpSc);
        } else {
          if (_stpSp.italic) {
            canvas.drawText(_stpSp.x + 1, _stpAbsY, _stpSp.text, _stpClr);
            canvas.drawText(_stpSp.x, _stpAbsY + Math.floor(CHAR_H / 2), _stpSp.text, _stpClr);
          } else {
            canvas.drawText(_stpSp.x, _stpAbsY, _stpSp.text, _stpClr);
          }
          if (_stpSp.bold) canvas.drawText(_stpSp.x + 1, _stpAbsY, _stpSp.text, _stpClr);
        }
        if (_stpSp.underline || _stpSp.href) {
          canvas.drawLine(_stpSp.x, _stpAbsY + _stpCH,
                          _stpSp.x + _stpSp.text.length * _stpCW, _stpAbsY + _stpCH, _stpClr);
        }
      }
    }

    // ── Fixed-element pass — paint position:fixed elements at viewport-anchored positions
    // These elements ignore scroll and always appear at their posTop/posLeft viewport coordinates.
    for (var _fxI = 0; _fxI < _lines.length; _fxI++) {
      var _fxLine = _lines[_fxI];
      if (_fxLine.fixedViewportY === undefined) continue;
      var _fxAbsY = y0 + _fxLine.fixedViewportY;
      if (_fxAbsY + (_fxLine.lineH || CHAR_H) < y0 || _fxAbsY >= y0 + ch) continue;
      // Paint background to cover scrolled content beneath
      if (_fxLine.bgColor !== undefined) {
        canvas.fillRect(0, _fxAbsY - 1, w, (_fxLine.lineH || LINE_H) + 1, _fxLine.bgColor);
      } else {
        canvas.fillRect(0, _fxAbsY - 1, w, (_fxLine.lineH || LINE_H) + 1, CLR_BG);
      }
      if (_fxLine.bgGradient) {
        renderGradientCSS(canvas, 0, _fxAbsY - 1, w, (_fxLine.lineH || LINE_H) + 1, _fxLine.bgGradient);
      }
      // Paint text spans
      for (var _fxJ = 0; _fxJ < _fxLine.nodes.length; _fxJ++) {
        var _fxSp = _fxLine.nodes[_fxJ];
        if (!_fxSp.text) continue;
        var _fxClr = _fxSp.color;
        if (_fxSp.href) {
          _fxClr = this._visited.has(_fxSp.href) ? CLR_VISITED
                 : _fxSp.href === this._hoverHref ? CLR_LINK_HOV : CLR_LINK;
        }
        var _fxSc = _fxSp.fontScale || 1;
        var _fxCW = CHAR_W * _fxSc;
        var _fxCH = CHAR_H * _fxSc;
        if (_fxSc > 1) {
          canvas.drawTextScaled(_fxSp.x, _fxAbsY, _fxSp.text, _fxClr, _fxSc);
          if (_fxSp.bold) canvas.drawTextScaled(_fxSp.x + _fxSc, _fxAbsY, _fxSp.text, _fxClr, _fxSc);
        } else {
          if (_fxSp.italic) {
            canvas.drawText(_fxSp.x + 1, _fxAbsY, _fxSp.text, _fxClr);
            canvas.drawText(_fxSp.x, _fxAbsY + Math.floor(CHAR_H / 2), _fxSp.text, _fxClr);
          } else {
            canvas.drawText(_fxSp.x, _fxAbsY, _fxSp.text, _fxClr);
          }
          if (_fxSp.bold) canvas.drawText(_fxSp.x + 1, _fxAbsY, _fxSp.text, _fxClr);
        }
        if (_fxSp.underline || _fxSp.href) {
          canvas.drawLine(_fxSp.x, _fxAbsY + _fxCH,
                          _fxSp.x + _fxSp.text.length * _fxCW, _fxAbsY + _fxCH, _fxClr);
        }
      }
    }

    this._drawWidgets(canvas, y0, ch);

    // Phase 3.1: lift damage clip before drawing scrollbar and canvas elements —
    // scrollbar thumb position changes on every scroll, canvas elements are always current.
    canvas.clearClipRect();

    // Scrollbar
    if (this._maxScrollY > 0 && ch > 0) {
      var sbW    = 10;
      var sbXd   = w - sbW - 2;
      var trackH = ch - 4;
      var thumbH = Math.max(12, Math.floor(trackH * ch / (ch + this._maxScrollY)));
      var thumbY = Math.floor((trackH - thumbH) * this._scrollY / this._maxScrollY);
      canvas.fillRect(sbXd, y0 + 2, sbW, trackH, 0xFFDDDDDD);
      canvas.fillRect(sbXd, y0 + 2 + thumbY, sbW, thumbH, CLR_BTN_BG);
      canvas.drawRect(sbXd, y0 + 2 + thumbY, sbW, thumbH, CLR_TOOLBAR_BD);
    }

    // ── Canvas element compositing (item 3.3) ─────────────────────────────────
    // Blit canvas element pixel buffers into the browser viewport at their
    // layout positions.  The canvas2d context renders into an RGBA Uint8Array;
    // we convert to BGRA Uint32Array and blit directly.
    if (this._pageJS) {
      var _cbufs = this._pageJS.getCanvasBuffers();
      for (var _ci = 0; _ci < _cbufs.length; _ci++) {
        var _cb = _cbufs[_ci];
        if (!_cb.rgba || _cb.width <= 0 || _cb.height <= 0) continue;
        // Find layout rect for this canvas element
        var _cRect: { x: number; y: number; w: number; h: number } | null = null;
        for (var _wk = 0; _wk < this._widgets.length; _wk++) {
          if (this._widgets[_wk].name === _cb.elId || (this._widgets[_wk] as any).elId === _cb.elId) {
            _cRect = { x: this._widgets[_wk].px, y: this._widgets[_wk].py, w: this._widgets[_wk].pw, h: this._widgets[_wk].ph };
            break;
          }
        }
        if (!_cRect) continue;
        // Convert RGBA → BGRA Uint32Array for blitPixelsDirect (reuse buffer)
        var _cPixelCount = _cb.width * _cb.height;
        if (!this._canvasPixelBuf || this._canvasPixelBuf.length < _cPixelCount) {
          this._canvasPixelBuf = new Uint32Array(_cPixelCount);
        }
        var _cPixels = this._canvasPixelBuf;
        var _rgba = _cb.rgba;
        for (var _pi = 0; _pi < _cPixels.length; _pi++) {
          var _ri = _pi * 4;
          _cPixels[_pi] = (_rgba[_ri + 3] << 24) | (_rgba[_ri] << 16) | (_rgba[_ri + 1] << 8) | _rgba[_ri + 2];
        }
        var _cdy = y0 + _cRect.y - this._scrollY;
        canvas.blitPixelsDirect(_cPixels, _cb.width, _cb.height, _cRect.x, _cdy);
      }
    }

    // Phase 3.1: restore clip rect and record what was rendered.
    canvas.restoreClipRect(_savedClip);
    this._tileContentVer = this._contentVersion;
    this._tileScrollY    = this._scrollY;
  }

  private _drawWidgets(canvas: Canvas, y0: number, ch: number): void {
    for (var wi = 0; wi < this._widgets.length; wi++) {
      var wp = this._widgets[wi];
      var wy = y0 + wp.py - this._scrollY;
      if (wy + wp.ph < y0 || wy > y0 + ch) continue;
      var focused = (wi === this._focusedWidget);
      switch (wp.kind) {
        case 'text':
        case 'password':  this._drawInputField(canvas, wp, wy, focused); break;
        case 'search':    this._drawSearchField(canvas, wp, wy, focused); break;
        case 'textarea':  this._drawTextarea(canvas, wp, wy, focused); break;
        case 'submit':
        case 'reset':
        case 'button':    this._drawButton(canvas, wp, wy); break;
        case 'checkbox':  this._drawCheckbox(canvas, wp, wy); break;
        case 'radio':     this._drawRadio(canvas, wp, wy); break;
        case 'select':    this._drawSelect(canvas, wp, wy, focused); break;
        case 'img':       this._drawImage(canvas, wp, wy); break;
      }
    }
  }

  private _drawInputField(canvas: Canvas, wp: PositionedWidget, wy: number, focused: boolean): void {
    var bdClr = focused ? CLR_INPUT_FOCUS : CLR_INPUT_BD;
    canvas.fillRect(wp.px, wy, wp.pw, wp.ph, CLR_INPUT_BG);
    canvas.drawRect(wp.px, wy, wp.pw, wp.ph, bdClr);
    var maxCh   = Math.max(1, Math.floor((wp.pw - 8) / CHAR_W));
    var disp    = wp.kind === 'password' ? '*'.repeat(wp.curValue.length) : wp.curValue;
    var showStr = disp.length > maxCh ? disp.slice(disp.length - maxCh) : disp;
    canvas.drawText(wp.px + 4, wy + 5, showStr, CLR_INPUT_TXT);
    if (focused && (this._cursorBlink >> 4) % 2 === 0) {
      var cursorX = wp.px + 4 + Math.min(wp.cursorPos, maxCh) * CHAR_W;
      canvas.fillRect(cursorX, wy + 4, 1, CHAR_H, CLR_INPUT_TXT);
    }
  }

  /** Draw a search input with a × clear button on the right (item 616). */
  private _drawSearchField(canvas: Canvas, wp: PositionedWidget, wy: number, focused: boolean): void {
    var bdClr  = focused ? CLR_INPUT_FOCUS : CLR_INPUT_BD;
    var btnW   = 18;
    var textW  = wp.pw - btnW;
    canvas.fillRect(wp.px, wy, wp.pw, wp.ph, CLR_INPUT_BG);
    canvas.drawRect(wp.px, wy, wp.pw, wp.ph, bdClr);
    // text area
    var maxCh   = Math.max(1, Math.floor((textW - 8) / CHAR_W));
    var disp    = wp.curValue;
    var showStr = disp.length > maxCh ? disp.slice(disp.length - maxCh) : disp;
    canvas.drawText(wp.px + 4, wy + 5, showStr, CLR_INPUT_TXT);
    if (focused && (this._cursorBlink >> 4) % 2 === 0) {
      var cursorX = wp.px + 4 + Math.min(wp.cursorPos, maxCh) * CHAR_W;
      canvas.fillRect(cursorX, wy + 4, 1, CHAR_H, CLR_INPUT_TXT);
    }
    // clear button (×)
    if (wp.curValue.length > 0) {
      var bx = wp.px + textW;
      canvas.fillRect(bx, wy, btnW, wp.ph, CLR_BTN_BG);
      canvas.drawLine(bx, wy, bx, wy + wp.ph, CLR_INPUT_BD);
      canvas.drawText(bx + 5, wy + 5, 'x', CLR_BTN_TXT);
    }
  }

  private _drawTextarea(canvas: Canvas, wp: PositionedWidget, wy: number, focused: boolean): void {
    var bdClr = focused ? CLR_INPUT_FOCUS : CLR_INPUT_BD;
    canvas.fillRect(wp.px, wy, wp.pw, wp.ph, CLR_INPUT_BG);
    canvas.drawRect(wp.px, wy, wp.pw, wp.ph, bdClr);
    var maxCh  = Math.max(1, Math.floor((wp.pw - 8) / CHAR_W));
    var rows   = wp.rows || 4;
    var lines  = wp.curValue.split('\n');
    for (var ri = 0; ri < Math.min(rows, lines.length); ri++) {
      canvas.drawText(wp.px + 4, wy + 4 + ri * LINE_H, lines[ri].slice(0, maxCh), CLR_INPUT_TXT);
    }
    if (focused && (this._cursorBlink >> 4) % 2 === 0) {
      var lastLine = lines[Math.min(rows - 1, lines.length - 1)] || '';
      var tx = wp.px + 4 + Math.min(lastLine.length, maxCh) * CHAR_W;
      var ty = wy + 4 + (Math.min(lines.length, rows) - 1) * LINE_H;
      canvas.fillRect(tx, ty, 1, CHAR_H, CLR_INPUT_TXT);
    }
  }

  private _drawButton(canvas: Canvas, wp: PositionedWidget, wy: number): void {
    var bgClr  = (wp.kind === 'reset' || wp.kind === 'button') ? CLR_BTN_RST_BG : CLR_BTN_SUB_BG;
    var txtClr = (wp.kind === 'reset' || wp.kind === 'button') ? CLR_BTN_TXT    : CLR_BTN_SUB_TXT;
    var label  = wp.curValue || (wp.kind === 'reset' ? 'Reset' : 'Submit');
    canvas.fillRect(wp.px, wy, wp.pw, wp.ph, bgClr);
    canvas.drawRect(wp.px, wy, wp.pw, wp.ph, CLR_INPUT_BD);
    var tx = wp.px + Math.floor((wp.pw - label.length * CHAR_W) / 2);
    var ty = wy   + Math.floor((wp.ph - CHAR_H) / 2);
    canvas.drawText(tx, ty, label, txtClr);
  }

  private _drawCheckbox(canvas: Canvas, wp: PositionedWidget, wy: number): void {
    var sz = WIDGET_CHECK_SZ;
    canvas.fillRect(wp.px, wy, sz, sz, CLR_INPUT_BG);
    canvas.drawRect(wp.px, wy, sz, sz, CLR_INPUT_BD);
    if (wp.curChecked) {
      canvas.fillRect(wp.px + 2, wy + 2, sz - 4, sz - 4, CLR_CHECK_FILL);
      canvas.drawText(wp.px + 2, wy + 2, 'v', 0xFFFFFFFF);
    }
    if (wp.curValue) canvas.drawText(wp.px + sz + 4, wy + 2, wp.curValue, CLR_BODY);
  }

  private _drawRadio(canvas: Canvas, wp: PositionedWidget, wy: number): void {
    var sz = WIDGET_CHECK_SZ;
    canvas.fillRect(wp.px, wy, sz, sz, CLR_INPUT_BG);
    canvas.drawRect(wp.px, wy, sz, sz, CLR_INPUT_BD);
    if (wp.curChecked) canvas.fillRect(wp.px + 3, wy + 3, sz - 6, sz - 6, CLR_CHECK_FILL);
    if (wp.curValue) canvas.drawText(wp.px + sz + 4, wy + 2, wp.curValue, CLR_BODY);
  }

  private _drawSelect(canvas: Canvas, wp: PositionedWidget, wy: number, focused: boolean): void {
    var bdClr  = focused ? CLR_INPUT_FOCUS : CLR_INPUT_BD;
    canvas.fillRect(wp.px, wy, wp.pw, wp.ph, CLR_SEL_BG);
    canvas.drawRect(wp.px, wy, wp.pw, wp.ph, bdClr);
    var opts   = wp.options || [];
    var label  = opts[wp.curSelIdx] || '';
    var maxCh  = Math.max(1, Math.floor((wp.pw - 20) / CHAR_W));
    canvas.drawText(wp.px + 4, wy + 5, label.slice(0, maxCh), CLR_INPUT_TXT);
    canvas.drawText(wp.px + wp.pw - 14, wy + 5, 'v', CLR_SEL_ARROW);
    canvas.drawLine(wp.px + wp.pw - 16, wy, wp.px + wp.pw - 16, wy + wp.ph, CLR_INPUT_BD);
  }

  private _drawImage(canvas: Canvas, wp: PositionedWidget, wy: number): void {
    if (!wp.imgLoaded) {
      canvas.fillRect(wp.px, wy, wp.pw, wp.ph, CLR_IMG_PH_BG);
      canvas.drawRect(wp.px, wy, wp.pw, wp.ph, CLR_IMG_PH_BD);
      var alt = wp.imgAlt || wp.imgSrc || '';
      if (alt) {
        var maxC = Math.max(1, Math.floor((wp.pw - 8) / CHAR_W));
        canvas.drawText(wp.px + 4,
          wy + Math.max(0, Math.floor((wp.ph - CHAR_H) / 2)),
          ('[' + alt + ']').slice(0, maxC), CLR_IMG_PH_TXT);
      }
      return;
    }
    if (wp.imgData) {
      // Alpha-compositing blit: SVGs may have transparent backgrounds
      canvas.blitPixelsAlpha(wp.imgData, wp.pw, wp.ph, wp.px, wy);
    } else {
      canvas.fillRect(wp.px, wy, wp.pw, wp.ph, CLR_IMG_PH_BG);
      canvas.drawRect(wp.px, wy, wp.pw, wp.ph, 0xFFFF9999);
      canvas.drawText(wp.px + 4, wy + Math.floor((wp.ph - CHAR_H) / 2), 'Image unavailable', 0xFFCC4444);
    }
  }

  private _drawStatusBar(canvas: Canvas): void {
    var w  = canvas.width;
    var y0 = canvas.height - STATUSBAR_H - (this._findMode ? FINDBAR_H : 0);
    canvas.fillRect(0, y0, w, STATUSBAR_H, CLR_STATUS_BG);
    canvas.drawLine(0, y0, w, y0, CLR_TOOLBAR_BD);
    var txt = this._hoverHref ? 'Link: ' + this._hoverHref
            : (this._status || this._pageTitle);
    if (!this._hoverHref && this._maxScrollY > 0) {
      txt += '  (' + Math.round(100 * this._scrollY / this._maxScrollY) + '%)';
    }
    canvas.drawText(4, y0 + 3, txt.slice(0, Math.floor((w - 8) / CHAR_W)), CLR_STATUS_TXT);
  }

  private _drawFindBar(canvas: Canvas): void {
    var w  = canvas.width;
    var y0 = canvas.height - STATUSBAR_H - FINDBAR_H;
    canvas.fillRect(0, y0, w, FINDBAR_H, CLR_FIND_BG);
    canvas.drawLine(0, y0, w, y0, CLR_FIND_BD);
    canvas.drawText(4, y0 + 7, 'Find:', CLR_FIND_TXT);
    var ix = 4 + 6 * CHAR_W;
    var iw = Math.min(200, w - ix - 30 * CHAR_W);
    canvas.fillRect(ix - 2, y0 + 4, iw + 4, FINDBAR_H - 8, CLR_URL_BG);
    canvas.drawRect(ix - 2, y0 + 4, iw + 4, FINDBAR_H - 8, CLR_FIND_BD);
    var mq  = Math.floor(iw / CHAR_W);
    var sq  = this._findQuery.length > mq ? this._findQuery.slice(-mq) : this._findQuery;
    canvas.drawText(ix, y0 + 7, sq, CLR_FIND_TXT);
    if ((this._cursorBlink >> 4) % 2 === 0) {
      canvas.fillRect(ix + sq.length * CHAR_W, y0 + 6, 1, CHAR_H, CLR_FIND_TXT);
    }
    var htxt = this._findHits.length > 0
      ? (this._findCur + 1) + ' / ' + this._findHits.length
      : (this._findQuery ? 'No matches' : '');
    var hx = ix + iw + 8;
    canvas.drawText(hx, y0 + 7, htxt, CLR_STATUS_TXT);
    canvas.drawText(hx + htxt.length * CHAR_W + 12, y0 + 7, 'n/N next/prev  Esc close', CLR_HR);
  }

  // ── Widget interaction ─────────────────────────────────────────────────────

  private _hitTestWidget(cx: number, cy: number): number {
    for (var i = 0; i < this._widgets.length; i++) {
      var wp = this._widgets[i];
      if (cx >= wp.px && cx < wp.px + wp.pw + 20 && cy >= wp.py && cy < wp.py + wp.ph) return i;
    }
    return -1;
  }

  private _handleWidgetClick(idx: number, cx: number, cy: number): void {
    var wp = this._widgets[idx];
    if (wp.disabled) return;
    // Fire blur on previously-focused widget before switching focus.
    if (this._focusedWidget >= 0 && this._focusedWidget !== idx) {
      var prevWp = this._widgets[this._focusedWidget];
      if (prevWp && prevWp.name && this._pageJS) {
        this._pageJS.fireBlur(prevWp.name);
        this._focusedWidgetName = '';
      }
    }
    switch (wp.kind) {
      case 'text':
      case 'password':
      case 'textarea': {
        this._focusedWidget  = idx;
        this._urlBarFocus    = false;
        this._urlAllSelected = false;
        var maxCw2   = Math.max(1, Math.floor((wp.pw - 8) / CHAR_W));
        var dispLen2 = Math.min(wp.curValue.length, maxCw2);
        var scrollO2 = wp.curValue.length - dispLen2;
        var relX2    = cx - (wp.px + 4);
        wp.cursorPos = scrollO2 + Math.max(0, Math.min(dispLen2, Math.round(relX2 / CHAR_W)));
        this._dirty  = true;
        if (wp.name && this._pageJS) { this._pageJS.fireFocus(wp.name); this._focusedWidgetName = wp.name; }
        break;
      }
      case 'search': {
        // If clicking the × clear button area (rightmost 18px), clear value (item 616)
        var clearBtnX = wp.px + (wp.pw - 18);
        if (cx >= clearBtnX && wp.curValue.length > 0) {
          wp.curValue  = '';
          wp.cursorPos = 0;
          if (this._pageJS) this._pageJS.fireInput(wp.name, '');
          this._dirty  = true;
        } else {
          this._focusedWidget  = idx;
          this._urlBarFocus    = false;
          this._urlAllSelected = false;
          var maxCwS   = Math.max(1, Math.floor((wp.pw - 26) / CHAR_W));
          var scrollOS = Math.max(0, wp.curValue.length - maxCwS);
          var relXS    = cx - (wp.px + 4);
          wp.cursorPos = scrollOS + Math.max(0, Math.min(wp.curValue.length - scrollOS, Math.round(relXS / CHAR_W)));
          this._dirty  = true;
          if (wp.name && this._pageJS) { this._pageJS.fireFocus(wp.name); this._focusedWidgetName = wp.name; }
        }
        break;
      }
      case 'submit':
      case 'button':  {
        // let JS handle the click first; if no JS or not consumed, do form submit
        var jsHandled = this._pageJS?.fireClick(wp.id !== undefined ? String(wp.id) : wp.name) ?? false;
        if (!jsHandled) this._submitForm(wp.formIdx, wp.name, wp.curValue);
        break;
      }
      case 'reset':   this._resetForm(wp.formIdx); break;
      case 'checkbox': wp.curChecked = !wp.curChecked; this._dirty = true; break;
      case 'radio':
        for (var ri = 0; ri < this._widgets.length; ri++) {
          var rw = this._widgets[ri];
          if (rw.kind === 'radio' && rw.name === wp.name && rw.formIdx === wp.formIdx)
            rw.curChecked = (ri === idx);
        }
        this._dirty = true; break;
      case 'select': {
        var opts = wp.options || [];
        if (opts.length > 0) { wp.curSelIdx = (wp.curSelIdx + 1) % opts.length; this._dirty = true; }
        this._focusedWidget = idx; break;
      }
    }
  }

  private _handleWidgetKey(wp: PositionedWidget, ch: string, ext: number): boolean {
    if (wp.disabled || wp.readonly) return false;
    switch (wp.kind) {
      case 'text':
      case 'password':
      case 'search': {
        if (ext === 0x4B) { wp.cursorPos = Math.max(0, wp.cursorPos - 1); this._dirty = true; if (this._pageJS) this._pageJS.fireKeydown(wp.name, 'ArrowLeft', 37); return true; }
        if (ext === 0x4D) { wp.cursorPos = Math.min(wp.curValue.length, wp.cursorPos + 1); this._dirty = true; if (this._pageJS) this._pageJS.fireKeydown(wp.name, 'ArrowRight', 39); return true; }
        if (ext === 0x47) { wp.cursorPos = 0; this._dirty = true; return true; }
        if (ext === 0x4F) { wp.cursorPos = wp.curValue.length; this._dirty = true; return true; }
        // ArrowUp/Down fire keydown so page JS can navigate autocomplete suggestions.
        if (ext === 0x48) { this._dirty = true; if (this._pageJS) this._pageJS.fireKeydown(wp.name, 'ArrowUp', 38); return true; }
        if (ext === 0x50) { this._dirty = true; if (this._pageJS) this._pageJS.fireKeydown(wp.name, 'ArrowDown', 40); return true; }
        if (ch === '\x1b') { this._focusedWidget = -1; this._dirty = true; return true; }
        if (ch === '\t')   { this._cycleFocusedWidget(1); return true; }
        if (ch === '\n' || ch === '\r') {
          if (this._pageJS) this._pageJS.fireKeydown(wp.name, 'Enter', 13);
          this._submitForm(wp.formIdx, '', ''); return true;
        }
        if (ch === '\b') {
          if (wp.cursorPos > 0) {
            wp.curValue  = wp.curValue.slice(0, wp.cursorPos - 1) + wp.curValue.slice(wp.cursorPos);
            wp.cursorPos = Math.max(0, wp.cursorPos - 1);
            this._dirty  = true;
            if (this._pageJS) { this._pageJS.fireKeydown(wp.name, 'Backspace', 8); this._pageJS.fireInput(wp.name, wp.curValue); }
          }
          return true;
        }
        if (ch >= ' ') {
          wp.curValue  = wp.curValue.slice(0, wp.cursorPos) + ch + wp.curValue.slice(wp.cursorPos);
          wp.cursorPos++;
          this._dirty  = true;
          if (this._pageJS) { this._pageJS.fireKeydown(wp.name, ch, ch.charCodeAt(0)); this._pageJS.fireInput(wp.name, wp.curValue); }
          return true;
        }
        return false;
      }
      case 'textarea': {
        if (ch === '\x1b') { this._focusedWidget = -1; this._dirty = true; return true; }
        if (ch === '\t')   { this._cycleFocusedWidget(1); return true; }
        if (ch === '\b')   { if (wp.curValue.length) { wp.curValue = wp.curValue.slice(0, -1); this._dirty = true; if (this._pageJS) { this._pageJS.fireKeydown(wp.name, 'Backspace', 8); this._pageJS.fireInput(wp.name, wp.curValue); } } return true; }
        if (ch === '\n' || ch === '\r') { wp.curValue += '\n'; this._dirty = true; if (this._pageJS) { this._pageJS.fireKeydown(wp.name, 'Enter', 13); this._pageJS.fireInput(wp.name, wp.curValue); } return true; }
        if (ch >= ' ') { wp.curValue += ch; this._dirty = true; if (this._pageJS) { this._pageJS.fireKeydown(wp.name, ch, ch.charCodeAt(0)); this._pageJS.fireInput(wp.name, wp.curValue); } return true; }
        return false;
      }
      case 'select': {
        var opts = wp.options || [];
        if (ext === 0x48 || ch === 'k') { wp.curSelIdx = Math.max(0, wp.curSelIdx - 1); this._dirty = true; if (this._pageJS) this._pageJS.fireChange(wp.name, wp.options?.[wp.curSelIdx] ?? ''); return true; }
        if (ext === 0x50 || ch === 'j') { wp.curSelIdx = Math.min(opts.length - 1, wp.curSelIdx + 1); this._dirty = true; if (this._pageJS) this._pageJS.fireChange(wp.name, wp.options?.[wp.curSelIdx] ?? ''); return true; }
        if (ch === '\x1b' || ch === '\t') { this._cycleFocusedWidget(1); return true; }
        return false;
      }
      case 'checkbox':
        if (ch === ' ' || ch === '\n' || ch === '\r') { wp.curChecked = !wp.curChecked; this._dirty = true; if (this._pageJS) this._pageJS.fireChange(wp.name, wp.curChecked ? 'on' : ''); return true; }
        return false;
      case 'radio':
        if (ch === ' ' || ch === '\n' || ch === '\r') {
          for (var ri = 0; ri < this._widgets.length; ri++) {
            var rw2 = this._widgets[ri];
            if (rw2.kind === 'radio' && rw2.name === wp.name && rw2.formIdx === wp.formIdx)
              rw2.curChecked = (rw2 === wp);
          }
          this._dirty = true; return true;
        }
        return false;
      case 'submit':
      case 'button':
        if (ch === '\n' || ch === '\r' || ch === ' ') { this._submitForm(wp.formIdx, wp.name, wp.curValue); return true; }
        return false;
      case 'reset':
        if (ch === '\n' || ch === '\r' || ch === ' ') { this._resetForm(wp.formIdx); return true; }
        return false;
    }
    return false;
  }

  private _cycleFocusedWidget(dir: number): void {
    var total = this._widgets.length;
    if (total === 0) return;
    var prev  = this._focusedWidget;
    var next  = (this._focusedWidget + dir + total) % total;
    var tries = 0;
    while (tries < total) {
      var wk = this._widgets[next].kind;
      if (wk !== 'hidden' && wk !== 'img') {
        if (prev >= 0 && prev !== next && this._pageJS) {
          var pWp = this._widgets[prev];
          if (pWp?.name) { this._pageJS.fireBlur(pWp.name); this._focusedWidgetName = ''; }
        }
        this._focusedWidget = next; this._dirty = true;
        var nWp = this._widgets[next];
        if (nWp?.name && this._pageJS) { this._pageJS.fireFocus(nWp.name); this._focusedWidgetName = nWp.name; }
        return;
      }
      next = (next + dir + total) % total; tries++;
    }
  }

  // ── Form submission ────────────────────────────────────────────────────────

  private _submitForm(formIdx: number, submitName: string, submitValue: string): void {
    var form = this._forms[formIdx];
    if (!form) { this._reload(); return; }

    var fields: Array<{name: string; value: string}> = [];
    for (var wi = 0; wi < this._widgets.length; wi++) {
      var wp2 = this._widgets[wi];
      if (wp2.formIdx !== formIdx || wp2.disabled) continue;
      switch (wp2.kind) {
        case 'text': case 'password': case 'search': case 'textarea':
          if (wp2.name) fields.push({ name: wp2.name, value: wp2.curValue }); break;
        case 'checkbox':
          if (wp2.curChecked && wp2.name) fields.push({ name: wp2.name, value: wp2.curValue || '1' }); break;
        case 'radio':
          if (wp2.curChecked && wp2.name) fields.push({ name: wp2.name, value: wp2.curValue }); break;
        case 'select': {
          var vals = wp2.optVals || [];
          var val  = vals[wp2.curSelIdx] !== undefined ? vals[wp2.curSelIdx] : (wp2.options || [])[wp2.curSelIdx] || '';
          if (wp2.name) fields.push({ name: wp2.name, value: val }); break;
        }
        case 'hidden':
          if (wp2.name) fields.push({ name: wp2.name, value: wp2.curValue }); break;
      }
    }
    if (submitName) fields.push({ name: submitName, value: submitValue });

    var action   = form.action || this._pageURL;
    var resolved = this._resolveHref(action);

    if (form.method === 'post') {
      this._submitPost(resolved, fields);
    } else {
      var qs  = fields.map(f => urlEncode(f.name) + '=' + urlEncode(f.value)).join('&');
      var url = resolved + (resolved.includes('?') ? '&' : '?') + qs;
      this._navigate(url);
    }
  }

  private _submitPost(url: string, fields: Array<{name: string; value: string}>): void {
    var body   = encodeFormData(fields);
    var parsed = parseURL(url);
    if (!parsed || parsed.protocol === 'about') { this._showError(url, 'Cannot POST to ' + url); return; }

    this._status  = 'Submitting form...';
    this._loading = true; this._dirty = true;
    this._histIdx++;
    this._history.splice(this._histIdx);
    this._history.push({ url, title: url });

    var self = this;
    this._fetchCoroId = os.fetchAsync(url, function(resp: FetchResponse | null, err?: string) {
      self._fetchCoroId = -1;
      if (!resp) { self._showError(url, err || 'POST failed'); return; }
      self._pageURL    = url;
      self._urlInput   = url;
      self._pageSource = resp.bodyText;
      self._showHTML(resp.bodyText, '', url);
      self._status = 'POST ' + resp.status;
      self._dirty  = true;
    }, { method: 'POST', body });
  }

  private _resetForm(formIdx: number): void {
    for (var wi = 0; wi < this._widgets.length; wi++) {
      var wp2 = this._widgets[wi];
      if (wp2.formIdx !== formIdx) continue;
      wp2.curValue   = wp2.value;
      wp2.curChecked = wp2.checked;
      wp2.curSelIdx  = wp2.selIdx || 0;
      wp2.cursorPos  = wp2.value.length;
    }
    this._dirty = true;
  }

  // ── Image fetching ────────────────────────────────────────────────────────

  private _fetchImages(): void {
    this._imgsFetching = true;
    var pendingCount   = 0;
    var self           = this;  // captured for async callbacks

    for (var wi = 0; wi < this._widgets.length; wi++) {
      var wp = this._widgets[wi];
      if (wp.kind !== 'img' || wp.imgLoaded) continue;
      var src = wp.imgSrc || '';
      if (!src) { wp.imgLoaded = true; wp.imgData = null; continue; }

      // Inline data: images — decode immediately without a network fetch
      if (src.startsWith('data:')) {
        var comma     = src.indexOf(',');
        var meta      = comma > 5 ? src.slice(5, comma) : '';
        var dataStr   = comma >= 0 ? src.slice(comma + 1) : '';
        var isBase64  = meta.indexOf(';base64') >= 0;
        var rawBytes  = isBase64 ? decodeBase64(dataStr) : Array.from(dataStr).map(c => c.charCodeAt(0));
        var decoded: DecodedImage | null = decodeBMP(rawBytes);
        if (!decoded) {
          // Try PNG
          if (rawBytes.length > 8 && rawBytes[0] === 0x89 && rawBytes[1] === 0x50) {
            try { decoded = decodePNG(new Uint8Array(rawBytes)); } catch (_e) {}
          }
          // Try JPEG
          if (!decoded && rawBytes.length > 3 && rawBytes[0] === 0xFF && rawBytes[1] === 0xD8) {
            try { decoded = decodeJPEG(new Uint8Array(rawBytes)); } catch (_e) {}
          }
          if (!decoded) {
            var pngDim0 = readPNGDimensions(rawBytes);
            if (pngDim0) {
              wp.imgNatW = pngDim0.w; wp.pw = Math.min(pngDim0.w, 600);
              wp.imgNatH = pngDim0.h; wp.ph = Math.round(pngDim0.h * wp.pw / pngDim0.w);
            }
          }
        }
        if (decoded) { wp.imgData = decoded.data; wp.pw = decoded.w; wp.ph = decoded.h; }
        wp.imgLoaded = true;
        this._imgCache.set(src, decoded);
        this._dirty = true;
        continue;
      }

      if (this._imgCache.has(src)) {
        var cached = this._imgCache.get(src)!;
        if (cached) { wp.imgData = cached.data; wp.pw = cached.w; wp.ph = cached.h; }
        wp.imgLoaded = true;
        continue;
      }

      pendingCount++;
      var resolved = this._resolveHref(src);
      var self = this;
      (function(ww: typeof wp, srcURL: string, rawSrc: string) {
        os.fetchAsync(srcURL, function(resp: FetchResponse | null, _err?: string) {
          if (resp && resp.status === 200 && resp.body.length >= 2) {
            var imgDecoded: DecodedImage | null = null;
            var b0 = resp.body[0] ?? 0;
            var b1 = resp.body[1] ?? 0;
            if (b0 === 0x42 && b1 === 0x4D) {
              // BMP — full pixel decode
              imgDecoded = decodeBMP(resp.body);
            } else if (b0 === 0x89 && b1 === 0x50) {
              // PNG — full decode using inline TypeScript PNG decoder
              try { imgDecoded = decodePNG(new Uint8Array(resp.body)); } catch (_e) {}
            } else if (b0 === 0xFF && b1 === 0xD8) {
              // JPEG — full decode using inline TypeScript JPEG decoder
              try { imgDecoded = decodeJPEG(new Uint8Array(resp.body)); } catch (_e) {}
            } else {
              // Other — read dimensions only, show sized placeholder
              var pDim = readPNGDimensions(resp.body);
              if (pDim) {
                ww.imgNatW = pDim.w; ww.pw = Math.min(pDim.w, 600);
                ww.imgNatH = pDim.h; ww.ph = Math.round(pDim.h * ww.pw / pDim.w);
              }
            }
            self._imgCache.set(rawSrc, imgDecoded);
            if (imgDecoded) { ww.imgData = imgDecoded.data; ww.pw = imgDecoded.w; ww.ph = imgDecoded.h; }
          } else {
            self._imgCache.set(rawSrc, null);
          }
          ww.imgLoaded = true;
          self._dirty  = true;
        });
      })(wp, resolved, src);
    }

    // ── Also fetch CSS background-image url() sources (item 386) ──────────────
    var bgUrlSet = new Set<string>();
    for (var _bgi = 0; _bgi < this._pageLines.length; _bgi++) {
      var _bgUrl = this._pageLines[_bgi].bgImageUrl;
      if (_bgUrl && !this._bgImageMap.has(_bgUrl)) bgUrlSet.add(_bgUrl);
    }
    bgUrlSet.forEach(function(rawBgUrl) {
      var resolvedBg = self._resolveHref(rawBgUrl);
      pendingCount++;
      (function(bgSrc: string) {
        os.fetchAsync(resolvedBg, function(resp: FetchResponse | null) {
          var bgDec: DecodedImage | null = null;
          if (resp && resp.status === 200) {
            var _bb = resp.body || [];
            var _b0 = _bb[0] ?? 0, _b1 = _bb[1] ?? 0;
            if (_b0 === 0x89 && _b1 === 0x50) {
              try { bgDec = decodePNG(new Uint8Array(_bb)); } catch (_e) {}
            } else if (_b0 === 0xFF && _b1 === 0xD8) {
              try { bgDec = decodeJPEG(new Uint8Array(_bb)); } catch (_e) {}
            } else {
              bgDec = decodeBMP(_bb);
            }
          }
          self._bgImageMap.set(bgSrc, bgDec);
          pendingCount--;
          if (pendingCount === 0) { self._imgsFetching = false; }
          self._dirty = true;
        });
      })(rawBgUrl);
    });

    this._imgsFetching = pendingCount > 0;
  }

  // ── Navigation ────────────────────────────────────────────────────────────

  /** Public entry-point: navigate the browser to `url`. */
  navigate(url: string): void { this._navigate(url); }

  private _navigate(url: string): void {
    // Flush all per-page caches (layout, styles, images) before loading new page
    flushAllCaches();
    flushCSSMatchCache();
    resetCSSVars();
    this._histIdx++;
    this._history.splice(this._histIdx);
    this._history.push({ url, title: url });
    this._startFetch(url);
  }

  private _resolveHref(href: string): string {
    if (href.startsWith('http://') || href.startsWith('https://') ||
        href.startsWith('about:')  || href.startsWith('data:')    ||
        href.startsWith('blob:')) {
      return href;
    }
    if (href.startsWith('//')) {
      return (this._pageURL.startsWith('https://') ? 'https' : 'http') + ':' + href;
    }
    // Use <base href> if page provided one
    var base = this._pageBaseURL || this._pageURL;
    if (href.startsWith('/')) {
      var p = parseURL(base);
      if (!p) return href;
      var ps = (p.protocol === 'http' && p.port === 80) ||
               (p.protocol === 'https' && p.port === 443) ? '' : ':' + p.port;
      return p.protocol + '://' + p.host + ps + href;
    }
    if (href.startsWith('#')) return base.split('#')[0] + href;
    return base.replace(/\/[^/]*$/, '/') + href;
  }

  private _goBack(): void {
    if (this._histIdx <= 0) return;
    this._histIdx--;
    this._startFetch(this._history[this._histIdx].url);
  }

  private _goForward(): void {
    if (this._histIdx >= this._history.length - 1) return;
    this._histIdx++;
    this._startFetch(this._history[this._histIdx].url);
  }

  private _reload(): void { this._startFetch(this._pageURL); }

  /**
   * Hard reload: clear all caches for the current page before re-fetching.
   * Bound to Shift+R in the browser navigation mode.
   * Implements item 624: hard reload — clear cache for current page (Ctrl+Shift+R).
   */
  private _hardReload(): void {
    // Flush all browser-level caches (layout, style, fetch, image, etc.)
    flushAllCaches();
    flushCSSMatchCache();
    // Also clear the local image cache for this tab
    this._imgCache.clear();
    // Re-navigate from scratch
    this._startFetch(this._pageURL);
  }

  private _cancelFetch(): void {
    if (this._fetchCoroId >= 0) { os.cancel(this._fetchCoroId); this._fetchCoroId = -1; }
    if (this._pageJS) { this._pageJS.dispose(); this._pageJS = null; }
  }

  /** Toggle reader mode and re-render the current page (item 634). */
  private _toggleReaderMode(): void {
    this._readerMode = !this._readerMode;
    if (this._pageSource) {
      this._showHTML(this._pageSource, this._pageTitle, this._pageURL);
    }
    this._scrollY = 0;
    this._dirty   = true;
  }

  /** [Item 635] Save rendered page text to /tmp/print-<ts>.txt. */
  private _printPage(): void {
    var lines: string[] = [];
    var bar = ''; for (var bi = 0; bi < 72; bi++) bar += '=';
    lines.push(bar);
    lines.push('  ' + (this._pageTitle || this._pageURL));
    lines.push('  ' + this._pageURL);
    lines.push(bar);
    lines.push('');
    for (var li = 0; li < this._pageLines.length; li++) {
      var pl = this._pageLines[li];
      var rowText = '';
      for (var si = 0; si < pl.nodes.length; si++) rowText += pl.nodes[si].text;
      lines.push(rowText);
    }
    os.fs.mkdir('/tmp');
    var dest = '/tmp/print-' + Date.now() + '.txt';
    var saved = os.fs.write(dest, lines.join('\n'));
    this._status = saved ? 'Printed to ' + dest : 'Print failed: write error';
    this._dirty  = true;
  }

  /**
   * Extract readable article content from raw HTML (item 634).
   *
   * Strategy:
   *  1. Remove script, style, nav, header, footer, aside blocks.
   *  2. If <article> or <main> exists, extract just that.
   *  3. Wrap in clean HTML with readable styling.
   */
  private _extractReaderContent(html: string): string {
    // Remove blocks we never want in reader mode
    var stripped = html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, '')
      .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<aside\b[^>]*>[\s\S]*?<\/aside>/gi, '');

    // Try to find <article> first, then <main>
    var articleMatch = stripped.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
    var mainMatch    = stripped.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
    var bodyMatch    = stripped.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);

    var content = (articleMatch && articleMatch[1]) ||
                  (mainMatch    && mainMatch[1])    ||
                  (bodyMatch    && bodyMatch[1])    ||
                  stripped;

    // Extract the page title for reader view
    var titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    var title = titleMatch ? titleMatch[1].trim() : 'Reader View';

    return [
      '<!DOCTYPE html><html><head><title>' + title + ' — Reader View</title>',
      '<style>',
      'body { max-width: 680px; margin: 0 auto; padding: 24px 16px;',
      '       font-size: 18px; line-height: 1.6; color: #222; background: #fff; }',
      'h1,h2,h3,h4 { margin-top: 1.2em; }',
      'p { margin: 0.8em 0; }',
      'img { max-width: 100%; height: auto; }',
      'pre,code { background: #f4f4f4; padding: 2px 4px; }',
      '</style>',
      '</head><body>',
      '<h1 style="border-bottom:1px solid #ccc;padding-bottom:8px">' + title + '</h1>',
      content,
      '</body></html>',
    ].join('\n');
  }

  private _startFetch(rawURL: string): void {
    this._cancelFetch();
    this._pageURL       = rawURL;
    this._urlInput      = rawURL;
    this._loading       = true;
    this._scrollY       = 0;
    this._hoverHref     = '';
    this._hoverElId     = '';
    this._focusedWidgetName = '';
    this._status        = 'Loading...';
    this._dirty         = true;
    this._focusedWidget = -1;
    if (this._histIdx >= 0 && this._histIdx < this._history.length) {
      this._history[this._histIdx].url = rawURL;
    }

    var parsed = parseURL(rawURL);
    if (!parsed) { this._showError(rawURL, 'Invalid URL'); return; }

    // ── blob: URLs (item 639) ─────────────────────────────────────────────────
    // blob: URLs are created by URL.createObjectURL() in page JS.
    // Their content is stored in the jsruntime _blobStore and retrieved here.
    if (rawURL.startsWith('blob:')) {
      var blobEntry = getBlobURLContent(rawURL);
      if (!blobEntry) { this._showError(rawURL, 'Blob URL not found or revoked'); return; }
      this._pageSource = blobEntry.content;
      this._loading    = false;
      var blobType = blobEntry.type.toLowerCase();
      if (blobType.indexOf('text/html') >= 0 || blobType.indexOf('application/xhtml') >= 0) {
        this._showHTML(blobEntry.content, '', rawURL);
      } else {
        this._showPlainText(blobEntry.content, rawURL);
      }
      return;
    }

    // ── data: URLs ───────────────────────────────────────────────────────────
    if (parsed.protocol === 'data') {
      var mt   = (parsed.dataMediaType || 'text/plain').toLowerCase();
      var body = parsed.dataBody || '';
      if (mt.indexOf(';base64') >= 0) {
        var bytes = decodeBase64(body);
        body = bytes.map(b => String.fromCharCode(b)).join('');
      } else {
        try { body = decodeURIComponent(body.replace(/\+/g, ' ')); } catch (_) {}
      }
      this._pageSource = body;
      this._loading    = false;
      if (mt.indexOf('text/html') >= 0 || mt.indexOf('application/xhtml') >= 0) {
        this._showHTML(body, '', rawURL);
      } else {
        this._showPlainText(body, rawURL);
      }
      return;
    }

    // ── about: URLs ──────────────────────────────────────────────────────────
    if (parsed.protocol === 'about') {
      var pg = '';
      switch (parsed.path) {
        case 'blank':     pg = '';                      break;
        case 'jsos':      pg = aboutJsosHTML();         break;
        case 'jstest':    pg = aboutJstestHTML();        break;
        case 'history':   pg = this._historyHTML();     break;
        case 'bookmarks': pg = this._bookmarksHTML();   break;
        case 'source':    pg = this._sourceHTML();      break;
        default: pg = errorHTML(rawURL, 'Unknown about: page'); break;
      }
      this._pageSource = pg;
      this._showHTML(pg, parsed.path, rawURL);
      return;
    }

    // ── HTTP / HTTPS ─────────────────────────────────────────────────────────
    var self = this;
    this._fetchCoroId = os.fetchAsync(rawURL, function(resp: FetchResponse | null, err?: string) {
      self._fetchCoroId = -1;
      if (!resp) { self._showError(rawURL, err || 'Network error'); return; }
      var finalURL = resp.finalURL;
      self._pageURL  = finalURL;
      self._urlInput = finalURL;
      if (self._histIdx >= 0 && self._histIdx < self._history.length) {
        self._history[self._histIdx].url   = finalURL;
        self._history[self._histIdx].title = finalURL;
      }
      os.debug.log('[browser] HTTP', resp.status, resp.body.length + 'B');
      if (err) { self._showError(finalURL, err); return; }
      self._pageSource = resp.bodyText;
      // Parse Content-Security-Policy header if present
      var cspHeader = resp.headers.get('content-security-policy');
      self._cspPolicy = cspHeader ? parseCSP(cspHeader) : null;
      var ct = resp.headers.get('content-type') || 'text/html';
      if (ct.indexOf('application/json') >= 0 || ct.indexOf('text/json') >= 0) {
        self._showHTML(jsonViewerHTML(finalURL, resp.bodyText), 'JSON', finalURL);
      } else if (ct.indexOf('text/html') >= 0 || ct.indexOf('application/xhtml') >= 0) {
        self._showHTML(resp.bodyText, '', finalURL);
      } else {
        self._showPlainText(resp.bodyText, finalURL);
      }
      self._status = 'HTTP ' + resp.status + '  ' +
                     (finalURL.split('/')[2] || finalURL) + '  ' + resp.body.length + ' B';
      self._dirty  = true;
    });
  }

  /** Expand the damage rectangle to include a new dirty region (item 2.4). */
  private _expandDamage(x: number, y: number, w: number, h: number): void {
    if (!this._damage) { this._damage = { x, y, w, h }; return; }
    var rx = Math.min(this._damage.x, x);
    var ry = Math.min(this._damage.y, y);
    this._damage = {
      x: rx, y: ry,
      w: Math.max(this._damage.x + this._damage.w, x + w) - rx,
      h: Math.max(this._damage.y + this._damage.h, y + h) - ry,
    };
  }

  private _scrollBy(delta: number): void {
    var oldScroll = this._scrollY;
    this._scrollY = Math.max(0, Math.min(this._maxScrollY, this._scrollY + delta));
    var actual = this._scrollY - oldScroll;
    // Scroll-blit optimisation: shift existing pixels instead of full repaint (item 2.2)
    if (actual !== 0 && this._win && !this._loading && Math.abs(actual) < this._contentH()) {
      var y0 = TAB_BAR_H + TOOLBAR_H;
      var ch = this._contentH();
      this._win.canvas.scrollBlit(actual, y0, ch);
      // Mark only the newly exposed strip as damaged (item 2.4)
      var w = this._win.canvas.width;
      if (actual > 0) {
        this._expandDamage(0, y0 + ch - actual, w, actual);
      } else {
        this._expandDamage(0, y0, w, -actual);
      }
    }
    this._dirty = true;
    // Fire scroll event to page JS so scroll listeners and IntersectionObserver update
    if (actual !== 0 && this._pageJS) {
      this._pageJS.fireEvent('scroll', this._scrollY);
    }
  }

  private _hitTestLink(x: number, cy: number): string {
    for (var i = 0; i < this._pageLines.length; i++) {
      var line = this._pageLines[i];
      var lineTop = line.fixedViewportY !== undefined ? line.fixedViewportY + this._scrollY : line.y;
      if (lineTop > cy) { if (line.fixedViewportY === undefined) break; else continue; }
      if (lineTop + line.lineH <= cy) continue;
      for (var j = 0; j < line.nodes.length; j++) {
        var span = line.nodes[j];
        if (span.href && x >= span.x && x <= span.x + span.text.length * CHAR_W) {
          return span.href;
        }
      }
    }
    return '';
  }

  /** Returns the full span (href + download hint) under (x, cy). (item 636) */
  private _hitTestLinkFull(x: number, cy: number): RenderedSpan | null {
    for (var i = 0; i < this._pageLines.length; i++) {
      var line = this._pageLines[i];
      // Fixed elements: viewport-relative, so doc coord = fixedViewportY + scrollY
      var lineTop = line.fixedViewportY !== undefined ? line.fixedViewportY + this._scrollY : line.y;
      if (lineTop > cy) { if (line.fixedViewportY === undefined) break; else continue; }
      if (lineTop + line.lineH <= cy) continue;
      for (var j = 0; j < line.nodes.length; j++) {
        var span = line.nodes[j];
        if (span.noClick) continue;
        if (span.href && x >= span.x && x <= span.x + span.text.length * CHAR_W) {
          return span;
        }
      }
    }
    return null;
  }

  /** Returns ANY span at (x, cy), including those without href (for JS click dispatch). */
  private _hitTestAnySpan(x: number, cy: number): RenderedSpan | null {
    for (var i = 0; i < this._pageLines.length; i++) {
      var line = this._pageLines[i];
      var lineTop = line.fixedViewportY !== undefined ? line.fixedViewportY + this._scrollY : line.y;
      if (lineTop > cy) { if (line.fixedViewportY === undefined) break; else continue; }
      if (lineTop + line.lineH <= cy) continue;
      for (var j = 0; j < line.nodes.length; j++) {
        var span = line.nodes[j];
        if (span.noClick) continue;
        if (x >= span.x && x <= span.x + span.text.length * CHAR_W) {
          return span;
        }
      }
    }
    return null;
  }

  /** Download a URL to /downloads/<filename>. (item 636) */
  private _downloadURL(rawURL: string, filename: string): void {
    var self = this;
    var dlURL = this._resolveHref(rawURL);
    this._status = 'Downloading ' + filename + '...';
    this._dirty  = true;
    // For blob: URLs, retrieve content directly
    if (dlURL.startsWith('blob:')) {
      var blobEntry = getBlobURLContent(dlURL);
      if (!blobEntry) { self._status = 'Download failed: blob not found'; self._dirty = true; return; }
      os.fs.mkdir('/downloads');
      var saved = os.fs.write('/downloads/' + filename, blobEntry.content);
      self._status = saved ? 'Saved to /downloads/' + filename : 'Download failed: write error';
      self._dirty  = true;
      return;
    }
    // For data: URLs, decode inline
    var parsed = parseURL(dlURL);
    if (parsed && parsed.protocol === 'data') {
      var body = parsed.dataBody || '';
      if ((parsed.dataMediaType || '').indexOf(';base64') >= 0) {
        var bytes = decodeBase64(body);
        body = bytes.map(function(b: number) { return String.fromCharCode(b); }).join('');
      } else {
        try { body = decodeURIComponent(body.replace(/\+/g, ' ')); } catch (_) {}
      }
      os.fs.mkdir('/downloads');
      var saved2 = os.fs.write('/downloads/' + filename, body);
      self._status = saved2 ? 'Saved to /downloads/' + filename : 'Download failed: write error';
      self._dirty  = true;
      return;
    }
    // HTTP fetch
    this._fetchCoroId = os.fetchAsync(dlURL, function(resp: FetchResponse | null, err?: string) {
      self._fetchCoroId = -1;
      if (!resp || err) { self._status = 'Download failed: ' + (err || 'network error'); self._dirty = true; return; }
      os.fs.mkdir('/downloads');
      var saved3 = os.fs.write('/downloads/' + filename, resp.bodyText);
      self._status = saved3 ? 'Saved to /downloads/' + filename : 'Download failed: write error';
      self._dirty  = true;
    });
  }

  // ── URL bar autocomplete (item 632) ──────────────────────────────────────

  /** Compute up to 5 matching history + bookmark entries for the given input. */
  private _computeURLSuggestions(input: string): HistoryEntry[] {
    if (!input || input.length < 1) return [];
    var q   = input.toLowerCase();
    var seen = new Set<string>();
    var out: HistoryEntry[] = [];
    // Search history (most recent first — history is in order, highest idx = most recent)
    for (var hi = this._history.length - 1; hi >= 0; hi--) {
      var he = this._history[hi]!;
      if (seen.has(he.url)) continue;
      if (he.url.toLowerCase().indexOf(q) >= 0 || (he.title && he.title.toLowerCase().indexOf(q) >= 0)) {
        seen.add(he.url);
        out.push(he);
        if (out.length >= 5) return out;
      }
    }
    // Then bookmarks
    for (var bi = 0; bi < this._bookmarks.length; bi++) {
      var bk = this._bookmarks[bi]!;
      if (seen.has(bk.url)) continue;
      if (bk.url.toLowerCase().indexOf(q) >= 0 || (bk.title && bk.title.toLowerCase().indexOf(q) >= 0)) {
        seen.add(bk.url);
        out.push(bk);
        if (out.length >= 5) return out;
      }
    }
    return out;
  }

  // ── Bookmarks ─────────────────────────────────────────────────────────────

  private _addBookmark(): void {
    for (var bi = 0; bi < this._bookmarks.length; bi++) {
      if (this._bookmarks[bi].url === this._pageURL) {
        this._status = 'Already bookmarked'; this._dirty = true; return;
      }
    }
    this._bookmarks.push({ url: this._pageURL, title: this._pageTitle });
    this._status = 'Bookmarked: ' + this._pageTitle; this._dirty = true;
  }

  private _bookmarksHTML(): string {
    if (!this._bookmarks.length)
      return '<h1>Bookmarks</h1><p>No bookmarks yet. Press <kbd>Ctrl+D</kbd> to bookmark a page.</p>';

    // Group bookmarks by folder (item 631)
    var folderMap = new Map<string, HistoryEntry[]>();
    for (var i = 0; i < this._bookmarks.length; i++) {
      var bk = this._bookmarks[i];
      var folder = bk.folder || '';
      if (!folderMap.has(folder)) folderMap.set(folder, []);
      folderMap.get(folder)!.push(bk);
    }

    var ls = ['<h1>Bookmarks</h1>'];

    // Render unfiled bookmarks first, then folders
    var unfiledBks = folderMap.get('') || [];
    if (unfiledBks.length > 0) {
      ls.push('<ul>');
      for (var ui = 0; ui < unfiledBks.length; ui++) {
        var ubk = unfiledBks[ui];
        ls.push('<li><a href="' + ubk.url + '">' + (ubk.title || ubk.url) + '</a></li>');
      }
      ls.push('</ul>');
    }

    // Render each folder
    folderMap.forEach(function(bks: HistoryEntry[], fname: string) {
      if (!fname) return; // already rendered unfiled
      ls.push('<h2>' + fname + '</h2><ul>');
      for (var fi = 0; fi < bks.length; fi++) {
        var fbk = bks[fi];
        ls.push('<li><a href="' + fbk.url + '">' + (fbk.title || fbk.url) + '</a></li>');
      }
      ls.push('</ul>');
    });

    return ls.join('\n');
  }

  // ── Find in page ──────────────────────────────────────────────────────────

  private _openFind(): void {
    this._findMode = true; this._findQuery = '';
    this._findHits = []; this._findCur = 0;
    this._clearSearchHighlights(); this._dirty = true;
  }

  private _clearFind(): void { this._findMode = false; this._clearSearchHighlights(); this._dirty = true; }

  private _clearSearchHighlights(): void {
    for (var i = 0; i < this._pageLines.length; i++) {
      var ns = this._pageLines[i].nodes;
      for (var j = 0; j < ns.length; j++) { delete ns[j].searchHit; delete ns[j].hitIdx; }
    }
  }

  private _doFind(): void {
    this._clearSearchHighlights(); this._findHits = [];
    if (!this._findQuery) return;
    var q = this._findQuery.toLowerCase(); var idx = 0;
    for (var i = 0; i < this._pageLines.length; i++) {
      var ns = this._pageLines[i].nodes;
      for (var j = 0; j < ns.length; j++) {
        if (ns[j].text.toLowerCase().indexOf(q) >= 0) {
          ns[j].searchHit = true; ns[j].hitIdx = idx;
          this._findHits.push({ lineIdx: i, spanIdx: j }); idx++;
        }
      }
    }
    this._findCur = 0;
    if (this._findHits.length > 0) this._scrollToFindHit();
  }

  private _cycleFind(dir: number): void {
    if (!this._findHits.length) return;
    this._findCur = (this._findCur + dir + this._findHits.length) % this._findHits.length;
    this._scrollToFindHit(); this._dirty = true;
  }

  private _scrollToFindHit(): void {
    if (this._findCur >= this._findHits.length) return;
    var hit  = this._findHits[this._findCur];
    var line = this._pageLines[hit.lineIdx];
    if (!line) return;
    var ch = this._contentH();
    if (line.y < this._scrollY || line.y + line.lineH > this._scrollY + ch) {
      this._scrollY = Math.max(0, line.y - Math.floor(ch / 3));
    }
    this._dirty = true;
  }

  // ── Page display ──────────────────────────────────────────────────────────

  private _showHTML(html: string, fallbackTitle: string, url: string): void {
    // Reader mode (item 634): extract article content and present cleanly
    if (this._readerMode) {
      html = this._extractReaderContent(html);
    }

    // ── Reset CSS variable registry for new page ─────────────────────────────
    resetCSSVars();
    // ── Update viewport dimensions for vw/vh unit resolution ─────────────────
    setViewport(
      this._win ? this._win.canvas.width : 1920,
      this._win ? this._contentH()       : 1080,
    );

    // ── Pass 1: collect <style> blocks + <link rel="stylesheet"> hrefs ────────
    var _shT0 = Date.now();
    os.debug.log('[browser] showHTML', (html.length / 1024).toFixed(1) + 'KB', url.slice(0, 60));
    // Tokenize ONCE — all three parse passes (pass1, pass2, r3) reuse the same
    // token array.  On Google's ~100KB HTML this saves 2 redundant O(HTML) scans
    // and eliminates all associated string allocation in passes 2 and 3.
    var _htmlTokens = tokenise(html);
    pumpCursor();  // keep cursor alive after tokenise (~200-500ms)
    var r = parseHTMLFromTokens(_htmlTokens);
    pumpCursor();  // keep cursor alive after pass1 parse (~500-1500ms)
    var _shT1 = Date.now();
    var _pass1NodeCount = r.nodes.length;
    os.debug.log('[browser] pass1:', r.nodes.length, 'nodes', r.scripts.length, 'scripts', r.styles.length, 'styles', r.styleLinks.length, 'cssLinks', 'in', (_shT1 - _shT0) + 'ms');
    // ── Pre-fetch external scripts ASAP — overlaps download with CSS parse + pass2 ──
    // deduplicatedFetch dedup (30s window) ensures loadExternalScript joins in-flight
    // fetch instead of starting a new one.  ~4s head-start on 500KB Google XJS bundle.
    for (var _preSci = 0; _preSci < r.scripts.length; _preSci++) {
      var _preSrec = r.scripts[_preSci];
      if (_preSrec && !_preSrec.inline && _preSrec.src && _preSrec.type !== 'module') {
        JITBrowserEngine.prefetchURL(this._resolveHref(_preSrec.src));
      }
    }
    this._forms       = r.forms;
    this._pageBaseURL = r.baseURL ? this._resolveHref(r.baseURL) : '';

    // ── Build inline stylesheet — serve from cache on same-site revisits where
    // <style> blocks are identical (saves ~1.6s re-parse of 800+ rules).
    var sheets: CSSRule[] = [];
    var _styleKey = r.styles.join('\n');
    var _cachedInlineSheets = _styleKey.length > 0 ? this._inlineStyleCache.get(_styleKey) : undefined;
    if (_cachedInlineSheets) {
      sheets = _cachedInlineSheets;
      os.debug.log('[browser] parseStylesheet: inline cache hit', sheets.length, 'rules');
    } else {
      try {
        sheets = r.styles.length > 0 ? parseStylesheet(_styleKey) : [];
        pumpCursor();  // keep cursor alive after stylesheet parse (~500-1600ms)
        if (sheets.length > 0) this._inlineStyleCache.set(_styleKey, sheets);
      } catch (_cssErr) {
        os.debug.log('[browser] parseStylesheet THREW:', String(_cssErr).slice(0, 200));
      }
    }
    var _shT2 = Date.now();
    os.debug.log('[browser] parseStylesheet:', sheets.length, 'rules in', (_shT2 - _shT1) + 'ms');

    // ── Pre-apply cached external CSS — avoids deferred re-layout on same-site nav
    var _uncachedCSSLinks: string[] = [];
    for (var _cssi = 0; _cssi < r.styleLinks.length; _cssi++) {
      var _cssHref = this._resolveHref(r.styleLinks[_cssi]!);
      var _preCached = this._cssCache.get(_cssHref);
      if (_preCached) {
        // Already have this CSS — fold it into sheets right now
        sheets = sheets.concat(_preCached);
      } else {
        _uncachedCSSLinks.push(_cssHref);
      }
    }
    os.debug.log('[browser] css:', sheets.length, 'rules, uncached:', _uncachedCSSLinks.length);

    // ── Start CSS fetch EARLY — overlaps network with pass2 + _layoutPage ────────
    // JS is single-threaded: callbacks only fire after _showHTML() returns so they
    // see the FINAL values of `sheets`, `_cachedIndex`, `_htmlTokens` (captured by
    // reference via closure).  Starting fetches here instead of after _layoutPage
    // overlaps ~2s of CSS download with ~3s of CSS matching in pass2.
    var _self_css = this;
    var _newCSSRules: CSSRule[] = [];
    var _cssPending = _uncachedCSSLinks.length;
    if (_uncachedCSSLinks.length > 0) {
      for (var _uli = 0; _uli < _uncachedCSSLinks.length; _uli++) {
        (function(cssURL: string) {
          os.fetchAsync(cssURL, function(resp: FetchResponse | null) {
            if (resp && resp.status === 200 && resp.bodyText.trim()) {
              var _fetchedRules = parseStylesheet(resp.bodyText);
              pumpCursor();  // keep cursor alive after external CSS parse
              // Cache rules by URL — instant application on next same-site navigation
              _self_css._cssCache.set(cssURL, _fetchedRules);
              for (var _ri = 0; _ri < _fetchedRules.length; _ri++) _newCSSRules.push(_fetchedRules[_ri]);
            }
            _cssPending--;
            if (_cssPending === 0 && _newCSSRules.length > 0) {
              // Re-parse and re-layout with all sheets (inline + cached + newly fetched).
              // Update `sheets` in-place so the `rerender` closure (used when JS
              // mutates the DOM) also sees the external CSS — not just inline rules.
              sheets = sheets.concat(_newCSSRules);
              // Rebuild cached index since sheets changed (new rules added)
              // Also flush CSS match cache so next rerender is fresh
              flushCSSMatchCache();
              _cachedIndex = buildSheetIndex(sheets);
              var r3 = parseHTMLFromTokens(_htmlTokens, sheets, _cachedIndex);  // reuses tokens — no re-tokenize
              pumpCursor();  // keep cursor alive after CSS re-parse
              // Fallback: if external CSS hid most content, re-parse ignoring display:none
              if (r3.nodes.length < 10 && _pass1NodeCount > 20) {
                r3 = parseHTMLFromTokens(_htmlTokens, sheets, _cachedIndex, true);
                pumpCursor();
              }
              _self_css._forms       = r3.forms;
              _self_css._pageBaseURL = r3.baseURL ? _self_css._resolveHref(r3.baseURL) : '';
              _self_css._layoutPage(r3.nodes as any, r3.widgets as any, r3.title || fallbackTitle || url, url);
              pumpCursor();  // keep cursor alive after CSS re-layout
            }
          });
        })(_uncachedCSSLinks[_uli]!);
      }
    }

    // ── Pass 2: re-parse with all available CSS (inline + any cached external) ─
    // Build the RuleIndex once here; cache it so the rerender closure and r3 path
    // can reuse it without rebuilding 800+ rules on every DOM mutation tick.
    var _cachedIndex: RuleIndex | null = sheets.length > 0 ? buildSheetIndex(sheets) : null;
    if (sheets.length > 0) {
      try {
        var _shT2b = Date.now();
        r = parseHTMLFromTokens(_htmlTokens, sheets, _cachedIndex);  // reuses tokens — no re-tokenize
        pumpCursor();  // keep cursor alive after pass2 parse (~500-2000ms)
        os.debug.log('[browser] pass2 parseHTML:', r.nodes.length, 'nodes in', (Date.now() - _shT2b) + 'ms');

        // Fallback: if CSS display:none hid nearly everything (JS-dependent page)
        // and pass1 had substantially more content, re-parse ignoring display:none.
        // This ensures JS-heavy pages like Google still show readable content.
        if ((r.nodes.length < 10 || r.nodes.length < _pass1NodeCount * 0.4) && _pass1NodeCount > 20) {
          os.debug.log('[browser] pass2 too few nodes (' + r.nodes.length + ' vs pass1=' + _pass1NodeCount + ') — re-parsing without display:none');
          var _shT2c = Date.now();
          r = parseHTMLFromTokens(_htmlTokens, sheets, _cachedIndex, true);  // ignoreDisplayNone=true
          pumpCursor();
          os.debug.log('[browser] pass2-fallback:', r.nodes.length, 'nodes', r.widgets.length, 'widgets in', (Date.now() - _shT2c) + 'ms');
        }

        this._forms       = r.forms;
        this._pageBaseURL = r.baseURL ? this._resolveHref(r.baseURL) : '';
      } catch (_p2Err) {
        os.debug.log('[browser] pass2 parseHTML THREW:', String(_p2Err).slice(0, 200));
      }
    }

    // Dispose any previous page JS before setting up the new page
    if (this._pageJS) { this._pageJS.dispose(); this._pageJS = null; }
    var _shT3 = Date.now();
    os.debug.log('[browser] parse:', r.scripts.length, 'scripts,', r.nodes.length, 'nodes @', url.slice(0, 72));
    this._layoutPage(r.nodes as any, r.widgets as any, r.title || fallbackTitle || url, url);
    pumpCursor();  // keep cursor alive after layout (~300-1000ms)
    os.debug.log('[browser] layoutPage in', (Date.now() - _shT3) + 'ms, total showHTML so far', (Date.now() - _shT0) + 'ms');

    // ── Favicon: fetch <link rel="icon"> image and store on current tab (item 628) ──
    if (r.favicon) {
      var _faviconUrl = this._resolveHref(r.favicon);
      var _self_fav   = this;
      var _favTabIdx  = this._curTab;
      os.fetchAsync(_faviconUrl, function(resp: FetchResponse | null) {
        if (resp && resp.status === 200) {
          var _bytes: number[] = resp.body || [];
          var _favDecoded: DecodedImage | null = null;
          if (_bytes.length > 8 && _bytes[0] === 0x89 && _bytes[1] === 0x50) {
            try { _favDecoded = decodePNG(new Uint8Array(_bytes)); } catch (_e) {}
          }
          if (!_favDecoded) _favDecoded = decodeBMP(_bytes);
          if (_favDecoded && _favDecoded.data) {
            var _favTab = _self_fav._tabs[_favTabIdx];
            if (_favTab) {
              _favTab.faviconData = _favDecoded.data;
              _favTab.faviconW    = _favDecoded.w;
              _favTab.faviconH    = _favDecoded.h;
              _favTab.favicon     = _faviconUrl;
              _self_fav._dirty    = true;
            }
          }
        }
      });
    }

    // Start JS engine for the new page (after layout so widgets have positions).
    os.debug.log('[browser] about to createPageJS, scripts:', r.scripts.length);
    if (r.scripts.length > 0) {
      var self2 = this;
      this._jsStartMs = Date.now();
      // Track dynamically-injected <style> content already folded into sheets,
      // so the rerender closure doesn't re-parse and re-append the same Google
      // CSS on every DOM mutation (which would grow sheets unboundedly).
      var _seenDynStyles = new Set<string>();
      this._pageJS = createPageJS(html, r.scripts, {
        baseURL: url,
        navigate: (u: string) => self2._navigate(u),
        setTitle: (t: string) => { self2._pageTitle = t; self2._dirty = true; },
        alert:   (msg: string) => { self2._status = 'Alert: ' + msg; self2._dirty = true; os.debug.log('[browser alert]', msg); },
        confirm: (_msg: string): boolean => true,   // no blocking UI — default accept
        prompt:  (_msg: string, def: string): string => def,
        rerender: (tokens: any[]) => {
          // Re-parse the mutated body from pre-tokenised tokens (item 1.2).
          // Wrap in synthetic <body> open/close for the parser.
          var bodyTokens: any[] = [{ kind: 'open', tag: 'body', text: '', attrs: new Map() }];
          for (var _ti = 0; _ti < tokens.length; _ti++) bodyTokens.push(tokens[_ti]);
          bodyTokens.push({ kind: 'close', tag: 'body', text: '', attrs: new Map() });
          // Check for dynamically injected <style> tags (e.g. styled-components, MUI).
          // To avoid a full CSS re-parse on every rerender, do a cheap check first:
          // only run the style-extraction pass if any token is a 'style' tag.
          var _hasStyleTag = false;
          for (var _si2 = 0; _si2 < tokens.length; _si2++) {
            if (tokens[_si2] && tokens[_si2].tag === 'style') { _hasStyleTag = true; break; }
          }
          if (_hasStyleTag) {
            // Merge any new inline styles from JS-injected <style> tags into sheets.
            // Deduplicate by style text content — Google re-injects the same <style>
            // block on every DOM mutation which would grow sheets unboundedly.
            // Extract style text directly from tokens (open/text/close triples) —
            // avoids a redundant full parseHTMLFromTokens call just to get style content.
            var _styleTexts: string[] = [];
            var _inStyleTag = false;
            for (var _si3 = 0; _si3 < tokens.length; _si3++) {
              var _stok = tokens[_si3];
              if (!_stok) continue;
              if (_stok.kind === 'open'  && _stok.tag === 'style') { _inStyleTag = true;  continue; }
              if (_stok.kind === 'close' && _stok.tag === 'style') { _inStyleTag = false; continue; }
              if (_inStyleTag && _stok.kind === 'text' && _stok.text) _styleTexts.push(_stok.text);
            }
            if (_styleTexts.length > 0) {
              var _dynStyles = _styleTexts.join('\n');
              if (!_seenDynStyles.has(_dynStyles)) {
                _seenDynStyles.add(_dynStyles);
                var _dynRules  = parseStylesheet(_dynStyles);
                if (_dynRules.length > 0) {
                  sheets = sheets.concat(_dynRules);
                  // Rebuild cached index since sheets changed
                  // Also flush CSS match cache so cache reflects new rules
                  flushCSSMatchCache();
                  _cachedIndex = buildSheetIndex(sheets);
                }
              }
            }
          }
          // Pass cached RuleIndex to avoid rebuilding 800+ rules on every DOM mutation
          var _rrT0 = Date.now();
          var r2 = parseHTMLFromTokens(bodyTokens, sheets, _cachedIndex);
          pumpCursor();  // keep cursor alive after rerender parse
          var [_cacheHits, _cacheTotal, _cacheSize] = getCSSMatchCacheStats();
          os.debug.log('[browser] rerender CSS in', (Date.now() - _rrT0) + 'ms, rules:', sheets.length, 'idx:', _cachedIndex ? 'cached' : 'none', 'cacheHit:', _cacheHits + '/' + _cacheTotal + ' sz:' + _cacheSize);
          // Fallback: if CSS hid nearly everything, re-parse ignoring display:none
          if ((r2.nodes.length < 10 || r2.nodes.length < _pass1NodeCount * 0.4) && _pass1NodeCount > 20) {
            os.debug.log('[browser] rerender: too few nodes (' + r2.nodes.length + ') — re-parsing without display:none');
            r2 = parseHTMLFromTokens(bodyTokens, sheets, _cachedIndex, true);
            pumpCursor();
          }
          os.debug.log('[browser] rerender: assigning forms nodes=' + r2.nodes.length + ' widgets=' + r2.widgets.length);
          self2._forms = r2.forms;
          os.debug.log('[browser] rerender: calling _layoutPage');
          self2._layoutPage(r2.nodes as any, r2.widgets as any, self2._pageTitle, self2._pageURL, true /*isRerender*/);
          pumpCursor();  // keep cursor alive after rerender layout
          os.debug.log('[browser] rerender: _layoutPage done');
        },
        log: (msg: string) => os.debug.log(msg),
        getWidgetValue: (id: string) => {
          var w = self2._widgets.find(wg => wg.name === id || String((wg as any).id) === id);
          return w ? w.curValue : undefined;
        },
        setWidgetValue: (id: string, value: string) => {
          var w = self2._widgets.find(wg => wg.name === id || String((wg as any).id) === id);
          if (w) { w.curValue = value; self2._dirty = true; }
        },
        getScrollY: () => self2._scrollY,
        scrollTo: (_x: number, y: number) => { self2._scrollBy(y - self2._scrollY); },
      }, this._cspPolicy);
      // Push initial layout rects to the JS runtime so getBoundingClientRect() works
      this._pushLayoutRects();
    }
  }

  private _showPlainText(text: string, url: string): void {
    var pnodes = text.split('\n').map(l => ({
      type: 'pre' as const, spans: [{ text: l }],
    }));
    this._forms       = [];
    this._pageBaseURL = '';
    this._layoutPage(pnodes as any, [], url, url);
  }

  private _showError(url: string, reason: string): void {
    os.debug.error('[browser] error:', reason);
    var r = parseHTML(errorHTML(url, reason));
    this._forms       = r.forms;
    this._pageBaseURL = '';
    this._layoutPage(r.nodes as any, r.widgets as any, 'Error', url);
    this._status = reason;
  }

  private _layoutPage(
    nodes:   any[],
    bps:     any[],
    title:   string,
    url:     string,
    isRerender?: boolean
  ): void {
    this._loading   = false;
    this._pageTitle = title;
    this._pageURL   = url;
    this._urlInput  = url;
    this._scrollY   = 0;

    var w  = this._win ? this._win.canvas.width : 800;
    var lr = layoutNodes(nodes, bps, w);

    // ── Compress large vertical gaps (widget-anchor based) ─────────────
    var _gapLines = lr.lines;
    var _gapWidgets = lr.widgets;
    var _GAP_MAX = 8; // max gap between widget anchors (half LINE_H for tighter compression)
    if (_gapLines.length > 1) {
      // Collect anchors from visible widgets only (reliable visual indicators)
      var _gAnchors: { y: number; yEnd: number }[] = [];
      for (var _gwi = 0; _gwi < _gapWidgets.length; _gwi++) {
        if (_gapWidgets[_gwi].kind === 'hidden') continue;
        if (_gapWidgets[_gwi].ph <= 0) continue;
        _gAnchors.push({ y: _gapWidgets[_gwi].py, yEnd: _gapWidgets[_gwi].py + _gapWidgets[_gwi].ph });
      }
      _gAnchors.sort(function(a, b) { return a.y - b.y; });
      // Merge overlapping/adjacent anchors
      var _gMerged: { y: number; yEnd: number }[] = [];
      for (var _gmi = 0; _gmi < _gAnchors.length; _gmi++) {
        if (_gMerged.length > 0 && _gAnchors[_gmi].y <= _gMerged[_gMerged.length - 1].yEnd + 2) {
          if (_gAnchors[_gmi].yEnd > _gMerged[_gMerged.length - 1].yEnd) {
            _gMerged[_gMerged.length - 1].yEnd = _gAnchors[_gmi].yEnd;
          }
        } else {
          _gMerged.push({ y: _gAnchors[_gmi].y, yEnd: _gAnchors[_gmi].yEnd });
        }
      }

      // Build breakpoints: at each gap > _GAP_MAX, record cumulative shift
      var _gCumul = 0;
      var _breaks: { y: number; shift: number }[] = [];
      for (var _bi = 1; _bi < _gMerged.length; _bi++) {
        var _bGap = _gMerged[_bi].y - _gMerged[_bi - 1].yEnd;
        if (_bGap > _GAP_MAX) {
          _gCumul += _bGap - _GAP_MAX;
          _breaks.push({ y: _gMerged[_bi].y, shift: _gCumul });
        }
      }

      if (_gCumul > 0) {
        // Apply shifts to all lines and widgets
        for (var _gli = 0; _gli < _gapLines.length; _gli++) {
          var _origLY = _gapLines[_gli].y;
          var _shiftL = 0;
          for (var _ciL = _breaks.length - 1; _ciL >= 0; _ciL--) {
            if (_origLY >= _breaks[_ciL].y) { _shiftL = _breaks[_ciL].shift; break; }
          }
          if (_shiftL > 0) _gapLines[_gli].y = _origLY - _shiftL;
        }
        for (var _gwi2 = 0; _gwi2 < _gapWidgets.length; _gwi2++) {
          var _origWY = _gapWidgets[_gwi2].py;
          var _shiftW = 0;
          for (var _ciW = _breaks.length - 1; _ciW >= 0; _ciW--) {
            if (_origWY >= _breaks[_ciW].y) { _shiftW = _breaks[_ciW].shift; break; }
          }
          if (_shiftW > 0) _gapWidgets[_gwi2].py = _origWY - _shiftW;
        }
      }
    }

    this._pageLines = lr.lines;
    this._rebuildStickyIndex();
    this._contentVersion++;          // Phase 3: invalidate tile cache on new layout
    this._widgets   = lr.widgets;

    var contentH = this._contentH();
    var last     = this._pageLines[this._pageLines.length - 1];
    var totalH   = last ? last.y + last.lineH + CONTENT_PAD : 0;
    for (var wi = 0; wi < this._widgets.length; wi++) {
      var wbot = this._widgets[wi].py + this._widgets[wi].ph + CONTENT_PAD;
      if (wbot > totalH) totalH = wbot;
    }
    this._maxScrollY = Math.max(0, totalH - contentH);

    if (this._histIdx >= 0 && this._histIdx < this._history.length) {
      this._history[this._histIdx].title = title;
    }
    if (this._findMode && this._findQuery) this._doFind();

    var hasImages = this._widgets.some(wg => wg.kind === 'img' && !wg.imgLoaded);
    // Also check for background images that need fetching (item 386)
    var hasBgImages = this._pageLines.some(ln => ln.bgImageUrl != null && !this._bgImageMap.has(ln.bgImageUrl));
    if (hasImages || hasBgImages) this._fetchImages();

    // ── Write layout rects back to VElements for getBoundingClientRect() ──────
    os.debug.log('[browser] _layoutPage: calling _pushLayoutRects isRerender=' + (isRerender ? 'yes' : 'no'));
    if (this._pageJS) this._pushLayoutRects();
    os.debug.log('[browser] _layoutPage: _pushLayoutRects done');

    this._dirty = true;
  }

  /**
   * Build a map of elId → {x, y, w, h} from the current RenderedLine[] and
   * call PageJS.updateLayoutRects() so that getBoundingClientRect() etc. work.
   */
  private _pushLayoutRects(): void {
    if (!this._pageJS) return;
    var _rectMap = new Map<string, { x: number; y: number; w: number; h: number }>();
    var _lines = this._pageLines;
    for (var _li = 0; _li < _lines.length; _li++) {
      var _ln = _lines[_li];
      // Box decoration gives exact element rect (block elements with id/elId)
      if (_ln.boxDeco && (_ln as any)._decoElId) {
        var _bd = _ln.boxDeco;
        var _bid = (_ln as any)._decoElId as string;
        _rectMap.set(_bid, { x: _bd.x, y: _ln.y, w: _bd.w, h: _bd.h });
      }
      // Span-based rects for inline elements (carry elId from click-dispatch)
      var _lnSpans = _ln.nodes;
      for (var _si = 0; _si < _lnSpans.length; _si++) {
        var _sp = _lnSpans[_si];
        if (!_sp.elId || !_sp.text) continue;
        var _sc = _sp.fontScale || 1;
        var _spW = _sp.text.length * CHAR_W * _sc;
        var existing = _rectMap.get(_sp.elId);
        if (!existing) {
          _rectMap.set(_sp.elId, { x: _sp.x, y: _ln.y, w: _spW, h: _ln.lineH });
        } else {
          var _newX = Math.min(existing.x, _sp.x);
          var _newY = Math.min(existing.y, _ln.y);
          var _newR = Math.max(existing.x + existing.w, _sp.x + _spW);
          var _newB = Math.max(existing.y + existing.h, _ln.y + _ln.lineH);
          existing.x = _newX; existing.y = _newY;
          existing.w = _newR - _newX; existing.h = _newB - _newY;
        }
      }
    }
    if (_rectMap.size > 0) this._pageJS.updateLayoutRects(_rectMap);
  }

  // ── About / source page generators ────────────────────────────────────────

  private _historyHTML(): string {
    if (!this._history.length) return '<h1>History</h1><p>No pages visited yet.</p>';
    var ls = ['<h1>Browsing History</h1><ul>'];
    for (var i = this._history.length - 1; i >= 0; i--) {
      var e = this._history[i];
      ls.push('<li><a href="' + e.url + '">' + (e.title || e.url) + '</a></li>');
    }
    ls.push('</ul>');
    return ls.join('\n');
  }

  private _sourceHTML(): string {
    if (!this._pageSource)
      return '<h1>Page Source</h1><p>No source &mdash; navigate to a page first.</p>';
    var esc = this._pageSource
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return '<h1>Page Source: ' + this._pageURL + '</h1><pre>' + esc + '</pre>';
  }

  /** Rebuild the cached sticky-element index after _pageLines changes. */
  private _rebuildStickyIndex(): void {
    var idxs: number[] = [];
    for (var i = 0; i < this._pageLines.length; i++) {
      if (this._pageLines[i].stickyTop !== undefined) idxs.push(i);
    }
    this._stickyIndices = idxs;
  }
}

export const browserApp = new BrowserApp();

// ── Paint & DOM-write optimizations ──────────────────────────────────────────

/** [Item 961] DOMWriteDebouncer — collect DOM mutations issued during the
 *  current synchronous JS turn and batch-flush them before the next paint.
 *  Avoids forced reflows when multiple writes happen close together (e.g.
 *  during rapid `input` events). */
export class DOMWriteDebouncer {
  private _writes: Array<() => void> = [];
  private _scheduled = false;

  /** Queue a DOM write callback. */
  write(fn: () => void): void {
    this._writes.push(fn);
    if (!this._scheduled) {
      this._scheduled = true;
      // Defer to after the current microtask queue drains
      Promise.resolve().then(() => this._flush());
    }
  }

  /** Flush all pending writes immediately (called before paint). */
  flush(): void { this._flush(); }

  private _flush(): void {
    this._scheduled = false;
    var ws = this._writes.splice(0);
    for (var i = 0; i < ws.length; i++) ws[i]();
  }

  /** Return true when writes are queued. */
  get pending(): boolean { return this._writes.length > 0; }
}

/** [Item 973] PaintProfiler — records per-region repaint reasons and durations
 *  so hot repaint areas can be identified.  Enabled only when
 *  `paintProfiler.enabled` is set to `true`. */
export class PaintProfiler {
  enabled = false;
  private _records: Array<{ x: number; y: number; w: number; h: number; reason: string; ms: number }> = [];
  private _starts: Map<string, number> = new Map();

  /** Call before repainting a region. */
  startRepaint(key: string, _x: number, _y: number, _w: number, _h: number): void {
    if (!this.enabled) return;
    this._starts.set(key, Date.now());
  }

  /** Call after repainting; `reason` is a short string (e.g. `'text-change'`). */
  endRepaint(key: string, x: number, y: number, w: number, h: number, reason: string): void {
    if (!this.enabled) return;
    var s = this._starts.get(key);
    if (s === undefined) return;
    var ms = Date.now() - s;
    this._starts.delete(key);
    this._records.push({ x, y, w, h, reason, ms });
    // Keep last 256 records to avoid unbounded growth
    if (this._records.length > 256) this._records.shift();
  }

  /** Return all recorded repaint events, newest last. */
  report(): typeof this._records { return this._records.slice(); }

  /** Clear all recorded data. */
  reset(): void { this._records = []; this._starts.clear(); }
}

export const domWriteDebouncer = new DOMWriteDebouncer();
export const paintProfiler     = new PaintProfiler();

