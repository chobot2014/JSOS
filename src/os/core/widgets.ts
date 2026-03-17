/**
 * JSOS SDK Widget Library
 *
 * Reusable UI components that app code should use instead of reimplementing
 * the same rendering + hit-testing logic in every app.
 *
 * Exports:
 *   BaseApp   — abstract class; extend instead of duplicating onMount/onUnmount/
 *               onFocus/onBlur/onResize/_win/_dirty/_focused boilerplate.
 *   TabBar    — horizontal tab strip with keyboard and mouse navigation.
 *   Sidebar   — vertical navigation panel (left-side category list).
 *   ListView  — scrollable, selectable list of text rows.
 *   Label     — single-line text with optional icon character.
 *   ProgressBar — horizontal progress / loading indicator.
 *   Button    — clickable labelled rectangle; tracks press state.
 *   TextInput — single-line editable text field.
 *
 * Usage pattern (app file):
 *   import { os, BaseApp, TabBar, ListView, type Canvas,
 *            type KeyEvent, type MouseEvent, type WMWindow } from '../../core/sdk.js';
 *
 *   class MyApp extends BaseApp {
 *     readonly name = 'My App';
 *     private _tabs = new TabBar(['One', 'Two', 'Three']);
 *     ...
 *   }
 *
 * Architectural note (agents.md):
 *   All logic lives in TypeScript.  These widgets are pure TypeScript — no C,
 *   no DOM, no external dependencies.  They receive a Canvas and draw using the
 *   Canvas pixel API.
 */

import { Canvas } from '../ui/canvas.js';
import type { App, WMWindow, KeyEvent, MouseEvent } from '../ui/wm.js';

// ── Colour palette (widget-private defaults) ─────────────────────────────────
// Apps may override via constructor options or by calling render with a Theme.
const W_BG_DARK   = 0xFF1A2A3A;
const W_BG_MID    = 0xFF111920;
const W_ACTIVE    = 0xFF2255AA;
const W_ACTIVE_HV = 0xFF3366CC;
const W_BORDER    = 0xFF334455;
const W_TEXT      = 0xFFCCCCCC;
const W_TEXT_DIM  = 0xFF778899;
const W_TEXT_SEL  = 0xFFFFFFFF;
const W_CURSOR    = 0xFF4499FF;
const W_INPUT_BG  = 0xFF1E2830;
const W_INPUT_BDR = 0xFF445566;
const W_INPUT_FOC = 0xFF3366AA;
const W_PRESS     = 0xFF113380;

// ── BaseApp ──────────────────────────────────────────────────────────────────

/**
 * Abstract base class for all JSOS windowed applications.
 *
 * Provides:
 *  - _win, _dirty, _focused state management (no app-level boilerplate).
 *  - Default implementations of onMount, onUnmount, onFocus, onBlur, onResize.
 *  - invalidate() — marks the window dirty and optionally calls wm.markDirty().
 *  - onInit? / onDestroy? — optional hooks so apps don't override onMount.
 *
 * Apps only need to implement: name, onKey, onMouse, render.
 *
 * Example:
 *   export class MyApp extends BaseApp {
 *     readonly name = 'My App';
 *     onInit() { this._tabs.selected = 0; }
 *     onKey(ev: KeyEvent) { if (this._tabs.handleKey(ev.key)) this.invalidate(); }
 *     onMouse(ev: MouseEvent) { ... }
 *     render(canvas: Canvas): boolean {
 *       if (!this._dirty) return false;
 *       this._dirty = false;
 *       canvas.clear(0xFF1E1E2E);
 *       this._tabs.render(canvas, 0, 0, canvas.width);
 *       return true;
 *     }
 *   }
 */
export abstract class BaseApp implements App {
  /** Display name shown in the title bar and taskbar. */
  abstract readonly name: string;

  /** Handle to the window this app is mounted in.  null before onMount / after onUnmount. */
  protected _win: WMWindow | null = null;

