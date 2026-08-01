// [Item 785] Snake — classic snake game

declare var kernel: any;

const BW = 40;  // board width
const BH = 20;  // board height

type Point = { x: number; y: number };
type Dir = 'U' | 'D' | 'L' | 'R';

function eqPt(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

function randFood(snake: Point[]): Point {
  var pt: Point;
  var tries = 0;
  do {
    pt = { x: Math.floor(Math.random() * BW), y: Math.floor(Math.random() * BH) };
    tries++;
  } while (tries < 500 && snake.some(function(s) { return eqPt(s, pt); }));
  return pt;
}

function nextHead(head: Point, dir: Dir): Point {
  switch (dir) {
    case 'U': return { x: head.x, y: head.y - 1 };
    case 'D': return { x: head.x, y: head.y + 1 };
    case 'L': return { x: head.x - 1, y: head.y };
    case 'R': return { x: head.x + 1, y: head.y };
  }
}

function render(terminal: any, snake: Point[], food: Point, score: number, gameOver: boolean): void {
  // Build grid
  var grid: string[][] = [];
  for (var r = 0; r < BH; r++) {
    var row: string[] = [];
    for (var c = 0; c < BW; c++) row.push(' ');
    grid.push(row);
  }

  // Place food
  if (food.y >= 0 && food.y < BH && food.x >= 0 && food.x < BW)
    grid[food.y][food.x] = '●';

  // Place snake
  for (var i = 0; i < snake.length; i++) {
    var s = snake[i];
    if (s.y >= 0 && s.y < BH && s.x >= 0 && s.x < BW)
      grid[s.y][s.x] = i === 0 ? '▓' : '█';
  }

  terminal.clear();
  terminal.println(' SNAKE   Score: ' + score + '   Length: ' + snake.length + '   wasd/arrows: move  q: quit');
  terminal.println(' ┌' + '─'.repeat(BW) + '┐');
  for (var r2 = 0; r2 < BH; r2++) {
    terminal.println(' │' + grid[r2].join('') + '│');
  }
  terminal.println(' └' + '─'.repeat(BW) + '┘');
  if (gameOver) terminal.println('  *** GAME OVER *** Press q to exit.');
}

function opposite(d: Dir): Dir {
  if (d === 'U') return 'D';
  if (d === 'D') return 'U';
  if (d === 'L') return 'R';
  return 'L';
}

export function launchSnake(terminal: any): void {
  // Initial snake in middle heading right
  var snake: Point[] = [
    { x: 22, y: 10 },
    { x: 21, y: 10 },
    { x: 20, y: 10 },
  ];
  var dir: Dir = 'R';
  var nextDir: Dir = 'R';
  var food: Point = randFood(snake);
  var score = 0;
  var gameOver = false;
  var tickMs = 120;

  terminal.clear();
  kernel.sleep(100);
  render(terminal, snake, food, score, gameOver);

  var lastTick = kernel.getUptime ? kernel.getUptime() : Date.now();

  while (true) {
    kernel.sleep(40);

    // Input
    if (kernel.hasKey && kernel.hasKey()) {
      var k = kernel.readKey ? kernel.readKey() : '';
      var kc = typeof k === 'string' ? k.charCodeAt(0) : k;
      var ks = typeof k === 'string' ? k : String.fromCharCode(kc);

      if (ks === 'q' || kc === 81 || kc === 113) {
        terminal.clear();
        terminal.println('Thanks for playing Snake! Final score: ' + score);
        return;
      }

      if (!gameOver) {
        var nd: Dir | null = null;
        if (ks === 'w' || ks === 'W' || ks === '\x1b[A') nd = 'U';
        else if (ks === 's' || ks === 'S' || ks === '\x1b[B') nd = 'D';
        else if (ks === 'd' || ks === 'D' || ks === '\x1b[C') nd = 'R';
        else if (ks === 'a' || ks === 'A' || ks === '\x1b[D') nd = 'L';

        if (nd && nd !== opposite(dir)) nextDir = nd;
      }
    }

    // Tick
    var now = kernel.getUptime ? kernel.getUptime() : Date.now();
    if (!gameOver && (now - lastTick) >= tickMs) {
      lastTick = now;
      dir = nextDir;
      var head = nextHead(snake[0], dir);

      // Wall collision
      if (head.x < 0 || head.x >= BW || head.y < 0 || head.y >= BH) {
        gameOver = true;
        render(terminal, snake, food, score, gameOver);
        continue;
      }
      // Self collision (skip tail since it will move)
      for (var i = 0; i < snake.length - 1; i++) {
        if (eqPt(head, snake[i])) {
          gameOver = true;
          break;
        }
      }
      if (gameOver) {
        render(terminal, snake, food, score, gameOver);
        continue;
      }

      // Eat food?
      var ate = eqPt(head, food);
      snake.unshift(head);
      if (ate) {
        score += 10;
        food = randFood(snake);
        // Speed up slightly
        tickMs = Math.max(60, tickMs - 2);
      } else {
        snake.pop();
      }
      render(terminal, snake, food, score, gameOver);
    }
  }
}
