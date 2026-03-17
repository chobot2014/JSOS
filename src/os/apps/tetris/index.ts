// [Item 784] Tetris — classic falling-blocks game

declare var kernel: any;

const W = 10;
const H = 20;

// 7 standard tetrominoes — each piece is a 4×4 bitmap
const PIECES: number[][][][] = [
  // I
  [[[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]],
   [[0,0,1,0],[0,0,1,0],[0,0,1,0],[0,0,1,0]],
   [[0,0,0,0],[0,0,0,0],[1,1,1,1],[0,0,0,0]],
   [[0,1,0,0],[0,1,0,0],[0,1,0,0],[0,1,0,0]]],
  // O
  [[[0,0,0,0],[0,1,1,0],[0,1,1,0],[0,0,0,0]],
   [[0,0,0,0],[0,1,1,0],[0,1,1,0],[0,0,0,0]],
   [[0,0,0,0],[0,1,1,0],[0,1,1,0],[0,0,0,0]],
   [[0,0,0,0],[0,1,1,0],[0,1,1,0],[0,0,0,0]]],
  // T
  [[[0,0,0,0],[0,1,1,1],[0,0,1,0],[0,0,0,0]],
   [[0,0,1,0],[0,1,1,0],[0,0,1,0],[0,0,0,0]],
   [[0,0,1,0],[0,1,1,1],[0,0,0,0],[0,0,0,0]],
   [[0,0,1,0],[0,0,1,1],[0,0,1,0],[0,0,0,0]]],
  // S
  [[[0,0,0,0],[0,0,1,1],[0,1,1,0],[0,0,0,0]],
   [[0,0,1,0],[0,0,1,1],[0,0,0,1],[0,0,0,0]],
   [[0,0,0,0],[0,0,1,1],[0,1,1,0],[0,0,0,0]],
   [[0,0,1,0],[0,0,1,1],[0,0,0,1],[0,0,0,0]]],
  // Z
  [[[0,0,0,0],[0,1,1,0],[0,0,1,1],[0,0,0,0]],
   [[0,0,0,1],[0,0,1,1],[0,0,1,0],[0,0,0,0]],
   [[0,0,0,0],[0,1,1,0],[0,0,1,1],[0,0,0,0]],
   [[0,0,0,1],[0,0,1,1],[0,0,1,0],[0,0,0,0]]],
  // J
  [[[0,0,0,0],[0,1,1,1],[0,0,0,1],[0,0,0,0]],
   [[0,0,1,1],[0,0,1,0],[0,0,1,0],[0,0,0,0]],
   [[0,0,1,0],[0,0,1,1,1],[0,0,0,0],[0,0,0,0]],
   [[0,0,0,1],[0,0,0,1],[0,0,1,1],[0,0,0,0]]],
  // L
  [[[0,0,0,0],[0,1,1,1],[0,1,0,0],[0,0,0,0]],
   [[0,0,1,0],[0,0,1,0],[0,0,1,1],[0,0,0,0]],
   [[0,0,0,1],[0,1,1,1],[0,0,0,0],[0,0,0,0]],
   [[0,1,1,0],[0,0,1,0],[0,0,1,0],[0,0,0,0]]],
];

const CHARS = [' ', '█'];
const BORDER = '│';
const FLOOR  = '─';

function makeBoard(): number[][] {
  var b: number[][] = [];
  for (var r = 0; r < H; r++) {
    b.push(new Array(W).fill(0));
  }
  return b;
}

function nextPiece(): { type: number; rot: number; x: number; y: number } {
  return { type: Math.floor(Math.random() * 7), rot: 0, x: 3, y: 0 };
}

function pieceBlocks(p: { type: number; rot: number; x: number; y: number }): [number,number][] {
  var shape = PIECES[p.type][p.rot];
  var result: [number,number][] = [];
  for (var r = 0; r < 4; r++) {
    for (var c = 0; c < 4; c++) {
      if (shape[r][c]) result.push([p.y + r, p.x + c]);
    }
  }
  return result;
}

function valid(board: number[][], blocks: [number,number][]): boolean {
  for (var i = 0; i < blocks.length; i++) {
    var row = blocks[i][0], col = blocks[i][1];
    if (col < 0 || col >= W || row >= H) return false;
    if (row >= 0 && board[row][col]) return false;
  }
  return true;
}

function lockPiece(board: number[][], p: any): void {
  var blocks = pieceBlocks(p);
  for (var i = 0; i < blocks.length; i++) {
    var r = blocks[i][0], c = blocks[i][1];
    if (r >= 0) board[r][c] = 1;
  }
}

