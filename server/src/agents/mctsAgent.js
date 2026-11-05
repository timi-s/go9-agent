'use strict';

/**
 * 本地内置 AI 的 MCTS（蒙特卡洛树搜索）引擎。
 *
 * 相比原来的纯静态启发式评分，MCTS 通过大量随机对局模拟来评估着点，
 * 能自然发现提子、做活、围空等战术，棋力明显更强（见 scripts/benchmark-ai.js）。
 *
 * 设计要点：
 * - 独立的轻量棋盘（Int8Array + 气/提子/简单劫），不做超级劫历史，保证模拟速度；
 *   最终选出的着点仍由调用方用真实规则引擎校验（registry / gameStore）。
 * - UCT 选择；每个节点保存一份 81 字节盘面快照，避免回放路径。
 * - 随机落子模拟（rollout）到双方连续 pass 或 2*N 步，按中国规则数子（白贴 komi）判胜负。
 * - 以「固定模拟次数」作为预算（easy/medium/hard），因此给定随机种子时结果可复现，
 *   便于测试；可用 BUILTIN_AI_MAX_MS 设置时间上限作为保险。
 */

const DEFAULT_KOMI = 7.5;
const DEFAULT_SIZE = 9;

const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;

const DIFFICULTY_PLAYOUTS = {
  easy: 400,
  medium: 1500,
  hard: 5000,
};

const UCT_C = 1.05;
const PUCT_C = 2.0;
// 9 路随机对局通常 60-120 手结束；限制模拟步数可显著提高单位时间模拟量。
const MAX_PLAYOUT_MOVES = 130;

/** 预计算 9 路（以及通用 size）邻居表。 */
const neighborCache = new Map();
function neighborsFor(size) {
  if (neighborCache.has(size)) return neighborCache.get(size);
  const result = new Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const idx = y * size + x;
      const list = [];
      if (x > 0) list.push(idx - 1);
      if (x < size - 1) list.push(idx + 1);
      if (y > 0) list.push(idx - size);
      if (y < size - 1) list.push(idx + size);
      result[idx] = list;
    }
  }
  neighborCache.set(size, result);
  return result;
}

/** 可复现的伪随机数（mulberry32）。 */
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

function hashPosition(cells, ko, toMove) {
  let hash = 2166136261 ^ toMove;
  for (let i = 0; i < cells.length; i += 1) {
    hash ^= cells[i] + i;
    hash = Math.imul(hash, 16777619);
  }
  hash ^= ko + 1;
  return hash >>> 0;
}

/** 轻量棋盘：只实现落子/提子/简单劫/停一手/数子，供 MCTS 内部模拟使用。 */
class FastBoard {
  constructor(size = DEFAULT_SIZE, komi = DEFAULT_KOMI) {
    this.size = size;
    this.n = size * size;
    this.komi = komi;
    this.cells = new Int8Array(this.n);
    this.ko = -1;
    this.toMove = BLACK;
    this.passCount = 0;
    this.neighbors = neighborsFor(size);

    this._mark = new Int32Array(this.n);
    this._libSeen = new Int32Array(this.n);
    this._stack = new Int32Array(this.n);
    this._group = new Int32Array(this.n);
    this._captured = new Int32Array(this.n);
    this._visited = new Int32Array(this.n);
    this._gen = 0;
  }

  loadFrom(other) {
    this.cells.set(other.cells);
    this.ko = other.ko;
    this.toMove = other.toMove;
    this.passCount = other.passCount;
  }

  /** 收集 idx 所在棋块，写入 this._group，返回 { count, liberties }。 */
  collect(idx) {
    const color = this.cells[idx];
    this._gen += 1;
    const gen = this._gen;
    const mark = this._mark;
    const libSeen = this._libSeen;
    const stack = this._stack;
    const group = this._group;
    const cells = this.cells;
    let sp = 0;
    let gc = 0;
    let libs = 0;
    mark[idx] = gen;
    stack[sp++] = idx;
    while (sp > 0) {
      const current = stack[--sp];
      group[gc++] = current;
      const nbs = this.neighbors[current];
      for (let k = 0; k < nbs.length; k += 1) {
        const nb = nbs[k];
        const v = cells[nb];
        if (v === EMPTY) {
          if (libSeen[nb] !== gen) {
            libSeen[nb] = gen;
            libs += 1;
          }
        } else if (v === color && mark[nb] !== gen) {
          mark[nb] = gen;
          stack[sp++] = nb;
        }
      }
    }
    return { count: gc, liberties: libs };
  }

