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
  os, Canvas,
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
import { parseHTML }    from './html.js';
import { parseStylesheet, buildSheetIndex, type CSSRule, type RuleIndex, resetCSSVars } from './stylesheet.js';
import { decodePNG }    from './img-png.js';
import { decodeJPEG }   from './img-jpeg.js';
import { layoutNodes }  from './layout.js';
import { aboutJsosHTML, errorHTML, jsonViewerHTML } from './pages.js';
import { createPageJS, getBlobURLContent, type PageJS } from './jsruntime.js';
import { flushAllCaches } from './cache.js';
import { renderGradientCSS } from './gradient.js';

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
  favicon?:      string;
  faviconData?:  Uint32Array | null;
  faviconW?:     number;
  faviconH?:     number;
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
  private _scrollY     = 0;
  private _maxScrollY  = 0;
  private _loading     = false;
  private _status      = '';
  private _dirty       = true;
  private _hoverHref   = '';

  // Form / widget state
  private _forms:         FormState[]         = [];
  private _widgets:       PositionedWidget[]  = [];
  private _focusedWidget  = -1;

  // Image cache: maps src URL → decoded image (null = fetch failed / unsupported)
  private _imgCache    = new Map<string, DecodedImage | null>();
  private _imgsFetching = false;
  // Background-image cache: URL → decoded (item 386)
  private _bgImageMap  = new Map<string, DecodedImage | null>();

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
    this._win = win;
    // Initialize first tab
    this._tabs = [this._makeBlankTab('about:jsos')];
    this._curTab = 0;
    this._loadTab(0);
    this._navigate('about:jsos');
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

        if (this._focusedWidget >= 0) { this._focusedWidget = -1; this._dirty = true; }
        if (this._urlBarFocus) {
          this._urlBarFocus = false; this._urlAllSelected = false;
          this._urlSuggestions = []; this._urlSuggestIdx = -1;
          this._dirty = true;
        } else {
          this._dirty = true;
        }
      }
    }

    // Hover — update hoverHref and set CSS cursor (items 415/416)
    if (event.y >= contentY0 && event.y < contentY1) {
      var cy2  = event.y - contentY0 + this._scrollY;
      var newH = this._hitTestLink(event.x, cy2);
      if (newH !== this._hoverHref) {
        this._hoverHref = newH;
        os.wm.setCursor(newH ? 'pointer' : 'default');
        this._dirty = true;
      }
    } else if (this._hoverHref) {
      this._hoverHref = '';
      os.wm.setCursor('default');
      this._dirty = true;
    }
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  render(canvas: Canvas): boolean {
    // Tick JS timers / RAF before dirty check
    if (this._pageJS) {
      var nowMs = Date.now() - this._jsStartMs;
      this._pageJS.tick(nowMs);
    }
    if (this._urlBarFocus || this._focusedWidget >= 0) {
      var prevPhase = (this._cursorBlink >> 4) & 1;
      this._cursorBlink++;
      if (((this._cursorBlink >> 4) & 1) !== prevPhase) this._dirty = true;
    }
    if (!this._dirty) return false;
    this._dirty = false;

    this._drawTabBar(canvas);
    this._drawToolbar(canvas);
    this._drawContent(canvas);
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
        for (var _fr = 0; _fr < fSz; _fr++) {
          for (var _fc = 0; _fc < fSz; _fc++) {
            var _fsr = Math.floor(_fr * t.faviconH / fSz);
            var _fsc = Math.floor(_fc * t.faviconW / fSz);
            var _fpx = t.faviconData[_fsr * t.faviconW + _fsc] ?? 0;
            if (_fpx >>> 24 > 0) canvas.setPixel(tx + 4 + _fc, 5 + _fr, _fpx);
          }
        }
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

    canvas.fillRect(0, y0, w, ch, CLR_BG);

    if (this._loading) {
      canvas.drawText(CONTENT_PAD, y0 + 20, 'Loading  ' + this._pageURL + ' ...', CLR_STATUS_TXT);
      return;
    }

    // Binary-search to the first visible line
    var _lines = this._pageLines;
    var _sv    = this._scrollY;
    var _lo = 0, _hi = _lines.length;
    while (_lo < _hi) {
      var _mid = (_lo + _hi) >> 1;
      if (_lines[_mid].y + _lines[_mid].lineH < _sv) _lo = _mid + 1;
      else _hi = _mid;
    }
    for (var i = _lo; i < _lines.length; i++) {
      var line  = _lines[i];
      var lineY = line.y - _sv;
      if (lineY > ch) break;
      var absY = y0 + lineY;

      if (line.hrLine) {
        canvas.fillRect(CONTENT_PAD, absY + 1, w - CONTENT_PAD * 2, 1, CLR_HR); continue;
      }
      if (line.bgColor) {
        canvas.fillRect(0, absY - 1, w, line.lineH + 1, line.bgColor);
      }
      if (line.bgGradient) {
        renderGradientCSS(canvas, 0, absY - 1, w, line.lineH + 1, line.bgGradient);
      }
      // CSS background-image url() tile (item 386)
      if (line.bgImageUrl) {
        var _bgDec = this._bgImageMap.get(line.bgImageUrl);
        if (_bgDec && _bgDec.data) {
          var _bw = _bgDec.w, _bh = _bgDec.h;
          for (var _br = 0; _br < line.lineH + 1; _br++) {
            var _bsr = _br % _bh;
            for (var _bc = 0; _bc < w; _bc++) {
              var _bsc = _bc % _bw;
              var _bpx = _bgDec.data[_bsr * _bw + _bsc];
              if (_bpx !== undefined && (_bpx >>> 24) > 0) canvas.setPixel(_bc, absY - 1 + _br, _bpx);
            }
          }
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

    this._drawWidgets(canvas, y0, ch);

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
      for (var row = 0; row < wp.ph; row++) {
        for (var col = 0; col < wp.pw; col++) {
          canvas.setPixel(wp.px + col, wy + row, wp.imgData[row * wp.pw + col]);
        }
      }
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
        if (ext === 0x4B) { wp.cursorPos = Math.max(0, wp.cursorPos - 1); this._dirty = true; return true; }
        if (ext === 0x4D) { wp.cursorPos = Math.min(wp.curValue.length, wp.cursorPos + 1); this._dirty = true; return true; }
        if (ext === 0x47) { wp.cursorPos = 0; this._dirty = true; return true; }
        if (ext === 0x4F) { wp.cursorPos = wp.curValue.length; this._dirty = true; return true; }
        if (ch === '\x1b') { this._focusedWidget = -1; this._dirty = true; return true; }
        if (ch === '\t')   { this._cycleFocusedWidget(1); return true; }
        if (ch === '\n' || ch === '\r') { this._submitForm(wp.formIdx, '', ''); return true; }
        if (ch === '\b') {
          if (wp.cursorPos > 0) {
            wp.curValue  = wp.curValue.slice(0, wp.cursorPos - 1) + wp.curValue.slice(wp.cursorPos);
            wp.cursorPos = Math.max(0, wp.cursorPos - 1);
            this._dirty  = true;
            if (this._pageJS) this._pageJS.fireInput(wp.name, wp.curValue);
          }
          return true;
        }
        if (ch >= ' ') {
          wp.curValue  = wp.curValue.slice(0, wp.cursorPos) + ch + wp.curValue.slice(wp.cursorPos);
          wp.cursorPos++;
          this._dirty  = true;
          if (this._pageJS) this._pageJS.fireInput(wp.name, wp.curValue);
          return true;
        }
        return false;
      }
      case 'textarea': {
        if (ch === '\x1b') { this._focusedWidget = -1; this._dirty = true; return true; }
        if (ch === '\t')   { this._cycleFocusedWidget(1); return true; }
        if (ch === '\b')   { if (wp.curValue.length) { wp.curValue = wp.curValue.slice(0, -1); this._dirty = true; if (this._pageJS) this._pageJS.fireInput(wp.name, wp.curValue); } return true; }
        if (ch === '\n' || ch === '\r') { wp.curValue += '\n'; this._dirty = true; if (this._pageJS) this._pageJS.fireInput(wp.name, wp.curValue); return true; }
        if (ch >= ' ') { wp.curValue += ch; this._dirty = true; if (this._pageJS) this._pageJS.fireInput(wp.name, wp.curValue); return true; }
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
    var next  = (this._focusedWidget + dir + total) % total;
    var tries = 0;
    while (tries < total) {
      var wk = this._widgets[next].kind;
      if (wk !== 'hidden' && wk !== 'img') { this._focusedWidget = next; this._dirty = true; return; }
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

  private _navigate(url: string): void {
    // Flush all per-page caches (layout, styles, images) before loading new page
    flushAllCaches();
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

  private _scrollBy(delta: number): void {
    this._scrollY = Math.max(0, Math.min(this._maxScrollY, this._scrollY + delta));
    this._dirty   = true;
  }

  private _hitTestLink(x: number, cy: number): string {
    for (var i = 0; i < this._pageLines.length; i++) {
      var line = this._pageLines[i];
      if (line.y > cy) break;
      if (line.y + line.lineH <= cy) continue;
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
      if (line.y > cy) break;
      if (line.y + line.lineH <= cy) continue;
      for (var j = 0; j < line.nodes.length; j++) {
        var span = line.nodes[j];
        if (span.href && x >= span.x && x <= span.x + span.text.length * CHAR_W) {
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

    // ── Pass 1: collect <style> blocks + <link rel="stylesheet"> hrefs ────────
    var r = parseHTML(html);
    this._forms       = r.forms;
    this._pageBaseURL = r.baseURL ? this._resolveHref(r.baseURL) : '';

    // Build inline-sheet rules immediately (synchronous)
    var sheets: CSSRule[] = r.styles.length > 0
      ? parseStylesheet(r.styles.join('\n'))
      : [];

    // ── Pass 2: re-parse with inline CSS rules applied ────────────────────────
    if (sheets.length > 0) {
      r = parseHTML(html, sheets);
      this._forms       = r.forms;
      this._pageBaseURL = r.baseURL ? this._resolveHref(r.baseURL) : '';
    }

    // Dispose any previous page JS before setting up the new page
    if (this._pageJS) { this._pageJS.dispose(); this._pageJS = null; }
    this._layoutPage(r.nodes as any, r.widgets as any, r.title || fallbackTitle || url, url);

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

    // ── External stylesheets: fetch async, re-render when ready ───────────────
    if (r.styleLinks.length > 0) {
      var self = this;
      var linkSheetsCSS = '';
      var pending = r.styleLinks.length;
      for (var li = 0; li < r.styleLinks.length; li++) {
        var lHref = this._resolveHref(r.styleLinks[li]!);
        (function(cssURL: string) {
          os.fetchAsync(cssURL, function(resp: FetchResponse | null) {
            if (resp && resp.status === 200) linkSheetsCSS += '\n' + resp.bodyText;
            pending--;
            if (pending === 0 && linkSheetsCSS.trim()) {
              // Re-parse and re-layout with all sheets (inline + external)
              var extRules = parseStylesheet(linkSheetsCSS);
              var allSheets = sheets.concat(extRules);
              var r3 = parseHTML(html, allSheets);
              self._forms       = r3.forms;
              self._pageBaseURL = r3.baseURL ? self._resolveHref(r3.baseURL) : '';
              self._layoutPage(r3.nodes as any, r3.widgets as any, r3.title || fallbackTitle || url, url);
            }
          });
        })(lHref);
      }
    }

    // Start JS engine for the new page (after layout so widgets have positions)
    if (r.scripts.length > 0) {
      var self2 = this;
      this._jsStartMs = Date.now();
      this._pageJS = createPageJS(html, r.scripts, {
        baseURL: url,
        navigate: (u: string) => self2._navigate(u),
        setTitle: (t: string) => { self2._pageTitle = t; self2._dirty = true; },
        alert:   (msg: string) => { self2._status = 'Alert: ' + msg; self2._dirty = true; os.debug.log('[browser alert]', msg); },
        confirm: (_msg: string): boolean => true,   // no blocking UI — default accept
        prompt:  (_msg: string, def: string): string => def,
        rerender: (bodyHTML: string) => {
          // Re-parse the mutated body and re-layout without re-running scripts
          var newHTML  = '<body>' + bodyHTML + '</body>';
          var r2 = parseHTML(newHTML, sheets);
          self2._forms = r2.forms;
          self2._layoutPage(r2.nodes as any, r2.widgets as any, self2._pageTitle, self2._pageURL);
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
      });
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
    url:     string
  ): void {
    this._loading   = false;
    this._pageTitle = title;
    this._pageURL   = url;
    this._urlInput  = url;
    this._scrollY   = 0;

    var w  = this._win ? this._win.canvas.width : 800;
    var lr = layoutNodes(nodes, bps, w);
    this._pageLines = lr.lines;
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

    this._dirty = true;
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

