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

// [Item 651] Extract and display function signature with type hints
function getFunctionSignature(fn: Function): string {
  try {
    var src = fn.toString();
    // Handle arrow functions, regular functions, and methods
    var m = src.match(/^(?:async\s+)?(?:function\s*\w*\s*)?\(([^)]*)\)/);
    if (!m) m = src.match(/^(?:async\s+)?(\([^)]*\))\s*=>/);
    if (!m) m = src.match(/^(?:async\s+)?[\w$]+\s*=\s*(?:async\s+)?\(([^)]*)\)/);
    var params = m ? (m[1] || m[0]) : '';
    var name = fn.name || '(anonymous)';
    return name + '(' + params + ')';
  } catch (_) {
    return fn.name || '(fn)';
  }
}

// [Item 651] Show function signature hint when completing, called from readline tab handler
function showFunctionHint(buf: string): boolean {
  // If the buffer ends like: `someFunc(` — show the signature
  var callM = buf.match(/([\w$][\w$.]*)\s*\(([^)]*)$/);
  if (!callM) return false;
  var fnExpr = callM[1];
  var g = globalThis as any;
  var fn: any;
  if (fnExpr.indexOf('.') === -1) {
    fn = g[fnExpr];
  } else {
    var parts = fnExpr.split('.');
    fn = g;
    for (var pi = 0; pi < parts.length; pi++) {
      if (fn == null) break;
      fn = fn[parts[pi]];
    }
  }
  if (typeof fn !== 'function') return false;
  var sig = getFunctionSignature(fn);
  terminal.println('');
  terminal.colorPrint('  ' + sig, Color.DARK_GREY);
  terminal.println('');
  return true;
}

//  Readline

// [Item 675] JS token coloriser for live syntax highlighting in the input line.
var _JS_KEYWORDS = new Set([
  'var','let','const','function','return','if','else','while','for','do',
  'break','continue','new','delete','typeof','instanceof','in','of','class',
  'extends','import','export','default','try','catch','finally','throw',
  'async','await','switch','case','null','true','false','undefined','void',
  'this','super','yield','get','set','static',
]);

/** [Item 675] Tokenize JS input into {text, color} pairs for live highlighting. */
function _jsTokenize(code: string): Array<{ text: string; color: number }> {
  var tokens: Array<{ text: string; color: number }> = [];
  var i = 0;
  while (i < code.length) {
    var c = code[i];
    // Line comment
    if (c === '/' && code[i + 1] === '/') {
      var end = code.indexOf('\n', i); if (end === -1) end = code.length;
      tokens.push({ text: code.slice(i, end), color: Color.DARK_GREY }); i = end; continue;
    }
    // Block comment
    if (c === '/' && code[i + 1] === '*') {
      var end2 = code.indexOf('*/', i + 2); if (end2 === -1) end2 = code.length - 2;
      tokens.push({ text: code.slice(i, end2 + 2), color: Color.DARK_GREY }); i = end2 + 2; continue;
    }
    // String
    if (c === '"' || c === "'" || c === '`') {
      var q = c; var j = i + 1;
      while (j < code.length && code[j] !== q) { if (code[j] === '\\') j++; j++; }
      tokens.push({ text: code.slice(i, j + 1), color: Color.LIGHT_GREEN }); i = j + 1; continue;
    }
    // Number
    if ((c >= '0' && c <= '9') || (c === '.' && i + 1 < code.length && code[i + 1] >= '0' && code[i + 1] <= '9')) {
      var jn = i;
      while (jn < code.length && /[\d.xXbBoOeE_]/.test(code[jn])) jn++;
      tokens.push({ text: code.slice(i, jn), color: Color.LIGHT_CYAN }); i = jn; continue;
    }
    // Identifier or keyword
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$') {
      var ji = i;
      while (ji < code.length && /[\w$]/.test(code[ji])) ji++;
      var word = code.slice(i, ji);
      tokens.push({ text: word, color: _JS_KEYWORDS.has(word) ? Color.YELLOW : Color.WHITE });
      i = ji; continue;
    }
    // Brackets
    var opColor = '()[]{}'.indexOf(c) !== -1 ? Color.WHITE :
                  '=!<>'.indexOf(c)   !== -1 ? Color.LIGHT_CYAN : Color.LIGHT_GREY;
    tokens.push({ text: c, color: opColor }); i++;
  }
  return tokens;
}