  isLegal(idx, color) {
    const cells = this.cells;
    if (cells[idx] !== EMPTY) return false;
    if (idx === this.ko) return false;
    const nbs = this.neighbors[idx];
    for (let k = 0; k < nbs.length; k += 1) {
      if (cells[nbs[k]] === EMPTY) return true;
    }
    for (let k = 0; k < nbs.length; k += 1) {
      const nb = nbs[k];
      const v = cells[nb];
      if (v === EMPTY) continue;
      const info = this.collect(nb);
      if (v === color) {
        if (info.liberties > 1) return true;
      } else if (info.liberties === 1) {
        return true;
      }
    }
    return false;
  }

  play(idx) {
    const color = this.toMove;
    const opponent = color === BLACK ? WHITE : BLACK;
    const cells = this.cells;
    const nbs = this.neighbors[idx];
    cells[idx] = color;

    let capturedCount = 0;
    let capturedIdx = -1;
    for (let k = 0; k < nbs.length; k += 1) {
      const nb = nbs[k];
      if (cells[nb] !== opponent) continue;
      const info = this.collect(nb);
      if (info.liberties !== 0) continue;
      for (let g = 0; g < info.count; g += 1) {
        const stone = this._group[g];
        cells[stone] = EMPTY;
        capturedCount += 1;
        if (capturedCount === 1) capturedIdx = stone;
      }
    }

    let nextKo = -1;
    if (capturedCount === 1) {
      const own = this.collect(idx);
      if (own.count === 1 && own.liberties === 1) nextKo = capturedIdx;
    }
    this.ko = nextKo;
    this.toMove = opponent;
    this.passCount = 0;
    return capturedCount;
  }

  pass() {
    this.ko = -1;
    this.passCount += 1;
    this.toMove = this.toMove === BLACK ? WHITE : BLACK;
  }

  isTerminal() {
    return this.passCount >= 2;
  }

  /** 中国规则数子：棋子 + 单方围空，白加 komi；返回 { black, white, winner }。 */
  score() {
    const cells = this.cells;
    const size = this.size;
    let black = 0;
    let white = 0;
    const visited = this._visited;
    this._gen += 1;
    const gen = this._gen;

    for (let idx = 0; idx < this.n; idx += 1) {
      const v = cells[idx];
      if (v === BLACK) {
        black += 1;
        continue;
      }
      if (v === WHITE) {
        white += 1;
        continue;
      }
      if (visited[idx] === gen) continue;

      // 泛洪空区，判断它只接触哪一方。
      let regionSize = 0;
      let touchesBlack = false;
      let touchesWhite = false;
      const stack = this._stack;
      let sp = 0;
      stack[sp++] = idx;
      visited[idx] = gen;
      while (sp > 0) {
        const current = stack[--sp];
        regionSize += 1;
        const nbs = this.neighbors[current];
        for (let k = 0; k < nbs.length; k += 1) {
          const nb = nbs[k];
          const nv = cells[nb];
          if (nv === BLACK) touchesBlack = true;
          else if (nv === WHITE) touchesWhite = true;
          else if (visited[nb] !== gen) {
            visited[nb] = gen;
            stack[sp++] = nb;
          }
        }
      }
      if (touchesBlack && !touchesWhite) black += regionSize;
      else if (touchesWhite && !touchesBlack) white += regionSize;
    }

    const whiteTotal = white + this.komi;
    const winner = black > whiteTotal ? BLACK : whiteTotal > black ? WHITE : EMPTY;
    return { black, white: whiteTotal, winner };
  }

  winnerColor() {
    return this.score().winner;
  }

  /** 随机落子模拟到终局（或达到步数上限），返回胜方颜色（EMPTY 表示和棋）。 */
  rollout(random, maxMoves = MAX_PLAYOUT_MOVES) {
    const limit = this.n * 2 < maxMoves ? this.n * 2 : maxMoves;
    let lastMove = -1;
    for (let step = 0; step < limit; step += 1) {
      if (this.passCount >= 2) return this.winnerColor();
      const move = this.randomLegalMove(random, lastMove);
      if (move < 0) this.pass();
      else {
        this.play(move);
        lastMove = move;
      }
    }
    return this.winnerColor();
  }

