/**
 * form-validate.ts — HTML5 Client-side form validation
 *
 * Implements item 603:
 *   Form validation: `required`, `minlength`, `maxlength`, `pattern`,
 *   `min`, `max`, `type` (email, url, number) constraints.
 *
 * Called before form submission to validate all PositionedWidget fields.
 * Returns a list of validation errors that the browser shows as inline
 * constraint violation messages.
 */

import type { PositionedWidget } from './types.js';

// ── Validation error ──────────────────────────────────────────────────────────

export interface ValidationError {
  /** Widget id (PositionedWidget.id) that failed validation. */
  widgetId: number;
  /** Human-readable error message (displayed under the field). */
  message: string;
  /** Which constraint triggered the error. */
  constraint: 'valueMissing' | 'tooShort' | 'tooLong' | 'patternMismatch'
            | 'typeMismatch' | 'rangeUnderflow' | 'rangeOverflow';
}

// ── Validators ────────────────────────────────────────────────────────────────

/** Checks that a field with `required` has a non-empty value (item 603). */
function checkRequired(w: PositionedWidget): ValidationError | null {
  if (!w.required) return null;
  var val = w.curValue ?? '';
  if (w.kind === 'checkbox') {
    return w.curChecked ? null : {
      widgetId: w.id,
      message: `${w.name || 'Field'} must be checked.`,
      constraint: 'valueMissing',
    };
  }
  if (val.trim() === '') {
    return {
      widgetId: w.id,
      message: `${w.name || 'Field'} is required.`,
      constraint: 'valueMissing',
    };
  }
  return null;
}

/** Checks `minlength` constraint (item 603). */
function checkMinLength(w: PositionedWidget): ValidationError | null {
  if (!w.minLength || !w.minLength) return null;
  var len = (w.curValue ?? '').length;
  if (len < w.minLength) {
    return {
      widgetId: w.id,
      message: `${w.name || 'Field'} must be at least ${w.minLength} characters (currently ${len}).`,
      constraint: 'tooShort',
    };
  }
  return null;
}

/** Checks `maxlength` constraint (item 603). */
function checkMaxLength(w: PositionedWidget): ValidationError | null {
  if (!w.maxLength) return null;
  var len = (w.curValue ?? '').length;
  if (len > w.maxLength) {
    return {
      widgetId: w.id,
      message: `${w.name || 'Field'} must be at most ${w.maxLength} characters (currently ${len}).`,
      constraint: 'tooLong',
    };
  }
  return null;
}

/** Checks `pattern` attribute (item 603). */
function checkPattern(w: PositionedWidget): ValidationError | null {
  if (!w.pattern) return null;
  var val = w.curValue ?? '';
  if (val === '') return null; // empty is handled by 'required'
  try {
    var re = new RegExp('^(?:' + w.pattern + ')$');
    if (!re.test(val)) {
      return {
        widgetId: w.id,
        message: `${w.name || 'Field'} doesn't match the required pattern.`,
        constraint: 'patternMismatch',
      };
    }
  } catch (_) {
    // Bad pattern — ignore (silently pass)
  }
  return null;
}

/** Checks input type constraints: email, url, number, tel (item 603). */
function checkTypeMismatch(w: PositionedWidget): ValidationError | null {
  var val  = w.curValue ?? '';
  if (val === '') return null;
  var type = w.inputType;
  if (!type) return null;

  var ok = true;
  if (type === 'email') {
    // Simple email regex: local@domain.tld
    ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val);
  } else if (type === 'url') {
    try { new URL(val); } catch (_) { ok = false; }
  } else if (type === 'number') {
    ok = !isNaN(parseFloat(val));
  } else if (type === 'tel') {
    // Very permissive: digits, spaces, +, -, ()
    ok = /^[\d\s+\-().]+$/.test(val);
  }

  if (!ok) {
    return {
      widgetId: w.id,
      message: `${w.name || 'Field'} must be a valid ${type}.`,
      constraint: 'typeMismatch',
    };
  }
  return null;
}

