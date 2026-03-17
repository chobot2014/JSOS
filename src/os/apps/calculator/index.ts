/**
 * [Item 775] Calculator App
 * A simple expression calculator rendered in the terminal.
 * Launched via `calc()` from the REPL/commands.
 */

import { Terminal } from '../../ui/terminal';

/**
 * Safely evaluate a math expression string.
 * Allows digits, operators, parens, dots, Math.xxx identifiers and constants.
 */
function evalExpr(expr: string): number {
  const safe = expr
    .replace(/\^/g, '**')
    .replace(/\bsqrt\b/g,  'Math.sqrt')
    .replace(/\babs\b/g,   'Math.abs')
    .replace(/\bfloor\b/g, 'Math.floor')
    .replace(/\bceil\b/g,  'Math.ceil')
    .replace(/\bround\b/g, 'Math.round')
    .replace(/\bsin\b/g,   'Math.sin')
    .replace(/\bcos\b/g,   'Math.cos')
    .replace(/\btan\b/g,   'Math.tan')
    .replace(/\blog2\b/g,  'Math.log2')
    .replace(/\blog10\b/g, 'Math.log10')
    .replace(/\blog\b/g,   'Math.log')
    .replace(/\bpow\b/g,   'Math.pow')
    .replace(/\bmax\b/g,   'Math.max')
    .replace(/\bmin\b/g,   'Math.min')
    .replace(/\bpi\b/gi,   'Math.PI')
    .replace(/\be\b/g,     'Math.E');

  // Guard against any remaining unexpected identifiers after replacements
  const stripped = safe.replace(/Math\.(PI|E|sqrt|abs|floor|ceil|round|sin|cos|tan|log[210]*|pow|max|min)/g, '0');
  if (/[a-zA-Z_$]/.test(stripped)) {
    throw new Error('invalid characters in expression');
  }
  // eslint-disable-next-line no-new-func
  const result = (new Function('return (' + safe + ')'))();
  if (typeof result !== 'number') throw new Error('not a number');
  if (!isFinite(result)) throw new Error(isNaN(result) ? 'NaN' : result > 0 ? 'Infinity' : '-Infinity');
  return result;
}

function formatResult(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(parseFloat(n.toPrecision(12)));
}

/**
 * Interactive calculator REPL loop — synchronous, uses terminal.readLine().
 */
export function launchCalculator(terminal: Terminal): void {
  terminal.println('\x1b[1mJSOS Calculator\x1b[0m  (expression per line, c=clear, q=quit)');
  terminal.println('  Ops: + - * / ** %    Fns: sqrt abs sin cos tan log log2 log10 pow');
  terminal.println('  Constants: pi  e      Example: sqrt(2) * pi');
  terminal.println('');

  let lastResult = '';
  for (;;) {
    const line = terminal.readLine('calc> ').trim();
    if (line === '' && lastResult) {
      terminal.println('  = ' + lastResult);
      continue;
    }
    if (line === 'q' || line === 'quit' || line === 'exit') {
      terminal.println('Calculator closed.');
      break;
    }
    if (line === 'c' || line === 'C' || line === 'clear') {
      lastResult = '';
      terminal.println('  (cleared)');
      continue;
    }
    if (!line) continue;
    try {
      const result = evalExpr(line);
      lastResult = formatResult(result);
      terminal.println('  \x1b[32m= ' + lastResult + '\x1b[0m');
    } catch (e: any) {
      terminal.println('  \x1b[31mError: ' + (e.message || 'invalid expression') + '\x1b[0m');
      lastResult = '';
    }
  }
}
