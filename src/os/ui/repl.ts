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
import fs from '../fs/filesystem.js';
import { Color } from '../core/kernel.js';
import { threadManager } from '../process/threads.js';
import { net } from '../net/net.js';

declare var kernel: import('../core/kernel.js').KernelAPI;

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

//  Tab completion 

/**
 * Return a list of completion candidates for the current buffer.
 *
 * Handles three cases (item 652 for path completion):
 *   1. Inside a string literal whose content looks like a path → filesystem completions
 *   2. An identifier with a dot (obj.prop) → property name completions
 *   3. A bare identifier → global name completions
 */
function tabComplete(buf: string): string[] {
  // ── Case 1: filesystem path inside a string literal (item 652) ────────────
  // Detect an unmatched quote followed by something that looks like a path.
  var pathM = buf.match(/(['"])(\/?[^'"]*?)([^/]*)$/);
  if (pathM) {
    var quote    = pathM[1];  // ' or "
    var pathDir  = pathM[2];  // directory prefix including trailing / or ''
    var pathFile = pathM[3];  // file prefix being completed
    // Ensure there really is an unmatched quote before this match
    var rawBefore = buf.slice(0, buf.lastIndexOf(quote));
    var singles = (rawBefore.match(/'/g) || []).length;
    var doubles = (rawBefore.match(/"/g) || []).length;
    if ((quote === "'" && singles % 2 === 0) ||
        (quote === '"' && doubles % 2 === 0)) {
      // We're inside an open string — offer filesystem completions
      var dirToList = pathDir || '/';
      if (!dirToList.startsWith('/')) {
        dirToList = fs.cwd().replace(/\/?$/, '/') + dirToList;
      }
      var entries: Array<{ name: string; type: string }>;
      try { entries = (fs.ls(dirToList) as Array<{ name: string; type: string }>) || []; } catch(_) { entries = []; }
      var results: string[] = [];
      for (var ei = 0; ei < entries.length; ei++) {
        var ent = entries[ei];
        if (ent.name.indexOf(pathFile) === 0) {
          var completion = quote + pathDir + ent.name + (ent.type === 'directory' ? '/' : '');
          results.push(completion);
        }
      }
      return results.sort();
    }
  }

  // ── Cases 2 & 3: identifier / property completion ─────────────────────────
  var m = buf.match(/[\w$][\w$.]*$/);
  var prefix = m ? m[0] : '';
  if (!prefix) return [];

  var g = globalThis as any;
  var dot = prefix.lastIndexOf('.');

  if (dot === -1) {
    // Complete top-level global names
    var keys: string[] = [];
    for (var k in g) {
      if (k.indexOf(prefix) === 0) keys.push(k);
    }
    return keys.sort();
  } else {
    // Complete object.property
    var objExpr = prefix.slice(0, dot);
    var propPfx = prefix.slice(dot + 1);
    var obj = g[objExpr];
    if (obj === null || obj === undefined) return [];
    var keys: string[] = [];
    for (var k in obj) {
      if (k.indexOf(propPfx) === 0) keys.push(objExpr + '.' + k);
    }
    return keys.sort();
  }
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
    if (key.ext === 0x86) { terminal.scrollViewUp(20);   continue; }  // PgUp
    if (key.ext === 0x87) { terminal.scrollViewDown(20); continue; }  // PgDown
    // Any other key snaps back to the live view before acting
    terminal.resumeLive();

    if (key.ext !== 0) {
      if (key.ext === 0x80) {
        if (_history.length === 0) continue;
        if (histIdx === -1) { savedBuf = buf; histIdx = _history.length - 1; }
        else if (histIdx > 0) { histIdx--; }
        else { continue; }
        for (var i = 0; i < buf.length; i++) terminal.print('\b \b');
        buf = _history[histIdx];
        terminal.print(buf);
      } else if (key.ext === 0x81) {
        if (histIdx === -1) continue;
        for (var i = 0; i < buf.length; i++) terminal.print('\b \b');
        if (histIdx < _history.length - 1) {
          histIdx++;
          buf = _history[histIdx];
        } else {
          histIdx = -1;
          buf = savedBuf;
        }
        terminal.print(buf);
      }
      continue;
    }

    var ch = key.ch;
    if (!ch) continue;

    if (ch === '\n' || ch === '\r') { terminal.putchar('\n'); return buf; }

    if (ch === '\b' || ch === '\x7f') {
      if (buf.length > 0) { buf = buf.slice(0, -1); terminal.print('\b \b'); histIdx = -1; }
      continue;
    }

    if (ch === '\x03') { terminal.println('^C'); return ''; }

    if (ch === '\x15') {
      for (var i = 0; i < buf.length; i++) terminal.print('\b \b');
      buf = ''; histIdx = -1;
      continue;
    }

    if (ch === '\x0c') {
      terminal.clear();
      printPrompt();
      terminal.print(buf);
      continue;
    }

    if (ch === '\t') {
      var completions = tabComplete(buf);
      if (completions.length === 0) {
        // nothing — ring bell
        terminal.putchar('\x07');
      } else if (completions.length === 1) {
        // Inline-complete the remaining suffix
        var full = completions[0];
        var m = buf.match(/[\w$][\w$.]*$/);
        var partial = m ? m[0] : '';
        var suffix = full.slice(partial.length);
        buf += suffix;
        terminal.print(suffix);
        histIdx = -1;
      } else {
        // Show all candidates (sorted, 4 per row)
        terminal.println('');
        var cols = 4;
        for (var ci = 0; ci < completions.length; ci++) {
          var label = completions[ci];
          while (label.length < 20) label += ' ';
          terminal.print(label);
          if ((ci + 1) % cols === 0) terminal.println('');
        }
        if (completions.length % cols !== 0) terminal.println('');
        printPrompt();
        terminal.print(buf);
      }
      continue;
    }

    if (ch >= ' ') { buf += ch; terminal.print(ch); histIdx = -1; }
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

/** True when the string looks like an JS error (includes SyntaxError). */
function _isErrorString(s: string): boolean {
  return s.indexOf('Error:') !== -1;   // covers TypeError:, SyntaxError:, etc.
}

/**
 * Print a REPL result to the terminal with syntax-appropriate colouring.
 * Handles:
 *  - item 645: SyntaxError / all other errors shown in LIGHT_RED
 *  - item 649: Multi-line stack traces — first line in LIGHT_RED, each
 *              "at …" frame in DARK_GREY with file+line in LIGHT_YELLOW
 */
function _printReplResult(result: string): void {
  if (result === '__JSOS_PRINTED__') return;
  if (result === '__JSOS_UNDEF__' || result === 'undefined') return;

  // ── Error with optional stack trace (items 645 + 649) ────────────────────
  if (_isErrorString(result)) {
    var lines = result.split('\n');
    // First line: error message
    terminal.colorPrintln(lines[0], Color.LIGHT_RED);
    // Remaining lines: stack frames  (e.g. "    at foo (eval:1:5)")
    for (var li = 1; li < lines.length; li++) {
      var frame = lines[li];
      if (frame.trim().length === 0) continue;
      // Highlight "at <funcName> (<location>)" — dimm the "at", colour location
      var atIdx = frame.indexOf(' at ');
      if (atIdx !== -1) {
        var parenOpen = frame.lastIndexOf('(');
        var parenClose = frame.lastIndexOf(')');
        if (parenOpen !== -1 && parenClose > parenOpen) {
          // function name part
          terminal.colorPrint(frame.slice(0, parenOpen), Color.DARK_GREY);
          // file:line:col in brighter colour
          terminal.colorPrint(frame.slice(parenOpen, parenClose + 1), Color.YELLOW);
          terminal.colorPrintln('', Color.DARK_GREY);
        } else {
          terminal.colorPrintln(frame, Color.DARK_GREY);
        }
      } else {
        terminal.colorPrintln(frame, Color.DARK_GREY);
      }
    }
    return;
  }

  if (result === 'null') {
    terminal.colorPrintln('null', Color.DARK_GREY);
  } else if (result === 'true' || result === 'false') {
    terminal.colorPrintln(result, Color.YELLOW);
  } else if (result !== 'Infinity' && result !== '-Infinity' && result !== 'NaN' && !isNaN(Number(result))) {
    terminal.colorPrintln(result, Color.LIGHT_CYAN);
  } else if (result.length > 0 && result[0] === '"') {
    terminal.colorPrintln(result, Color.LIGHT_GREEN);
  } else {
    terminal.colorPrintln(result, Color.WHITE);
  }
}

// ── Top-level await support (item 646) ────────────────────────────────────────
// Install result/error callbacks in globalThis so async eval can call them.
// The callback prints the result one tick later (when the Promise resolves).
(function _setupAwaitCallbacks() {
  var g = globalThis as any;
  g.__replResult = function(v: unknown): void {
    var s: string;
    if (v === undefined) return;
    if (v === null) { s = 'null'; }
    else if (v instanceof Error) { s = String(v); }
    else if (v && typeof (v as any).__jsos_print__ === 'function') { (v as any).__jsos_print__(); return; }
    else if (typeof v === 'object') { try { s = JSON.stringify(v, null, 2); } catch (_) { s = String(v); } }
    else { s = String(v); }
    _printReplResult(s);
  };
  g.__replError = function(e: unknown): void {
    // item 649: format error with multi-line stack trace
    var errStr = e instanceof Error
      ? String(e) + (e.stack ? '\n' + e.stack : '')
      : 'Uncaught (in promise): ' + String(e) + ' Error:';
    _printReplResult(errStr);
  };
})();

function evalAndPrint(code: string): void {
  // ── Top-level await (item 646): wrap code in async IIFE ───────────────────
  var hasAwait = /\bawait\b/.test(code);
  if (hasAwait) {
    var asyncWrapped =
      '(async function(){' +
      'var __r=(' + code + ');' +
      'if(__r===undefined)return"__JSOS_UNDEF__";' +
      'if(__r===null)return"null";' +
      'if(__r instanceof Error)return String(__r);' +
      'if(__r&&typeof __r.__jsos_print__==="function"){__r.__jsos_print__();return"__JSOS_PRINTED__";}' +
      'if(typeof __r==="object")return JSON.stringify(__r,null,2);' +
      'return String(__r);' +
      '})()\n.then(function(r){__replResult(r)},function(e){__replError(e)})';
    kernel.eval(asyncWrapped);
    return; // result delivered asynchronously via __replResult / __replError
  }

  var exprWrapped =
    '(function(){' +
    'var __r=(' + code + ');' +
    'if(__r===undefined)return"__JSOS_UNDEF__";' +
    'if(__r===null)return"null";' +
    'if(__r instanceof Error)return String(__r);' +
    // If the value carries a pretty-printer, call it and signal the outer
    // handler to stay silent — the printer already wrote to the terminal.
    'if(__r&&typeof __r.__jsos_print__==="function"){__r.__jsos_print__();return"__JSOS_PRINTED__";}' +
    'if(typeof __r==="object")return JSON.stringify(__r,null,2);' +
    'return String(__r);' +
    '})()';

  var result = kernel.eval(exprWrapped);

  // Statement syntax (var/function/for/if …) — re-eval directly
  if (result.indexOf('SyntaxError') === 0) {
    result = kernel.eval(code);
    if (result === 'undefined') return;
  }

  _printReplResult(result);
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
  kernel.serialPut('REPL ready\n');
  // Register history() as a global here so it closes over _history
  (globalThis as any).history = function() {
    if (_history.length === 0) { terminal.println('(empty)'); return; }
    for (var i = 0; i < _history.length; i++) {
      var n = '' + (i + 1);
      while (n.length < 3) n = ' ' + n;
      terminal.colorPrint(n + '  ', Color.DARK_GREY);
      terminal.println(_history[i]);
    }
  };

  // ── Startup scripts (items 659, 660) ──────────────────────────────────────
  // Execute /etc/repl.ts (global startup) then /home/<user>/.repl.ts (per-user).
  var _startupPaths = ['/etc/repl.ts', '/etc/replrc'];
  var _userHome = ((globalThis as any).os && (globalThis as any).os.env &&
                   (globalThis as any).os.env.get('HOME')) || '/home/user';
  _startupPaths.push(_userHome + '/.repl.ts');
  _startupPaths.push(_userHome + '/.replrc');
  for (var _si = 0; _si < _startupPaths.length; _si++) {
    var _sp = _startupPaths[_si];
    var _spContent = fs.readFile(_sp);
    if (_spContent !== null && _spContent.trim().length > 0) {
      try {
        var _spResult = kernel.eval(_spContent);
        if (_spResult && _spResult.indexOf('Error:') !== -1) {
          terminal.colorPrintln('repl: error in ' + _sp + ': ' + _spResult, Color.LIGHT_RED);
        }
      } catch (_spErr) {
        terminal.colorPrintln('repl: error loading ' + _sp + ': ' + String(_spErr), Color.LIGHT_RED);
      }
    }
  }

  var mlBuffer = '';

  for (;;) {
    // Advance async coroutines (e.g. os.fetchAsync) and poll NIC frames.
    // Must run before blocking on readline so async work progresses each loop.
    threadManager.tickCoroutines();
    net.pollNIC();

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
