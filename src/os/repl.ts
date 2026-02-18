/**
 * JSOS JavaScript REPL
 *
 * Dot-commands    : .ls  .cat  .cd  .pwd  .mkdir  .rm  .cp  .mv  .write
 *                   .append  .touch  .find  .stat  .run
 *                   .ps  .kill  .mem  .uptime  .sysinfo  .colors
 *                   .hostname  .echo  .test  .clear  .history  .halt  .reboot
 * JS globals      : fs.*  sys.*  print(s)
 * Keyboard        : Up/Down history  Ctrl+U erase  Ctrl+C cancel  Ctrl+L redraw
 */

import terminal from './terminal.js';
import fs from './filesystem.js';
import systemManager from './system.js';
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

function readline(prompt: string, promptColor: number): string {
  terminal.colorPrint(prompt, promptColor);
  var buf = '';
  var histIdx = -1;
  var savedBuf = '';

  for (;;) {
    var key = kernel.waitKeyEx();

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
      terminal.colorPrint(prompt, promptColor);
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
  var wrapped =
    '(function(){' +
    'var __r=(' + code + ');' +
    'if(__r===undefined)return"undefined";' +
    'if(__r===null)return"null";' +
    'if(typeof __r==="object")return JSON.stringify(__r,null,2);' +
    'return String(__r);' +
    '})()';
  try {
    var result = kernel.eval(wrapped);
    printResult(result);
  } catch (e) {
    terminal.colorPrintln('' + e, Color.LIGHT_RED);
  }
}

//  Filesystem dot-commands 

function dotLs(args: string[]): void {
  var path = args[0] || '';
  var target = path || fs.cwd();
  var items = fs.ls(path);
  if (items.length === 0) {
    if (!fs.exists(target)) { terminal.colorPrintln('No such directory: ' + target, Color.LIGHT_RED); return; }
    terminal.colorPrintln('(empty)', Color.DARK_GREY);
    return;
  }
  terminal.colorPrintln('  ' + target, Color.DARK_GREY);
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var pad = '';
    for (var p = 0; p < Math.max(1, 28 - item.name.length); p++) pad += ' ';
    terminal.print('  ');
    if (item.type === 'directory') {
      terminal.colorPrint(item.name + '/', Color.LIGHT_BLUE);
      terminal.println('');
    } else {
      if (item.name.slice(-3) === '.js') {
        terminal.colorPrint(item.name, Color.LIGHT_GREEN);
      } else {
        terminal.print(item.name);
      }
      terminal.colorPrintln(pad + item.size + 'B', Color.DARK_GREY);
    }
  }
}

function dotCat(args: string[]): void {
  if (!args[0]) { terminal.colorPrintln('Usage: .cat <file>', Color.YELLOW); return; }
  var content = fs.readFile(args[0]);
  if (content === null) { terminal.colorPrintln('No such file: ' + args[0], Color.LIGHT_RED); return; }
  terminal.println(content);
}

function dotWrite(args: string[]): void {
  if (args.length < 2) { terminal.colorPrintln('Usage: .write <file> <content...>', Color.YELLOW); return; }
  var text = args.slice(1).join(' ');
  if (fs.writeFile(args[0], text)) { terminal.colorPrintln('Wrote ' + text.length + 'B -> ' + args[0], Color.LIGHT_GREEN); }
  else { terminal.colorPrintln('Write failed: ' + args[0], Color.LIGHT_RED); }
}

function dotAppend(args: string[]): void {
  if (args.length < 2) { terminal.colorPrintln('Usage: .append <file> <content...>', Color.YELLOW); return; }
  var text = args.slice(1).join(' ');
  if (fs.appendFile(args[0], text)) { terminal.colorPrintln('Appended ' + text.length + 'B -> ' + args[0], Color.LIGHT_GREEN); }
  else { terminal.colorPrintln('Append failed: ' + args[0], Color.LIGHT_RED); }
}

function dotMkdir(args: string[]): void {
  if (!args[0]) { terminal.colorPrintln('Usage: .mkdir <path>', Color.YELLOW); return; }
  if (fs.mkdir(args[0])) { terminal.colorPrintln('Created: ' + args[0], Color.LIGHT_GREEN); }
  else { terminal.colorPrintln('Failed: ' + args[0], Color.LIGHT_RED); }
}

