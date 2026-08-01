/**
 * timezone.ts — IANA timezone database (item 919)
 *
 * Provides a compact subset of the IANA tz database as a TypeScript module.
 * Exposed as `os.time.tz` via sdk.ts.
 *
 * API:
 *   tz.list()                    → string[]     — all known zone names
 *   tz.offset(zone, epochMs?)    → number        — UTC offset in minutes at the given time
 *   tz.abbr(zone, epochMs?)      → string        — abbreviation (e.g. 'EST', 'CEST')
 *   tz.convert(epochMs, from, to) → number       — convert epoch ms from one zone to another
 *   tz.localToUtc(localMs, zone) → number        — local clock time → UTC epoch ms
 *   tz.utcToLocal(epochMs, zone) → number        — UTC epoch ms → local clock ms
 */

// ── Compact zone table ────────────────────────────────────────────────────────
// Each entry: [stdOffset, dstOffset, dstStart (month,week,dow,hr), dstEnd, stdAbbr, dstAbbr]
// Offsets in minutes east of UTC; month 1-12; week 1=first,5=last; dow 0=Sun; hr local.
// If dstOffset === stdOffset → no DST.

interface TZRule {
  std: number;   // standard offset (min east of UTC)
  dst: number;   // DST offset (min east of UTC); same as std = no DST
  // DST starts at: first occurrence of dow on or after (month, week*7 days from start) at hr local
  dsM: number; dsDow: number; dsWk: number; dsHr: number;
  deM: number; deDow: number; deWk: number; deHr: number;
  sAbbr: string;
  dAbbr: string;
}

function _rule(std: number, dst: number,
               dsM: number, dsDow: number, dsWk: number, dsHr: number,
               deM: number, deDow: number, deWk: number, deHr: number,
               sAbbr: string, dAbbr: string): TZRule {
  return { std, dst, dsM, dsDow, dsWk, dsHr, deM, deDow, deWk, deHr, sAbbr, dAbbr };
}

