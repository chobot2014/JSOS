/**
 * locale.ts — JSOS Locale Module (items 925, 926)
 *
 * Provides date/number/string formatting and collation without depending on
 * IANA Intl runtime (QuickJS has limited Intl support). Individual processes
 * can set their own locale; the default is read from /etc/config.json.
 *
 * API surface:
 *   locale.set('en-US')          — set locale for the current process
 *   locale.get()                 — current locale string
 *   locale.format(date)          — format Date as locale-aware string
 *   locale.formatNumber(n, opts) — format number (decimal/currency/percent)
 *   locale.collate(a, b)         — locale-aware string comparison (-1 / 0 / 1)
 *   locale.sortKey(s)            — produce a stable sort key string for s
 */

import { config } from './config.js';

// ── Per-process locale storage ────────────────────────────────────────────────
// We store one locale string per QuickJS context (there is only one per process
// in JSOS). Module-level variable acts as the "process" locale.
var _currentLocale: string = '';

/** Read resolved locale — falls back to /etc/config.json → 'en-US'. */
export function get(): string {
  if (_currentLocale) return _currentLocale;
  return config.get<string>('locale', 'en-US');
}

/** Set the locale for this process. (item 926) */
export function set(locale: string): void {
  _currentLocale = locale;
}

// ── Built-in locale data ──────────────────────────────────────────────────────
// Minimal but functional inline tables so we have no external deps.

interface LocaleData {
  months:    string[];                  // [0] = January
  monthsShort: string[];
  days:      string[];                  // [0] = Sunday
  daysShort: string[];
  ampm:      [string, string];          // ['AM', 'PM']
  dateFormat: string;                   // strftime-style: %d/%m/%Y  etc.
  timeFormat: string;
  decimalSep: string;                   // '.' or ','
  groupSep:   string;                   // ',' or '.' or ''
  currencySymbol: string;
  currencyAfter: boolean;               // true → 10 € vs $ 10
}

var _localeData: Record<string, LocaleData> = {
  'en-US': {
    months: ['January','February','March','April','May','June',
             'July','August','September','October','November','December'],
    monthsShort: ['Jan','Feb','Mar','Apr','May','Jun',
                  'Jul','Aug','Sep','Oct','Nov','Dec'],
    days: ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'],
    daysShort: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'],
    ampm: ['AM','PM'],
    dateFormat: '%m/%d/%Y',
    timeFormat: '%I:%M:%S %p',
    decimalSep: '.', groupSep: ',', currencySymbol: '$', currencyAfter: false,
  },
  'en-GB': {
    months: ['January','February','March','April','May','June',
             'July','August','September','October','November','December'],
    monthsShort: ['Jan','Feb','Mar','Apr','May','Jun',
                  'Jul','Aug','Sep','Oct','Nov','Dec'],
    days: ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'],
    daysShort: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'],
    ampm: ['am','pm'],
    dateFormat: '%d/%m/%Y',
    timeFormat: '%H:%M:%S',
    decimalSep: '.', groupSep: ',', currencySymbol: '£', currencyAfter: false,
  },
  'de-DE': {
    months: ['Januar','Februar','März','April','Mai','Juni',
             'Juli','August','September','Oktober','November','Dezember'],
    monthsShort: ['Jan','Feb','Mär','Apr','Mai','Jun',
                  'Jul','Aug','Sep','Okt','Nov','Dez'],
    days: ['Sonntag','Montag','Dienstag','Mittwoch','Donnerstag','Freitag','Samstag'],
    daysShort: ['So','Mo','Di','Mi','Do','Fr','Sa'],
    ampm: ['AM','PM'],
    dateFormat: '%d.%m.%Y',
    timeFormat: '%H:%M:%S',
    decimalSep: ',', groupSep: '.', currencySymbol: '€', currencyAfter: true,
  },
  'fr-FR': {
    months: ['janvier','février','mars','avril','mai','juin',
             'juillet','août','septembre','octobre','novembre','décembre'],
    monthsShort: ['jan','fév','mar','avr','mai','jun',
                  'jul','aoû','sep','oct','nov','déc'],
    days: ['dimanche','lundi','mardi','mercredi','jeudi','vendredi','samedi'],
    daysShort: ['dim','lun','mar','mer','jeu','ven','sam'],
    ampm: ['AM','PM'],
    dateFormat: '%d/%m/%Y',
    timeFormat: '%H:%M:%S',
    decimalSep: ',', groupSep: ' ', currencySymbol: '€', currencyAfter: true,
  },
  'ja-JP': {
    months: ['1月','2月','3月','4月','5月','6月',
             '7月','8月','9月','10月','11月','12月'],
    monthsShort: ['1月','2月','3月','4月','5月','6月',
                  '7月','8月','9月','10月','11月','12月'],
    days: ['日曜日','月曜日','火曜日','水曜日','木曜日','金曜日','土曜日'],
    daysShort: ['日','月','火','水','木','金','土'],
    ampm: ['午前','午後'],
    dateFormat: '%Y年%m月%d日',
    timeFormat: '%H:%M:%S',
    decimalSep: '.', groupSep: ',', currencySymbol: '¥', currencyAfter: false,
  },
  'zh-CN': {
    months: ['一月','二月','三月','四月','五月','六月',
             '七月','八月','九月','十月','十一月','十二月'],
    monthsShort: ['1月','2月','3月','4月','5月','6月',
                  '7月','8月','9月','10月','11月','12月'],
    days: ['星期日','星期一','星期二','星期三','星期四','星期五','星期六'],
    daysShort: ['日','一','二','三','四','五','六'],
    ampm: ['上午','下午'],
    dateFormat: '%Y/%m/%d',
    timeFormat: '%H:%M:%S',
    decimalSep: '.', groupSep: ',', currencySymbol: '¥', currencyAfter: false,
  },
  'ar-SA': {
    months: ['يناير','فبراير','مارس','أبريل','مايو','يونيو',
             'يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'],
    monthsShort: ['يناير','فبراير','مارس','أبريل','مايو','يونيو',
                  'يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'],
    days: ['الأحد','الاثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'],
    daysShort: ['أحد','اثن','ثلا','أرب','خمي','جمع','سبت'],
    ampm: ['ص','م'],
    dateFormat: '%d/%m/%Y',
    timeFormat: '%I:%M:%S %p',
    decimalSep: '.', groupSep: ',', currencySymbol: 'ر.س', currencyAfter: true,
  },
};

