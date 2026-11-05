'use strict';

/**
 * 内置 AI：MCTS（蒙特卡洛树搜索）+ 静态启发式评分。
 *
 * - getMove：优先用 MCTS 搜索（easy/medium/hard 对应不同模拟次数），
 *   MCTS 异常或无法给出着点时回退到原来的静态启发式 getMove。
 * - scoreMoves：继承自 HeuristicGoAgent 的确定性静态评分，复盘分析继续使用它
 *   （复盘需要快速、可复现的评分，不需要 MCTS）。
 */

const HeuristicGoAgent = require('./heuristicGoAgent');
const { MctsGoAgent } = require('./mctsAgent');
const { PythonGoAgent } = require('./pythonAgent');

const BOARD_SIZE = 9;

/** 中国规则数子（棋子 + 单方围空，白加 komi），返回 { black, white }。 */
function areaScore(board, size, komi) {
  const visited = new Set();
  const neighbors = (x, y) => {
    const list = [];
    if (x > 0) list.push([x - 1, y]);
    if (x < size - 1) list.push([x + 1, y]);
    if (y > 0) list.push([x, y - 1]);
    if (y < size - 1) list.push([x, y + 1]);
    return list;
  };

  let black = 0;
  let white = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const cell = board[y][x];
      if (cell === 'black') {
        black += 1;
        continue;
      }
      if (cell === 'white') {
        white += 1;
        continue;
      }
      const key = `${x},${y}`;
      if (visited.has(key)) continue;

      const stack = [[x, y]];
      visited.add(key);
      let regionSize = 0;
      let touchesBlack = false;
      let touchesWhite = false;
      while (stack.length > 0) {
        const [cx, cy] = stack.pop();
        regionSize += 1;
        for (const [nx, ny] of neighbors(cx, cy)) {
          const value = board[ny][nx];
          if (value === 'black') touchesBlack = true;
          else if (value === 'white') touchesWhite = true;
          else {
            const nk = `${nx},${ny}`;
            if (!visited.has(nk)) {
              visited.add(nk);
              stack.push([nx, ny]);
            }
          }
        }
      }
      if (touchesBlack && !touchesWhite) black += regionSize;
      else if (touchesWhite && !touchesBlack) white += regionSize;
    }
  }
  return { black, white: white + komi };
}

function advantageOf(board, color, size, komi) {
  const { black, white } = areaScore(board, size, komi);
  return color === 'black' ? black - white : white - black;
}

class BuiltinGoAgent extends HeuristicGoAgent {
  /**
   * @param {{ seed?: number, size?: number, komi?: number, playouts?: Record<string, number> }} [options]
   */
  constructor({ seed, size, komi, playouts } = {}) {
    super({ seed });
    this.mcts = new MctsGoAgent({ seed: this.seed, size: size || 9, komi: komi || 7.5, playouts });
    this.lastStats = null;
    this.lastDecision = null;
  }

  /**
   * 终局判断：对方刚 pass 且我方 pass 后会赢 → 结束对局；
   * 官子阶段（空点很少）且没有任何一手能提高己方数子优势、当前又不落后 → pass，避免无意义填子。
   */
  shouldPass(game, state) {
    const size = state.size || BOARD_SIZE;
    const komi = typeof state.komi === 'number' ? state.komi : 7.5;
    const color = state.currentPlayer;

    if (state.passCount >= 1) {
      const probe = game.clone();
      const result = probe.pass();
      if (result.ok && probe.winner === color) return '对方已停一手，pass 可直接以胜利结束对局';
    }

    let emptyCount = 0;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (!state.board[y][x]) emptyCount += 1;
      }
    }
    if (emptyCount > 10) return null;

    const before = advantageOf(state.board, color, size, komi);
    if (before < 0) return null; // 落后时继续下，期待对手失误

    const legal = game.getLegalMoves();
    let bestGain = -Infinity;
    for (const move of legal) {
      const probe = game.clone();
      if (!probe.place(move.x, move.y).ok) continue;
      const afterState = probe.getState();
      const after = advantageOf(afterState.board, color, size, komi);
      bestGain = Math.max(bestGain, after - before);
    }
    if (bestGain <= 0.5) return '官子已定，继续落子不会提高己方数子优势';
    return null;
  }

  async getMove(game, { difficulty = 'medium' } = {}) {
    try {
      const state = game.getState();
      if (state.winner !== null && state.winner !== undefined) return null;

      const passReason = this.shouldPass(game, state);
      if (passReason) {
        this.lastStats = { difficulty, playouts: 0, elapsedMs: 0, visits: 0, winRate: null };
        this.lastDecision = 'pass';
        return null;
      }
      this.lastDecision = 'move';

      // 静态评分作为根节点先验，引导 MCTS 在有限模拟量下优先搜索合理着点。
      let priors = null;
      try {
        priors = this.scoreMoves(game, { noise: false });
      } catch {
        priors = null;
      }
      const move = await this.mcts.getMove(game, { difficulty, priors });
      this.lastStats = this.mcts.lastStats;
      return move;
    } catch {
      // MCTS 出错时退回静态启发式，保证 AI 永远能出招。
      return super.getMove(game, { difficulty });
    }
  }
}

module.exports = BuiltinGoAgent;

/**
 * 内置 AI 的默认实现：优先调用本地 Python AI（server/ai/go_ai.py），
 * Python 不可用或调用失败时自动回退到 JS 内置 MCTS，保证永远能出招。
 */
class BuiltinWithPython extends BuiltinGoAgent {
  constructor({ env = process.env, seed, size, komi, playouts } = {}) {
    super({ seed, size, komi, playouts });
    this.python = PythonGoAgent.isAvailable(env) ? new PythonGoAgent({ env, seed: this.seed }) : null;
    this.backend = this.python ? 'python' : 'js';
    this.lastPythonError = null;
  }

  async getMove(game, { difficulty = 'medium' } = {}) {
    if (this.python) {
      try {
        const move = await this.python.getMove(game, { difficulty });
        this.backend = 'python';
        if (this.python.lastStats) this.lastStats = { ...this.python.lastStats, backend: 'python' };
        return move;
      } catch (error) {
        this.lastPythonError = error instanceof Error ? error.message : String(error);
        this.backend = 'js';
      }
    }
    const move = await super.getMove(game, { difficulty });
    if (this.lastStats) this.lastStats = { ...this.lastStats, backend: 'js' };
    return move;
  }
}

function createBuiltinAgent(options = {}) {
  return new BuiltinWithPython(options);
}

module.exports.createBuiltinAgent = createBuiltinAgent;
module.exports.BuiltinWithPython = BuiltinWithPython;