/** Checks `min` / `max` range constraints for number/date inputs (item 603). */
function checkRange(w: PositionedWidget): ValidationError | null {
  if (!w.inputMin && !w.inputMax) return null;
  var val = parseFloat(w.curValue ?? '');
  if (isNaN(val)) return null;

  if (w.inputMin !== undefined) {
    var min = parseFloat(w.inputMin);
    if (!isNaN(min) && val < min) {
      return {
        widgetId: w.id,
        message: `${w.name || 'Field'} must be at least ${w.inputMin}.`,
        constraint: 'rangeUnderflow',
      };
    }
  }
  if (w.inputMax !== undefined) {
    var max = parseFloat(w.inputMax);
    if (!isNaN(max) && val > max) {
      return {
        widgetId: w.id,
        message: `${w.name || 'Field'} must be at most ${w.inputMax}.`,
        constraint: 'rangeOverflow',
      };
    }
  }
  return null;
}

// ── Main validation function (item 603) ────────────────────────────────────────

/**
 * Validate all widgets in a form before submission.
 *
 * @param widgets - All PositionedWidget instances in the form (formIdx matches).
 * @param formIdx - Index of the form being submitted.
 * @returns Array of validation errors. Empty = valid, submit can proceed.
 *
 * Item 603: form validation with required, minlength, maxlength, pattern.
 */
export function validateForm(
  widgets:  PositionedWidget[],
  formIdx:  number
): ValidationError[] {
  var errors: ValidationError[] = [];

  for (var i = 0; i < widgets.length; i++) {
    var w = widgets[i];
    if (w.formIdx !== formIdx) continue;
    if (w.disabled) continue;
    if (w.kind === 'hidden' || w.kind === 'img') continue;

    var err: ValidationError | null = null;

    err = checkRequired(w);    if (err) { errors.push(err); continue; }
    err = checkMinLength(w);   if (err) { errors.push(err); continue; }
    err = checkMaxLength(w);   if (err) { errors.push(err); continue; }
    err = checkPattern(w);     if (err) { errors.push(err); continue; }
    err = checkTypeMismatch(w);if (err) { errors.push(err); continue; }
    err = checkRange(w);       if (err) { errors.push(err); }
  }

  return errors;
}

/**
 * Quick check: returns true if the form is valid, false otherwise.
 * Equivalent to calling `validateForm(...).length === 0`.
 *
 * Item 603.
 */
export function isFormValid(widgets: PositionedWidget[], formIdx: number): boolean {
  return validateForm(widgets, formIdx).length === 0;
}

/**
 * Summarize validation errors into a human-readable string list.
 * Suitable for displaying in an alert or inline message block.
 *
 * Item 603.
 */
export function formatValidationErrors(errors: ValidationError[]): string {
  return errors.map(function(e) { return '\u2022 ' + e.message; }).join('\n');
}

// ════════════════════════════════════════════════════════════════════════════
// [Items 605-614] Extended input type validation and widget support
// ════════════════════════════════════════════════════════════════════════════

/**
 * [Item 605] Validate an <input type="email"> value.
 *
 * Per HTML5 spec: at least one `@`, local part, and domain with at least one dot.
 * Enforces max 254 chars total, 64 chars local part.
 */
export function validateEmail(value: string): { valid: boolean; message?: string } {
  if (!value) return { valid: false, message: 'Email address is required.' };
  if (value.length > 254) return { valid: false, message: 'Email address is too long.' };
  var at = value.lastIndexOf('@');
  if (at < 1) return { valid: false, message: 'Email must include a name before @.' };
  var local = value.slice(0, at);
  var domain = value.slice(at + 1);
  if (local.length > 64) return { valid: false, message: 'Email local part is too long.' };
  if (!domain.includes('.')) return { valid: false, message: 'Email domain must include a dot.' };
  if (!/^[^\s@]+$/.test(local)) return { valid: false, message: 'Email contains invalid characters.' };
  if (!/^[^\s.@][^\s@]*\.[a-z]{2,}$/i.test(domain)) return { valid: false, message: 'Email domain is invalid.' };
  return { valid: true };
}