/** Return locale data, falling back to en-US if unknown. */
function _data(locale?: string): LocaleData {
  var loc = locale || get();
  // Exact match
  if (_localeData[loc]) return _localeData[loc];
  // Language-only fallback: 'de' → 'de-DE'
  var lang = loc.split('-')[0];
  for (var key in _localeData) {
    if (key.split('-')[0] === lang) return _localeData[key];
  }
  return _localeData['en-US'];
}

// ── Date formatting (item 925) ────────────────────────────────────────────────

/**
 * Format a Date object using the locale-specific format.
 * @param date  Date to format (defaults to now).
 * @param style 'date' | 'time' | 'datetime' (default)
 */
export function format(date?: Date, style: 'date' | 'time' | 'datetime' = 'datetime'): string {
  var d = date || new Date();
  var ld = _data();
  var fmt = style === 'date'     ? ld.dateFormat
            : style === 'time'   ? ld.timeFormat
            : ld.dateFormat + ' ' + ld.timeFormat;
  return _strftime(fmt, d, ld);
}

/** Format a Date with an explicit locale. */
export function formatWithLocale(date: Date, locale: string,
                                  style: 'date' | 'time' | 'datetime' = 'datetime'): string {
  var ld = _data(locale);
  var fmt = style === 'date'     ? ld.dateFormat
            : style === 'time'   ? ld.timeFormat
            : ld.dateFormat + ' ' + ld.timeFormat;
  return _strftime(fmt, date, ld);
}

/** strftime-style token expansion. Supports: %Y %y %m %d %H %I %M %S %p %A %a %B %b */
function _strftime(fmt: string, d: Date, ld: LocaleData): string {
  var h24 = d.getHours();
  var isPM = h24 >= 12;
  var h12 = h24 % 12 || 12;
  return fmt.replace(/%[YymdHIMSpAaBb]/g, (tok) => {
    switch (tok) {
      case '%Y': return String(d.getFullYear());
      case '%y': return String(d.getFullYear()).slice(-2);
      case '%m': return _pad2(d.getMonth() + 1);
      case '%d': return _pad2(d.getDate());
      case '%H': return _pad2(h24);
      case '%I': return _pad2(h12);
      case '%M': return _pad2(d.getMinutes());
      case '%S': return _pad2(d.getSeconds());
      case '%p': return isPM ? ld.ampm[1] : ld.ampm[0];
      case '%A': return ld.days[d.getDay()];
      case '%a': return ld.daysShort[d.getDay()];
      case '%B': return ld.months[d.getMonth()];
      case '%b': return ld.monthsShort[d.getMonth()];
      default:   return tok;
    }
  });
}

