/**
 * appearance.ts — CSS `appearance` property rendering (Item 426)
 *
 * Implements native OS-style widget rendering for form controls when
 * `appearance: button | textfield | checkbox | radio | listbox | menulist`
 * is set (or when a UA default appearance is active).
 *
 * Each function renders directly into an RGBA Uint32Array framebuffer.
 * Colours follow a flat JSOS system theme (overridable via ThemeTokens).
 *
 * Exports:
 *   AppearanceRenderer      — main renderer class
 *   appearanceRenderer      — singleton
 *   renderNativeWidget()    — convenience wrapper
 */

// ── Theme tokens ─────────────────────────────────────────────────────────────

export interface AppearanceTheme {
  // System button
  btnFace:        number;   // button body  ARGB (0xFF…)
  btnHighlight:   number;   // top/left bevel
  btnShadow:      number;   // bottom/right bevel
  btnText:        number;   // button text colour
  btnPressedFace: number;   // background when :active
  // Input / textfield
  inputBg:        number;
  inputBorder:    number;
  inputText:      number;
  inputFocusBorder: number;
  // Checkbox / radio
  checkBg:        number;
  checkBorder:    number;
  checkMark:      number;
  radioDot:       number;
  // Menulist (select / combobox)
  menuFace:       number;
  menuArrow:      number;
  menuBorder:     number;
  menuText:       number;
}

export const DEFAULT_THEME: AppearanceTheme = {
  btnFace:          0xFFE0E0E0,
  btnHighlight:     0xFFFFFFFF,
  btnShadow:        0xFF808080,
  btnText:          0xFF000000,
  btnPressedFace:   0xFFC0C0C0,
  inputBg:          0xFFFFFFFF,
  inputBorder:      0xFF808080,
  inputText:        0xFF000000,
  inputFocusBorder: 0xFF0055CC,
  checkBg:          0xFFFFFFFF,
  checkBorder:      0xFF666666,
  checkMark:        0xFF000000,
  radioDot:         0xFF000000,
  menuFace:         0xFFE8E8E8,
  menuArrow:        0xFF333333,
  menuBorder:       0xFF888888,
  menuText:         0xFF000000,
};

// ── Low-level pixel helpers ───────────────────────────────────────────────────

function setPixel(fb: Uint32Array, stride: number, x: number, y: number, color: number): void {
  if (x < 0 || y < 0) return;
  const idx = y * stride + x;
  if (idx >= 0 && idx < fb.length) fb[idx] = color;
}

function fillRect(
  fb: Uint32Array, stride: number,
  x: number, y: number, w: number, h: number,
  color: number,
): void {
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) {
      setPixel(fb, stride, col, row, color);
    }
  }
}

/** Draw a 1-pixel border rectangle. */
function drawBorderRect(
  fb: Uint32Array, stride: number,
  x: number, y: number, w: number, h: number,
  color: number,
): void {
  for (let col = x; col < x + w; col++) {
    setPixel(fb, stride, col, y,         color);
    setPixel(fb, stride, col, y + h - 1, color);
  }
  for (let row = y + 1; row < y + h - 1; row++) {
    setPixel(fb, stride, x,         row, color);
    setPixel(fb, stride, x + w - 1, row, color);
  }
}

/** 3D bevel border: highlight top/left, shadow bottom/right (classic Windows style). */
function drawBevel(
  fb: Uint32Array, stride: number,
  x: number, y: number, w: number, h: number,
  highlight: number, shadow: number,
): void {
  for (let col = x; col < x + w; col++) {
    setPixel(fb, stride, col, y, highlight);
    setPixel(fb, stride, col, y + h - 1, shadow);
  }
  for (let row = y + 1; row < y + h - 1; row++) {
    setPixel(fb, stride, x,         row, highlight);
    setPixel(fb, stride, x + w - 1, row, shadow);
  }
}

/**
 * Render a tiny 5×7 ASCII character into the framebuffer.
 * Used for labelled buttons in appearance rendering.
 */
const TINY_FONT: Record<number, number[]> = {
  /* space */ 32: [0,0,0,0,0],
  /* ! */ 33: [4,4,4,0,4],
  /* A */ 65: [14,17,31,17,17],
  /* B */ 66: [30,17,30,17,30],
  /* C */ 67: [14,17,16,17,14],
  /* O */ 79: [14,17,17,17,14],
  /* K */ 75: [17,18,28,18,17],
  /* X */ 88: [17,10,4,10,17],
  /* ▼ */ 9660: [31,14,4,0,0],
};