/**
 * [Item 606] Validate an <input type="url"> value.
 *
 * Requires a valid absolute URL with http/https scheme.
 */
export function validateURL(value: string): { valid: boolean; message?: string } {
  if (!value) return { valid: false, message: 'URL is required.' };
  try {
    var u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:' &&
        u.protocol !== 'ftp:' && u.protocol !== 'mailto:') {
      return { valid: false, message: 'URL must use http:// or https://.' };
    }
    return { valid: true };
  } catch (_) {
    return { valid: false, message: 'Must be a valid URL (e.g. https://example.com).' };
  }
}

/**
 * [Item 607] Validate and normalize an <input type="number"> value.
 *
 * @param value   Current string value
 * @param min     Optional minimum (as string or number)
 * @param max     Optional maximum (as string or number)
 * @param step    Optional step (as string or number); 'any' bypasses step validation
 */
export function validateNumber(value: string, min?: string | number, max?: string | number, step?: string | number): { valid: boolean; message?: string; parsed?: number } {
  if (!value) return { valid: false, message: 'A number is required.' };
  var n = Number(value);
  if (!isFinite(n)) return { valid: false, message: `"${value}" is not a valid number.` };

  if (min !== undefined && min !== '') {
    var minN = Number(min);
    if (n < minN) return { valid: false, message: `Must be at least ${min}.`, parsed: n };
  }
  if (max !== undefined && max !== '') {
    var maxN = Number(max);
    if (n > maxN) return { valid: false, message: `Must be at most ${max}.`, parsed: n };
  }
  if (step !== undefined && step !== '' && String(step).toLowerCase() !== 'any') {
    var stepN = Number(step);
    if (stepN > 0) {
      var base = min !== undefined ? Number(min) : 0;
      var rem = Math.abs((n - base) % stepN);
      if (rem > 1e-9 && Math.abs(rem - stepN) > 1e-9) {
        return { valid: false, message: `Value must be a multiple of ${step} from ${min ?? '0'}.`, parsed: n };
      }
    }
  }
  return { valid: true, parsed: n };
}

/**
 * [Item 608] Validate an <input type="range"> value and clamp to [min, max].
 *
 * Range inputs always have a valid numeric value (clamped), so validation
 * just normalizes; it never returns `valid: false`.
 *
 * @returns { valid, clamped } — clamped is the constrained numeric value.
 */
export function validateRange(value: string, min = 0, max = 100, step = 1): { valid: boolean; clamped: number } {
  var n = parseFloat(value);
  if (!isFinite(n)) n = min;
  n = Math.min(max, Math.max(min, n));
  if (step > 0) n = Math.round((n - min) / step) * step + min;
  return { valid: true, clamped: n };
}

// ── Date/time helpers ──────────────────────────────────────────────────────────

/** Parse ISO date string "YYYY-MM-DD" → { y, m, d } or null */
function parseISODate(s: string): { y: number; m: number; d: number } | null {
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  var y = parseInt(m[1]!), mo = parseInt(m[2]!), d = parseInt(m[3]!);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return { y, m: mo, d };
}

/** Parse ISO time string "HH:MM" or "HH:MM:SS" → milliseconds since midnight, or -1 */
function parseISOTime(s: string): number {
  var m = s.match(/^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/);
  if (!m) return -1;
  var h = parseInt(m[1]!), min = parseInt(m[2]!), sec = parseInt(m[3] ?? '0'), ms = parseInt((m[4] ?? '0').padEnd(3, '0').slice(0, 3));
  if (h > 23 || min > 59 || sec > 59) return -1;
  return ((h * 60 + min) * 60 + sec) * 1000 + ms;
}

/**
 * [Item 609] Validate <input type="date"> and <input type="time"> values.
 *
 * @param type     "date" | "time"
 * @param value    The current input value
 * @param min      Optional minimum date/time string
 * @param max      Optional maximum date/time string
 */
