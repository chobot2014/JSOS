/**
 * JSOS - JavaScript Operating System
 * Main entry point
 *
 * Boots directly into a JavaScript REPL. No traditional shell or
 * filesystem commands  everything is live JavaScript running on
 * bare metal via QuickJS ES2023.
 */

import terminal from './terminal.js';
import { Color } from './kernel.js';
import { startRepl } from './repl.js';

declare var kernel: import('./kernel.js').KernelAPI;

/** Route console.log / .error / .warn through kernel VGA output */
function setupConsole(): void {
  var con = {
    log: function() {
      var parts: string[] = [];
      for (var i = 0; i < arguments.length; i++) {
        var arg = arguments[i];
        if (arg === null) {
          parts.push('null');
        } else if (arg === undefined) {
          parts.push('undefined');
        } else if (typeof arg === 'object') {
          try { parts.push(JSON.stringify(arg)); } catch (e) { parts.push('' + arg); }
        } else {
          parts.push('' + arg);
        }
      }
      kernel.print(parts.join(' '));
    },
    error: function() {
      var parts: string[] = [];
      for (var i = 0; i < arguments.length; i++) parts.push('' + arguments[i]);
      var saved = kernel.getColor();
      kernel.setColor(Color.LIGHT_RED, Color.BLACK);
      kernel.print(parts.join(' '));
      kernel.setColor(saved & 0x0F, (saved >> 4) & 0x0F);
    },
    warn: function() {
      var parts: string[] = [];
      for (var i = 0; i < arguments.length; i++) parts.push('' + arguments[i]);
      var saved = kernel.getColor();
      kernel.setColor(Color.YELLOW, Color.BLACK);
      kernel.print(parts.join(' '));
      kernel.setColor(saved & 0x0F, (saved >> 4) & 0x0F);
    },
    clear: function() { kernel.clear(); }
  };
  (globalThis as any).console = con;
}

/** Boot banner */
function printBanner(): void {
  kernel.clear();
  kernel.setColor(Color.LIGHT_CYAN, Color.BLACK);
  kernel.print('');
  kernel.print('     ######  ######  ####### ######  ');
  kernel.print('       ##   ##       ##   ## ##      ');
  kernel.print('       ##    ######  ##   ##  #####  ');
  kernel.print('  ##   ##        ## ##   ##      ## ');
  kernel.print('   #####   ######  ####### ######  ');
  kernel.print('');
  kernel.setColor(Color.WHITE, Color.BLACK);
  kernel.print('       JavaScript Operating System');
  kernel.print('');
  kernel.setColor(Color.DARK_GREY, Color.BLACK);
  kernel.print('  QuickJS ES2023  |  i686  |  Bare Metal');
  kernel.print('  Type .help to see available APIs');
  kernel.print('');
  kernel.setColor(Color.LIGHT_GREY, Color.BLACK);
}

/** Main entry point - called by the bundled JS IIFE footer */
function main(): void {
  setupConsole();
  printBanner();
  startRepl();
  // startRepl() loops forever; only returns on halt/reboot
  kernel.halt();
}

export { main };
export default main;