function drawChar(
  fb: Uint32Array, stride: number,
  x: number, y: number,
  charCode: number, color: number,
  scale = 1,
): void {
  const glyph = TINY_FONT[charCode];
  if (!glyph) return;
  for (let row = 0; row < glyph.length; row++) {
    const bits = glyph[row];
    for (let col = 0; col < 5; col++) {
      if (bits & (1 << (4 - col))) {
        fillRect(fb, stride, x + col * scale, y + row * scale, scale, scale, color);
      }
    }
  }
}

function drawText(
  fb: Uint32Array, stride: number,
  x: number, y: number,
  text: string, color: number,
  scale = 1,
): void {
  for (let i = 0; i < text.length; i++) {
    drawChar(fb, stride, x + i * (5 + 1) * scale, y, text.charCodeAt(i), color, scale);
  }
}

// ── Widget renderers ──────────────────────────────────────────────────────────

/**
 * [Item 426] Render a native-style push button.
 * @param pressed  true when the button is in :active state
 */
export function renderNativeButton(
  fb: Uint32Array, stride: number,
  x: number, y: number, w: number, h: number,
  label: string,
  pressed = false,
  theme: AppearanceTheme = DEFAULT_THEME,
): void {
  const face = pressed ? theme.btnPressedFace : theme.btnFace;
  fillRect(fb, stride, x, y, w, h, face);
  drawBevel(fb, stride, x, y, w, h,
    pressed ? theme.btnShadow    : theme.btnHighlight,
    pressed ? theme.btnHighlight : theme.btnShadow,
  );
  // Centre text
  const charW = 6;  // 5px glyph + 1px gap
  const textW = label.length * charW;
  const tx = x + Math.max(0, Math.floor((w - textW) / 2));
  const ty = y + Math.max(0, Math.floor((h - 7) / 2));
  drawText(fb, stride, tx, ty, label.toUpperCase(), theme.btnText);
}

/**
 * [Item 426] Render a native-style single-line text field.
 * @param focused  true when the field has keyboard focus
 */
export function renderNativeTextfield(
  fb: Uint32Array, stride: number,
  x: number, y: number, w: number, h: number,
  value: string,
  focused = false,
  theme: AppearanceTheme = DEFAULT_THEME,
): void {
  fillRect(fb, stride, x + 1, y + 1, w - 2, h - 2, theme.inputBg);
  const borderColor = focused ? theme.inputFocusBorder : theme.inputBorder;
  drawBorderRect(fb, stride, x, y, w, h, borderColor);
  if (focused) {
    // Draw a second inner focus ring
    drawBorderRect(fb, stride, x + 1, y + 1, w - 2, h - 2, theme.inputFocusBorder);
  }
  // Clip text to inner region and render up to available chars
  const innerW = w - 4;
  const maxChars = Math.floor(innerW / 6);
  const visText = value.slice(-maxChars);  // show tail of value
  drawText(fb, stride, x + 3, y + Math.floor((h - 7) / 2), visText, theme.inputText);
}

/**
 * [Item 426] Render a native-style checkbox.
 * Size is always 13×13 pixels regardless of `w`/`h` (UA default).
 */
export function renderNativeCheckbox(
  fb: Uint32Array, stride: number,
  x: number, y: number,
  checked: boolean,
  indeterminate = false,
  theme: AppearanceTheme = DEFAULT_THEME,
): void {
  const sz = 13;
  fillRect(fb, stride, x + 1, y + 1, sz - 2, sz - 2, theme.checkBg);
  drawBorderRect(fb, stride, x, y, sz, sz, theme.checkBorder);
  if (indeterminate) {
    fillRect(fb, stride, x + 3, y + 5, sz - 6, 3, theme.checkMark);
  } else if (checked) {
    // Draw a ✓ checkmark using two line segments
    const mark = theme.checkMark;
    setPixel(fb, stride, x + 2, y + 6, mark);
    setPixel(fb, stride, x + 3, y + 7, mark);
    setPixel(fb, stride, x + 4, y + 8, mark);
    setPixel(fb, stride, x + 5, y + 7, mark);
    setPixel(fb, stride, x + 6, y + 6, mark);
    setPixel(fb, stride, x + 7, y + 5, mark);
    setPixel(fb, stride, x + 8, y + 4, mark);
    setPixel(fb, stride, x + 9, y + 3, mark);
    setPixel(fb, stride, x + 10, y + 2, mark);
  }
}

/**
 * [Item 426] Render a native-style radio button.
 * Size is always 13×13 pixels.
 */