  /**
   * Dirty flag — set to true whenever state changes that require a redraw.
   * The render() method should clear this to false after drawing, and return
   * the old value so the WM knows whether to composite the frame.
   *
   * Pattern:
   *   render(canvas: Canvas): boolean {
   *     if (!this._dirty) return false;
   *     this._dirty = false;
   *     // ... draw ...
   *     return true;
   *   }
   */
  protected _dirty = true;

  /** True while this window has keyboard focus. */
  protected _focused = false;

  // ── Lifecycle (App interface) ──────────────────────────────────────────────

  onMount(win: WMWindow): void {
    this._win     = win;
    this._dirty   = true;
    this._focused = false;
    this.onInit?.();
  }

  onUnmount(): void {
    this.onDestroy?.();
    this._win     = null;
    this._focused = false;
  }

  onFocus(): void {
    this._focused = true;
    this._dirty   = true;
  }

  onBlur(): void {
    this._focused = false;
    this._dirty   = true;
  }

  onResize(_w: number, _h: number): void {
    this._dirty = true;
  }

  // ── Hooks ─────────────────────────────────────────────────────────────────

  /** Called immediately after the window is mounted.  Override instead of onMount. */
  onInit?(): void;

  /** Called immediately before the window is unmounted.  Override instead of onUnmount. */
  onDestroy?(): void;

  // ── Abstract interface ────────────────────────────────────────────────────

  abstract onKey(event: KeyEvent): void;
  abstract onMouse(event: MouseEvent): void;
  abstract render(canvas: Canvas): boolean;

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Mark the window as needing a full redraw.
   * Call this whenever internal state changes that affect the visual output.
   */
  protected invalidate(): void {
    this._dirty = true;
  }

  /** Current content area width (0 if not mounted). */
  protected get width():  number { return this._win ? this._win.canvas.width  : 0; }
  /** Current content area height (0 if not mounted). */
  protected get height(): number { return this._win ? this._win.canvas.height : 0; }
}

// ── TabBar ────────────────────────────────────────────────────────────────────

export interface TabBarOptions {
  /** Width of each tab in pixels (default 80). */
  tabW?: number;
  /** Height of the tab bar in pixels (default 22). */
  tabH?: number;
  /** Background colour of the active tab (default W_ACTIVE). */
  activeBg?: number;
  /** Background colour of an inactive tab (default W_BG_DARK). */
  inactiveBg?: number;
  /** Separator line colour below the bar (default W_BORDER). */
  borderColor?: number;
}

/**
 * Horizontal tab bar.
 *
 * Example:
 *   var tabs = new TabBar(['Overview', 'Processes', 'Network']);
 *
 *   // in onKey:
 *   if (tabs.handleKey(ev.key)) this.invalidate();
 *
 *   // in onMouse:
 *   if (ev.type === 'down' && tabs.handleClick(ev.x, ev.y)) this.invalidate();
 *
 *   // in render:
 *   tabs.render(canvas, 0, 0, canvas.width);
 *   var contentY = tabs.height;
 */
export class TabBar {
  private _selected = 0;
  private _tabW: number;
  private _tabH: number;
  private _activeBg: number;
  private _inactiveBg: number;
  private _borderColor: number;

  constructor(public readonly labels: string[], opts?: TabBarOptions) {
    this._tabW       = (opts && opts.tabW  !== undefined) ? opts.tabW  : 80;
    this._tabH       = (opts && opts.tabH  !== undefined) ? opts.tabH  : 22;
    this._activeBg   = (opts && opts.activeBg   !== undefined) ? opts.activeBg   : W_ACTIVE;
    this._inactiveBg = (opts && opts.inactiveBg !== undefined) ? opts.inactiveBg : W_BG_DARK;
    this._borderColor= (opts && opts.borderColor!== undefined) ? opts.borderColor: W_BORDER;
  }