export function validateDateTime(type: 'date' | 'time', value: string, min?: string, max?: string): { valid: boolean; message?: string } {
  if (!value) return { valid: false, message: `A ${type} is required.` };

  if (type === 'date') {
    var parsed = parseISODate(value);
    if (!parsed) return { valid: false, message: 'Date must be in YYYY-MM-DD format.' };
    if (min) {
      var parsedMin = parseISODate(min);
      if (parsedMin) {
        var vMS = new Date(parsed.y, parsed.m - 1, parsed.d).getTime();
        var mMS = new Date(parsedMin.y, parsedMin.m - 1, parsedMin.d).getTime();
        if (vMS < mMS) return { valid: false, message: `Date must be on or after ${min}.` };
      }
    }
    if (max) {
      var parsedMax = parseISODate(max);
      if (parsedMax) {
        var vMS2 = new Date(parsed.y, parsed.m - 1, parsed.d).getTime();
        var xMS = new Date(parsedMax.y, parsedMax.m - 1, parsedMax.d).getTime();
        if (vMS2 > xMS) return { valid: false, message: `Date must be on or before ${max}.` };
      }
    }
    return { valid: true };
  }

  if (type === 'time') {
    var tMs = parseISOTime(value);
    if (tMs < 0) return { valid: false, message: 'Time must be in HH:MM or HH:MM:SS format.' };
    if (min) {
      var minMs = parseISOTime(min);
      if (minMs >= 0 && tMs < minMs) return { valid: false, message: `Time must be ${min} or later.` };
    }
    if (max) {
      var maxMs = parseISOTime(max);
      if (maxMs >= 0 && tMs > maxMs) return { valid: false, message: `Time must be ${max} or earlier.` };
    }
    return { valid: true };
  }

  return { valid: true };
}

/**
 * [Item 610] Validate and normalize an <input type="color"> value.
 *
 * HTML5 color inputs always store the value as a lowercase hex color: #rrggbb.
 * Accepts #rgb, #rrggbb, named colors, rgb() notation.
 */