export function renderNativeRadio(
  fb: Uint32Array, stride: number,
  x: number, y: number,
  checked: boolean,
  theme: AppearanceTheme = DEFAULT_THEME,
): void {
  const sz = 13;
  const cx = x + 6, cy = y + 6, r = 5;
  // Draw circle border (midpoint circle algorithm)
  let ex = 0, ey = r, d = 3 - 2 * r;
  while (ey >= ex) {
    for (const [dx, dy] of [[ ex, ey],[-ex, ey],[ ex,-ey],[-ex,-ey],
                            [ ey, ex],[-ey, ex],[ ey,-ex],[-ey,-ex]]) {
      setPixel(fb, stride, cx + dx, cy + dy, theme.checkBorder);
    }
    if (d < 0) d += 4 * ex + 6;
    else { d += 4 * (ex - ey) + 10; ey--; }
    ex++;
  }
  // Fill interior white
  fillRect(fb, stride, x + 2, y + 2, sz - 4, sz - 4, theme.checkBg);
  // Re-draw border on top (fillRect stomped it)
  ex = 0; ey = r; d = 3 - 2 * r;
  while (ey >= ex) {
    for (const [dx, dy] of [[ ex, ey],[-ex, ey],[ ex,-ey],[-ex,-ey],
                            [ ey, ex],[-ey, ex],[ ey,-ex],[-ey,-ex]]) {
      setPixel(fb, stride, cx + dx, cy + dy, theme.checkBorder);
    }
    if (d < 0) d += 4 * ex + 6;
    else { d += 4 * (ex - ey) + 10; ey--; }
    ex++;
  }
  if (checked) {
    // Filled inner dot
    fillRect(fb, stride, cx - 2, cy - 2, 5, 5, theme.radioDot);
  }
}

/**
 * [Item 426] Render a native-style menu list (combobox / <select>).
 */
export function renderNativeMenulist(
  fb: Uint32Array, stride: number,
  x: number, y: number, w: number, h: number,
  selectedText: string,
  theme: AppearanceTheme = DEFAULT_THEME,
): void {
  fillRect(fb, stride, x, y, w, h, theme.menuFace);
  drawBorderRect(fb, stride, x, y, w, h, theme.menuBorder);

  // Drop-down arrow gutter (rightmost 16px)
  const arrowW = 16;
  const gutterX = x + w - arrowW;
  // Separator line
  for (let row = y + 1; row < y + h - 1; row++) {
    setPixel(fb, stride, gutterX, row, theme.menuBorder);
  }
  // Down-triangle (▼) centred in gutter
  const arrowY = y + Math.floor((h - 4) / 2);
  for (let i = 0; i < 4; i++) {
    const triW = 8 - i * 2;
    const triX = gutterX + Math.floor((arrowW - triW) / 2);
    fillRect(fb, stride, triX, arrowY + i, triW, 1, theme.menuArrow);
  }

  // Render selected option text
  const innerW = w - arrowW - 6;
  const maxChars = Math.floor(innerW / 6);
  const visText = selectedText.slice(0, maxChars);
  drawText(fb, stride, x + 4, y + Math.floor((h - 7) / 2), visText, theme.menuText);
}

/**
 * [Item 426] Render a native-style scrollbar thumb.
 */
export function renderNativeScrollbarThumb(
  fb: Uint32Array, stride: number,
  x: number, y: number, w: number, h: number,
  theme: AppearanceTheme = DEFAULT_THEME,
): void {
  fillRect(fb, stride, x, y, w, h, theme.btnFace);
  drawBevel(fb, stride, x, y, w, h, theme.btnHighlight, theme.btnShadow);
}

/**
 * [Item 426] Render a native-style progress bar.
 */
export function renderNativeProgressBar(
  fb: Uint32Array, stride: number,
  x: number, y: number, w: number, h: number,
  value: number,   // 0.0 – 1.0
  theme: AppearanceTheme = DEFAULT_THEME,
): void {
  fillRect(fb, stride, x, y, w, h, theme.inputBg);
  drawBorderRect(fb, stride, x, y, w, h, theme.inputBorder);
  const fillW = Math.round((w - 2) * Math.max(0, Math.min(1, value)));
  if (fillW > 0) {
    fillRect(fb, stride, x + 1, y + 1, fillW, h - 2, 0xFF0066CC);
  }
}

/**
 * [Item 426] Render a native-style range slider.
 */