  /** Currently selected tab index. */
  get selected(): number { return this._selected; }
  set selected(i: number) {
    if (i >= 0 && i < this.labels.length) this._selected = i;
  }

  /** Pixel height of the entire tab bar including separator line. */
  get height(): number { return this._tabH + 1; }

  /**
   * Handle keyboard navigation (ArrowLeft, ArrowRight, '1'–'9').
   * Returns true if the selection changed.
   */
  handleKey(key: string): boolean {
    if (key === 'ArrowLeft' && this._selected > 0) {
      this._selected--;
      return true;
    }
    if (key === 'ArrowRight' && this._selected < this.labels.length - 1) {
      this._selected++;
      return true;
    }
    // Number keys: '1' selects index 0, etc.
    var n = parseInt(key, 10);
    if (!isNaN(n) && n >= 1 && n <= this.labels.length) {
      var idx = n - 1;
      if (idx !== this._selected) { this._selected = idx; return true; }
    }
    return false;
  }

  /**
   * Handle a mouse-down event.  x/y must be relative to the tab bar top-left.
   * Returns true if the selection changed.
   */
  handleClick(x: number, y: number): boolean {
    if (y < 0 || y >= this._tabH) return false;
    var i = Math.floor(x / this._tabW);
    if (i >= 0 && i < this.labels.length && i !== this._selected) {
      this._selected = i;
      return true;
    }
    return false;
  }

  /**
   * Render the tab bar.
   * @param canvas  Target canvas.
   * @param x       Left edge (content-relative).
   * @param y       Top edge (content-relative).
   * @param totalW  Total pixel width to fill.
   */
  render(canvas: Canvas, x: number, y: number, totalW: number): void {
    for (var i = 0; i < this.labels.length; i++) {
      var tx     = x + i * this._tabW;
      var active = (i === this._selected);
      canvas.fillRect(tx, y, this._tabW - 2, this._tabH,
        active ? this._activeBg : this._inactiveBg);
      canvas.drawText(tx + 6, y + 4, this.labels[i],
        active ? W_TEXT_SEL : W_TEXT_DIM);
    }
    canvas.drawLine(x, y + this._tabH, x + totalW, y + this._tabH, this._borderColor);
  }
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

export interface SidebarOptions {
  /** Width of the sidebar in pixels (default 90). */
  width?: number;
  /** Height of each item row in pixels (default 20). */
  rowH?: number;
  /** Inner padding from the left edge (default 8). */
  padding?: number;
  /** Background colour (default W_BG_MID). */
  bg?: number;
  /** Separator line colour on the right edge (default W_BORDER). */
  borderColor?: number;
}

/**
 * Vertical navigation sidebar.
 *
 * Example:
 *   var sidebar = new Sidebar(['Display', 'Users', 'Network', 'Storage']);
 *
 *   // in onKey:
 *   if (sidebar.handleKey(ev.key)) this.invalidate();
 *
 *   // in onMouse:
 *   if (ev.type === 'down' && sidebar.handleClick(ev.x, ev.y)) this.invalidate();
 *
 *   // in render (sidebar fills full height):
 *   sidebar.render(canvas, canvas.height);
 *   // content starts at x = sidebar.width + padding
 */
export class Sidebar {
  private _selected = 0;
  private _w:       number;
  private _rowH:    number;
  private _pad:     number;
  private _bg:      number;
  private _border:  number;

  constructor(public readonly labels: string[], opts?: SidebarOptions) {
    this._w      = (opts && opts.width   !== undefined) ? opts.width   : 90;
    this._rowH   = (opts && opts.rowH   !== undefined) ? opts.rowH   : 20;
    this._pad    = (opts && opts.padding !== undefined) ? opts.padding : 8;
    this._bg     = (opts && opts.bg     !== undefined) ? opts.bg     : W_BG_MID;
    this._border = (opts && opts.borderColor !== undefined) ? opts.borderColor : W_BORDER;
  }

