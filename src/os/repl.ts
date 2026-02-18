/**
 * JSOS JavaScript REPL
 *
 * The entire OS interface. Every line is live JavaScript evaluated by
 * the QuickJS ES2023 engine running on bare-metal i686.
 *
 * Features:
 *   - Input history (Up / Down arrows via kernel.waitKeyEx)
 *   - Automatic multiline (open-bracket detection)
 *   - Ctrl+U clear line, Ctrl+C cancel, Ctrl+L redraw
 *   - Rich color-coded output (numbers, strings, booleans, errors)
 *   - Dot-commands: .help  .clear  .history  .halt  .reboot
 */

import terminal from './terminal.js';
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

//  Readline with arrow-key history 

/** Read a line, printing `prompt` first. Supports Up/Down history, Ctrl+U, Ctrl+C, Ctrl+L. */
function readline(prompt: string, promptColor: number): string {
  terminal.colorPrint(prompt, promptColor);

  var buf = '';
  var histIdx = -1;   // -1 = not browsing history
  var savedBuf = '';  // draft saved when history browsing begins

  for (;;) {
    var key = kernel.waitKeyEx();

    //  Extended keys 
    if (key.ext !== 0) {
      if (key.ext === 0x80) {
        // Arrow Up  go back in history
        if (_history.length === 0) continue;
        if (histIdx === -1) { savedBuf = buf; histIdx = _history.length - 1; }
        else if (histIdx > 0) { histIdx--; }
        else { continue; } // already at oldest entry
        for (var i = 0; i < buf.length; i++) kernel.printRaw('\b \b');
        buf = _history[histIdx];
        kernel.printRaw(buf);
      } else if (key.ext === 0x81) {
        // Arrow Down  go forward in history
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
      // Left / Right ignored (no mid-line cursor movement in VGA text mode)
      continue;
    }

    //  Regular keys 
    var ch = key.ch;
    if (!ch) continue;

    // Enter
    if (ch === '\n' || ch === '\r') {
      kernel.print('');
      return buf;
    }

    // Backspace / Delete
    if (ch === '\b' || ch === '\x7f') {
      if (buf.length > 0) {
        buf = buf.slice(0, -1);
        kernel.printRaw('\b \b');
        histIdx = -1;
      }
      continue;
    }

    // Ctrl+C  cancel current line
    if (ch === '\x03') {
      kernel.print('^C');
      return '';
    }

    // Ctrl+U  erase to start of line
    if (ch === '\x15') {
      for (var i = 0; i < buf.length; i++) kernel.printRaw('\b \b');
      buf = '';
      histIdx = -1;
      continue;
    }

    // Ctrl+L  clear screen and redraw prompt + current input
    if (ch === '\x0c') {
      kernel.clear();
      terminal.colorPrint(prompt, promptColor);
      kernel.printRaw(buf);
      continue;
    }

    // Printable character
    if (ch >= ' ') {
      buf += ch;
      kernel.printRaw(ch);
      histIdx = -1;
    }
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
    if (escaped)              { escaped = false; continue; }
    if (c === '\\' && inStr)  { escaped = true;  continue; }
    if (inStr)                { if (c === strChar) inStr = false; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = true; strChar = c; continue; }
    if (c === '{' || c === '(' || c === '[') depth++;
    if (c === '}' || c === ')' || c === ']') depth--;
  }

  return depth > 0;
}

//  Result display 

function printResult(result: string): void {
  if (result === 'undefined') {
    terminal.colorPrintln('undefined', Color.DARK_GREY);
  } else if (result === 'null') {
    terminal.colorPrintln('null', Color.DARK_GREY);
  } else if (result === 'true' || result === 'false') {
    terminal.colorPrintln(result, Color.YELLOW);
  } else if (result.length > 0 && !isNaN(Number(result))) {
    terminal.colorPrintln(result, Color.LIGHT_CYAN);
  } else if (
    result.indexOf('Error:') !== -1 ||
    result.indexOf('TypeError') === 0 ||
    result.indexOf('ReferenceError') === 0 ||
    result.indexOf('SyntaxError') === 0 ||
    result.indexOf('RangeError') === 0
  ) {
    terminal.colorPrintln(result, Color.LIGHT_RED);
  } else if (result.length > 0 && result[0] === '"') {
    terminal.colorPrintln(result, Color.LIGHT_GREEN);
  } else {
    terminal.colorPrintln(result, Color.WHITE);
  }
}

function evalAndPrint(code: string): void {
  try {
    var result = kernel.eval(code);
    printResult(result);
  } catch (e) {
    terminal.colorPrintln('' + e, Color.LIGHT_RED);
  }
}

//  Help 

function printHelp(): void {
  terminal.println('');
  terminal.colorPrintln('JSOS JavaScript REPL', Color.WHITE);
  terminal.colorPrintln('Every line is evaluated as ES2023 JavaScript on bare-metal i686.', Color.LIGHT_GREY);
  terminal.println('');
  terminal.colorPrintln('Dot commands:', Color.LIGHT_CYAN);
  terminal.println('  .help       This help text');
  terminal.println('  .clear      Clear the screen');
  terminal.println('  .history    Show input history');
  terminal.println('  .reboot     Reboot the system');
  terminal.println('  .halt       Power off');
  terminal.println('');
  terminal.colorPrintln('Keyboard shortcuts:', Color.LIGHT_CYAN);
  terminal.println('  Up / Down   Browse history');
  terminal.println('  Ctrl+U      Clear current line');
  terminal.println('  Ctrl+C      Cancel current line');
  terminal.println('  Ctrl+L      Redraw screen');
  terminal.println('');
  terminal.colorPrintln('Global: kernel', Color.LIGHT_CYAN);
  terminal.println('  kernel.print(s)           Print line');
  terminal.println('  kernel.printRaw(s)        Print without newline');
  terminal.println('  kernel.clear()            Clear screen');
  terminal.println('  kernel.setColor(fg, bg)   VGA color 0-15');
  terminal.println('  kernel.getColor()         Packed color byte');
  terminal.println('  kernel.getMemoryInfo()    { total, free, used }');
  terminal.println('  kernel.getUptime()        Milliseconds since boot');
  terminal.println('  kernel.getTicks()         Raw PIT tick count');
  terminal.println('  kernel.sleep(ms)          Sleep ms milliseconds');
  terminal.println('  kernel.getScreenSize()    { width, height }');
  terminal.println('  kernel.getCursor()        { row, col }');
  terminal.println('  kernel.setCursor(r, c)    Move cursor');
  terminal.println('  kernel.readline()         Simple line input');
  terminal.println('  kernel.readKey()          Non-blocking keypress');
  terminal.println('  kernel.waitKey()          Block for one keypress');
  terminal.println('  kernel.waitKeyEx()        { ch, ext } with arrow keys');
  terminal.println('  kernel.inb(port)          Read I/O port byte');
  terminal.println('  kernel.outb(port, val)    Write I/O port byte');
  terminal.println('  kernel.eval(code)         Evaluate JS string');
  terminal.println('  kernel.reboot()           Reboot');
  terminal.println('  kernel.halt()             Halt');
  terminal.println('  kernel.colors             { BLACK, BLUE, ... }');
  terminal.println('');
  terminal.colorPrintln('VGA colors (0-15):', Color.LIGHT_CYAN);
  terminal.println('  0=BLACK  1=BLUE  2=GREEN   3=CYAN    4=RED');
  terminal.println('  5=MAGENTA 6=BROWN 7=LT_GREY 8=DK_GREY 9=LT_BLUE');
  terminal.println('  10=LT_GREEN 11=LT_CYAN 12=LT_RED 14=YELLOW 15=WHITE');
  terminal.println('');
  terminal.colorPrintln('Examples:', Color.LIGHT_CYAN);
  terminal.colorPrintln('  2 + 2', Color.WHITE);
  terminal.colorPrintln("  JSON.stringify(kernel.getMemoryInfo())", Color.WHITE);
  terminal.colorPrintln("  kernel.setColor(14,0); kernel.print('hello')", Color.WHITE);
  terminal.colorPrintln("  for(var i=0;i<16;i++){kernel.setColor(i,0);kernel.printRaw('## ');}", Color.WHITE);
  terminal.println('');
}

//  Main REPL loop 

export function startRepl(): void {
  var mlBuffer = '';  // accumulated multiline input

  for (;;) {
    // Choose prompt
    var prompt      = mlBuffer.length > 0 ? '.. ' : '>> ';
    var promptColor = mlBuffer.length > 0 ? Color.DARK_GREY : Color.YELLOW;

    var line = readline(prompt, promptColor);

    //  Dot-commands (fresh lines only) 
    if (mlBuffer.length === 0 && line.length > 0 && line[0] === '.') {
      var cmd = line.trim().toLowerCase();

      if (cmd === '.help')   { printHelp();      continue; }
      if (cmd === '.clear')  { kernel.clear();   continue; }
      if (cmd === '.halt')   { kernel.halt(); }
      if (cmd === '.reboot') { kernel.reboot(); }

      if (cmd === '.history') {
        terminal.println('');
        if (_history.length === 0) {
          terminal.colorPrintln('(empty)', Color.DARK_GREY);
        } else {
          for (var i = 0; i < _history.length; i++) {
            var n = '' + (i + 1);
            while (n.length < 3) n = ' ' + n;
            terminal.colorPrint(n + '  ', Color.DARK_GREY);
            terminal.println(_history[i]);
          }
        }
        terminal.println('');
        continue;
      }

      terminal.colorPrintln('Unknown: ' + line.trim() + '  (try .help)', Color.LIGHT_RED);
      continue;
    }

    //  Empty line while in multiline mode  execute buffer 
    if (mlBuffer.length > 0 && line.trim().length === 0) {
      if (mlBuffer.trim().length > 0) {
        addHistory(mlBuffer.trim());
        evalAndPrint(mlBuffer);
      }
      mlBuffer = '';
      continue;
    }

    //  Skip blank lines in normal mode 
    if (line.trim().length === 0) continue;

    addHistory(line);

    //  Check for incomplete input (unmatched open brackets) 
    var combined = mlBuffer + line + '\n';
    if (isIncomplete(combined)) {
      mlBuffer = combined;
      continue;
    }

    //  Evaluate 
    evalAndPrint(mlBuffer + line);
    mlBuffer = '';
  }
}