function dotTouch(args: string[]): void {
  if (!args[0]) { terminal.colorPrintln('Usage: .touch <file>', Color.YELLOW); return; }
  if (!fs.exists(args[0])) fs.writeFile(args[0], '');
  terminal.colorPrintln('Touched: ' + args[0], Color.LIGHT_GREEN);
}

function dotRm(args: string[]): void {
  if (!args[0]) { terminal.colorPrintln('Usage: .rm <path>', Color.YELLOW); return; }
  if (fs.rm(args[0])) { terminal.colorPrintln('Removed: ' + args[0], Color.LIGHT_GREEN); }
  else { terminal.colorPrintln('Failed (not found or non-empty dir): ' + args[0], Color.LIGHT_RED); }
}

function dotCp(args: string[]): void {
  if (args.length < 2) { terminal.colorPrintln('Usage: .cp <src> <dst>', Color.YELLOW); return; }
  if (fs.cp(args[0], args[1])) { terminal.colorPrintln('Copied ' + args[0] + ' -> ' + args[1], Color.LIGHT_GREEN); }
  else { terminal.colorPrintln('Copy failed: ' + args[0], Color.LIGHT_RED); }
}

function dotMv(args: string[]): void {
  if (args.length < 2) { terminal.colorPrintln('Usage: .mv <src> <dst>', Color.YELLOW); return; }
  if (fs.mv(args[0], args[1])) { terminal.colorPrintln('Moved ' + args[0] + ' -> ' + args[1], Color.LIGHT_GREEN); }
  else { terminal.colorPrintln('Move failed: ' + args[0], Color.LIGHT_RED); }
}

function dotFind(args: string[]): void {
  var basePath = args.length >= 2 ? args[0] : '/';
  var pattern  = args.length >= 2 ? args[1] : (args[0] || '*');
  var results = fs.find(basePath, pattern);
  for (var i = 0; i < results.length; i++) terminal.println('  ' + results[i]);
  terminal.colorPrintln('  ' + results.length + ' match(es)', Color.DARK_GREY);
}

function dotStat(args: string[]): void {
  if (!args[0]) { terminal.colorPrintln('Usage: .stat <path>', Color.YELLOW); return; }
  var info = fs.stat(args[0]);
  if (!info) { terminal.colorPrintln('No such path: ' + args[0], Color.LIGHT_RED); return; }
  terminal.println('  Path : ' + args[0]);
  terminal.println('  Type : ' + info.type);
  terminal.println('  Size : ' + info.size + ' bytes');
  terminal.println('  Perm : ' + info.permissions);
}

function dotCd(args: string[]): void {
  var path = args[0] || '/home/user';
  if (!fs.cd(path)) { terminal.colorPrintln('No such directory: ' + path, Color.LIGHT_RED); }
  else { terminal.colorPrint('  '); terminal.colorPrintln(fs.cwd(), Color.LIGHT_BLUE); }
}

function dotPwd(): void {
  terminal.colorPrintln(fs.cwd(), Color.LIGHT_BLUE);
}

function dotRun(args: string[]): void {
  if (!args[0]) { terminal.colorPrintln('Usage: .run <file.js>', Color.YELLOW); return; }
  var code = fs.readFile(args[0]);
  if (code === null) code = fs.readFile('/bin/' + args[0]);
  if (code === null) { terminal.colorPrintln('Not found: ' + args[0], Color.LIGHT_RED); return; }
  terminal.colorPrintln('  running ' + args[0] + '...', Color.DARK_GREY);
  evalAndPrint(code);
}

//  System dot-commands 

function dotPs(): void {
  var procs = systemManager.getProcessList();
  terminal.colorPrintln('  PID  NAME                STATE        PRI', Color.LIGHT_CYAN);
  terminal.colorPrintln('  ----------------------------------------', Color.DARK_GREY);
  for (var i = 0; i < procs.length; i++) {
    var p = procs[i];
    var pid  = ('    ' + p.id).slice(-4);
    var name = (p.name + '                    ').slice(0, 20);
    var st   = (p.state + '             ').slice(0, 13);
    terminal.print('  ' + pid + '  ' + name + st);
    terminal.colorPrintln('' + p.priority, Color.DARK_GREY);
  }
  terminal.colorPrintln('  ' + procs.length + ' process(es)', Color.DARK_GREY);
}