  /** Currently selected item index. */
  get selected(): number { return this._selected; }
  set selected(i: number) {
    if (i >= 0 && i < this.labels.length) this._selected = i;
  }

  /** Pixel width of the sidebar including the separator line. */
  get width(): number { return this._w + 1; }

  /**
   * Handle keyboard navigation (ArrowUp, ArrowDown).
   * Returns true if selection changed.
   */
  handleKey(key: string): boolean {
    if (key === 'ArrowUp' && this._selected > 0) {
      this._selected--;
      return true;
    }
    if (key === 'ArrowDown' && this._selected < this.labels.length - 1) {
      this._selected++;
      return true;
    }
    return false;
  }

  /**
   * Handle a mouse-down event.  x/y must be relative to the window content area.
   * Returns true if selection changed.
   */
  handleClick(x: number, y: number): boolean {
    if (x < 0 || x >= this._w) return false;
    var row = Math.floor((y - this._pad) / this._rowH);
    if (row >= 0 && row < this.labels.length && row !== this._selected) {
      this._selected = row;
      return true;
    }
    return false;
  }

  /**
   * Render the sidebar.
   * @param canvas  Target canvas (paints from x=0, y=0).
   * @param h       Full height of the sidebar in pixels.
   */
  render(canvas: Canvas, h: number): void {
    canvas.fillRect(0, 0, this._w, h, this._bg);
    for (var i = 0; i < this.labels.length; i++) {
      var py = this._pad + i * this._rowH;
      if (i === this._selected) {
        canvas.fillRect(0, py - 2, this._w - 1, this._rowH, W_ACTIVE);
      }
      canvas.drawText(this._pad, py + 2, this.labels[i],
        i === this._selected ? W_TEXT_SEL : W_TEXT);
    }
    canvas.drawLine(this._w, 0, this._w, h, this._border);
  }
}

// ── ListView ──────────────────────────────────────────────────────────────────

export interface ListViewOptions {
  /** Height of each row in pixels (default 18). */
  rowH?: number;
  /** Inner left padding for row text (default 4). */
  padding?: number;
  /** Selected row highlight colour (default W_ACTIVE). */
  selBg?: number;
  /** Normal text colour (default W_TEXT). */
  textColor?: number;
  /** Selected row text colour (default W_TEXT_SEL). */
  selTextColor?: number;
  /** Show a vertical scroll bar on the right edge (default true). */
  showScrollbar?: boolean;
}

/**
 * Scrollable, selectable list of text items.
 *
 * Example:
 *   var list = new ListView(['foo', 'bar', 'baz']);
 *
 *   // in onKey:
 *   if (list.handleKey(ev.key)) this.invalidate();
 *
 *   // in onMouse:
 *   if (ev.type === 'down') {
 *     var changed = list.handleClick(ev.x, ev.y, contentY, contentH);
 *     if (changed) this.invalidate();
 *   }
 *
 *   // in render:
 *   list.render(canvas, 0, contentY, canvas.width, contentH);
 */
export class ListView {
  private _items:   string[];
  private _selected = -1;
  private _scroll   = 0;
  private _rowH:    number;
  private _pad:     number;
  private _selBg:   number;
  private _textClr: number;
  private _selClr:  number;
  private _showSb:  boolean;

  constructor(items: string[] = [], opts?: ListViewOptions) {
    this._items   = items.slice();
    this._rowH    = (opts && opts.rowH        !== undefined) ? opts.rowH        : 18;
    this._pad     = (opts && opts.padding     !== undefined) ? opts.padding     : 4;
    this._selBg   = (opts && opts.selBg       !== undefined) ? opts.selBg       : W_ACTIVE;
    this._textClr = (opts && opts.textColor   !== undefined) ? opts.textColor   : W_TEXT;
    this._selClr  = (opts && opts.selTextColor!== undefined) ? opts.selTextColor: W_TEXT_SEL;
    this._showSb  = (opts && opts.showScrollbar !== undefined) ? opts.showScrollbar : true;
  }

