/**
 * [Item 776] Clock / Timer App
 * Three modes accessible from a single entry-point:
 *   clock      – live digital clock (HH:MM:SS)
 *   stopwatch  – lap timer (s=start/pause, l=lap, r=reset)
 *   countdown  – count down from N seconds (s=start/pause, r=reset, <N>=set)
 *
 * Launched via `clock([mode], [seconds])` from the REPL/commands.
 * Uses the synchronous `kernel.sleep / kernel.hasKey / kernel.readKey` pattern.
 */

import { Terminal } from '../../ui/terminal';
declare var kernel: import('../../core/kernel.js').KernelAPI;

type ClockMode = 'clock' | 'stopwatch' | 'countdown';

function pad2(n: number): string { return n < 10 ? '0' + n : String(n); }

function formatMs(ms: number, centi = false): string {
  const t = Math.max(0, ms);
  const totalSec = Math.floor(t / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const cc = Math.floor((t % 1000) / 10);
  return centi ? `${pad2(h)}:${pad2(m)}:${pad2(s)}.${pad2(cc)}` : `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

function getNow(): string {
  const d = new Date();
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function getDate(): string {
  const d = new Date();
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${pad2(d.getDate())} ${d.getFullYear()}`;
}

/**
 * Synchronous interactive clock/stopwatch/countdown app.
 * Loops with `kernel.sleep(200)` between display refreshes,
 * checking `kernel.hasKey()` after each sleep for non-blocking input.
 */
export function launchClock(terminal: Terminal, mode: ClockMode = 'clock', countdownSec?: number): void {
  const modeLabel = mode.charAt(0).toUpperCase() + mode.slice(1);
  terminal.println(`\x1b[1mJSOS ${modeLabel}\x1b[0m  (q=quit)`);

  // Stopwatch state
  let swRunning = false;
  let swElapsed = 0;     // accumulated ms
  let swBase    = 0;     // kernel.getUptime() base when started
  let swLaps: number[] = [];

  // Countdown state
  let cdTotal   = (countdownSec ?? 60) * 1000;  // ms remaining
  let cdRunning = false;
  let cdBase    = 0;
  let cdDone    = false;

  if (mode === 'stopwatch') {
    terminal.println('  s=start/pause  l=lap  r=reset  q=quit');
  } else if (mode === 'countdown') {
    terminal.println(`  ${countdownSec ?? 60}s countdown — s=start/pause  r=reset  <N>=set secs  q=quit`);
  } else {
    terminal.println('  q=quit');
  }

  let running = true;
  while (running) {
    // Render current state on a single line (overwrite)
    terminal.print('\r\x1b[2K');

    if (mode === 'clock') {
      terminal.print(`  \x1b[1;36m${getNow()}\x1b[0m   ${getDate()}`);

    } else if (mode === 'stopwatch') {
      if (swRunning) swElapsed = (kernel.getUptime() - swBase);
      const ind = swRunning ? '\x1b[32m▶\x1b[0m' : '\x1b[33m⏸\x1b[0m';
      terminal.print(`  ${ind} \x1b[1;36m${formatMs(swElapsed, true)}\x1b[0m`);
      if (swLaps.length > 0) terminal.print(`   laps: ${swLaps.length}`);

    } else if (mode === 'countdown') {
      let remaining = cdTotal;
      if (cdRunning) remaining = cdTotal - (kernel.getUptime() - cdBase);
      if (remaining <= 0 && cdRunning) {
        cdRunning = false; cdDone = true; cdTotal = 0;
        remaining = 0;
        terminal.println('');
        terminal.println('  \x1b[1;31m*** TIME\'S UP! ***\x1b[0m');
      }
      const col = remaining < 10000 ? '\x1b[31m' : remaining < 30000 ? '\x1b[33m' : '\x1b[36m';
      const ind = cdRunning ? '\x1b[32m▶\x1b[0m' : cdDone ? '\x1b[31m✓\x1b[0m' : '\x1b[33m⏸\x1b[0m';
      terminal.print(`  ${ind} ${col}\x1b[1m${formatMs(remaining)}\x1b[0m`);
    }

    kernel.sleep(200);

    // Handle any pending keystrokes (non-blocking)
    while (kernel.hasKey()) {
      const key = kernel.readKey().toLowerCase();
      if (key === 'q' || key === '\x03') {
        running = false;
        break;
      }
      if (mode === 'stopwatch') {
        if (key === 's') {
          if (!swRunning) { swBase = kernel.getUptime() - swElapsed; swRunning = true; }
          else            { swElapsed = kernel.getUptime() - swBase;  swRunning = false; }
        } else if (key === 'l') {
          const snap = swRunning ? kernel.getUptime() - swBase : swElapsed;
          swLaps.push(snap);
          terminal.println('');
          terminal.println(`  Lap ${swLaps.length}: ${formatMs(snap, true)}`);
        } else if (key === 'r') {
          swRunning = false; swElapsed = 0; swLaps = [];
          terminal.println('');
          terminal.println('  (reset)');
        }
      } else if (mode === 'countdown') {
        if (key === 's') {
          if (!cdRunning && !cdDone) { cdBase = kernel.getUptime(); cdRunning = true; }
          else if (cdRunning)        { cdTotal -= kernel.getUptime() - cdBase; cdRunning = false; }
        } else if (key === 'r') {
          cdTotal = (countdownSec ?? 60) * 1000; cdRunning = false; cdDone = false;
          terminal.println('');
          terminal.println('  (reset)');
        } else if (key >= '1' && key <= '9') {
          // Accumulate single-character numeric: user types a digit to set N seconds quickly
          const secs = parseInt(key) * 10;  // coarse — type single digit → ×10 seconds
          cdTotal = secs * 1000; cdRunning = false; cdDone = false;
          terminal.println('');
          terminal.println(`  Set to ${secs}s`);
        }
      }
    }
  }

  terminal.println('');
  terminal.println(`${modeLabel} closed.`);
}
