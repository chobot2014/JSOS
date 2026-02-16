/**
 * JSOS JavaScript REPL
 * Interactive JavaScript read-eval-print loop
 * Runs live JS on bare metal via kernel.eval()
 */

import terminal from './terminal.js';
import { Color } from './kernel.js';

declare var kernel: import('./kernel.js').KernelAPI;

export function startRepl(): void {
  terminal.println('');
  terminal.colorPrintln('JSOS JavaScript REPL', Color.WHITE);
  terminal.colorPrintln('Type JavaScript expressions to evaluate them.', Color.DARK_GREY);
  terminal.colorPrintln('Type .help for REPL commands, .exit to return to shell.', Color.DARK_GREY);
  terminal.println('');

  var running = true;
  var multiline = false;
  var buffer = '';

  while (running) {
    // Print prompt
    if (multiline) {
      terminal.colorPrint('... ', Color.DARK_GREY);
    } else {
      terminal.colorPrint('js> ', Color.YELLOW);
    }

    var line = kernel.readline();

    // Handle REPL commands
    if (!multiline && line.length > 0 && line[0] === '.') {
      var cmd = line.trim().toLowerCase();
      
      if (cmd === '.exit' || cmd === '.quit') {
        terminal.println('Exiting REPL.');
        running = false;
        continue;
      }
      
      if (cmd === '.help') {
        printReplHelp();
        continue;
      }
      
      if (cmd === '.clear') {
        terminal.clear();
        continue;
      }
      
      if (cmd === '.multi') {
        terminal.colorPrintln('Multi-line mode. Enter empty line to execute.', Color.DARK_GREY);
        multiline = true;
        buffer = '';
        continue;
      }

      terminal.error('Unknown REPL command: ' + cmd);
      terminal.println('Type .help for available commands.');
      continue;
    }

    // Multi-line mode
    if (multiline) {
      if (line.trim().length === 0 && buffer.length > 0) {
        // Execute the buffer
        evalAndPrint(buffer);
        buffer = '';
        multiline = false;
        continue;
      }
      buffer += line + '\n';
      continue;
    }

    // Single-line eval
    if (line.trim().length === 0) continue;

    evalAndPrint(line);
  }
}

function evalAndPrint(code: string): void {
  try {
    var result = kernel.eval(code);
    
    if (result === 'undefined') {
      terminal.colorPrintln('undefined', Color.DARK_GREY);
    } else if (result === 'null') {
      terminal.colorPrintln('null', Color.DARK_GREY);
    } else if (result === 'true' || result === 'false') {
      terminal.colorPrintln(result, Color.YELLOW);
    } else if (!isNaN(Number(result)) && result.length > 0) {
      terminal.colorPrintln(result, Color.LIGHT_CYAN);
    } else if (isErrorResult(result)) {
      terminal.colorPrintln(result, Color.LIGHT_RED);
    } else {
      terminal.colorPrintln(result, Color.LIGHT_GREEN);
    }
  } catch (e) {
    terminal.error('' + e);
  }
}

function isErrorResult(result: string): boolean {
  return result.indexOf('Error') === 0 ||
         result.indexOf('TypeError') === 0 ||
         result.indexOf('ReferenceError') === 0 ||
         result.indexOf('SyntaxError') === 0 ||
         result.indexOf('RangeError') === 0;
}

function printReplHelp(): void {
  terminal.println('');
  terminal.colorPrintln('REPL Commands:', Color.WHITE);
  terminal.println('  .help     Show this help message');
  terminal.println('  .exit     Exit the REPL and return to shell');
  terminal.println('  .clear    Clear the screen');
  terminal.println('  .multi    Enter multi-line mode (empty line to execute)');
  terminal.println('');
  terminal.colorPrintln('Available Globals:', Color.WHITE);
  terminal.println('  kernel    Direct access to kernel API');
  terminal.println('            kernel.print(msg)    - print to screen');
  terminal.println('            kernel.setColor(f,b) - set VGA colors');
  terminal.println('            kernel.getMemoryInfo() - memory stats');
  terminal.println('            kernel.getUptime()   - ms since boot');
  terminal.println('            kernel.sleep(ms)     - sleep');
  terminal.println('            kernel.getScreenSize() - screen dimensions');
  terminal.println('            kernel.inb(port)     - read I/O port');
  terminal.println('            kernel.outb(port,v)  - write I/O port');
  terminal.println('');
  terminal.colorPrintln('Examples:', Color.WHITE);
  terminal.colorPrintln('  2 + 2', Color.DARK_GREY);
  terminal.colorPrintln('  kernel.getMemoryInfo()', Color.DARK_GREY);
  terminal.colorPrintln('  for (var i=0; i<16; i++) { kernel.setColor(i,0); kernel.printRaw("X"); }', Color.DARK_GREY);
  terminal.println('');
}