  /** 真眼：四邻都是己方或边界，且所有盘内对角点也是己方。 */
  isEye(idx, color) {
    const nbs = this.neighbors[idx];
    for (let k = 0; k < nbs.length; k += 1) {
      if (this.cells[nbs[k]] !== color) return false;
    }
    const size = this.size;
    const x = idx % size;
    const y = (idx / size) | 0;
    for (let dy = -1; dy <= 1; dy += 2) {
      for (let dx = -1; dx <= 1; dx += 2) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= size || ny < 0 || ny >= size) continue;
        if (this.cells[ny * size + nx] !== color) return false;
      }
    }
    return true;
  }

  randomLegalMove(random, lastMove = -1) {
    const cells = this.cells;
    const color = this.toMove;
    const n = this.n;
    // 局部响应：50% 概率优先尝试上一手附近，模拟更接近真实棋形。
    if (lastMove >= 0 && random() < 0.5) {
      const nbs = this.neighbors[lastMove];
      const start = (random() * nbs.length) | 0;
      for (let k = 0; k < nbs.length; k += 1) {
        const idx = nbs[(start + k) % nbs.length];
        if (cells[idx] === EMPTY && !this.isEye(idx, color) && this.isLegal(idx, color)) return idx;
      }
    }
    // 先做少量拒绝采样（盘中空点较多时命中率高）。
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const idx = (random() * n) | 0;
      if (cells[idx] !== EMPTY || this.isEye(idx, color)) continue;
      if (this.isLegal(idx, color)) return idx;
    }
    const start = (random() * n) | 0;
    for (let k = 0; k < n; k += 1) {
      const idx = (start + k) % n;
      if (cells[idx] === EMPTY && !this.isEye(idx, color) && this.isLegal(idx, color)) return idx;
    }
    return -1;
  }

  legalMoves() {
    const moves = [];
    for (let idx = 0; idx < this.n; idx += 1) {
      if (this.cells[idx] === EMPTY && this.isLegal(idx, this.toMove)) moves.push(idx);
    }
    return moves;
  }
}

function makeNode(parent, mover, move, board) {
  return {
    parent,
    mover,
    move,
    cells: board.cells.slice(),
    ko: board.ko,
    toMove: board.toMove,
    passCount: board.passCount,
    children: [],
    untried: null,
    visits: 0,
    wins: 0,
  };
}

class MctsGoAgent {
  /**
   * @param {{ seed?: number, size?: number, komi?: number, playouts?: Record<string, number> }} [options]
   */
  constructor({ seed, size = DEFAULT_SIZE, komi = DEFAULT_KOMI, playouts } = {}) {
    this.seed = Number.isFinite(seed) ? Math.floor(seed) >>> 0 : Math.floor(Math.random() * 0xffffffff);
    this.size = size;
    this.komi = komi;
    this.playouts = { ...DIFFICULTY_PLAYOUTS, ...(playouts || {}) };
    this.timeLimitMs = Number(process.env.BUILTIN_AI_MAX_MS) || 0;
    this.lastStats = null;
  }

