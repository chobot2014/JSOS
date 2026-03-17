/**
 * JSOS Calendar App (Item 774)
 *
 * Interactive month-view calendar with navigation.
 * Uses kernel.getUptime() as a time base to derive a simulated month/year.
 *
 * Controls:
 *   Left / h / p    previous month
 *   Right / l / n   next month
 *   t               jump to "today"
 *   a               add a note for the selected day
 *   d               delete note for selected day
 *   Arrow Up/Down   move selection by week
 *   Enter / Space   view notes for selected day
 *   q / Escape      quit
 */

declare var kernel: any;

import terminal from '../../ui/terminal.js';
import { Color } from '../../core/kernel.js';

// ── Date maths helpers ────────────────────────────────────────────────────────

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December'
];
const DAY_ABBR = ['Su','Mo','Tu','We','Th','Fr','Sa'];

/** Number of days in a month (simple Gregorian). */
function daysInMonth(year: number, month: number): number {
  // month: 1-12
  if (month === 2) {
    return (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28;
  }
  return [0,31,28,31,30,31,30,31,31,30,31,30,31][month];
}

/**
 * Compute the day-of-week (0=Sun) for the 1st of a given month, using
 * Tomohiko Sakamoto's algorithm.
 */
function firstDayOfWeek(year: number, month: number): number {
  var t = [0,3,2,5,0,3,5,1,4,6,2,4];
  if (month < 3) year--;
  return (year + Math.floor(year/4) - Math.floor(year/100) + Math.floor(year/400) + t[month-1] + 1) % 7;
}

/** Derive a "current" year/month from uptime so the calendar always makes sense. */
function currentYearMonth(): { year: number; month: number; day: number } {
  // Base: 2025-01-01; advance by uptime days
  var uptimeSec = 0;
  try { uptimeSec = kernel.getUptime ? kernel.getUptime() : 0; } catch(_) {}
  var BASE_YEAR = 2025;
  var BASE_DOY  = 1;   // day-of-year
  var totalDays = Math.floor(uptimeSec / 86400) + BASE_DOY;
  var year = BASE_YEAR;
  while (true) {
    var diy = (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 366 : 365;
    if (totalDays <= diy) break;
    totalDays -= diy;
    year++;
  }
  var month = 1;
  while (month <= 12) {
    var dim = daysInMonth(year, month);
    if (totalDays <= dim) break;
    totalDays -= dim;
    month++;
  }
  return { year, month, day: Math.max(1, totalDays) };
}

// ── Notes store ───────────────────────────────────────────────────────────────

// Key: "YYYY-MM-DD" → note text
var notes = new Map<string, string>();

function noteKey(year: number, month: number, day: number): string {
  return year + '-' +
    String(month).padStart(2, '0') + '-' +
    String(day).padStart(2, '0');
}

// ── Renderer ──────────────────────────────────────────────────────────────────

function renderCalendar(
  term: typeof terminal,
  year: number,
  month: number,
  selDay: number,
  todayYear: number,
  todayMonth: number,
  todayDay: number
): void {
  term.println('\x1b[2J\x1b[H');  // clear

  // Header
  var title = '  ' + MONTH_NAMES[month - 1] + ' ' + year + '  ';
  var pad = Math.max(0, Math.floor((28 - title.length) / 2));
  term.colorPrintln(' '.repeat(pad) + title, Color.WHITE);
  term.colorPrintln(' Su  Mo  Tu  We  Th  Fr  Sa', Color.YELLOW);
  term.colorPrintln(' ' + '-'.repeat(27), Color.DARK_GREY);

  var firstDow = firstDayOfWeek(year, month);
  var dim      = daysInMonth(year, month);
  var col      = firstDow;
  var line     = ' '.repeat(col * 4);

  for (var d = 1; d <= dim; d++) {
    var hasNote = notes.has(noteKey(year, month, d));
    var isToday = (d === todayDay && month === todayMonth && year === todayYear);
    var isSel   = (d === selDay);

    var cell = String(d).padStart(2, ' ');
    if (hasNote) cell = cell + '*';
    else         cell = cell + ' ';

    if (isSel && isToday) {
      // selected + today
      line += '[' + cell + ']';
    } else if (isSel) {
      line += '[' + cell + ']';
    } else if (isToday) {
      line += '<' + cell + '>';
    } else {
      line += ' ' + cell + ' ';
    }

    col++;
    if (col === 7) {
      // flush line with colour
      var coloured = line;
      if (isSel || line.includes('[')) {
        term.colorPrintln(coloured, Color.LIGHT_CYAN);
      } else {
        term.println(coloured);
      }
      line = ' ';
      col  = 0;
    }
  }
  if (col > 0) {
    term.println(line);
  }

  term.colorPrintln(' ' + '-'.repeat(27), Color.DARK_GREY);

  // Show note for selected day if any
  var selKey = noteKey(year, month, selDay);
  var note   = notes.get(selKey);
  if (note) {
    term.colorPrintln('  Note [' + selDay + ']: ' + note, Color.LIGHT_GREEN);
  } else {
    term.colorPrintln('  Day ' + selDay + ' — no note', Color.DARK_GREY);
  }

  term.println('');
  term.colorPrintln(
    '  \u2190/h=prev  \u2192/l=next  t=today  a=add note  d=del note  q=quit',
    Color.DARK_GREY);
}

// ── Input helpers ─────────────────────────────────────────────────────────────

function readLine(term: typeof terminal, prompt: string): string {
  term.colorPrint(prompt, Color.YELLOW);
  var buf = '';
  while (true) {
    kernel.sleep(20);
    if (!kernel.hasKey()) continue;
    var k = kernel.readKey() as string;
    if (k === '\r' || k === '\n') break;
    if (k === '\x7f' || k === '\x08') {
      if (buf.length > 0) { buf = buf.slice(0, -1); term.print('\x08 \x08'); }
      continue;
    }
    if (k === '\x1b') break;
    buf += k;
    term.print(k);
  }
  term.println('');
  return buf;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export function launchCalendar(term: typeof terminal): void {
  var today = currentYearMonth();
  var year  = today.year;
  var month = today.month;
  var selDay = today.day;

  renderCalendar(term, year, month, selDay, today.year, today.month, today.day);

  while (true) {
    kernel.sleep(30);
    if (!kernel.hasKey()) continue;
    var key = kernel.readKey() as string;

    // Quit
    if (key === 'q' || key === '\x1b') break;

    // Navigate months
    var prevMonth = key === '\x1b[D' || key === 'h' || key === 'p';
    var nextMonth = key === '\x1b[C' || key === 'l' || key === 'n';

    if (prevMonth) {
      month--;
      if (month < 1) { month = 12; year--; }
      selDay = Math.min(selDay, daysInMonth(year, month));
      renderCalendar(term, year, month, selDay, today.year, today.month, today.day);
      continue;
    }
    if (nextMonth) {
      month++;
      if (month > 12) { month = 1; year++; }
      selDay = Math.min(selDay, daysInMonth(year, month));
      renderCalendar(term, year, month, selDay, today.year, today.month, today.day);
      continue;
    }

    // Move selection by day (up/down = week)
    if (key === '\x1b[A') {
      selDay = Math.max(1, selDay - 7);
      renderCalendar(term, year, month, selDay, today.year, today.month, today.day);
      continue;
    }
    if (key === '\x1b[B') {
      selDay = Math.min(daysInMonth(year, month), selDay + 7);
      renderCalendar(term, year, month, selDay, today.year, today.month, today.day);
      continue;
    }

    // Move selection by single day
    if (key === '-' || key === ',') {
      selDay = Math.max(1, selDay - 1);
      renderCalendar(term, year, month, selDay, today.year, today.month, today.day);
      continue;
    }
    if (key === '=' || key === '.') {
      selDay = Math.min(daysInMonth(year, month), selDay + 1);
      renderCalendar(term, year, month, selDay, today.year, today.month, today.day);
      continue;
    }

    // Jump to today
    if (key === 't') {
      var t2 = currentYearMonth();
      year    = t2.year;
      month   = t2.month;
      selDay  = t2.day;
      today   = t2;
      renderCalendar(term, year, month, selDay, today.year, today.month, today.day);
      continue;
    }

    // Add note
    if (key === 'a') {
      term.println('');
      var noteText = readLine(term, 'Note for ' + noteKey(year, month, selDay) + ': ');
      if (noteText.trim()) {
        notes.set(noteKey(year, month, selDay), noteText.trim());
        term.colorPrintln('Note saved.', Color.LIGHT_GREEN);
        kernel.sleep(600);
      }
      renderCalendar(term, year, month, selDay, today.year, today.month, today.day);
      continue;
    }

    // Delete note
    if (key === 'd') {
      if (notes.delete(noteKey(year, month, selDay))) {
        term.colorPrintln('Note deleted.', Color.YELLOW);
        kernel.sleep(400);
      }
      renderCalendar(term, year, month, selDay, today.year, today.month, today.day);
      continue;
    }

    // Enter / Space — view note detail
    if (key === '\r' || key === ' ') {
      var nk = noteKey(year, month, selDay);
      var n  = notes.get(nk);
      term.println('');
      term.colorPrintln('--- ' + nk + ' ---', Color.WHITE);
      term.println(n ?? '(no note)');
      term.colorPrintln('Press any key to continue...', Color.DARK_GREY);
      while (!kernel.hasKey()) kernel.sleep(30);
      kernel.readKey();
      renderCalendar(term, year, month, selDay, today.year, today.month, today.day);
      continue;
    }

    // Numeric day input: typing 1-31 jumps to that day
    if (key >= '1' && key <= '9') {
      var nd = parseInt(key, 10);
      if (nd >= 1 && nd <= daysInMonth(year, month)) {
        selDay = nd;
        renderCalendar(term, year, month, selDay, today.year, today.month, today.day);
      }
      continue;
    }
  }

  term.colorPrintln('[Calendar closed]', Color.DARK_GREY);
}