function dotKill(args: string[]): void {
  if (!args[0]) { terminal.colorPrintln('Usage: .kill <pid>', Color.YELLOW); return; }
  var pid = parseInt(args[0]);
  if (systemManager.terminateProcess(pid)) { terminal.colorPrintln('Killed PID ' + pid, Color.LIGHT_GREEN); }
  else { terminal.colorPrintln('Cannot kill PID ' + pid + ' (not found or kernel)', Color.LIGHT_RED); }
}

function dotMem(): void {
  var m = kernel.getMemoryInfo();
  terminal.colorPrintln('Memory', Color.WHITE);
  terminal.println('  Total : ' + Math.floor(m.total / 1024) + ' KB');
  terminal.println('  Used  : ' + Math.floor(m.used  / 1024) + ' KB');
  terminal.println('  Free  : ' + Math.floor(m.free  / 1024) + ' KB');
  var BAR = 36;
  var used = Math.min(BAR, Math.floor((m.used / m.total) * BAR));
  var bar1 = ''; for (var i = 0; i < used;       i++) bar1 += '#';
  var bar2 = ''; for (var i = 0; i < BAR - used; i++) bar2 += '.';
  terminal.print('  [');
  terminal.colorPrint(bar1, Color.LIGHT_RED);
  terminal.colorPrint(bar2, Color.LIGHT_GREEN);
  terminal.println(']  ' + Math.floor((m.used / m.total) * 100) + '%');
}

function dotUptime(): void {
  var ms = kernel.getUptime();
  var s  = Math.floor(ms / 1000);
  var m  = Math.floor(s  / 60);  s = s % 60;
  var h  = Math.floor(m  / 60);  m = m % 60;
  var parts: string[] = [];
  if (h > 0) parts.push(h + 'h');
  if (m > 0) parts.push(m + 'm');
  parts.push(s + 's');
  terminal.println('  Uptime : ' + parts.join(' ') + '  (' + ms + ' ms)');
  terminal.colorPrintln('  Ticks  : ' + kernel.getTicks(), Color.DARK_GREY);
}

function dotSysinfo(): void {
  var m  = kernel.getMemoryInfo();
  var sc = kernel.getScreenSize();
  terminal.colorPrintln('JSOS System Information', Color.WHITE);
  terminal.colorPrintln('  ==========================================', Color.DARK_GREY);
  terminal.println('  OS       : JSOS v' + (fs.readFile('/etc/version') || '1.0.0'));
  terminal.println('  Hostname : ' + (fs.readFile('/etc/hostname') || 'jsos'));
  terminal.println('  Arch     : i686 (x86 32-bit)');
  terminal.println('  Runtime  : QuickJS ES2023');
  terminal.println('  Screen   : ' + sc.width + 'x' + sc.height + ' VGA text');
  terminal.println('  Memory   : ' + Math.floor(m.total / 1024) + ' KB total, ' +
                                     Math.floor(m.free  / 1024) + ' KB free');
  terminal.println('  Uptime   : ' + Math.floor(kernel.getUptime() / 1000) + 's');
  terminal.println('  Procs    : ' + systemManager.getProcessList().length);
}

function dotColors(): void {
  var names = ['BLACK','BLUE','GREEN','CYAN','RED','MAGENTA','BROWN','LT_GREY',
               'DK_GREY','LT_BLUE','LT_GREEN','LT_CYAN','LT_RED','LT_MAG','YELLOW','WHITE'];
  terminal.colorPrintln('VGA Palette (0-15)', Color.WHITE);
  for (var i = 0; i < 16; i++) {
    var label = i < 10 ? ' ' + i : '' + i;
    kernel.setColor(i, 0);
    kernel.printRaw('  ' + label + ' ########  ');
    kernel.setColor(7, 0);
    terminal.colorPrintln(names[i], Color.DARK_GREY);
  }
}

function dotHostname(args: string[]): void {
  if (args[0]) { fs.writeFile('/etc/hostname', args[0]); terminal.colorPrintln('hostname -> ' + args[0], Color.LIGHT_GREEN); }
  else { terminal.println(fs.readFile('/etc/hostname') || 'jsos'); }
}