const _ZONES: Record<string, TZRule> = {
  // UTC/GMT
  'UTC':                   _rule(0,    0,    0,0,0,0,  0,0,0,0,  'UTC',   'UTC'),
  'GMT':                   _rule(0,    0,    0,0,0,0,  0,0,0,0,  'GMT',   'GMT'),
  'Etc/UTC':               _rule(0,    0,    0,0,0,0,  0,0,0,0,  'UTC',   'UTC'),
  'Etc/GMT':               _rule(0,    0,    0,0,0,0,  0,0,0,0,  'GMT',   'GMT'),

  // Americas — US zones (DST: 2nd Sun Mar 02:00 → 1st Sun Nov 02:00)
  'America/New_York':      _rule(-300, -240,  3,0,2,2, 11,0,1,2, 'EST',  'EDT'),
  'America/Chicago':       _rule(-360, -300,  3,0,2,2, 11,0,1,2, 'CST',  'CDT'),
  'America/Denver':        _rule(-420, -360,  3,0,2,2, 11,0,1,2, 'MST',  'MDT'),
  'America/Los_Angeles':   _rule(-480, -420,  3,0,2,2, 11,0,1,2, 'PST',  'PDT'),
  'America/Anchorage':     _rule(-540, -480,  3,0,2,2, 11,0,1,2, 'AKST', 'AKDT'),
  'Pacific/Honolulu':      _rule(-600, -600,  0,0,0,0,  0,0,0,0, 'HST',  'HST'),
  'America/Phoenix':       _rule(-420, -420,  0,0,0,0,  0,0,0,0, 'MST',  'MST'),
  'America/Toronto':       _rule(-300, -240,  3,0,2,2, 11,0,1,2, 'EST',  'EDT'),
  'America/Vancouver':     _rule(-480, -420,  3,0,2,2, 11,0,1,2, 'PST',  'PDT'),
  'America/Mexico_City':   _rule(-360, -300,  4,0,1,2, 10,0,5,2, 'CST',  'CDT'),
  'America/Sao_Paulo':     _rule(-180, -120,  10,0,3,0,  2,0,3,0,'BRT',  'BRST'),
  'America/Argentina/Buenos_Aires': _rule(-180, -180, 0,0,0,0, 0,0,0,0, 'ART', 'ART'),
  'America/Santiago':      _rule(-240, -180,  10,0,2,24, 3,0,2,24,'CLT', 'CLST'),
  'America/Bogota':        _rule(-300, -300,  0,0,0,0,  0,0,0,0, 'COT',  'COT'),
  'America/Lima':          _rule(-300, -300,  0,0,0,0,  0,0,0,0, 'PET',  'PET'),

  // Europe (DST: last Sun Mar 01:00 UTC → last Sun Oct 01:00 UTC)
  'Europe/London':         _rule(0,    60,    3,0,5,1, 10,0,5,1, 'GMT',  'BST'),
  'Europe/Dublin':         _rule(0,    60,    3,0,5,1, 10,0,5,1, 'GMT',  'IST'),
  'Europe/Paris':          _rule(60,   120,   3,0,5,2, 10,0,5,3, 'CET',  'CEST'),
  'Europe/Berlin':         _rule(60,   120,   3,0,5,2, 10,0,5,3, 'CET',  'CEST'),
  'Europe/Rome':           _rule(60,   120,   3,0,5,2, 10,0,5,3, 'CET',  'CEST'),
  'Europe/Madrid':         _rule(60,   120,   3,0,5,2, 10,0,5,3, 'CET',  'CEST'),
  'Europe/Amsterdam':      _rule(60,   120,   3,0,5,2, 10,0,5,3, 'CET',  'CEST'),
  'Europe/Brussels':       _rule(60,   120,   3,0,5,2, 10,0,5,3, 'CET',  'CEST'),
  'Europe/Warsaw':         _rule(60,   120,   3,0,5,2, 10,0,5,3, 'CET',  'CEST'),
  'Europe/Athens':         _rule(120,  180,   3,0,5,3, 10,0,5,4, 'EET',  'EEST'),
  'Europe/Bucharest':      _rule(120,  180,   3,0,5,3, 10,0,5,4, 'EET',  'EEST'),
  'Europe/Helsinki':       _rule(120,  180,   3,0,5,3, 10,0,5,4, 'EET',  'EEST'),
  'Europe/Istanbul':       _rule(180,  180,   0,0,0,0,  0,0,0,0, 'TRT',  'TRT'),
  'Europe/Moscow':         _rule(180,  180,   0,0,0,0,  0,0,0,0, 'MSK',  'MSK'),
  'Europe/Kiev':           _rule(120,  180,   3,0,5,3, 10,0,5,4, 'EET',  'EEST'),
  'Europe/Stockholm':      _rule(60,   120,   3,0,5,2, 10,0,5,3, 'CET',  'CEST'),
  'Europe/Oslo':           _rule(60,   120,   3,0,5,2, 10,0,5,3, 'CET',  'CEST'),
  'Europe/Copenhagen':     _rule(60,   120,   3,0,5,2, 10,0,5,3, 'CET',  'CEST'),
  'Europe/Lisbon':         _rule(0,    60,    3,0,5,1, 10,0,5,2, 'WET',  'WEST'),
  'Europe/Zurich':         _rule(60,   120,   3,0,5,2, 10,0,5,3, 'CET',  'CEST'),
  'Europe/Prague':         _rule(60,   120,   3,0,5,2, 10,0,5,3, 'CET',  'CEST'),
  'Europe/Budapest':       _rule(60,   120,   3,0,5,2, 10,0,5,3, 'CET',  'CEST'),
  'Europe/Vienna':         _rule(60,   120,   3,0,5,2, 10,0,5,3, 'CET',  'CEST'),

  // Asia / Pacific
  'Asia/Dubai':            _rule(240,  240,   0,0,0,0,  0,0,0,0, 'GST',  'GST'),
  'Asia/Karachi':          _rule(300,  300,   0,0,0,0,  0,0,0,0, 'PKT',  'PKT'),
  'Asia/Kolkata':          _rule(330,  330,   0,0,0,0,  0,0,0,0, 'IST',  'IST'),
  'Asia/Dhaka':            _rule(360,  360,   0,0,0,0,  0,0,0,0, 'BST',  'BST'),
  'Asia/Bangkok':          _rule(420,  420,   0,0,0,0,  0,0,0,0, 'ICT',  'ICT'),
  'Asia/Jakarta':          _rule(420,  420,   0,0,0,0,  0,0,0,0, 'WIB',  'WIB'),
  'Asia/Ho_Chi_Minh':      _rule(420,  420,   0,0,0,0,  0,0,0,0, 'ICT',  'ICT'),
  'Asia/Shanghai':         _rule(480,  480,   0,0,0,0,  0,0,0,0, 'CST',  'CST'),
  'Asia/Hong_Kong':        _rule(480,  480,   0,0,0,0,  0,0,0,0, 'HKT',  'HKT'),
  'Asia/Taipei':           _rule(480,  480,   0,0,0,0,  0,0,0,0, 'CST',  'CST'),
  'Asia/Singapore':        _rule(480,  480,   0,0,0,0,  0,0,0,0, 'SGT',  'SGT'),
  'Asia/Kuala_Lumpur':     _rule(480,  480,   0,0,0,0,  0,0,0,0, 'MYT',  'MYT'),
  'Asia/Manila':           _rule(480,  480,   0,0,0,0,  0,0,0,0, 'PHT',  'PHT'),
  'Asia/Seoul':            _rule(540,  540,   0,0,0,0,  0,0,0,0, 'KST',  'KST'),
  'Asia/Tokyo':            _rule(540,  540,   0,0,0,0,  0,0,0,0, 'JST',  'JST'),
  'Asia/Vladivostok':      _rule(600,  600,   0,0,0,0,  0,0,0,0, 'VLAT', 'VLAT'),
  'Asia/Magadan':          _rule(660,  660,   0,0,0,0,  0,0,0,0, 'MAGT', 'MAGT'),
  'Asia/Kamchatka':        _rule(720,  720,   0,0,0,0,  0,0,0,0, 'PETT', 'PETT'),
  'Asia/Tehran':           _rule(210,  270,   3,0,0,0,   9,0,0,0,'IRST', 'IRDT'),
  'Asia/Jerusalem':        _rule(120,  180,   3,5,5,2, 10,0,5,2, 'IST',  'IDT'),
  'Asia/Riyadh':           _rule(180,  180,   0,0,0,0,  0,0,0,0, 'AST',  'AST'),
  'Asia/Baghdad':          _rule(180,  180,   0,0,0,0,  0,0,0,0, 'AST',  'AST'),
  'Asia/Yerevan':          _rule(240,  300,   3,0,5,2, 10,0,5,3, 'AMT',  'AMST'),
  'Asia/Kabul':            _rule(270,  270,   0,0,0,0,  0,0,0,0, 'AFT',  'AFT'),
  'Asia/Calcutta':         _rule(330,  330,   0,0,0,0,  0,0,0,0, 'IST',  'IST'),  // alias
  'Asia/Kathmandu':        _rule(345,  345,   0,0,0,0,  0,0,0,0, 'NPT',  'NPT'),
  'Asia/Rangoon':          _rule(390,  390,   0,0,0,0,  0,0,0,0, 'MMT',  'MMT'),
  'Asia/Colombo':          _rule(330,  330,   0,0,0,0,  0,0,0,0, 'IST',  'IST'),
  'Asia/Novosibirsk':      _rule(420,  420,   0,0,0,0,  0,0,0,0, 'NOVT', 'NOVT'),
  'Asia/Omsk':             _rule(360,  360,   0,0,0,0,  0,0,0,0, 'OMST', 'OMST'),
  'Asia/Krasnoyarsk':      _rule(420,  420,   0,0,0,0,  0,0,0,0, 'KRAT', 'KRAT'),
  'Asia/Irkutsk':          _rule(480,  480,   0,0,0,0,  0,0,0,0, 'IRKT', 'IRKT'),
  'Asia/Yakutsk':          _rule(540,  540,   0,0,0,0,  0,0,0,0, 'YAKT', 'YAKT'),

  // Africa
  'Africa/Cairo':          _rule(120,  120,   0,0,0,0,  0,0,0,0, 'EET',  'EET'),
  'Africa/Johannesburg':   _rule(120,  120,   0,0,0,0,  0,0,0,0, 'SAST', 'SAST'),
  'Africa/Nairobi':        _rule(180,  180,   0,0,0,0,  0,0,0,0, 'EAT',  'EAT'),
  'Africa/Lagos':          _rule(60,   60,    0,0,0,0,  0,0,0,0, 'WAT',  'WAT'),
  'Africa/Accra':          _rule(0,    0,     0,0,0,0,  0,0,0,0, 'GMT',  'GMT'),
  'Africa/Casablanca':     _rule(60,   120,   4,0,5,3, 10,0,5,4, 'WET',  'WEST'),
  'Africa/Tunis':          _rule(60,   60,    0,0,0,0,  0,0,0,0, 'CET',  'CET'),
  'Africa/Algiers':        _rule(60,   60,    0,0,0,0,  0,0,0,0, 'CET',  'CET'),

  // Pacific / Oceania
  'Australia/Sydney':      _rule(600,  660,   10,0,1,2,  4,0,1,3,'AEST', 'AEDT'),
  'Australia/Melbourne':   _rule(600,  660,   10,0,1,2,  4,0,1,3,'AEST', 'AEDT'),
  'Australia/Brisbane':    _rule(600,  600,   0,0,0,0,   0,0,0,0,'AEST', 'AEST'),
  'Australia/Adelaide':    _rule(570,  630,   10,0,1,2,  4,0,1,3,'ACST', 'ACDT'),
  'Australia/Darwin':      _rule(570,  570,   0,0,0,0,   0,0,0,0,'ACST', 'ACST'),
  'Australia/Perth':       _rule(480,  480,   0,0,0,0,   0,0,0,0,'AWST', 'AWST'),
  'Pacific/Auckland':      _rule(720,  780,   9,0,5,2,   4,0,1,3,'NZST', 'NZDT'),
  'Pacific/Fiji':          _rule(720,  780,   10,0,3,2,  1,0,3,3,'FJT',  'FJST'),
  'Pacific/Guam':          _rule(600,  600,   0,0,0,0,   0,0,0,0,'ChST', 'ChST'),
  'Pacific/Pago_Pago':     _rule(-660,-660,   0,0,0,0,   0,0,0,0,'SST',  'SST'),
  'Pacific/Tahiti':        _rule(-600,-600,   0,0,0,0,   0,0,0,0,'TAHT', 'TAHT'),

  // Common Etc/* fixed-offset zones
  'Etc/GMT+12':            _rule(-720,-720,   0,0,0,0,   0,0,0,0,'GMT-12','GMT-12'),
  'Etc/GMT+11':            _rule(-660,-660,   0,0,0,0,   0,0,0,0,'GMT-11','GMT-11'),
  'Etc/GMT+10':            _rule(-600,-600,   0,0,0,0,   0,0,0,0,'GMT-10','GMT-10'),
  'Etc/GMT+9':             _rule(-540,-540,   0,0,0,0,   0,0,0,0,'GMT-9','GMT-9'),
  'Etc/GMT+8':             _rule(-480,-480,   0,0,0,0,   0,0,0,0,'GMT-8','GMT-8'),
  'Etc/GMT+7':             _rule(-420,-420,   0,0,0,0,   0,0,0,0,'GMT-7','GMT-7'),
  'Etc/GMT+6':             _rule(-360,-360,   0,0,0,0,   0,0,0,0,'GMT-6','GMT-6'),
  'Etc/GMT+5':             _rule(-300,-300,   0,0,0,0,   0,0,0,0,'GMT-5','GMT-5'),
  'Etc/GMT+4':             _rule(-240,-240,   0,0,0,0,   0,0,0,0,'GMT-4','GMT-4'),
  'Etc/GMT+3':             _rule(-180,-180,   0,0,0,0,   0,0,0,0,'GMT-3','GMT-3'),
  'Etc/GMT+2':             _rule(-120,-120,   0,0,0,0,   0,0,0,0,'GMT-2','GMT-2'),
  'Etc/GMT+1':             _rule(-60,-60,     0,0,0,0,   0,0,0,0,'GMT-1','GMT-1'),
  'Etc/GMT-1':             _rule(60,  60,     0,0,0,0,   0,0,0,0,'GMT+1','GMT+1'),
  'Etc/GMT-2':             _rule(120, 120,    0,0,0,0,   0,0,0,0,'GMT+2','GMT+2'),
  'Etc/GMT-3':             _rule(180, 180,    0,0,0,0,   0,0,0,0,'GMT+3','GMT+3'),
  'Etc/GMT-4':             _rule(240, 240,    0,0,0,0,   0,0,0,0,'GMT+4','GMT+4'),
  'Etc/GMT-5':             _rule(300, 300,    0,0,0,0,   0,0,0,0,'GMT+5','GMT+5'),
  'Etc/GMT-6':             _rule(360, 360,    0,0,0,0,   0,0,0,0,'GMT+6','GMT+6'),
  'Etc/GMT-7':             _rule(420, 420,    0,0,0,0,   0,0,0,0,'GMT+7','GMT+7'),
  'Etc/GMT-8':             _rule(480, 480,    0,0,0,0,   0,0,0,0,'GMT+8','GMT+8'),
  'Etc/GMT-9':             _rule(540, 540,    0,0,0,0,   0,0,0,0,'GMT+9','GMT+9'),
  'Etc/GMT-10':            _rule(600, 600,    0,0,0,0,   0,0,0,0,'GMT+10','GMT+10'),
  'Etc/GMT-11':            _rule(660, 660,    0,0,0,0,   0,0,0,0,'GMT+11','GMT+11'),
  'Etc/GMT-12':            _rule(720, 720,    0,0,0,0,   0,0,0,0,'GMT+12','GMT+12'),
  'Etc/GMT-13':            _rule(780, 780,    0,0,0,0,   0,0,0,0,'GMT+13','GMT+13'),
  'Etc/GMT-14':            _rule(840, 840,    0,0,0,0,   0,0,0,0,'GMT+14','GMT+14'),
};