function clearLines(board: number[][]): number {
  var cleared = 0;
  for (var r = H - 1; r >= 0; r--) {
    if (board[r].every(function(v) { return v === 1; })) {
      board.splice(r, 1);
      board.unshift(new Array(W).fill(0));
      cleared++;
      r++;  // re-check same row index
    }
  }
  return cleared;
}

function render(terminal: any, board: number[][], current: any, score: number, lines: number, level: number, gameOver: boolean): void {
  // Build display board with current piece
  var display: number[][] = board.map(function(row) { return row.slice(); });
  if (!gameOver) {
    var blocks = pieceBlocks(current);
    blocks.forEach(function(b) {
      if (b[0] >= 0 && b[0] < H && b[1] >= 0 && b[1] < W) display[b[0]][b[1]] = 2;
    });
  }

  terminal.clear();
  terminal.println(' TETRIS         Score: ' + score + '   Lines: ' + lines + '   Level: ' + level);
  terminal.println(' ┌' + '──'.repeat(W) + '┐');
  for (var r = 0; r < H; r++) {
    var row = ' │';
    for (var c = 0; c < W; c++) {
      row += display[r][c] ? '██' : '  ';
    }
    row += '│';
    terminal.println(row);
  }
  terminal.println(' └' + '──'.repeat(W) + '┘');
  terminal.println(' a/d: move  w: rotate  s: soft-drop  space: hard-drop  q: quit');
  if (gameOver) terminal.println('  *** GAME OVER *** Press q to exit.');
}

export function launchTetris(terminal: any): void {
  var board = makeBoard();
  var current = nextPiece();
  var score = 0;
  var linesCleared = 0;
  var level = 1;
  var gameOver = false;
  var tickMs = 500;
  var lastTick = kernel.getUptime ? kernel.getUptime() : Date.now();

  terminal.clear();
  terminal.println('TETRIS — Loading...');
  kernel.sleep(200);

  render(terminal, board, current, score, linesCleared, level, gameOver);

  while (true) {
    kernel.sleep(50);

    // Read any pending key
    if (kernel.hasKey && kernel.hasKey()) {
      var k = kernel.readKey ? kernel.readKey() : '';
      var kc = typeof k === 'string' ? k.charCodeAt(0) : k;
      var ks = typeof k === 'string' ? k : String.fromCharCode(kc);

      if (ks === 'q' || kc === 81 || kc === 113) {
        terminal.clear();
        terminal.println('Thanks for playing Tetris!');
        return;
      }

      if (!gameOver) {
        var moved = false;
        if (ks === 'a' || ks === 'A') {
          var nb = pieceBlocks({ ...current, x: current.x - 1 });
          if (valid(board, nb)) { current.x--; moved = true; }
        } else if (ks === 'd' || ks === 'D') {
          var nb2 = pieceBlocks({ ...current, x: current.x + 1 });
          if (valid(board, nb2)) { current.x++; moved = true; }
        } else if (ks === 'w' || ks === 'W') {
          var newRot = (current.rot + 1) % 4;
          var nb3 = pieceBlocks({ ...current, rot: newRot });
          if (valid(board, nb3)) { current.rot = newRot; moved = true; }
        } else if (ks === 's' || ks === 'S') {
          var nb4 = pieceBlocks({ ...current, y: current.y + 1 });
          if (valid(board, nb4)) { current.y++; score++; moved = true; }
        } else if (kc === 32) {
          // Hard drop
          while (true) {
            var nb5 = pieceBlocks({ ...current, y: current.y + 1 });
            if (!valid(board, nb5)) break;
            current.y++;
            score += 2;
          }
          lockPiece(board, current);
          var cl = clearLines(board);
          linesCleared += cl;
          score += cl * cl * 100;
          level = Math.floor(linesCleared / 10) + 1;
          tickMs = Math.max(80, 500 - (level * 40));
          current = nextPiece();
          if (!valid(board, pieceBlocks(current))) gameOver = true;
          moved = true;
        }
        if (moved) render(terminal, board, current, score, linesCleared, level, gameOver);
      }
    }

    // Gravity tick
    var now = kernel.getUptime ? kernel.getUptime() : Date.now();
    if (!gameOver && (now - lastTick) >= tickMs) {
      lastTick = now;
      var downBlocks = pieceBlocks({ ...current, y: current.y + 1 });
      if (valid(board, downBlocks)) {
        current.y++;
      } else {
        lockPiece(board, current);
        var cl2 = clearLines(board);
        linesCleared += cl2;
        score += cl2 * cl2 * 100;
        level = Math.floor(linesCleared / 10) + 1;
        tickMs = Math.max(80, 500 - (level * 40));
        current = nextPiece();
        if (!valid(board, pieceBlocks(current))) gameOver = true;
      }
      render(terminal, board, current, score, linesCleared, level, gameOver);
    }
  }
}