  /** Currently selected index (-1 = nothing selected). */
  get selected(): number { return this._selected; }
  set selected(i: number) { this._selected = i; }

  /** Currently visible top row (scroll offset). */
  get scroll(): number { return this._scroll; }

  /** Number of items in the list. */
  get length(): number { return this._items.length; }

  /** Replace the item list.  Resets selection and scroll. */
  setItems(items: string[]): void {
    this._items    = items.slice();
    this._selected = -1;
    this._scroll   = 0;
  }

  /** Append a single item without resetting state. */
  addItem(item: string): void {
    this._items.push(item);
  }

  /** Get the text of a specific item, or undefined. */
  getItem(i: number): string | undefined {
    return this._items[i];
  }

  /**
   * Handle keyboard navigation (ArrowUp, ArrowDown, Home, End).
   * Automatically adjusts scroll to keep the selection visible.
   * Returns true if state changed.
   */
  handleKey(key: string): boolean {
    if (key === 'ArrowUp' && this._selected > 0) {
      this._selected--;
      this._ensureVisible();
      return true;
    }
    if (key === 'ArrowDown' && this._selected < this._items.length - 1) {
      this._selected++;
      this._ensureVisible();
      return true;
    }
    if (key === 'Home' && this._items.length > 0) {
      this._selected = 0;
      this._scroll   = 0;
      return true;
    }
    if (key === 'End' && this._items.length > 0) {
      this._selected = this._items.length - 1;
      this._ensureVisible();
      return true;
    }
    return false;
  }

  /**
   * Handle a mouse-down event.
   * @param x        Mouse x relative to content area.
   * @param y        Mouse y relative to content area.
   * @param areaY    Y offset at which the list starts (within the content area).
   * @param areaH    Visible height of the list area.
   * @returns true if the selection changed.
   */
  handleClick(x: number, y: number, areaY: number, areaH: number): boolean {
    if (y < areaY || y >= areaY + areaH) return false;
    var row = Math.floor((y - areaY) / this._rowH) + this._scroll;
    if (row < 0 || row >= this._items.length) return false;
    if (row !== this._selected) {
      this._selected = row;
      return true;
    }
    return false;
  }

  /**
   * Handle a scroll wheel event (positive = down, negative = up).
   * Returns true if the view changed.
   */
  handleScroll(delta: number, areaH: number): boolean {
    var visible = Math.floor(areaH / this._rowH);
    var maxScroll = Math.max(0, this._items.length - visible);
    var newScroll = Math.max(0, Math.min(maxScroll, this._scroll + delta));
    if (newScroll !== this._scroll) { this._scroll = newScroll; return true; }
    return false;
  }

  /**
   * Render the list into a rectangular region of the canvas.
   * @param canvas  Target canvas.
   * @param x       Left edge of the list area.
   * @param y       Top edge of the list area.
   * @param w       Width of the list area.
   * @param h       Height of the list area.
   */
  render(canvas: Canvas, x: number, y: number, w: number, h: number): void {
    var visibleRows = Math.floor(h / this._rowH);
    var sbW = this._showSb && this._items.length > visibleRows ? 9 : 0;
    var textW = w - sbW;

    for (var i = 0; i < visibleRows; i++) {
      var row = i + this._scroll;
      if (row >= this._items.length) break;
      var rowY = y + i * this._rowH;
      if (row === this._selected) {
        canvas.fillRect(x, rowY, textW, this._rowH, this._selBg);
      }
      canvas.drawText(x + this._pad, rowY + 2, this._items[row],
        row === this._selected ? this._selClr : this._textClr);
    }

    // Scroll bar
    if (sbW > 0) {
      var sbX = x + textW;
      canvas.fillRect(sbX, y, sbW - 1, h, 0xFF1A2030);
      if (this._items.length > 0) {
        var thumbH = Math.max(8, Math.floor(h * visibleRows / this._items.length));
        var maxSc  = Math.max(1, this._items.length - visibleRows);
        var thumbY = y + Math.floor((h - thumbH) * (this._scroll / maxSc));
        canvas.fillRect(sbX, thumbY, sbW - 1, thumbH, 0xFF5577AA);
      }
    }
  }

