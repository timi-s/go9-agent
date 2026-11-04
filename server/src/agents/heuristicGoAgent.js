'use strict';

/**
 * 启发式 9 路围棋 AI。
 *
 * 设计目标：
 * - 从不返回非法着点（候选点来自 Go9Game#getLegalMoves，已排除自杀/劫/超级劫）。
 * - 评分综合考虑：提子、救回被打吃的己方棋块、打吃对方、避免自陷打吃、
 *   避免填自己的真眼、布局偏好（三/四线、中心）以及少量随机扰动。
 * - difficulty：
 *   - easy：从评分前 10 名中随机挑一个，另有 30% 概率全盘随机合法点；
 *   - medium：直接选评分最高点；
 *   - hard：在评分前 6 名基础上追加一轮对手立即提子的威胁检查。
 *
 * 返回 null 表示建议 pass（无合法着点或对局已结束）。
 */

const DIFFICULTIES = new Set(['easy', 'medium', 'hard']);

const NEIGHBOR_OFFSETS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const DIAGONAL_OFFSETS = [
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

// 评分权重（经简单手调，保证“提子/救棋”显著高于布局偏好）。
const CAPTURE_WEIGHT = 60; // 每提一子
const LIBERTY_WEIGHT = 2; // 每口己方气（上限 4 口）
const SELF_ATARI_PENALTY = 55; // 落子后己方棋块只剩 1 口气
const SAVED_STONE_WEIGHT = 14; // 每救回一子
const ATARI_GROUP_WEIGHT = 10; // 打吃对方一个棋块
const ATARI_STONE_WEIGHT = 2; // 被打吃棋块的每颗子
const EYE_PENALTY = 70; // 填自己的真眼
const THREAT_WEIGHT = 70; // hard：对手可立即提掉的己方棋子数折算

function opponentOf(color) {
  return color === 'black' ? 'white' : 'black';
}

function createRandom(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function* neighborsOf(size, x, y) {
  for (const [dx, dy] of NEIGHBOR_OFFSETS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || nx >= size || ny < 0 || ny >= size) continue;
    yield [nx, ny];
  }
}

class HeuristicGoAgent {
  /**
   * @param {{ seed?: number }} [options]
   */
  constructor({ seed } = {}) {
    this.seed = Number.isFinite(seed) ? Math.floor(seed) >>> 0 : Math.floor(Math.random() * 0xffffffff);
    this._random = createRandom(this.seed);
  }

  /**
   * 计算下一手（内部带随机扰动，避免每局完全相同）。
   * @param {import('../games/go9')} game 进行中的对局（不会被修改）
   * @param {{ difficulty?: 'easy'|'medium'|'hard' }} [options]
   * @returns {Promise<{x: number, y: number} | null>} null 表示建议 pass
   */
  async getMove(game, { difficulty = 'medium' } = {}) {
    const scored = this.scoreMoves(game, { noise: true });
    if (scored.length === 0) return null;

    const mode = DIFFICULTIES.has(difficulty) ? difficulty : 'medium';
    if (mode === 'easy') return this._pickEasy(scored);
    if (mode === 'hard') {
      const state = game.getState();
      return this._pickHard(scored, this._createContext(state));
    }
    return { x: scored[0].x, y: scored[0].y };
  }

  /**
   * 给所有合法着点打分（按 score 降序）。供复盘评分等需要确定性的场景使用。
   * - 只包含 game.getLegalMoves() 返回的合法点；不修改 game。
   * - noise=false（默认）时结果完全确定；noise=true 时叠加随机扰动（getMove 内部使用）。
   * @param {import('../games/go9')} game
   * @param {{ noise?: boolean }} [options]
   * @returns {{x: number, y: number, score: number}[]}
   */
  scoreMoves(game, { noise = false } = {}) {
    if (!game || typeof game.getState !== 'function' || typeof game.getLegalMoves !== 'function') return [];

    const state = game.getState();
    if (state.winner !== null) return [];

    const legalMoves = game.getLegalMoves();
    if (!Array.isArray(legalMoves) || legalMoves.length === 0) return [];

    const context = this._createContext(state);
    const scored = legalMoves.map((move) => ({
      x: move.x,
      y: move.y,
      score: this._scoreMove(context, move, noise),
    }));
    // 同分时按 y/x 兜底排序，保证 noise=false 时结果可复现。
    scored.sort((left, right) => right.score - left.score || left.y - right.y || left.x - right.x);
    return scored;
  }

  _createContext(state) {
    const context = {
      board: state.board,
      size: state.size,
      me: state.currentPlayer,
      moveCount: state.moves.length,
      opponentAtariScore: 0,
    };
    context.opponentAtariScore = this._atariScore(context.board, context.size, opponentOf(context.me));
    return context;
  }

  // ------------------------------------------------------------------
  // 评分
  // ------------------------------------------------------------------

  _scoreMove(context, move, noise = false) {
    const { board, size, me, moveCount, opponentAtariScore } = context;
    const opponent = opponentOf(me);
    const simulated = this._simulate(board, size, move.x, move.y, me);

    let score = simulated.captured * CAPTURE_WEIGHT;

    // 落子后己方棋块的气：气越多越安全；只剩一口气且没有提子则重罚。
    const ownGroup = this._groupInfo(simulated.board, size, move.x, move.y);
    score += Math.min(ownGroup.liberties.size, 4) * LIBERTY_WEIGHT;
    if (ownGroup.liberties.size === 1 && simulated.captured === 0) {
      score -= SELF_ATARI_PENALTY;
    }

    // 救回相邻的、只剩一口气的己方棋块。
    const visited = new Set();
    for (const [nx, ny] of neighborsOf(size, move.x, move.y)) {
      if (board[ny][nx] !== me) continue;
      const stoneKey = `${nx},${ny}`;
      if (visited.has(stoneKey)) continue;
      const before = this._groupInfo(board, size, nx, ny);
      for (const stone of before.stones) visited.add(`${stone.x},${stone.y}`);
      if (before.liberties.size !== 1) continue;
      const after = this._groupInfo(simulated.board, size, nx, ny);
      if (after.liberties.size >= 2) {
        score += before.stones.length * SAVED_STONE_WEIGHT;
      }
    }

    // 打吃对方：只奖励本手新造成的打吃，避免所有候选点同分。
    score += this._atariScore(simulated.board, size, opponent) - opponentAtariScore;

    // 不填自己的真眼。
    if (this._isOwnEye(board, size, move.x, move.y, me)) score -= EYE_PENALTY;

    // 布局/邻近偏好。
    score += this._positionScore(board, size, moveCount, move);

    // 随机扰动：仅 noise=true（getMove）时启用，保证 scoreMoves 默认确定。
    if (noise) score += (this._random() - 0.5) * 6;
    return score;
  }

  /** 统计某色处于被打吃状态（仅剩 1 口气）的棋块的分数。 */
  _atariScore(board, size, color) {
    let score = 0;
    const visited = new Set();
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (board[y][x] !== color) continue;
        const stoneKey = `${x},${y}`;
        if (visited.has(stoneKey)) continue;
        const group = this._groupInfo(board, size, x, y);
        for (const stone of group.stones) visited.add(`${stone.x},${stone.y}`);
        if (group.liberties.size === 1) {
          score += ATARI_GROUP_WEIGHT + group.stones.length * ATARI_STONE_WEIGHT;
        }
      }
    }
    return score;
  }

  /** 自己的真眼：四邻都是己方/边界，且所有盘内对角点也都是己方。 */
  _isOwnEye(board, size, x, y, color) {
    for (const [nx, ny] of neighborsOf(size, x, y)) {
      if (board[ny][nx] !== color) return false;
    }
    for (const [dx, dy] of DIAGONAL_OFFSETS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= size || ny < 0 || ny >= size) continue;
      if (board[ny][nx] !== color) return false;
    }
    return true;
  }

  /** 布局偏好：三/四线、中心、靠近已有棋子；开局权重大，中后盘衰减。 */
  _positionScore(board, size, moveCount, move) {
    const edgeDistance = Math.min(move.x, move.y, size - 1 - move.x, size - 1 - move.y);
    let lineScore;
    if (edgeDistance === 0) lineScore = -14; // 一线
    else if (edgeDistance === 1) lineScore = -5; // 二线
    else if (edgeDistance === 2) lineScore = 8; // 三线
    else if (edgeDistance === 3) lineScore = 7; // 四线
    else lineScore = 3; // 中腹

    const openingFactor = Math.max(0, 1 - moveCount / 30);
    let score = lineScore * (0.35 + 0.65 * openingFactor);

    const center = (size - 1) / 2;
    const centerDistance = Math.abs(move.x - center) + Math.abs(move.y - center);
    score += Math.max(0, 5 - centerDistance) * 0.6 * (0.3 + openingFactor * 0.7);

    let nearest = Infinity;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (board[y][x] === null) continue;
        const distance = Math.abs(x - move.x) + Math.abs(y - move.y);
        if (distance < nearest) nearest = distance;
      }
    }
    if (nearest === 1) score += 3;
    else if (nearest === 2) score += 2;
    else if (nearest === 3) score += 0.5;

    return score;
  }

  // ------------------------------------------------------------------
  // 难度策略
  // ------------------------------------------------------------------

  _pickEasy(scored) {
    if (this._random() < 0.3) {
      const index = Math.floor(this._random() * scored.length);
      return { x: scored[index].x, y: scored[index].y };
    }
    const poolSize = Math.min(10, scored.length);
    const index = Math.floor(this._random() * poolSize);
    return { x: scored[index].x, y: scored[index].y };
  }

  _pickHard(scored, context) {
    const { board, size, me } = context;
    const poolSize = Math.min(6, scored.length);
    let best = null;
    for (let i = 0; i < poolSize; i += 1) {
      const candidate = scored[i];
      const simulated = this._simulate(board, size, candidate.x, candidate.y, me);
      const koPoint = this._koPointOf(simulated, size, candidate, me);
      const threat = this._opponentBestCapture(simulated.board, size, me, koPoint);
      const adjusted = candidate.score - threat * THREAT_WEIGHT;
      if (best === null || adjusted > best.score) {
        best = { x: candidate.x, y: candidate.y, score: adjusted };
      }
    }
    return { x: best.x, y: best.y };
  }

  /** 该手若形成简单劫，返回劫点（对手下一手不能立即提回）。 */
  _koPointOf(simulated, size, move, me) {
    if (simulated.captured !== 1 || simulated.capturedPositions.length !== 1) return null;
    const self = this._groupInfo(simulated.board, size, move.x, move.y);
    if (self.stones.length === 1 && self.liberties.size === 1) {
      const [capturedPoint] = simulated.capturedPositions;
      return { x: capturedPoint.x, y: capturedPoint.y };
    }
    return null;
  }

  /**
   * hard 用：模拟对手应手，返回对手下一手最多能直接提掉多少颗我方棋子。
   * 即找出所有只剩一口气的我方棋块中最大的一块；刚好是劫点的那口气除外
   * （对手不能立即提回，否则就误判成必死）。
   */
  _opponentBestCapture(board, size, me, koPoint = null) {
    let worst = 0;
    const visited = new Set();
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (board[y][x] !== me) continue;
        const stoneKey = `${x},${y}`;
        if (visited.has(stoneKey)) continue;
        const group = this._groupInfo(board, size, x, y);
        for (const stone of group.stones) visited.add(`${stone.x},${stone.y}`);
        if (group.liberties.size !== 1) continue;
        const [liberty] = group.liberties;
        const [libertyX, libertyY] = liberty.split(',').map(Number);
        if (koPoint !== null && koPoint.x === libertyX && koPoint.y === libertyY) continue;
        worst = Math.max(worst, group.stones.length);
      }
    }
    return worst;
  }

  // ------------------------------------------------------------------
  // 盘面工具
  // ------------------------------------------------------------------

  /** 在给定盘面上落子并提掉无气的对方棋块（假定落点为空）。 */
  _simulate(board, size, x, y, color) {
    const next = board.map((row) => row.slice());
    next[y][x] = color;
    const opponent = opponentOf(color);
    const capturedPositions = [];

    for (const [nx, ny] of neighborsOf(size, x, y)) {
      if (next[ny][nx] !== opponent) continue;
      const group = this._groupInfo(next, size, nx, ny);
      if (group.liberties.size > 0) continue;
      for (const stone of group.stones) {
        next[stone.y][stone.x] = null;
        capturedPositions.push(stone);
      }
    }
    return { board: next, captured: capturedPositions.length, capturedPositions };
  }

  /** 返回某点所在棋块的棋子列表与气（坐标字符串集合）。 */
  _groupInfo(board, size, startX, startY) {
    const stones = [];
    const liberties = new Set();
    const color = board[startY][startX];
    if (color === null || color === undefined) return { stones, liberties };

    const visited = new Set([`${startX},${startY}`]);
    const stack = [[startX, startY]];
    while (stack.length > 0) {
      const [x, y] = stack.pop();
      stones.push({ x, y });
      for (const [nx, ny] of neighborsOf(size, x, y)) {
        const cell = board[ny][nx];
        if (cell === null) {
          liberties.add(`${nx},${ny}`);
          continue;
        }
        if (cell !== color) continue;
        const key = `${nx},${ny}`;
        if (visited.has(key)) continue;
        visited.add(key);
        stack.push([nx, ny]);
      }
    }
    return { stones, liberties };
  }
}

module.exports = HeuristicGoAgent;