export function validateColor(value: string): { valid: boolean; normalized?: string; message?: string } {
  if (!value) return { valid: false, message: 'A color is required.' };
  var s = value.trim().toLowerCase();

  if (/^#[0-9a-f]{6}$/.test(s)) return { valid: true, normalized: s };
  if (/^#[0-9a-f]{3}$/.test(s)) {
    var hex6 = '#' + s[1]! + s[1]! + s[2]! + s[2]! + s[3]! + s[3]!;
    return { valid: true, normalized: hex6 };
  }
  if (s.startsWith('rgb(')) {
    var m3 = s.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
    if (m3) {
      var toHex = (n: number): string => Math.min(255, Math.max(0, n)).toString(16).padStart(2, '0');
      return { valid: true, normalized: '#' + toHex(parseInt(m3[1]!)) + toHex(parseInt(m3[2]!)) + toHex(parseInt(m3[3]!)) };
    }
  }
  // Named colors (small subset)
  var named: Record<string, string> = {
    black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000',
    blue: '#0000ff', yellow: '#ffff00', orange: '#ffa500', purple: '#800080',
    pink: '#ffc0cb', grey: '#808080', gray: '#808080', cyan: '#00ffff',
    magenta: '#ff00ff', brown: '#a52a2a', navy: '#000080',
  };
  if (named[s]) return { valid: true, normalized: named[s] };

  return { valid: false, message: `"${value}" is not a valid color.` };
}

/**
 * [Item 611] <input type="file"> — VFS file picker validation.
 *
 * Validates that the selected file path(s) exist in the virtual filesystem
 * and optionally match the `accept` attribute filter.
 *
 * @param filePaths  Array of selected file paths from the VFS picker
 * @param accept     Comma-separated MIME types or extensions (e.g. ".png,.jpg,image/*")
 * @param multiple   Whether multiple files are allowed
 */
export function validateFileInput(
  filePaths:   string[],
  accept?:     string,
  multiple?:   boolean,
): { valid: boolean; message?: string } {
  if (filePaths.length === 0) return { valid: false, message: 'Please select a file.' };
  if (!multiple && filePaths.length > 1) return { valid: false, message: 'Only one file may be selected.' };

  if (accept) {
    var acceptList = accept.split(',').map(a => a.trim().toLowerCase()).filter(Boolean);
    for (var fp of filePaths) {
      var ext = ('.' + fp.split('.').pop()).toLowerCase();
      var match = acceptList.some(function(a) {
        if (a.startsWith('.')) return a === ext;
        if (a.endsWith('/*')) {
          // MIME type wildcard: just check the extension roughly
          return true; // can't do MIME detection without reading the file
        }
        return false;
      });
      if (!match && acceptList.length > 0) {
        return { valid: false, message: `File "${fp.split('/').pop()}" does not match accepted types: ${accept}.` };
      }
    }
  }
  return { valid: true };
}

/**
 * [Item 612] Autofocus management.
 *
 * Given a list of positioned widgets, returns the id of the widget with
 * the `autofocus` attribute (represented as WidgetBlueprint.name === 'autofocus'
 * stored in a side channel, or via the `autofocus` field).
 *
 * The browser implementation should call `applyAutofocus()` after DOM load
 * to move the text cursor to the first autofocused field.
 */
export function findAutofocusWidget(widgets: PositionedWidget[]): number | null {
  for (var i = 0; i < widgets.length; i++) {
    if ((widgets[i] as any)['autofocus']) return widgets[i].id;
  }
  return null;
}

/**
 * [Item 613] Tab order management.
 *
 * Given a list of positioned widgets and the current focused widget id,
 * returns the next widget id in tab order (positive tabindex first,
 * then natural document order).
 *
 * @param widgets       All widgets on the page
 * @param currentId     Currently focused widget id (-1 for none)
 * @param reverse       True for Shift+Tab (reverse tab order)
 */
export function nextTabWidget(widgets: PositionedWidget[], currentId: number, reverse = false): number | null {
  // Partition widgets into tabindex>0 (sorted) and tabindex=0/unset (document order)
  type WI = PositionedWidget & { tabindex?: number };
  var positive = widgets.filter(w => ((w as WI).tabindex ?? 0) > 0)
    .sort((a, b) => ((a as WI).tabindex ?? 0) - ((b as WI).tabindex ?? 0));
  var natural  = widgets.filter(w => !((w as WI).tabindex) || ((w as WI).tabindex ?? 0) === 0);

  var ordered = [...positive, ...natural].filter(w => !w.disabled && w.kind !== 'hidden');
  if (ordered.length === 0) return null;

  var idx = ordered.findIndex(w => w.id === currentId);
  if (idx === -1) return ordered[reverse ? ordered.length - 1 : 0]?.id ?? null;

  var next = reverse ? idx - 1 : idx + 1;
  if (next < 0) next = ordered.length - 1;
  if (next >= ordered.length) next = 0;
  return ordered[next]?.id ?? null;
}

/**
 * [Item 614] <datalist> autocomplete suggestions.
 *
 * Given the current input value and a list of datalist option values,
 * returns filtered options that match as a prefix or substring.
 *
 * @param value    Current input value (may be partial)
 * @param options  Array of datalist option values from the HTML
 * @param maxItems Maximum suggestions to return (default 10)
 */
export function datalistSuggestions(value: string, options: string[], maxItems = 10): string[] {
  if (!value) return options.slice(0, maxItems);
  var lower = value.toLowerCase();
  // Priority: prefix matches first, then substring matches
  var prefix:    string[] = [];
  var substring: string[] = [];
  for (var opt of options) {
    var low = opt.toLowerCase();
    if (low.startsWith(lower))       prefix.push(opt);
    else if (low.includes(lower))    substring.push(opt);
  }
  return [...prefix, ...substring].slice(0, maxItems);
}

