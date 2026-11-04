class Go9Game {
  constructor() {
    this.size = 9;
    this.board = Array(9).fill().map(() => Array(9).fill(null));
    this.moves = [];
    this.currentPlayer = 'black';
    this.passCount = 0;
    this.winner = null;
    this.captures = { black: 0, white: 0 };
    this.koPoint = null;
  }
  getGroupAndLiberties(board, x, y) {
    const color = board[y][x];
    if (!color) return { group: [], liberties: new Set() };
    const group = []; const liberties = new Set();
    const visited = new Set([`${x},${y}`]); const stack = [[x, y]];
    while (stack.length) {
      const [cx, cy] = stack.pop(); group.push([cx, cy]);
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || nx >= this.size || ny < 0 || ny >= this.size) continue;
        const key = `${nx},${ny}`;
        if (board[ny][nx] === null) liberties.add(key);
        else if (board[ny][nx] === color && !visited.has(key)) { visited.add(key); stack.push([nx, ny]); }
      }
    }
    return { group, liberties };
  }
  place(x, y) {
    if (this.winner) return { ok: false, reason: 'game_over' };
    if (x < 0 || x >= 9 || y < 0 || y >= 9) return { ok: false, reason: 'out_of_board' };
    if (this.board[y][x] !== null) return { ok: false, reason: 'occupied' };
    if (this.koPoint && this.koPoint.x === x && this.koPoint.y === y) return { ok: false, reason: 'ko' };
    const color = this.currentPlayer;
    const opponent = color === 'black' ? 'white' : 'black';
    const copy = this.board.map(row => row.slice());
    copy[y][x] = color;
    let capturedCount = 0; let capturedPositions = [];
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || nx >= 9 || ny < 0 || ny >= 9) continue;
      if (copy[ny][nx] === opponent) {
        const { group, liberties } = this.getGroupAndLiberties(copy, nx, ny);
        if (liberties.size === 0) {
          for (const [gx, gy] of group) { copy[gy][gx] = null; capturedPositions.push({ x: gx, y: gy }); }
          capturedCount += group.length;
        }
      }
    }
    const self = this.getGroupAndLiberties(copy, x, y);
    if (self.liberties.size === 0 && capturedCount === 0) return { ok: false, reason: 'suicide' };
    let newKoPoint = null;
    if (capturedCount === 1 && capturedPositions.length === 1) newKoPoint = { x: capturedPositions[0].x, y: capturedPositions[0].y };
    this.board = copy; this.captures[color] += capturedCount;
    this.moves.push({ x, y, player: color, captured: capturedCount });
    this.koPoint = newKoPoint; this.currentPlayer = opponent; this.passCount = 0;
    return { ok: true, captured: capturedCount };
  }
  pass() {
    if (this.winner) return { ok: false };
    this.passCount++; this.koPoint = null;
    if (this.passCount >= 2) {
      this.winner = this.calculateWinner();
      return { ok: true, gameOver: true, winner: this.winner };
    }
    this.currentPlayer = this.currentPlayer === 'black' ? 'white' : 'black';
    this.moves.push({ x: null, y: null, player: this.currentPlayer === 'black' ? 'white' : 'black', pass: true });
    return { ok: true, passCount: this.passCount };
  }
  calculateWinner() {
    let blackScore = 0, whiteScore = 0; const visited = new Set();
    for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
      if (this.board[y][x] === 'black') blackScore++;
      else if (this.board[y][x] === 'white') whiteScore++;
      else if (this.board[y][x] === null && !visited.has(`${x},${y}`)) {
        const region = []; const stack = [[x, y]]; visited.add(`${x},${y}`);
        let tb = false, tw = false;
        while (stack.length) {
          const [cx, cy] = stack.pop(); region.push([cx, cy]);
          for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
            const nx = cx + dx, ny = cy + dy;
            if (nx < 0 || nx >= 9 || ny < 0 || ny >= 9) continue;
            const key = `${nx},${ny}`;
            if (this.board[ny][nx] === 'black') tb = true;
            else if (this.board[ny][nx] === 'white') tw = true;
            else if (this.board[ny][nx] === null && !visited.has(key)) { visited.add(key); stack.push([nx, ny]); }
          }
        }
        if (tb && !tw) blackScore += region.length;
        else if (tw && !tb) whiteScore += region.length;
      }
    }
    whiteScore += 7.5;
    if (blackScore > whiteScore) return 'black';
    if (whiteScore > blackScore) return 'white';
    return 'draw';
  }
  getState() {
    return { board: this.board, currentPlayer: this.currentPlayer, moves: this.moves,
             captures: this.captures, winner: this.winner, passCount: this.passCount, koPoint: this.koPoint };
  }
}
module.exports = Go9Game;