  private _ensureVisible(): void {
    // Adjust _scroll so _selected row is within the last known visible area.
    // We don't know actual height here so just keep selection >= scroll
    if (this._selected < this._scroll) {
      this._scroll = this._selected;
    }
    // No upper clamp without visible height; callers can clamp via handleScroll.
  }

  /** Ensure selected row is visible given a known visible row count. */
  ensureVisible(visibleRows: number): void {
    if (this._selected < 0) return;
    if (this._selected < this._scroll) {
      this._scroll = this._selected;
    } else if (this._selected >= this._scroll + visibleRows) {
      this._scroll = this._selected - visibleRows + 1;
    }
  }
}

// ── ProgressBar ───────────────────────────────────────────────────────────────

/**
 * Stateless horizontal progress bar helper.
 *
 * Example:
 *   ProgressBar.render(canvas, 10, 50, 200, 12, 0.65);   // 65% full
 *   ProgressBar.render(canvas, 10, 70, 200, 12, 0.65, { label: '65%' });
 */
export class ProgressBar {
  static render(
    canvas:    Canvas,
    x: number, y: number,
    w: number, h: number,
    fraction:  number,
    opts?: {
      fgColor?:  number;
      bgColor?:  number;
      bdColor?:  number;
      label?:    string;
      labelClr?: number;
    },
  ): void {
    var bg  = (opts && opts.bgColor) ? opts.bgColor : 0xFF1A2030;
    var fg  = (opts && opts.fgColor) ? opts.fgColor : 0xFF3399FF;
    var bd  = (opts && opts.bdColor) ? opts.bdColor : 0xFF445566;
    var f   = Math.min(1, Math.max(0, fraction));
    canvas.fillRect(x, y, w, h, bg);
    if (f > 0) canvas.fillRect(x, y, Math.floor(w * f), h, fg);
    canvas.drawRect(x, y, w, h, bd);
    if (opts && opts.label) {
      var lc = (opts.labelClr) ? opts.labelClr : W_TEXT_SEL;
      var m  = canvas.measureText(opts.label);
      canvas.drawText(x + Math.floor((w - m.width) / 2),
                      y + Math.floor((h - m.height) / 2),
                      opts.label, lc);
    }
  }
}

// ── Button ────────────────────────────────────────────────────────────────────

export interface ButtonOptions {
  bgColor?:    number;
  pressColor?: number;
  fgColor?:    number;
  borderColor?: number;
}

/**
 * Simple labelled button.
 *
 * Tracks its own pressed/hovered state.  Call handleMouseDown/Up and check
 * wasClicked() after each up event.
 *
 * Example:
 *   var btn = new Button('OK', 100, 200, 80, 24);
 *
 *   // in onMouse:
 *   btn.handleMouse(ev);
 *   if (btn.wasClicked()) { doSomething(); this.invalidate(); }
 *
 *   // in render:
 *   btn.render(canvas);
 */
export class Button {
  private _pressed  = false;
  private _clicked  = false;

  constructor(
    public label: string,
    public x:     number,
    public y:     number,
    public w:     number,
    public h:     number,
    private opts?: ButtonOptions,
  ) {}

  /** Returns true (once) if the button was clicked since the last call. */
  wasClicked(): boolean {
    var v = this._clicked;
    this._clicked = false;
    return v;
  }

  /** Pass every mouse event here. */
  handleMouse(ev: MouseEvent): void {
    var inside = ev.x >= this.x && ev.x < this.x + this.w &&
                 ev.y >= this.y && ev.y < this.y + this.h;
    if (ev.type === 'down' && inside) {
      this._pressed = true;
    } else if (ev.type === 'up') {
      if (this._pressed && inside) this._clicked = true;
      this._pressed = false;
    }
  }