/** [Item 675] Erase `oldLen` terminal chars then reprint `newBuf` with syntax highlight colors. */
function _redrawLine(oldLen: number, newBuf: string): void {
  for (var i = 0; i < oldLen; i++) terminal.print('\b \b');
  var tokens = _jsTokenize(newBuf);
  for (var ti = 0; ti < tokens.length; ti++) terminal.colorPrint(tokens[ti].text, tokens[ti].color);
}

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
        var _ob1 = buf.length; buf = _history[histIdx];
        _redrawLine(_ob1, buf);  // [Item 675] syntax-highlighted history entry
      } else if (key.ext === 0x81) {
        if (histIdx === -1) continue;
        var _ob2 = buf.length;
        if (histIdx < _history.length - 1) { histIdx++; buf = _history[histIdx]; }
        else { histIdx = -1; buf = savedBuf; }
        _redrawLine(_ob2, buf);  // [Item 675]
      }
      continue;
    }

    var ch = key.ch;
    if (!ch) continue;

    if (ch === '\n' || ch === '\r') { terminal.putchar('\n'); return buf; }

    if (ch === '\b' || ch === '\x7f') {
      if (buf.length > 0) {
        var _ob3 = buf.length; buf = buf.slice(0, -1);
        _redrawLine(_ob3, buf);  // [Item 675] recolourise after backspace
        histIdx = -1;
      }
      continue;
    }

    if (ch === '\x03') { terminal.println('^C'); return ''; }

    if (ch === '\x15') {
      _redrawLine(buf.length, ''); buf = ''; histIdx = -1;  // [Item 675]
      continue;
    }

    if (ch === '\x0c') {
      terminal.clear(); printPrompt();
      _redrawLine(0, buf);  // [Item 675] reprint with colours after Ctrl+L
      continue;
    }

    if (ch === '\t') {
      // [Item 651] Check if cursor is inside a function call — show signature hint
      if (showFunctionHint(buf)) {
        printPrompt(); _redrawLine(0, buf);  // [Item 675]
        continue;
      }
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
        var _ob4 = buf.length; buf += suffix;
        _redrawLine(_ob4, buf);  // [Item 675] recolourise with suffix
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
        printPrompt(); _redrawLine(0, buf);  // [Item 675]
      }
      continue;
    }

    if (ch >= ' ') {
      var _ob5 = buf.length; buf += ch;
      _redrawLine(_ob5, buf);  // [Item 675] live syntax highlighting on every char
      histIdx = -1;
    }
  }
}



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
  // [Item 661] Rewrite ES `import` statements at the REPL prompt to dynamic requires.
  // `import X from 'path'`  →  `var X = require('path')`
  // `import { a, b } from 'path'`  →  `var { a, b } = require('path')`
  // `import * as X from 'path'`  →  `var X = require('path')`
  var importRx = /^\s*import\s+(?:(\*\s+as\s+[\w$]+|\{[^}]*\}|[\w$]+(?:\s*,\s*\{[^}]*\})?)\s+from\s+)?['"]([^'"]+)['"]\s*;?\s*$/;
  var importM = code.trim().match(importRx);
  if (importM) {
    var binding = importM[1];
    var modPath = importM[2];
    var requireExpr: string;
    if (!binding) {
      requireExpr = 'require(' + JSON.stringify(modPath) + ')';
    } else if (binding.startsWith('* as ')) {
      var asName = binding.slice(5).trim();
      requireExpr = 'var ' + asName + ' = require(' + JSON.stringify(modPath) + ')';
    } else {
      requireExpr = 'var ' + binding.trim() + ' = require(' + JSON.stringify(modPath) + ')';
    }
    code = requireExpr;
  }

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

// ── REPL Multi-Session Manager (items 653-658) ────────────────────────────

/** A single REPL session with isolated history and scope snapshot. */
export interface ReplSession {
  id: number;
  name: string;
  history: string[];
  /** Snapshot of globalThis keys that belong to this session's scope. */
  scopeKeys: Set<string>;
  mlBuffer: string;
  active: boolean;
}

let _nextSessionId = 1;
const _sessions: ReplSession[] = [];
let _activeSessionId = 0;

/** Capture the current set of user-defined globalThis keys. */
function _captureScope(): Set<string> {
  var keys = new Set<string>();
  var g = globalThis as any;
  for (var k in g) keys.add(k);
  return keys;
}