  /**
   * @param {object} game 真实对局（只读取状态，不修改）
   * @param {{ difficulty?: 'easy'|'medium'|'hard', priors?: {x:number,y:number,score:number}[] }} [options]
   *        priors 为可选的先验着点分数（来自静态启发式评分），用于 PUCT 引导搜索。
   * @returns {Promise<{x:number,y:number}|null>}
   */
  async getMove(game, { difficulty = 'medium', priors } = {}) {
    if (!game || typeof game.getState !== 'function' || typeof game.getLegalMoves !== 'function') return null;

    const state = game.getState();
    if (state.winner !== null && state.winner !== undefined) return null;

    const legal = game.getLegalMoves();
    if (!Array.isArray(legal) || legal.length === 0) return null;

    const board = new FastBoard(this.size, state.komi === undefined ? this.komi : state.komi);
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        const cell = state.board[y] && state.board[y][x];
        if (cell === 'black') board.cells[y * this.size + x] = BLACK;
        else if (cell === 'white') board.cells[y * this.size + x] = WHITE;
      }
    }
    board.toMove = state.currentPlayer === 'white' ? WHITE : BLACK;
    board.ko = state.koPoint ? state.koPoint.y * this.size + state.koPoint.x : -1;
    board.passCount = state.passCount || 0;

    const level = Object.prototype.hasOwnProperty.call(this.playouts, difficulty) ? difficulty : 'medium';
    const budget = Math.max(1, Math.floor(this.playouts[level]));
    const random = createRandom((this.seed ^ hashPosition(board.cells, board.ko, board.toMove)) >>> 0);

    // 先验分布（静态评分的 softmax），用于根节点 PUCT；缺失时退化为普通 UCT。
    this._priorMap = buildPriorMap(priors, legal, this.size);
    const started = Date.now();
    const root = makeNode(null, 0, -1, board);
    root.isRoot = true;
    const work = new FastBoard(this.size, board.komi);
    work.komi = board.komi;

    let playoutCount = 0;
    for (let i = 0; i < budget; i += 1) {
      if (this.timeLimitMs > 0 && Date.now() - started >= this.timeLimitMs) break;

      work.loadFrom(root);
      let node = root;

      // 选择：一直走到还有未尝试着点的节点。
      while (node.untried !== null && node.untried.length === 0) {
        if (node.children.length === 0) break;
        node = this._select(node);
        work.loadFrom(node);
      }

      if (node.untried === null) node.untried = shuffle(work.legalMoves(), random);

      if (node.untried.length > 0) {
        const idx = node.untried.pop();
        work.loadFrom(node);
        work.play(idx);
        const child = makeNode(node, node.toMove, idx, work);
        if (node.isRoot && this._priorMap) child.prior = this._priorMap.get(idx) || 1e-6;
        node.children.push(child);
        node = child;
      }

      const winner = work.isTerminal() ? work.winnerColor() : work.rollout(random);
      playoutCount += 1;
      this._backpropagate(node, winner);
    }

    // 选择访问次数最多的着点（更稳健）。
    let best = null;
    for (const child of root.children) {
      if (best === null || child.visits > best.visits || (child.visits === best.visits && child.wins > best.wins)) {
        best = child;
      }
    }

    const elapsedMs = Date.now() - started;
    this.lastStats = {
      difficulty: level,
      playouts: playoutCount,
      elapsedMs,
      visits: best ? best.visits : 0,
      winRate: best && best.visits > 0 ? Math.round((best.wins / best.visits) * 1000) / 1000 : null,
    };
    this._priorMap = null;

    if (!best) return null;
    const x = best.move % this.size;
    const y = Math.floor(best.move / this.size);
    // 最后再用真实规则引擎校验一次（极端情况下 MCTS 的简化盘面可能与引擎有差异）。
    const ok = legal.some((move) => move.x === x && move.y === y);
    if (!ok) {
      return legal[Math.floor(random() * legal.length)];
    }
    return { x, y };
  }

  _select(node) {
    if (node.isRoot && this._priorMap) {
      // PUCT：Q + c * P * sqrt(N) / (1 + n)
      const sqrtParent = Math.sqrt(node.visits || 1);
      let best = null;
      let bestScore = -Infinity;
      for (const child of node.children) {
        if (child.visits === 0) return child;
        const q = child.wins / child.visits;
        const u = (PUCT_C * (child.prior || 0) * sqrtParent) / (1 + child.visits);
        const score = q + u;
        if (score > bestScore) {
          bestScore = score;
          best = child;
        }
      }
      return best;
    }

    const logVisits = Math.log(node.visits || 1);
    let best = null;
    let bestScore = -Infinity;
    for (const child of node.children) {
      const score =
        child.visits === 0
          ? Infinity
          : child.wins / child.visits + UCT_C * Math.sqrt(logVisits / child.visits);
      if (score > bestScore) {
        bestScore = score;
        best = child;
      }
    }
    return best;
  }

  _backpropagate(node, winner) {
    for (let current = node; current !== null; current = current.parent) {
      current.visits += 1;
      if (current.mover !== 0 && current.mover === winner) current.wins += 1;
    }
  }
}

function shuffle(list, random) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = (random() * (i + 1)) | 0;
    const tmp = list[i];
    list[i] = list[j];
    list[j] = tmp;
  }
  return list;
}

/**
 * 把静态评分转换成根节点的先验概率（softmax，温度 20）。
 * 只保留合法着点；缺失时返回 null，退化为普通 UCT。
 */
function buildPriorMap(priors, legalMoves, size) {
  if (!Array.isArray(priors) || priors.length === 0) return null;
  const legal = new Set(legalMoves.map((move) => move.y * size + move.x));
  const usable = priors.filter(
    (item) => item && Number.isFinite(item.score) && legal.has(item.y * size + item.x),
  );
  if (usable.length === 0) return null;

  let max = -Infinity;
  for (const item of usable) max = Math.max(max, item.score);

  let total = 0;
  const weights = new Map();
  for (const item of usable) {
    const weight = Math.exp((item.score - max) / 20);
    weights.set(item.y * size + item.x, weight);
    total += weight;
  }
  if (!(total > 0)) return null;

  const map = new Map();
  for (const [idx, weight] of weights) map.set(idx, weight / total);
  // 未出现在先验里的合法点给极小概率，保证仍会被探索到。
  for (const idx of legal) if (!map.has(idx)) map.set(idx, 1e-6);
  return map;
}

module.exports = {
  MctsGoAgent,
  FastBoard,
  DIFFICULTY_PLAYOUTS,
  DEFAULT_KOMI,
};