  get pressed(): boolean { return this._pressed; }

  render(canvas: Canvas): void {
    var bg  = this._pressed
      ? ((this.opts && this.opts.pressColor) ? this.opts.pressColor : W_PRESS)
      : ((this.opts && this.opts.bgColor)    ? this.opts.bgColor    : W_ACTIVE);
    var fg  = (this.opts && this.opts.fgColor)    ? this.opts.fgColor    : W_TEXT_SEL;
    var bd  = (this.opts && this.opts.borderColor) ? this.opts.borderColor : 0xFF6688AA;
    canvas.fillRect(this.x, this.y, this.w, this.h, bg);
    canvas.drawRect(this.x, this.y, this.w, this.h, bd);
    var m = canvas.measureText(this.label);
    canvas.drawText(
      this.x + Math.floor((this.w - m.width)  / 2),
      this.y + Math.floor((this.h - m.height) / 2),
      this.label, fg,
    );
  }
}

// ── TextInput ─────────────────────────────────────────────────────────────────

export interface TextInputOptions {
  maxLength?:    number;
  placeholder?:  string;
  bgColor?:      number;
  fgColor?:      number;
  borderColor?:  number;
  focusBorder?:  number;
  cursorColor?:  number;
}

/**
 * Single-line editable text input widget.
 *
 * Manages its own cursor position and text buffer.  Call `handleKey` on key
 * down events while the input is focused; call `render` each frame.
 *
 * Example:
 *   var input = new TextInput(10, 40, 200, 20, { placeholder: 'Type here…' });
 *
 *   // in onMouse:
 *   if (ev.type === 'down') input.focused = input.hitsArea(ev.x, ev.y);
 *
 *   // in onKey (only when focused):
 *   if (input.focused) { input.handleKey(ev); this.invalidate(); }
 *
 *   // in render:
 *   input.render(canvas);
 *   var value = input.value;
 */
export class TextInput {
  private _buf:      string;
  private _cursor:   number;
  private _maxLen:   number;
  private _ph:       string;
  private _bg:       number;
  private _fg:       number;
  private _bd:       number;
  private _focusBd:  number;
  private _cursorClr: number;

  focused = false;

  constructor(
    public x: number,
    public y: number,
    public w: number,
    public h: number,
    opts?: TextInputOptions,
  ) {
    this._buf       = '';
    this._cursor    = 0;
    this._maxLen    = (opts && opts.maxLength   !== undefined) ? opts.maxLength   : 256;
    this._ph        = (opts && opts.placeholder !== undefined) ? opts.placeholder : '';
    this._bg        = (opts && opts.bgColor     !== undefined) ? opts.bgColor     : W_INPUT_BG;
    this._fg        = (opts && opts.fgColor     !== undefined) ? opts.fgColor     : W_TEXT;
    this._bd        = (opts && opts.borderColor !== undefined) ? opts.borderColor : W_INPUT_BDR;
    this._focusBd   = (opts && opts.focusBorder !== undefined) ? opts.focusBorder : W_INPUT_FOC;
    this._cursorClr = (opts && opts.cursorColor !== undefined) ? opts.cursorColor : W_CURSOR;
  }

  get value(): string { return this._buf; }
  set value(v: string) {
    this._buf    = v.slice(0, this._maxLen);
    this._cursor = this._buf.length;
  }

  /** Clear the input field. */
  clear(): void { this._buf = ''; this._cursor = 0; }

  /** True if (x, y) falls within the input bounds. */
  hitsArea(x: number, y: number): boolean {
    return x >= this.x && x < this.x + this.w &&
           y >= this.y && y < this.y + this.h;
  }

