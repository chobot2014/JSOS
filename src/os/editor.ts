/**
 * JSOS Fullscreen Text Editor
 *
 * Usage: edit()            — new empty buffer
 *        edit('/tmp/x.js') — open file
 *
 * Keys:
 *   Arrow keys      move cursor
 *   Home / End      start / end of line
 *   PgUp / PgDown   scroll content
 *   Backspace       delete char before cursor
 *   Delete (0x88)   delete char at cursor
 *   Enter           insert newline / split line
 *   Ctrl+S          save  (prompts for filename if unsaved)
 *   Ctrl+Q          quit  (warns if unsaved changes)
 *   Ctrl+X          force-quit without saving
 *   Ctrl+K          cut current line → clipboard
 *   Ctrl+U          paste clipboard line before cursor
 *   Ctrl+L          redraw screen
 */

import fs from './filesystem.js';
import terminal from './terminal.js';

declare var kernel: import('./kernel.js').KernelAPI;

// ── Screen layout ───────────────────────────────────────────────────────────
var EDIT_ROWS  = 23;   // rows 0-22: text content
var STATUS_ROW = 23;   // row 23: file name + cursor position
var HINT_ROW   = 24;   // row 24: key hints

// ── VGA colour bytes  (bg << 4) | fg  ─────────────────────────────────────
// bg must be 0-7 to avoid blink
var C_NORMAL  = 0x07;  // light-grey on black
var C_TILDE   = 0x08;  // dark-grey  on black  (empty-line marker)
var C_STATUS  = 0x70;  // black on light-grey  (inverted)
var C_HINT    = 0x30;  // black on cyan
var C_WARN    = 0x4E;  // yellow on red
var C_PROMPT  = 0x1F;  // white on blue

// ── Helpers ─────────────────────────────────────────────────────────────────
function pad80(s: string): string {
  if (s.length >= 80) return s.slice(0, 80);
  while (s.length < 80) s += ' ';
  return s;
}

function lpad(s: string, w: number): string {
  while (s.length < w) s = ' ' + s;
  return s;
}