// ── DST calculation ───────────────────────────────────────────────────────────

/** Returns the UTC epoch ms of the Nth occurrence of weekday `dow` in `month`/`year`
 *  where week=1→first, week=2→second, week=5→last occurrence. */
function _nthWeekday(year: number, month: number, week: number, dow: number): number {
  // First day of month (0=Sun)
  var firstMs = Date.UTC(year, month - 1, 1);
  var firstDow = new Date(firstMs).getUTCDay();
  var diff = (dow - firstDow + 7) % 7;
  var first = 1 + diff;
  var day: number;
  if (week <= 0 || week >= 5) {
    // Last occurrence
    var daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    day = first + 7 * 4;
    while (day > daysInMonth) day -= 7;
  } else {
    day = first + 7 * (week - 1);
  }
  return Date.UTC(year, month - 1, day);
}

/**
 * Determine whether a UTC epoch ms falls in DST for the given zone.
 * Returns true if DST is in effect.
 */
function _isDST(rule: TZRule, epochMs: number): boolean {
  if (rule.std === rule.dst) return false;
  var d = new Date(epochMs);
  var year = d.getUTCFullYear();

  // DST transition expressed in local-standard time (use std offset)
  var startMs = _nthWeekday(year, rule.dsM, rule.dsWk, rule.dsDow)
               - rule.std * 60000 + rule.dsHr * 3600000;
  var endMs   = _nthWeekday(year, rule.deM, rule.deWk, rule.deDow)
               - rule.std * 60000 + rule.deHr * 3600000;

  if (startMs < endMs) {
    // Northern hemisphere: DST spring → fall
    return epochMs >= startMs && epochMs < endMs;
  } else {
    // Southern hemisphere: DST wraps around year boundary
    return epochMs >= startMs || epochMs < endMs;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Return sorted list of all known timezone names. */
export function list(): string[] {
  return Object.keys(_ZONES).sort();
}

/** Return the UTC offset in minutes (east of UTC) for `zone` at `epochMs` (now if omitted). */
export function offset(zone: string, epochMs?: number): number {
  var rule = _ZONES[zone];
  if (!rule) return 0;
  var t = (epochMs !== undefined) ? epochMs : Date.now();
  return _isDST(rule, t) ? rule.dst : rule.std;
}

/** Return the timezone abbreviation for `zone` at `epochMs`. */
export function abbr(zone: string, epochMs?: number): string {
  var rule = _ZONES[zone];
  if (!rule) return zone;
  var t = (epochMs !== undefined) ? epochMs : Date.now();
  return _isDST(rule, t) ? rule.dAbbr : rule.sAbbr;
}

/** Convert a UTC epoch ms to the local wall-clock ms in `zone`. */
export function utcToLocal(epochMs: number, zone: string): number {
  return epochMs + offset(zone, epochMs) * 60000;
}

/** Convert a local wall-clock ms in `zone` to UTC epoch ms (approximate). */
export function localToUtc(localMs: number, zone: string): number {
  var rule = _ZONES[zone];
  if (!rule) return localMs;
  // Approximate: use standard offset first, then check DST
  var approxUtc = localMs - rule.std * 60000;
  var off = _isDST(rule, approxUtc) ? rule.dst : rule.std;
  return localMs - off * 60000;
}

/** Convert epoch ms from timezone `from` to timezone `to`. */
export function convert(epochMs: number, _from: string, to: string): number {
  // epochMs is always UTC — just apply target offset
  return utcToLocal(epochMs, to);
}

/** Format offset as ±HH:MM string (e.g. '+05:30', '-08:00'). */
export function formatOffset(offsetMin: number): string {
  var sign   = offsetMin >= 0 ? '+' : '-';
  var abs    = Math.abs(offsetMin);
  var h      = Math.floor(abs / 60);
  var m      = abs % 60;
  var pad2   = (n: number) => (n < 10 ? '0' : '') + n;
  return sign + pad2(h) + ':' + pad2(m);
}

/** Return true if `zone` is a known IANA timezone name in this database. */
export function isKnown(zone: string): boolean {
  return Object.prototype.hasOwnProperty.call(_ZONES, zone);
}

export const tz = { list, offset, abbr, utcToLocal, localToUtc, convert, formatOffset, isKnown };
