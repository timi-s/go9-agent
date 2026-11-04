'use strict';

/**
 * 9 路围棋规则引擎。
 *
 * 规则要点：
 * - 位置超级劫（positional superko）：任何一手棋都不允许让盘面回到此前出现过的
 *   任一局面（包括初始空盘）；简单劫的立即提回统一以 reason='ko' 拒绝。
 * - 禁止自杀手：落子后己方棋块若无气则拒绝。
 * - 连续两次 pass 按中国规则数子终局（盘面棋子 + 单方围空，白贴 komi）。
 * - undo 基于内部快照实现，可跨终局（认输/两次 pass）恢复。
 *
 * 该类为 CommonJS 模块，`module.exports = Go9Game`，可直接 new 使用。
 */

const BLACK = 'black';
const WHITE = 'white';

const NEIGHBOR_OFFSETS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function opponentOf(color) {
  return color === BLACK ? WHITE : BLACK;
}

function isColor(color) {
  return color === BLACK || color === WHITE;
}

class Go9Game {
  /**
   * @param {{ size?: number, komi?: number }} [options]
   */
  constructor({ size = 9, komi = 7.5 } = {}) {
    this.size = size;
    this.komi = komi;
    this.board = createEmptyBoard(size);
    this.moves = [];
    this.currentPlayer = BLACK;
    this.captures = { black: 0, white: 0 };
    this.passCount = 0;
    this.winner = null;
    this.result = null;
    this.koPoint = null;

    // 以下为内部状态：历史上出现过的盘面（位置超级劫用）与可撤销快照栈。
    this._positionKeys = new Set([this._boardKey(this.board)]);
    this._history = [this._snapshot()];
  }

  /**
   * 落子。
   * @returns {{ok: true, captured: number, move: object} | {ok: false, reason: string}}
   */
  place(x, y) {
    if (this.winner !== null) return { ok: false, reason: 'game_over' };
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= this.size || y < 0 || y >= this.size) {
      return { ok: false, reason: 'out_of_board' };
    }
    if (this.board[y][x] !== null) return { ok: false, reason: 'occupied' };
    if (this.koPoint !== null && this.koPoint.x === x && this.koPoint.y === y) {
      return { ok: false, reason: 'ko' };
    }

    const color = this.currentPlayer;
    const placement = this._simulatePlacement(this.board, x, y, color);
    if (placement.suicide) return { ok: false, reason: 'suicide' };
    if (this._positionKeys.has(placement.key)) return { ok: false, reason: 'superko' };

    const captured = placement.capturedPositions.length;
    this.board = placement.board;
    this.captures[color] += captured;
    const move = { x, y, player: color, captured };
    this.moves.push(move);
    this._positionKeys.add(placement.key);
    this.koPoint = this._detectKo(this.board, x, y, placement.capturedPositions);
    this.currentPlayer = opponentOf(color);
    this.passCount = 0;
    this._pushHistory();