// ── Public entry point ───────────────────────────────────────────────────────
export function openEditor(filePath?: string): void {

  // Load file or start empty
  var content = filePath ? (fs.readFile(filePath) || '') : '';
  var lines: string[] = content.split('\n');
  if (lines.length === 0) lines = [''];

  var curRow  = 0;  // cursor position in document
  var curCol  = 0;
  var viewTop = 0;  // first visible document line
  var modified  = false;
  var savedPath = filePath || '';
  var clipboard = '';
  var message   = '';  // one-shot status message (cleared after next render)

  // ── Clamp curCol to line length ──────────────────────────────────────────
  function clampCol(): void {
    var len = lines[curRow].length;
    if (curCol > len) curCol = len;
  }

  // ── Ensure cursor row is visible ─────────────────────────────────────────
  function scrollIntoView(): void {
    if (curRow < viewTop) viewTop = curRow;
    if (curRow >= viewTop + EDIT_ROWS) viewTop = curRow - EDIT_ROWS + 1;
    if (viewTop < 0) viewTop = 0;
  }

  // ── Render one content row ───────────────────────────────────────────────
  function renderContentRow(screenRow: number): void {
    var docRow = viewTop + screenRow;
    if (docRow < lines.length) {
      var line = lines[docRow];
      kernel.vgaDrawRow(screenRow, pad80(line), C_NORMAL);
    } else {
      kernel.vgaDrawRow(screenRow, pad80('~'), C_TILDE);
    }
  }

  // ── Render the whole editor ───────────────────────────────────────────────
  function render(): void {
    // Content area
    for (var r = 0; r < EDIT_ROWS; r++) renderContentRow(r);

    // Status bar
    var fname   = savedPath || '[No File]';
    var mod     = modified ? ' [+]' : '';
    var posInfo = ' Ln ' + (curRow + 1) + '/' + lines.length +
                  ' Co ' + (curCol + 1) + ' ';
    var left    = ' JSOS Edit \u2502 ' + fname + mod;
    var status  = left;
    while (status.length < 80 - posInfo.length) status += ' ';
    status = pad80(status + posInfo);
    kernel.vgaDrawRow(STATUS_ROW, status, message ? C_WARN : C_STATUS);

    // Hint bar — show one-shot message or default hints
    var hintText: string;
    if (message) {
      hintText = pad80('  ' + message);
      message = '';
    } else {
      hintText = pad80(' ^S:Save  ^Q:Quit  ^X:Force-quit  ^K:Cut  ^U:Paste  ' +
                       'Home/End  PgUp/Dn  Del');
    }
    kernel.vgaDrawRow(HINT_ROW, hintText, C_HINT);

    // Position hardware cursor
    var hcol = curCol < 80 ? curCol : 79;
    kernel.vgaSetCursor(curRow - viewTop, hcol);
  }

  // ── Prompt for a string in the status bar ────────────────────────────────
  function promptString(label: string): string {
    var val = '';
    for (;;) {
      var promptLine = ' ' + label + val;
      while (promptLine.length < 79) promptLine += ' ';
      kernel.vgaDrawRow(STATUS_ROW, pad80(promptLine), C_PROMPT);
      kernel.vgaSetCursor(STATUS_ROW, 1 + label.length + val.length);

      var k = kernel.waitKeyEx();
      if (k.ch === '\n' || k.ch === '\r') return val;
      if (k.ch === '\x1b') return '';
      if ((k.ch === '\b' || k.ch === '\x7f') && val.length > 0) {
        val = val.slice(0, -1);
      } else if (k.ch && k.ch >= ' ') {
        val += k.ch;
      }
    }
  }

  // ── Save ─────────────────────────────────────────────────────────────────
  function save(): void {
    if (!savedPath) {
      var name = promptString('Save as: ');
      if (!name) { message = 'Save cancelled.'; return; }
      savedPath = name;
    }
    if (fs.writeFile(savedPath, lines.join('\n'))) {
      modified = false;
      message = 'Saved: ' + savedPath;
    } else {
      message = 'ERROR: could not write ' + savedPath;
    }
  }

  // ── Initialize ───────────────────────────────────────────────────────────
  terminal.resumeLive();  // snap out of any scrollback view
  kernel.vgaFill(' ', C_NORMAL);
  render();

  // ── Main loop ────────────────────────────────────────────────────────────
  for (;;) {
    var key = kernel.waitKeyEx();

    if (key.ext !== 0) {
      switch (key.ext) {

        case 0x80:  // Arrow Up
          if (curRow > 0) { curRow--; clampCol(); }
          break;

        case 0x81:  // Arrow Down
          if (curRow < lines.length - 1) { curRow++; clampCol(); }
          break;

        case 0x82:  // Arrow Left
          if (curCol > 0) {
            curCol--;
          } else if (curRow > 0) {
            curRow--;
            curCol = lines[curRow].length;
          }
          break;

        case 0x83:  // Arrow Right
          if (curCol < lines[curRow].length) {
            curCol++;
          } else if (curRow < lines.length - 1) {
            curRow++;
            curCol = 0;
          }
          break;

        case 0x84:  // Home
          curCol = 0;
          break;

        case 0x85:  // End
          curCol = lines[curRow].length;
          break;

        case 0x86:  // PgUp
          curRow = curRow - EDIT_ROWS > 0 ? curRow - EDIT_ROWS : 0;
          clampCol();
          break;

        case 0x87:  // PgDown
          curRow = curRow + EDIT_ROWS < lines.length - 1
            ? curRow + EDIT_ROWS : lines.length - 1;
          clampCol();
          break;

        case 0x88:  // Delete
          if (curCol < lines[curRow].length) {
            lines[curRow] = lines[curRow].slice(0, curCol) +
                            lines[curRow].slice(curCol + 1);
            modified = true;
          } else if (curRow < lines.length - 1) {
            lines[curRow] += lines[curRow + 1];
            lines.splice(curRow + 1, 1);
            modified = true;
          }
          break;

        default:
          break;
      }

    } else {
      var ch = key.ch;
      if (!ch) continue;

      if (ch === '\x13') {             // Ctrl+S — save
        save();

      } else if (ch === '\x11') {      // Ctrl+Q — quit (warn if modified)
        if (modified) {
          message = 'Unsaved changes! Press Ctrl+Q again to quit, any key to cancel.';
          render();
          var conf = kernel.waitKeyEx();
          if (conf.ch === '\x11') break;
          message = '';
        } else {
          break;
        }

      } else if (ch === '\x18') {      // Ctrl+X — force quit
        break;

      } else if (ch === '\x0b') {      // Ctrl+K — cut line
        clipboard = lines[curRow];
        lines.splice(curRow, 1);
        if (lines.length === 0) lines = [''];
        if (curRow >= lines.length) curRow = lines.length - 1;
        curCol = 0;
        modified = true;
        message = 'Cut line → clipboard';

      } else if (ch === '\x15') {      // Ctrl+U — paste clipboard line
        lines.splice(curRow, 0, clipboard);
        modified = true;
        message = 'Pasted line from clipboard';

      } else if (ch === '\x0c') {      // Ctrl+L — force full redraw
        kernel.clear();

      } else if (ch === '\n' || ch === '\r') {   // Enter — split line
        var before = lines[curRow].slice(0, curCol);
        var after  = lines[curRow].slice(curCol);
        lines[curRow] = before;
        lines.splice(curRow + 1, 0, after);
        curRow++;
        curCol = 0;
        modified = true;

      } else if (ch === '\b' || ch === '\x7f') { // Backspace
        if (curCol > 0) {
          lines[curRow] = lines[curRow].slice(0, curCol - 1) +
                          lines[curRow].slice(curCol);
          curCol--;
          modified = true;
        } else if (curRow > 0) {
          var prevLen = lines[curRow - 1].length;
          lines[curRow - 1] += lines[curRow];
          lines.splice(curRow, 1);
          curRow--;
          curCol = prevLen;
          modified = true;
        }

      } else if (ch >= ' ') {          // Printable character
        lines[curRow] = lines[curRow].slice(0, curCol) + ch +
                        lines[curRow].slice(curCol);
        curCol++;
        modified = true;

      } else if (ch === '\t') {        // Tab → 4 spaces
        var spaces = '    ';
        lines[curRow] = lines[curRow].slice(0, curCol) + spaces +
                        lines[curRow].slice(curCol);
        curCol += 4;
        modified = true;
      }
    }

    scrollIntoView();
    render();
  }

  // ── Restore terminal ──────────────────────────────────────────────────────
  terminal.clear();
}