function _pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

// ── Number formatting ──────────────────────────────────────────────────────────

export interface NumberFormatOptions {
  /** 'decimal' (default) | 'currency' | 'percent' */
  style?: 'decimal' | 'currency' | 'percent';
  /** Decimal digits to use (default 2 for currency, 0 for integers, auto otherwise). */
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
  /** Currency symbol override. */
  currency?: string;
}

/**
 * Format a number according to the current locale.
 * @example locale.formatNumber(1234567.89) // '1,234,567.89'
 * @example locale.formatNumber(0.1234, { style: 'percent' }) // '12.34%'
 */
export function formatNumber(n: number, opts?: NumberFormatOptions): string {
  var ld = _data();
  var style = (opts && opts.style) || 'decimal';
  var pct = style === 'percent' ? n * 100 : n;
  var minFrac = opts && opts.minimumFractionDigits !== undefined ? opts.minimumFractionDigits
                : style === 'currency' ? 2 : undefined;
  var maxFrac = opts && opts.maximumFractionDigits !== undefined ? opts.maximumFractionDigits
                : style === 'currency' ? 2 : undefined;

  var parts = pct.toFixed(maxFrac !== undefined ? maxFrac : 2).split('.');
  var intPart = parts[0];
  var fracPart = parts.length > 1 ? parts[1] : '';

  // Remove trailing zeros if no min specified
  if (minFrac === undefined && fracPart) {
    fracPart = fracPart.replace(/0+$/, '');
  } else if (minFrac !== undefined && fracPart.length < minFrac) {
    while (fracPart.length < minFrac) fracPart += '0';
  }

  // Insert group separators (thousands)
  var grouped = '';
  var neg = intPart[0] === '-';
  var digits = neg ? intPart.slice(1) : intPart;
  for (var i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0 && ld.groupSep) grouped += ld.groupSep;
    grouped += digits[i];
  }
  if (neg) grouped = '-' + grouped;

  var result = fracPart ? grouped + ld.decimalSep + fracPart : grouped;

  if (style === 'currency') {
    var sym = (opts && opts.currency) || ld.currencySymbol;
    result = ld.currencyAfter ? result + '\u00a0' + sym : sym + result;
  } else if (style === 'percent') {
    result += '%';
  }

  return result;
}

// ── String collation (item 925) ────────────────────────────────────────────────

/**
 * Locale-aware string comparison. Returns -1, 0 or 1.
 * Uses basic Unicode code-point comparison with accented letter folding for
 * common Latin scripts. For full Unicode collation a proper DUCET table would
 * be needed, but this covers the 95 % everyday case.
 */
export function collate(a: string, b: string): -1 | 0 | 1 {
  var ka = sortKey(a);
  var kb = sortKey(b);
  if (ka < kb) return -1;
  if (ka > kb) return 1;
  return 0;
}

/**
 * Return a stable sort key string for locale-aware ordering.
 * Folds accents/diacritics for Latin-based scripts so that ä sorts like a, ö like o, etc.
 */
export function sortKey(s: string): string {
  // Normalise to NFD-like by collapsing common accented Latin chars to their base
  return s.toLowerCase()
    .replace(/[àáâãäå]/g, 'a')
    .replace(/[èéêë]/g, 'e')
    .replace(/[ìíîï]/g, 'i')
    .replace(/[òóôõöø]/g, 'o')
    .replace(/[ùúûü]/g, 'u')
    .replace(/[ýÿ]/g, 'y')
    .replace(/[ñ]/g, 'n')
    .replace(/[ç]/g, 'c')
    .replace(/[ß]/g, 'ss')
    .replace(/[æ]/g, 'ae')
    .replace(/[œ]/g, 'oe')
    .replace(/[ð]/g, 'd')
    .replace(/[þ]/g, 'th');
}

// ── Export facade object ──────────────────────────────────────────────────────

export const locale = {
  get,
  set,
  format,
  formatWithLocale,
  formatNumber,
  collate,
  sortKey,
};