    return { ok: true, captured, move: { ...move } };
  }

  /**
   * 停一手（pass）。连续两次 pass 数子终局。
   * @returns {{ok: true, gameOver: boolean, winner: string|null} | {ok: false, reason: string}}
   */
  pass() {
    if (this.winner !== null) return { ok: false, reason: 'game_over' };

    const player = this.currentPlayer;
    this.moves.push({ x: null, y: null, player, captured: 0, pass: true });
    this.passCount += 1;
    this.koPoint = null;
    this.currentPlayer = opponentOf(player);

    let gameOver = false;
    if (this.passCount >= 2) {
      this.winner = this._computeWinner();
      this.result = this._buildScoreResult();
      gameOver = true;
    }
    this._pushHistory();
    return { ok: true, gameOver, winner: this.winner };
  }

  /**
   * 认输。默认当前行棋方认输。
   * @param {'black'|'white'} [player]
   * @returns {{ok: true, winner: string} | {ok: false, reason: string}}
   */
  resign(player) {
    if (this.winner !== null) return { ok: false, reason: 'game_over' };
    const resigning = player === undefined || player === null ? this.currentPlayer : player;
    if (!isColor(resigning)) return { ok: false, reason: 'invalid_move' };

    const winner = opponentOf(resigning);
    this.winner = winner;
    this.result = { method: 'resign', black: null, white: null, winner, margin: null };
    this._pushHistory();
    return { ok: true, winner };
  }

  /**
   * 悔棋，可跨终局（认输、两次 pass）。
   * @param {number} [steps=1]
   * @returns {{ok: true, undone: number} | {ok: false, reason: 'nothing_to_undo'}}
   */
  undo(steps = 1) {
    const numeric = Number(steps);
    const wanted = Math.max(1, Math.min(20, Number.isFinite(numeric) ? Math.floor(numeric) : 1));
    const undone = Math.min(wanted, this._history.length - 1);
    if (undone <= 0) return { ok: false, reason: 'nothing_to_undo' };

    for (let i = 0; i < undone; i += 1) this._history.pop();
    this._restore(this._history[this._history.length - 1]);
    return { ok: true, undone };
  }

  /**
   * 当前所有合法着点（已排除已占点、自杀、简单劫与超级劫）。
   * @returns {{x: number, y: number}[]}
   */
  getLegalMoves() {
    if (this.winner !== null) return [];
    const color = this.currentPlayer;
    const legal = [];
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        if (this.board[y][x] !== null) continue;
        if (this.koPoint !== null && this.koPoint.x === x && this.koPoint.y === y) continue;
        const placement = this._simulatePlacement(this.board, x, y, color);
        if (placement.suicide || this._positionKeys.has(placement.key)) continue;
        legal.push({ x, y });
      }
    }
    return legal;
  }

  /** 输出 docs/API.md 约定的 GameState（深拷贝，外部修改不会影响棋局）。 */
  getState() {
    return {
      size: this.size,
      board: this.board.map((row) => row.slice()),
      currentPlayer: this.currentPlayer,
      moves: this.moves.map((move) => ({ ...move })),
      captures: { ...this.captures },
      winner: this.winner,
      result: this.result === null ? null : { ...this.result },
      passCount: this.passCount,
      koPoint: this.koPoint === null ? null : { ...this.koPoint },
      lastMove: this._lastMove(),
      moveCount: this.moves.length,
      komi: this.komi,
    };
  }

  /** 深拷贝，包含盘面、着法历史、超级劫历史与悔棋快照。 */
  clone() {
    const copy = new Go9Game({ size: this.size, komi: this.komi });
    copy.board = this.board.map((row) => row.slice());
    copy.moves = this.moves.map((move) => ({ ...move }));
    copy.currentPlayer = this.currentPlayer;
    copy.captures = { ...this.captures };
    copy.passCount = this.passCount;
    copy.winner = this.winner;
    copy.result = this.result === null ? null : { ...this.result };
    copy.koPoint = this.koPoint === null ? null : { ...this.koPoint };
    copy._positionKeys = new Set(this._positionKeys);
    copy._history = this._history.map((snapshot) => cloneSnapshot(snapshot));
    return copy;
  }

  /**
   * 从着法历史重建对局（用于数据库降级回放）。
   * 遇到非法着法会停止回放并返回已重建的部分，保证始终返回可用对局。
   * @param {Array<{x:number|null, y:number|null, player?:string, pass?:boolean}>} moves
   * @param {{size?: number, komi?: number}} [options]
   */
  static replay(moves = [], options = {}) {
    const game = new Go9Game(options);
    if (!Array.isArray(moves)) return game;
    for (const move of moves) {
      if (!move || typeof move !== 'object') continue;
      if (isColor(move.player)) game.currentPlayer = move.player;
      const isPass = move.pass === true || move.x === null || move.x === undefined || move.y === null || move.y === undefined;
      const applied = isPass ? game.pass() : game.place(move.x, move.y);
      if (!applied.ok) break;
    }
    return game;
  }

  // ------------------------------------------------------------------
  // 内部实现
  // ------------------------------------------------------------------

  /**
   * 在给定盘面上模拟一手棋（不修改本对象），返回提子结果与新局面。
   * @returns {{board: Array<Array<string|null>>, capturedPositions: {x:number,y:number}[], suicide: boolean, key: string}}
   */
  _simulatePlacement(board, x, y, color) {
    const next = board.map((row) => row.slice());
    next[y][x] = color;
    const opponent = opponentOf(color);
    const capturedPositions = [];

    for (const [nx, ny] of this._neighbors(x, y)) {
      if (next[ny][nx] !== opponent) continue;
      const { stones, liberties } = this._groupAndLiberties(next, nx, ny);
      if (liberties.size > 0) continue;
      for (const stone of stones) {
        next[stone.y][stone.x] = null;
        capturedPositions.push(stone);
      }
    }

    const self = this._groupAndLiberties(next, x, y);
    return {
      board: next,
      capturedPositions,
      suicide: self.liberties.size === 0,
      key: this._boardKey(next),
    };
  }

  /** 简单劫判定：单子提单子，且落子后的己方单子只剩一个气（即被提点）。 */
  _detectKo(board, x, y, capturedPositions) {
    if (capturedPositions.length !== 1) return null;
    const self = this._groupAndLiberties(board, x, y);
    if (self.stones.length === 1 && self.liberties.size === 1) {
      const [capturedPoint] = capturedPositions;
      return { x: capturedPoint.x, y: capturedPoint.y };
    }
    return null;
  }

  /** 取得某个棋块的所有棋子与气。 */
  _groupAndLiberties(board, startX, startY) {
    const stones = [];
    const liberties = new Set();
    const color = board[startY][startX];
    if (color === null || color === undefined) return { stones, liberties };

    const visited = new Set([`${startX},${startY}`]);
    const stack = [[startX, startY]];
    while (stack.length > 0) {
      const [x, y] = stack.pop();
      stones.push({ x, y });
      for (const [nx, ny] of this._neighbors(x, y)) {
        const value = board[ny][nx];
        if (value === null) {
          liberties.add(`${nx},${ny}`);
          continue;
        }
        if (value !== color) continue;
        const key = `${nx},${ny}`;
        if (visited.has(key)) continue;
        visited.add(key);
        stack.push([nx, ny]);
      }
    }
    return { stones, liberties };
  }

  * _neighbors(x, y) {
    for (const [dx, dy] of NEIGHBOR_OFFSETS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= this.size || ny < 0 || ny >= this.size) continue;
      yield [nx, ny];
    }
  }

  _boardKey(board) {
    let key = '';
    for (const row of board) {
      for (const cell of row) {
        key += cell === BLACK ? 'b' : cell === WHITE ? 'w' : '.';
      }
      key += '/';
    }
    return key;
  }

  _lastMove() {
    const last = this.moves[this.moves.length - 1];
    if (!last) return null;
    return { x: last.x, y: last.y };
  }

  /** 中国规则数子：盘面棋子 + 单方围空；白方另加 komi。 */
  _scoreBoard() {
    let black = 0;
    let white = 0;
    const visited = new Set();

    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        const cell = this.board[y][x];
        if (cell === BLACK) {
          black += 1;
          continue;
        }
        if (cell === WHITE) {
          white += 1;
          continue;
        }
        const startKey = `${x},${y}`;
        if (visited.has(startKey)) continue;

        // 泛洪空区，统计它接触到的颜色。
        const regionSize = this._floodEmptyRegion(x, y, visited);
        if (regionSize.blackOnly) black += regionSize.size;
        else if (regionSize.whiteOnly) white += regionSize.size;
      }
    }
    return { black, white };
  }

  _floodEmptyRegion(startX, startY, visited) {
    let size = 0;
    let touchesBlack = false;
    let touchesWhite = false;
    const stack = [[startX, startY]];
    visited.add(`${startX},${startY}`);

    while (stack.length > 0) {
      const [x, y] = stack.pop();
      size += 1;
      for (const [nx, ny] of this._neighbors(x, y)) {
        const cell = this.board[ny][nx];
        if (cell === BLACK) touchesBlack = true;
        else if (cell === WHITE) touchesWhite = true;
        else {
          const key = `${nx},${ny}`;
          if (visited.has(key)) continue;
          visited.add(key);
          stack.push([nx, ny]);
        }
      }
    }
    return { size, blackOnly: touchesBlack && !touchesWhite, whiteOnly: touchesWhite && !touchesBlack };
  }

  _computeWinner() {
    const { black, white } = this._scoreBoard();
    const whiteWithKomi = white + this.komi;
    if (black > whiteWithKomi) return BLACK;
    if (whiteWithKomi > black) return WHITE;
    return 'draw';
  }

  _buildScoreResult() {
    const { black, white } = this._scoreBoard();
    const whiteWithKomi = white + this.komi;
    const winner = black > whiteWithKomi ? BLACK : whiteWithKomi > black ? WHITE : 'draw';
    return {
      method: 'score',
      black,
      white: whiteWithKomi,
      winner,
      margin: Math.abs(black - whiteWithKomi),
    };
  }

  _snapshot() {
    return {
      board: this.board.map((row) => row.slice()),
      moves: this.moves.map((move) => ({ ...move })),
      currentPlayer: this.currentPlayer,
      captures: { ...this.captures },
      passCount: this.passCount,
      winner: this.winner,
      result: this.result === null ? null : { ...this.result },
      koPoint: this.koPoint === null ? null : { ...this.koPoint },
      positionKeys: Array.from(this._positionKeys),
    };
  }

  _pushHistory() {
    this._history.push(this._snapshot());
  }

  _restore(snapshot) {
    this.board = snapshot.board.map((row) => row.slice());
    this.moves = snapshot.moves.map((move) => ({ ...move }));
    this.currentPlayer = snapshot.currentPlayer;
    this.captures = { ...snapshot.captures };
    this.passCount = snapshot.passCount;
    this.winner = snapshot.winner;
    this.result = snapshot.result === null ? null : { ...snapshot.result };
    this.koPoint = snapshot.koPoint === null ? null : { ...snapshot.koPoint };
    this._positionKeys = new Set(snapshot.positionKeys);
  }
}

function createEmptyBoard(size) {
  return Array.from({ length: size }, () => Array(size).fill(null));
}

function cloneSnapshot(snapshot) {
  return {
    board: snapshot.board.map((row) => row.slice()),
    moves: snapshot.moves.map((move) => ({ ...move })),
    currentPlayer: snapshot.currentPlayer,
    captures: { ...snapshot.captures },
    passCount: snapshot.passCount,
    winner: snapshot.winner,
    result: snapshot.result === null ? null : { ...snapshot.result },
    koPoint: snapshot.koPoint === null ? null : { ...snapshot.koPoint },
    positionKeys: snapshot.positionKeys.slice(),
  };
}

module.exports = Go9Game;