function dotEcho(args: string[]): void {
  terminal.println(args.join(' '));
}

function dotTest(): void {
  terminal.colorPrintln('JSOS Self-Tests', Color.WHITE);
  terminal.colorPrintln('  -----------------------------------------------', Color.DARK_GREY);
  var passed = 0;
  var failed = 0;

  function check(label: string, ok: boolean, note?: string): void {
    var pad = '';
    for (var i = 0; i < Math.max(1, 34 - label.length); i++) pad += '.';
    terminal.print('  ' + label + pad);
    if (ok) { terminal.colorPrintln('PASS', Color.LIGHT_GREEN); passed++; }
    else { terminal.colorPrintln('FAIL' + (note ? ' (' + note + ')' : ''), Color.LIGHT_RED); failed++; }
  }

  fs.writeFile('/tmp/_t', 'hello');
  check('fs write+read', fs.readFile('/tmp/_t') === 'hello');
  fs.rm('/tmp/_t');
  check('fs rm', !fs.exists('/tmp/_t'));
  fs.mkdir('/tmp/_td');
  check('fs mkdir', fs.isDirectory('/tmp/_td'));
  check('fs cp', (fs.cp('/etc/hostname', '/tmp/_cp') && fs.exists('/tmp/_cp')));
  fs.rm('/tmp/_cp');
  var m = kernel.getMemoryInfo();
  check('mem.total > 0', m.total > 0, '' + m.total);
  var t1 = kernel.getUptime();
  kernel.sleep(50);
  check('timer advancing', kernel.getUptime() > t1);
  var sc = kernel.getScreenSize();
  check('screen 80x25', sc.width === 80 && sc.height === 25, sc.width + 'x' + sc.height);
  check('kernel.eval 2+2', kernel.eval('2+2') === '4');
  var proc = systemManager.createProcess('_test');
  check('createProcess', proc !== null);
  if (proc) systemManager.terminateProcess(proc.id);

  terminal.colorPrintln('  -----------------------------------------------', Color.DARK_GREY);
  var total = passed + failed;
  if (failed === 0) { terminal.colorPrintln('  All ' + total + ' tests passed!', Color.LIGHT_GREEN); }
  else { terminal.colorPrintln('  ' + passed + '/' + total + ' passed, ' + failed + ' failed', Color.YELLOW); }
}

//  Help 

