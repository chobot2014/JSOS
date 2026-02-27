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