export function renderNativeRange(
  fb: Uint32Array, stride: number,
  x: number, y: number, w: number, h: number,
  value: number,   // 0.0 – 1.0
  theme: AppearanceTheme = DEFAULT_THEME,
): void {
  const trackH = 4;
  const trackY = y + Math.floor((h - trackH) / 2);
  fillRect(fb, stride, x, trackY, w, trackH, theme.inputBorder);
  // Thumb
  const thumbX = x + Math.round(value * (w - 12));
  const thumbY = y + Math.floor((h - 16) / 2);
  fillRect(fb, stride, thumbX, thumbY, 12, 16, theme.btnFace);
  drawBevel(fb, stride, thumbX, thumbY, 12, 16, theme.btnHighlight, theme.btnShadow);
}

// ── AppearanceRenderer ─────────────────────────────────────────────────────────

export type AppearanceValue =
  | 'none' | 'auto'
  | 'button' | 'push-button' | 'square-button'
  | 'textfield' | 'searchfield'
  | 'checkbox'
  | 'radio'
  | 'menulist' | 'listbox' | 'menulist-button'
  | 'scrollbarbutton-up' | 'scrollbarbutton-down' | 'scrollbarthumb-horizontal' | 'scrollbarthumb-vertical'
  | 'progressbar'
  | 'slider-horizontal' | 'meter';

export interface WidgetRenderParams {
  appearance:    AppearanceValue;
  x: number; y: number; w: number; h: number;
  value?:        string | number;   // text value or numeric 0–1
  checked?:      boolean;
  indeterminate?: boolean;
  focused?:      boolean;
  pressed?:      boolean;
  disabled?:     boolean;
}

/**
 * [Item 426] Central dispatcher — given a CSS `appearance` value and element
 * geometry, draws the appropriate native control into `fb`.
 */
export class AppearanceRenderer {
  private _theme: AppearanceTheme;

  constructor(theme: AppearanceTheme = DEFAULT_THEME) {
    this._theme = theme;
  }

  setTheme(t: AppearanceTheme): void { this._theme = t; }
  getTheme(): AppearanceTheme { return this._theme; }

  /**
   * Render a native widget into the framebuffer.
   * @returns true if the appearance was handled (caller should skip default CSS painting),
   *          false if the appearance is 'none'/'auto' (caller renders normally).
   */
  render(fb: Uint32Array, stride: number, p: WidgetRenderParams): boolean {
    const { x, y, w, h } = p;
    const t = this._theme;

    switch (p.appearance) {
      case 'none':
      case 'auto':
        return false;

      case 'button':
      case 'push-button':
      case 'square-button':
        renderNativeButton(fb, stride, x, y, w, h,
          typeof p.value === 'string' ? p.value : '',
          p.pressed ?? false, t);
        return true;

      case 'textfield':
      case 'searchfield':
        renderNativeTextfield(fb, stride, x, y, w, h,
          typeof p.value === 'string' ? p.value : '',
          p.focused ?? false, t);
        return true;

      case 'checkbox':
        renderNativeCheckbox(fb, stride, x, y,
          p.checked ?? false, p.indeterminate ?? false, t);
        return true;

      case 'radio':
        renderNativeRadio(fb, stride, x, y, p.checked ?? false, t);
        return true;

      case 'menulist':
      case 'menulist-button':
      case 'listbox':
        renderNativeMenulist(fb, stride, x, y, w, h,
          typeof p.value === 'string' ? p.value : '', t);
        return true;

      case 'scrollbarthumb-horizontal':
      case 'scrollbarthumb-vertical':
        renderNativeScrollbarThumb(fb, stride, x, y, w, h, t);
        return true;

      case 'progressbar':
      case 'meter':
        renderNativeProgressBar(fb, stride, x, y, w, h,
          typeof p.value === 'number' ? p.value : 0, t);
        return true;

      case 'slider-horizontal':
        renderNativeRange(fb, stride, x, y, w, h,
          typeof p.value === 'number' ? p.value : 0, t);
        return true;

      default:
        return false;
    }
  }
}

/** Shared singleton used by the browser render pipeline. */
export const appearanceRenderer = new AppearanceRenderer();

/**
 * [Item 426] Convenience wrapper — renders a native widget into `fb` when
 * the element has a non-'none' `appearance` CSS property.
 *
 * @returns true if rendered (caller should NOT draw with default CSS box model)
 */
export function renderNativeWidget(
  fb: Uint32Array,
  stride: number,
  params: WidgetRenderParams,
): boolean {
  return appearanceRenderer.render(fb, stride, params);
}
