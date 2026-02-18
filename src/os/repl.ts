/**
 * JSOS JavaScript REPL
 *
 * Everything is plain JavaScript. Shell-like functions (ls, cd, cat, mkdir …)
 * are globals defined in main.ts. Type help() to see them all.
 *
 * Keyboard: Up/Down history  Ctrl+U erase  Ctrl+C cancel  Ctrl+L redraw
 *           open { ( [       auto-multiline; empty line to execute
 */

import terminal from './terminal.js';
import fs from './filesystem.js';
import { Color } from './kernel.js';

declare var kernel: import('./kernel.js').KernelAPI;

//  History 

var _history: string[] = [];
var HISTORY_MAX = 200;

function addHistory(line: string): void {
  var t = line.trim();
  if (!t) return;
  if (_history.length > 0 && _history[_history.length - 1] === t) return;
  _history.push(t);
  if (_history.length > HISTORY_MAX) _history.shift();
}

//  Readline 

function readline(printPrompt: () => void): string {
  printPrompt();
  var buf = '';
  var histIdx = -1;
  var savedBuf = '';

  for (;;) {
    var key = kernel.waitKeyEx();

    // ── Scrollback: PgUp / PgDown ──────────────────────────────────────────
    if (key.ext === 0x86) { kernel.scrollUp(20);   continue; }  // PgUp
    if (key.ext === 0x87) { kernel.scrollDown(20); continue; }  // PgDown
    // Any other key snaps back to the live view before acting
    kernel.resumeLive();

    if (key.ext !== 0) {
      if (key.ext === 0x80) {
        if (_history.length === 0) continue;
        if (histIdx === -1) { savedBuf = buf; histIdx = _history.length - 1; }
        else if (histIdx > 0) { histIdx--; }
        else { continue; }
        for (var i = 0; i < buf.length; i++) kernel.printRaw('\b \b');
        buf = _history[histIdx];
        kernel.printRaw(buf);
      } else if (key.ext === 0x81) {
        if (histIdx === -1) continue;
        for (var i = 0; i < buf.length; i++) kernel.printRaw('\b \b');
        if (histIdx < _history.length - 1) {
          histIdx++;
          buf = _history[histIdx];
        } else {
          histIdx = -1;
          buf = savedBuf;
        }
        kernel.printRaw(buf);
      }
      continue;
    }

    var ch = key.ch;
    if (!ch) continue;

    if (ch === '\n' || ch === '\r') { kernel.print(''); return buf; }

    if (ch === '\b' || ch === '\x7f') {
      if (buf.length > 0) { buf = buf.slice(0, -1); kernel.printRaw('\b \b'); histIdx = -1; }
      continue;
    }

    if (ch === '\x03') { kernel.print('^C'); return ''; }

    if (ch === '\x15') {
      for (var i = 0; i < buf.length; i++) kernel.printRaw('\b \b');
      buf = ''; histIdx = -1;
      continue;
    }

    if (ch === '\x0c') {
      kernel.clear();
      printPrompt();
      kernel.printRaw(buf);
      continue;
    }

    if (ch >= ' ') { buf += ch; kernel.printRaw(ch); histIdx = -1; }
  }
}

//  Bracket depth counter (automatic multiline) 

function isIncomplete(code: string): boolean {
  var depth = 0;
  var inStr = false;
  var strChar = '';
  var escaped = false;
  for (var i = 0; i < code.length; i++) {
    var c = code[i];
    if (escaped)             { escaped = false; continue; }
    if (c === '\\' && inStr) { escaped = true;  continue; }
    if (inStr)               { if (c === strChar) inStr = false; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = true; strChar = c; continue; }
    if (c === '{' || c === '(' || c === '[') depth++;
    if (c === '}' || c === ')' || c === ']') depth--;
  }
  return depth > 0;
}

//  Eval + display ───────────────────────────────────────────────────────────

// Try to evaluate code as an expression first so we can JSON-stringify objects.
// If that's a SyntaxError (e.g. it's a statement like `var x = 5`), fall back
// to direct eval. Shell functions return undefined — we suppress that silently.
function evalAndPrint(code: string): void {
  var exprWrapped =
    '(function(){' +
    'var __r=(' + code + ');' +
    'if(__r===undefined)return"__JSOS_UNDEF__";' +
    'if(__r===null)return"null";' +
    'if(__r instanceof Error)return String(__r);' +
    'if(typeof __r==="object")return JSON.stringify(__r,null,2);' +
    'return String(__r);' +
    '})()';

  var result = kernel.eval(exprWrapped);

  // Statement syntax (var/function/for/if …) — re-eval directly
  if (result.indexOf('SyntaxError') === 0) {
    result = kernel.eval(code);
    if (result === 'undefined') return;
  }

  if (result === '__JSOS_UNDEF__' || result === 'undefined') return;

  if (result === 'null') {
    terminal.colorPrintln('null', Color.DARK_GREY);
  } else if (result === 'true' || result === 'false') {
    terminal.colorPrintln(result, Color.YELLOW);
  } else if (result !== 'Infinity' && result !== '-Infinity' && result !== 'NaN' && !isNaN(Number(result))) {
    terminal.colorPrintln(result, Color.LIGHT_CYAN);
  } else if (result.indexOf('Error:') !== -1) {
    terminal.colorPrintln(result, Color.LIGHT_RED);
  } else if (result.length > 0 && result[0] === '"') {
    terminal.colorPrintln(result, Color.LIGHT_GREEN);
  } else {
    terminal.colorPrintln(result, Color.WHITE);
  }
}

//  Shell prompt ─────────────────────────────────────────────────────────────

function printShellPrompt(): void {
  var cwd = fs.cwd();
  if (cwd.indexOf('/home/user') === 0) cwd = '~' + cwd.slice(10);
  terminal.colorPrint(cwd, Color.LIGHT_BLUE);
  terminal.colorPrint('> ', Color.YELLOW);
}

function printContinuePrompt(): void {
  terminal.colorPrint('.. ', Color.DARK_GREY);
}

//  Main REPL loop ───────────────────────────────────────────────────────────

export function startRepl(): void {
  // Register history() as a global here so it closes over _history
  (globalThis as any).history = function() {
    if (_history.length === 0) { kernel.print('(empty)'); return; }
    for (var i = 0; i < _history.length; i++) {
      var n = '' + (i + 1);
      while (n.length < 3) n = ' ' + n;
      terminal.colorPrint(n + '  ', Color.DARK_GREY);
      terminal.println(_history[i]);
    }
  };

  var mlBuffer = '';

  for (;;) {
    var isMulti = mlBuffer.length > 0;
    var line = readline(isMulti ? printContinuePrompt : printShellPrompt);

    if (isMulti && line.trim().length === 0) {
      if (mlBuffer.trim().length > 0) { addHistory(mlBuffer.trim()); evalAndPrint(mlBuffer); }
      mlBuffer = '';
      continue;
    }

    if (line.trim().length === 0) continue;

    addHistory(line);

    var combined = mlBuffer + line + '\n';
    if (isIncomplete(combined)) { mlBuffer = combined; continue; }

    evalAndPrint(mlBuffer + line);
    mlBuffer = '';
  }
}