function printHelp(): void {
  terminal.println('');
  terminal.colorPrintln('JSOS JavaScript REPL', Color.WHITE);
  terminal.colorPrintln('Every line is ES2023 JavaScript on bare-metal i686.', Color.LIGHT_GREY);

  terminal.println('');
  terminal.colorPrintln('Filesystem:', Color.YELLOW);
  terminal.println('  .ls   [path]          List directory');
  terminal.println('  .cat  <file>          Show file contents');
  terminal.println('  .cd   [path]          Change directory');
  terminal.println('  .pwd                  Print working directory');
  terminal.println('  .mkdir  <path>        Create directory');
  terminal.println('  .touch  <file>        Create empty file');
  terminal.println('  .rm   <path>          Remove file or empty dir');
  terminal.println('  .cp   <src> <dst>     Copy file');
  terminal.println('  .mv   <src> <dst>     Move / rename');
  terminal.println('  .write  <f> <text>    Overwrite file');
  terminal.println('  .append <f> <text>    Append to file');
  terminal.println('  .find [path] <pat>    Find files  (* wildcard)');
  terminal.println('  .stat <path>          File info');
  terminal.println('  .run  <file.js>       Execute JS file');

  terminal.println('');
  terminal.colorPrintln('System:', Color.YELLOW);
  terminal.println('  .ps                   Process list');
  terminal.println('  .kill <pid>           Terminate process');
  terminal.println('  .mem                  Memory + usage bar');
  terminal.println('  .uptime               System uptime');
  terminal.println('  .sysinfo              System summary');
  terminal.println('  .colors               VGA color palette');
  terminal.println('  .hostname [name]      Show or set hostname');
  terminal.println('  .echo <text>          Print text');
  terminal.println('  .test                 Run self-tests');

  terminal.println('');
  terminal.colorPrintln('REPL:', Color.YELLOW);
  terminal.println('  .clear    .history    .help    .halt    .reboot');
  terminal.println('  Up/Down   history browse');
  terminal.println('  Ctrl+U    erase line');
  terminal.println('  Ctrl+C    cancel line');
  terminal.println('  Ctrl+L    redraw screen');
  terminal.println('  {  (  [   auto-multiline; empty line to execute');

  terminal.println('');
  terminal.colorPrintln('JS globals:', Color.YELLOW);
  terminal.colorPrint('  fs', Color.LIGHT_CYAN);
  terminal.println('   .ls .cat .read .write .append .mkdir .touch .rm .cp .mv');
  terminal.println('       .stat .exists .isDir .isFile .pwd .cd .find .run');
  terminal.colorPrint('  sys', Color.LIGHT_CYAN);
  terminal.println('  .mem .ps .kill .uptime .screen .spawn .sleep');
  terminal.println('       .hostname .version .sysinfo .reboot .halt');
  terminal.colorPrint('  print', Color.LIGHT_CYAN);
  terminal.println('(s)   shortcut for kernel.print(s)');

  terminal.println('');
  terminal.colorPrintln('Examples:', Color.YELLOW);
  terminal.colorPrintln("  2 + 2", Color.WHITE);
  terminal.colorPrintln("  fs.ls('/bin')", Color.WHITE);
  terminal.colorPrintln("  fs.ls('/bin').map(function(f){return f.name;})", Color.WHITE);
  terminal.colorPrintln("  sys.mem()", Color.WHITE);
  terminal.colorPrintln("  fs.write('/tmp/hi.js','kernel.print(42)')", Color.WHITE);
  terminal.colorPrintln("  fs.run('/tmp/hi.js')", Color.WHITE);
  terminal.colorPrintln("  for(var i=0;i<16;i++){kernel.setColor(i,0);kernel.printRaw('##');}", Color.WHITE);
  terminal.println('');
}

//  Dot-command dispatcher 

function handleDot(line: string): void {
  var parts = line.trim().split(' ');
  var cmd   = parts[0].toLowerCase();
  var args  = parts.slice(1).filter(function(s) { return s.length > 0; });

  switch (cmd) {
    case '.help':     printHelp();       break;
    case '.clear':    kernel.clear();    break;
    case '.halt':     kernel.halt();     break;
    case '.reboot':   kernel.reboot();   break;

    case '.history':
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
      break;

    case '.ls':       dotLs(args);       break;
    case '.cat':      dotCat(args);      break;
    case '.write':    dotWrite(args);    break;
    case '.append':   dotAppend(args);   break;
    case '.mkdir':    dotMkdir(args);    break;
    case '.touch':    dotTouch(args);    break;
    case '.rm':       dotRm(args);       break;
    case '.cp':       dotCp(args);       break;
    case '.mv':       dotMv(args);       break;
    case '.find':     dotFind(args);     break;
    case '.stat':     dotStat(args);     break;
    case '.cd':       dotCd(args);       break;
    case '.pwd':      dotPwd();          break;
    case '.run':      dotRun(args);      break;
    case '.ps':       dotPs();           break;
    case '.kill':     dotKill(args);     break;
    case '.mem':      dotMem();          break;
    case '.uptime':   dotUptime();       break;
    case '.sysinfo':  dotSysinfo();      break;
    case '.colors':   dotColors();       break;
    case '.hostname': dotHostname(args); break;
    case '.echo':     dotEcho(args);     break;
    case '.test':     dotTest();         break;

    default:
      terminal.colorPrintln('Unknown: ' + cmd + '   (try .help)', Color.LIGHT_RED);
      break;
  }
}

//  Main REPL loop 

export function startRepl(): void {
  var mlBuffer = '';

  for (;;) {
    var isMulti     = mlBuffer.length > 0;
    var prompt      = isMulti ? '.. ' : '>> ';
    var promptColor = isMulti ? Color.DARK_GREY : Color.YELLOW;

    var line = readline(prompt, promptColor);

    if (!isMulti && line.length > 0 && line[0] === '.') {
      handleDot(line);
      continue;
    }

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