  /**
   * Handle a key-down event while the input is focused.
   * Returns true if the value changed (appropriate to call invalidate).
   */
  handleKey(ev: KeyEvent): boolean {
    if (ev.type !== 'down' && ev.type !== 'press') return false;
    switch (ev.key) {
      case 'Backspace':
        if (this._cursor > 0) {
          this._buf = this._buf.slice(0, this._cursor - 1) + this._buf.slice(this._cursor);
          this._cursor--;
          return true;
        }
        return false;
      case 'Delete':
        if (this._cursor < this._buf.length) {
          this._buf = this._buf.slice(0, this._cursor) + this._buf.slice(this._cursor + 1);
          return true;
        }
        return false;
      case 'ArrowLeft':
        if (this._cursor > 0) { this._cursor--; return true; }
        return false;
      case 'ArrowRight':
        if (this._cursor < this._buf.length) { this._cursor++; return true; }
        return false;
      case 'Home':
        if (this._cursor !== 0) { this._cursor = 0; return true; }
        return false;
      case 'End':
        if (this._cursor !== this._buf.length) { this._cursor = this._buf.length; return true; }
        return false;
      default:
        // Printable character — ev.ch is the character string
        if (ev.ch && ev.ch.length === 1 && this._buf.length < this._maxLen) {
          this._buf = this._buf.slice(0, this._cursor) + ev.ch + this._buf.slice(this._cursor);
          this._cursor++;
          return true;
        }
        return false;
    }
  }

  render(canvas: Canvas): void {
    canvas.fillRect(this.x, this.y, this.w, this.h, this._bg);
    canvas.drawRect(this.x, this.y, this.w, this.h,
      this.focused ? this._focusBd : this._bd);

    var PAD = 4;
    var m = canvas.measureText('M');
    var ch = m.height || 8;
    var ty = this.y + Math.floor((this.h - ch) / 2);

    if (this._buf.length === 0 && this._ph) {
      // Placeholder
      canvas.drawText(this.x + PAD, ty, this._ph, W_TEXT_DIM);
    } else {
      // Clip visible portion of text to the left of cursor
      var cw = m.width || 8;
      var visW = this.w - 2 * PAD;
      var curX = this._cursor * cw;
      var startChar = 0;
      if (curX > visW) {
        startChar = this._cursor - Math.floor(visW / cw);
      }
      var visible = this._buf.slice(startChar);
      canvas.drawText(this.x + PAD, ty, visible, this._fg);

      if (this.focused) {
        var localCurX = (this._cursor - startChar) * cw;
        canvas.fillRect(this.x + PAD + localCurX, ty, 2, ch, this._cursorClr);
      }
    }
  }
}

// ── Section header helper ────────────────────────────────────────────────────

/**
 * Draw a bold section header with an underline separator.
 * Commonly used inside content panels to separate logical groups of fields.
 *
 * Example:
 *   var y = drawSection(canvas, 10, 10, w - 20, 'Display Settings', 0xFFFFCC00);
 *   // y is the next available y position after the header
 */
export function drawSection(
  canvas:  Canvas,
  x:       number,
  y:       number,
  w:       number,
  title:   string,
  color:   number = W_TEXT_SEL,
  rowH:    number = 20,
): number {
  canvas.drawText(x, y, title, color);
  canvas.drawLine(x, y + rowH, x + w, y + rowH, W_BORDER);
  return y + rowH + 4;
}

/**
 * Draw a key-value info row.  Returns y of next row.
 *
 * Example:
 *   y = drawRow(canvas, 10, y, 'CPU Ticks:', String(ticks), Colors.WHITE);
 */
export function drawRow(
  canvas:   Canvas,
  x:        number,
  y:        number,
  label:    string,
  value:    string,
  valueClr: number = W_TEXT,
  labelClr: number = W_TEXT_DIM,
  rowH:     number = 20,
  valueX?:  number,
): number {
  canvas.drawText(x,               y, label, labelClr);
  canvas.drawText(valueX || x + 120, y, value, valueClr);
  return y + rowH;
}
