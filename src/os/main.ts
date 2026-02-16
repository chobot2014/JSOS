/**
 * JSOS - JavaScript Operating System
 * Main entry point
 * 
 * This is the first TypeScript code that runs after the C kernel
 * initializes the Duktape JavaScript runtime. It sets up the console
 * polyfill, prints the boot screen, and launches the interactive shell.
 * 
 * All I/O goes through the kernel object which is injected as a global
 * by the C-level Duktape bindings:
 *   kernel.print()     - VGA text output
 *   kernel.readline()  - blocking keyboard input
 *   kernel.setColor()  - VGA color control
 *   kernel.eval()      - live JS evaluation
 *   etc.
 */

import terminal from './terminal.js';
import fs from './filesystem.js';
import shell from './shell.js';
import systemManager from './system.js';
import { Color } from './kernel.js';

declare var kernel: import('./kernel.js').KernelAPI;

/** Set up console object to route through kernel VGA output */
function setupConsole(): void {
  // The polyfill in the bundler already provides console, but we override
  // it here to use our terminal abstraction properly
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
          try {
            parts.push(JSON.stringify(arg));
          } catch (e) {
            parts.push('' + arg);
          }
        } else {
          parts.push('' + arg);
        }
      }
      kernel.print(parts.join(' '));
    },
    error: function() {
      var parts: string[] = [];
      for (var i = 0; i < arguments.length; i++) {
        parts.push('' + arguments[i]);
      }
      var saved = kernel.getColor();
      kernel.setColor(Color.LIGHT_RED, Color.BLACK);
      kernel.print(parts.join(' '));
      kernel.setColor(saved & 0x0F, (saved >> 4) & 0x0F);
    },
    warn: function() {
      var parts: string[] = [];
      for (var i = 0; i < arguments.length; i++) {
        parts.push('' + arguments[i]);
      }
      var saved = kernel.getColor();
      kernel.setColor(Color.YELLOW, Color.BLACK);
      kernel.print(parts.join(' '));
      kernel.setColor(saved & 0x0F, (saved >> 4) & 0x0F);
    },
    clear: function() {
      kernel.clear();
    }
  };

  // Install globally
  (globalThis as any).console = con;
}

/** Print the boot splash screen */
function printBootScreen(): void {
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
  kernel.print('  Version ' + (fs.readFile('/etc/version') || '1.0.0') + ' | i686 | Duktape Runtime');
  kernel.print('  TypeScript -> ES5 -> Bare Metal');
  kernel.print('');
  
  kernel.setColor(Color.LIGHT_GREY, Color.BLACK);
}

/** Run boot sequence with status messages */
function bootSequence(): void {
  var startTime = kernel.getUptime();

  printBootScreen();

  // Boot steps
  var steps = [
    'Initializing console',
    'Setting up filesystem',
    'Loading process manager',
    'Registering shell commands',
    'Starting services',
  ];

  for (var i = 0; i < steps.length; i++) {
    terminal.colorPrint('[', Color.DARK_GREY);
    terminal.colorPrint(' OK ', Color.LIGHT_GREEN);
    terminal.colorPrint('] ', Color.DARK_GREY);
    terminal.println(steps[i]);
    kernel.sleep(80); // Brief delay for visual effect
  }

  var elapsed = kernel.getUptime() - startTime;
  terminal.println('');
  terminal.colorPrint('Boot complete', Color.LIGHT_GREEN);
  terminal.println(' in ' + elapsed + ' ms');
  terminal.println('');

  // Log boot
  fs.appendFile('/var/log/boot.log', '[' + kernel.getUptime() + '] Boot sequence completed in ' + elapsed + 'ms\n');
}

/** Main entry point - called by the bundled JS */
function main(): void {
  // Step 1: Set up console routing
  setupConsole();

  // Step 2: Run boot sequence
  bootSequence();

  // Step 3: Start the interactive shell (this blocks on keyboard input)
  shell.start();

  // If shell exits, show shutdown message
  terminal.println('');
  terminal.colorPrintln('JSOS has shut down. It is now safe to power off.', Color.LIGHT_GREY);
  kernel.halt();
}

// Export for the bundler's IIFE footer to call
export { main };
export default main;