/** Create a brand-new session (does not switch to it). */
function _newSession(name?: string): ReplSession {
  var id = _nextSessionId++;
  var session: ReplSession = {
    id,
    name: name || ('session-' + id),
    history: [],
    scopeKeys: _captureScope(),
    mlBuffer: '',
    active: false,
  };
  _sessions.push(session);
  return session;
}

/**
 * [Items 653-658] Multi-session REPL manager exposed as `repl` on globalThis.
 */
export class ReplManager {
  /** Open a new (optionally named) REPL session and mark it active. [Item 656] */
  open(name?: string): ReplSession {
    var s = _newSession(name);
    s.active = true;
    _activeSessionId = s.id;
    terminal.colorPrintln('[repl] opened session "' + s.name + '" (id=' + s.id + ')', Color.LIGHT_CYAN);
    return s;
  }

  /** Close the currently active session and return to the previous one. [Item 657] */
  close(): void {
    var idx = _sessions.findIndex(function(s) { return s.id === _activeSessionId; });
    if (idx < 0) { terminal.colorPrintln('[repl] no active session', Color.YELLOW); return; }
    var closed = _sessions.splice(idx, 1)[0];
    closed.active = false;
    terminal.colorPrintln('[repl] closed session "' + closed.name + '"', Color.DARK_GREY);
    // Switch to the nearest remaining session
    var prev = _sessions[idx > 0 ? idx - 1 : 0];
    if (prev) {
      _activeSessionId = prev.id;
      prev.active = true;
      // Restore history reference
      (_history as any).length = 0;
      for (var hi = 0; hi < prev.history.length; hi++) (_history as any).push(prev.history[hi]);
      terminal.colorPrintln('[repl] switched to session "' + prev.name + '"', Color.LIGHT_CYAN);
    } else {
      _activeSessionId = 0;
    }
  }

  /** List all open sessions. [Item 653] */
  list(): ReplSession[] {
    if (_sessions.length === 0) {
      terminal.colorPrintln('[repl] no sessions', Color.DARK_GREY);
      return [];
    }
    for (var i = 0; i < _sessions.length; i++) {
      var s = _sessions[i];
      var marker = s.id === _activeSessionId ? ' *' : '  ';
      terminal.colorPrint(marker + ' [' + s.id + '] ', Color.YELLOW);
      terminal.println(s.name);
    }
    return _sessions.slice();
  }

  /** Switch to an existing session by id or name. [Item 654] */
  switchTo(idOrName: number | string): void {
    var target = _sessions.find(function(s) {
      return s.id === idOrName || s.name === idOrName;
    });
    if (!target) { terminal.colorPrintln('[repl] session not found: ' + idOrName, Color.LIGHT_RED); return; }
    // Save current history back
    var cur = _sessions.find(function(s) { return s.id === _activeSessionId; });
    if (cur) {
      cur.history = (_history as any).slice();
      cur.active = false;
    }
    _activeSessionId = target.id;
    target.active = true;
    // Restore target history
    (_history as any).length = 0;
    for (var hi = 0; hi < target.history.length; hi++) (_history as any).push(target.history[hi]);
    terminal.colorPrintln('[repl] switched to session "' + target.name + '"', Color.LIGHT_CYAN);
  }

  /** Clone the current session's scope into a new session. [Item 658] */
  clone(name?: string): ReplSession {
    var s = _newSession(name);
    // Copy current scope keys so the new session "inherits" what's already defined
    var cur = _sessions.find(function(x) { return x.id === _activeSessionId; });
    if (cur) {
      cur.scopeKeys.forEach(function(k) { s.scopeKeys.add(k); });
    }
    terminal.colorPrintln('[repl] cloned session as "' + s.name + '" (id=' + s.id + ')', Color.LIGHT_CYAN);
    return s;
  }

  /** Return the currently active session object. */
  getActive(): ReplSession | undefined {
    return _sessions.find(function(s) { return s.id === _activeSessionId; });
  }

  /** [Item 661] Dynamically import an OS module by path and bind it to a name. */
  importModule(path: string, asName?: string): any {
    var mod = (globalThis as any).require ? (globalThis as any).require(path) : undefined;
    if (asName && mod !== undefined) {
      (globalThis as any)[asName] = mod;
    }
    return mod;
  }
}

export const replManager = new ReplManager();
// Expose as `repl` global so user can call repl.open(), repl.list() etc. [Item 656]
(globalThis as any).repl = replManager;
