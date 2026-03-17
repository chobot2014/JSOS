// [Item 777] Notes — simple line-buffer text editor
// Navigation: arrow keys, Ctrl+S to save, Ctrl+Q / Esc to quit

declare var kernel: any;
declare var fs: any;

export function launchNotes(terminal: any, filepath?: string): void {
  var path: string = filepath || '/tmp/notes.txt';
  var lines: string[] = [''];
  var cx = 0;  // cursor col
  var cy = 0;  // cursor row (line index)
  var modified = false;
  var statusMsg = '';
  var statusTimer = 0;

  // Load existing file
  if (filepath && fs.exists(filepath)) {
    var data = fs.readFile(filepath);
    if (data) {
      lines = String(data).split('\n');
      if (lines.length === 0) lines = [''];
    }
  }

  function setStatus(msg: string) {
    statusMsg = msg;
    statusTimer = 3;
  }

  function clamp(v: number, lo: number, hi: number) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function render() {
    terminal.clear();
    // Header
    var header = '  NOTES — ' + path + (modified ? ' *' : '') + '  |  Ctrl+S save  Ctrl+Q quit';
    terminal.println('─'.repeat(70));
    terminal.println(header);
    terminal.println('─'.repeat(70));

    // Content lines
    var visibleLines = Math.min(lines.length, 20);
    for (var i = 0; i < visibleLines; i++) {
      var lineNum = (i + 1).toString().padStart(3, ' ') + ' │ ';
      if (i === cy) {
        var before = lines[i].slice(0, cx);
        var curChar = lines[i][cx] || ' ';
        var after = lines[i].slice(cx + 1);
        terminal.print(lineNum + before);
        terminal.print('[' + curChar + ']');  // simple cursor indicator
        terminal.println(after);
      } else {
        terminal.println(lineNum + lines[i]);
      }
    }

    // Status bar
    terminal.println('─'.repeat(70));
    var pos = 'Ln ' + (cy + 1) + ', Col ' + (cx + 1) + '  |  ' + lines.length + ' lines';
    terminal.println('  ' + pos + (statusMsg ? '  |  ' + statusMsg : ''));
    terminal.println('─'.repeat(70));
  }

  function insertChar(ch: string) {
    lines[cy] = lines[cy].slice(0, cx) + ch + lines[cy].slice(cx);
    cx++;
    modified = true;
  }

  function deleteCharBefore() {
    if (cx > 0) {
      lines[cy] = lines[cy].slice(0, cx - 1) + lines[cy].slice(cx);
      cx--;
      modified = true;
    } else if (cy > 0) {
      // Merge with previous line
      cx = lines[cy - 1].length;
      lines[cy - 1] = lines[cy - 1] + lines[cy];
      lines.splice(cy, 1);
      cy--;
      modified = true;
    }
  }

  function splitLine() {
    var rest = lines[cy].slice(cx);
    lines[cy] = lines[cy].slice(0, cx);
    lines.splice(cy + 1, 0, rest);
    cy++;
    cx = 0;
    modified = true;
  }

  function saveFile() {
    try {
      fs.writeFile(path, lines.join('\n'));
      modified = false;
      setStatus('Saved to ' + path);
    } catch (e: any) {
      setStatus('Save failed: ' + String(e));
    }
  }

  render();

  while (true) {
    var key = kernel.waitkey ? kernel.waitkey() : kernel.readKey ? kernel.readKey() : null;
    if (!key && kernel.hasKey && !kernel.hasKey()) {
      kernel.sleep(30);
      continue;
    }
    if (!key) key = kernel.readKey ? kernel.readKey() : '';

    var code = typeof key === 'number' ? key : (typeof key === 'string' ? key.charCodeAt(0) : 0);
    var keyStr = typeof key === 'string' ? key : String.fromCharCode(code);

    // Ctrl+Q or Escape
    if (code === 17 || code === 27) {
      if (modified) {
        render();
        terminal.println('  Unsaved changes. Save before quitting? (y/n)');
        var ans = terminal.readLine('');
        if (ans && ans.toLowerCase() === 'y') {
          saveFile();
        }
      }
      terminal.clear();
      terminal.println('[notes] exited.');
      return;
    }

    // Ctrl+S
    if (code === 19) {
      saveFile();
      render();
      continue;
    }

    // Arrow keys (ANSI escape: 27, 91, 65/66/67/68)
    if (keyStr === '\x1b[A' || keyStr === 'UP') {
      if (cy > 0) { cy--; cx = clamp(cx, 0, lines[cy].length); }
    } else if (keyStr === '\x1b[B' || keyStr === 'DOWN') {
      if (cy < lines.length - 1) { cy++; cx = clamp(cx, 0, lines[cy].length); }
    } else if (keyStr === '\x1b[C' || keyStr === 'RIGHT') {
      if (cx < lines[cy].length) { cx++; }
      else if (cy < lines.length - 1) { cy++; cx = 0; }
    } else if (keyStr === '\x1b[D' || keyStr === 'LEFT') {
      if (cx > 0) { cx--; }
      else if (cy > 0) { cy--; cx = lines[cy].length; }
    } else if (code === 13 || keyStr === '\r' || keyStr === '\n') {
      // Enter
      splitLine();
    } else if (code === 8 || code === 127) {
      // Backspace
      deleteCharBefore();
    } else if (code >= 32 && code < 127) {
      insertChar(keyStr);
    }

    // Re-clamp cursor
    cy = clamp(cy, 0, lines.length - 1);
    cx = clamp(cx, 0, lines[cy].length);
    render();
  }
}
