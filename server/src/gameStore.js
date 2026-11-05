'use strict';

/**
 * 内存对局管理 + Prisma 持久化 + 回放重建。
 *
 * 设计要点：
 * - 活跃对局保存在 Map（LRU，最多 20 局）；落子/pass/resign/undo/ai-move 后
 *   best-effort 写库，数据库不可用时不影响对局。
 * - GET /api/games/:id 内存缺失时从 DB 的 moveHistory 回放重建（Go9Game.replay）。
 * - AI 走子通过可插拔 registry（server/src/agents/registry.js）路由；
 *   未注入 registry 时兼容旧的 agent.getMove 写法（测试用）。
 * - 对外输出的 GameState 严格按 docs/API.md 归一化，避免引擎内部字段泄漏；
 *   新增 aiProvider 字段记录本局使用的 AI provider。
 */

const crypto = require('node:crypto');
const Go9Game = require('./games/go9');
const HeuristicGoAgent = require('./agents/heuristicGoAgent');
const { analyzeGame } = require('./analysis/analyze');
const { isDatabaseUsable, markDatabaseUnavailable } = require('./db');

const DEFAULT_KOMI = 7.5;
const DEFAULT_MAX_GAMES = 20;
const DEFAULT_MAX_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 20;
const DEFAULT_PROVIDER = 'heuristic';
const ANALYZE_SEED = 1;

const COLORS = new Set(['black', 'white']);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeParseJson(text, fallback) {
  if (typeof text !== 'string' || text.trim() === '') return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function toDate(value) {
  if (value instanceof Date) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function toIso(value) {
  return toDate(value).toISOString();
}

function normalizeCoord(coord) {
  if (!isPlainObject(coord)) return null;
  const { x, y } = coord;
  return Number.isInteger(x) && Number.isInteger(y) ? { x, y } : null;
}

function normalizeBoard(rawBoard, size) {
  if (!Array.isArray(rawBoard)) {
    return Array.from({ length: size }, () => Array.from({ length: size }, () => null));
  }
  return Array.from({ length: size }, (_, y) => {
    const row = Array.isArray(rawBoard[y]) ? rawBoard[y] : [];
    return Array.from({ length: size }, (_, x) => {
      const cell = row[x];
      return cell === 'black' || cell === 'white' ? cell : null;
    });
  });
}

function normalizeMove(rawMove) {
  if (!isPlainObject(rawMove)) return { x: null, y: null, player: 'black', captured: 0, pass: true };
  const isPass =
    rawMove.pass === true ||
    rawMove.x === null ||
    rawMove.x === undefined ||
    rawMove.y === null ||
    rawMove.y === undefined;
  const player = COLORS.has(rawMove.player) ? rawMove.player : 'black';
  const captured = Number.isInteger(rawMove.captured) ? rawMove.captured : 0;
  if (isPass) return { x: null, y: null, player, captured, pass: true };
  return { x: rawMove.x, y: rawMove.y, player, captured };
}

function normalizeMoves(rawMoves) {
  if (!Array.isArray(rawMoves)) return [];
  return rawMoves.map(normalizeMove);
}

function normalizeWinner(value) {
  return value === 'black' || value === 'white' || value === 'draw' ? value : null;
}

function normalizeProvider(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * 把引擎 getState() 归一化为 docs/API.md 的 GameState。
 *
 * @param {object} raw
 * @param {{ komi?: number, aiProvider?: string, winnerOverride?: string|null, resultOverride?: object|null }} [options]
 */
function normalizeState(raw, options = {}) {
  const source = isPlainObject(raw) ? raw : {};
  const size = Number.isInteger(source.size) && source.size > 0 ? source.size : 9;
  const moves = normalizeMoves(source.moves);
  const board = normalizeBoard(source.board, size);

  let lastMove = null;
  if (source.lastMove === null) {
    lastMove = null;
  } else if (isPlainObject(source.lastMove)) {
    lastMove = normalizeCoord(source.lastMove);
  } else {
    for (let i = moves.length - 1; i >= 0; i -= 1) {
      const move = moves[i];
      if (!move.pass) {
        lastMove = { x: move.x, y: move.y };
        break;
      }
    }
  }

  const winner = normalizeWinner(source.winner) || normalizeWinner(options.winnerOverride);
  const result = isPlainObject(source.result)
    ? source.result
    : isPlainObject(options.resultOverride)
      ? options.resultOverride
      : null;

  const aiProvider =
    normalizeProvider(source.aiProvider) || normalizeProvider(options.aiProvider) || DEFAULT_PROVIDER;

  return {
    size,
    board,
    currentPlayer: source.currentPlayer === 'white' ? 'white' : 'black',
    moves,
    captures: {
      black: Number.isInteger(source.captures && source.captures.black) ? source.captures.black : 0,
      white: Number.isInteger(source.captures && source.captures.white) ? source.captures.white : 0,
    },
    winner,
    result,
    passCount: Number.isInteger(source.passCount) && source.passCount >= 0 ? source.passCount : 0,
    koPoint: normalizeCoord(source.koPoint),
    lastMove,
    moveCount: Number.isInteger(source.moveCount) && source.moveCount >= 0 ? source.moveCount : moves.length,
    komi: typeof source.komi === 'number' ? source.komi : typeof options.komi === 'number' ? options.komi : DEFAULT_KOMI,
    aiProvider,
  };
}

/**
 * 用着法历史重建对局。优先使用引擎的 Go9Game.replay（含 superko / 终局判定），
 * 旧版引擎没有 replay 时退回逐手 place/pass。
 *
 * @param {Array<object>} moves
 * @param {{ komi?: number }} [options]
 * @returns {InstanceType<typeof Go9Game>}
 */
function replayGame(moves, options = {}) {
  const list = Array.isArray(moves) ? moves : [];
  if (typeof Go9Game.replay === 'function') {
    return Go9Game.replay(list, { komi: options.komi });
  }
  const game = new Go9Game({ komi: options.komi });
  for (const move of list) {
    if (move && (move.pass === true || move.x === null || move.x === undefined)) game.pass();
    else if (move) game.place(move.x, move.y);
  }
  return game;
}

function inferResult(winner, moves) {
  if (!winner) return null;
  const recent = moves.slice(-2);
  const endedByPass = recent.length === 2 && recent.every((move) => move && move.pass);
  if (endedByPass) {
    return { method: 'score', black: null, white: null, winner, margin: null };
  }
  return { method: 'resign', black: null, white: null, winner, margin: null };
}

function isNotFoundError(error) {
  return Boolean(error && (error.code === 'P2025' || error.code === 'P2023'));
}

/** aiProvider 列/客户端尚未同步（Lead 集成前）时的兼容判断。 */
function isAiProviderSchemaError(error) {
  if (!error) return false;
  if (error.code === 'P2022') return true; // column does not exist
  if (error.name === 'PrismaClientValidationError') return true; // generated client 尚无该字段
  return /aiProvider/i.test(String(error.message || ''));
}

class GameStore {
  /**
   * @param {{
   *   db?: ReturnType<typeof import('./db').createDatabase>|null,
   *   registry?: object|null,
   *   agent?: object|null,
   *   scorer?: object|null,
   *   maxGames?: number,
   *   komi?: number
   * }} [options]
   */
  constructor(options = {}) {
    this.db = options.db || null;
    this.registry = options.registry || null;
    this.agent = options.agent || null;
    this.scorer = options.scorer || null;
    this.maxGames = Number.isInteger(options.maxGames) && options.maxGames > 0 ? options.maxGames : DEFAULT_MAX_GAMES;
    this.komi = typeof options.komi === 'number' ? options.komi : DEFAULT_KOMI;
    this.defaultProvider =
      this.registry && normalizeProvider(this.registry.defaultProvider)
        ? normalizeProvider(this.registry.defaultProvider)
        : DEFAULT_PROVIDER;
    this._aiProviderSchemaWarned = false;
    /** @type {Map<string, object>} */
    this.games = new Map();
  }

  // ------------------------------------------------------------------ 工具

  /** 对外状态快照（GameState）。 */
  snapshot(entry) {
    const raw = entry && entry.game && typeof entry.game.getState === 'function' ? entry.game.getState() : {};
    return normalizeState(raw, {
      komi: entry ? entry.komi : this.komi,
      aiProvider: entry ? entry.aiProvider : this.defaultProvider,
      winnerOverride: entry ? entry.winnerOverride : null,
      resultOverride: entry ? entry.resultOverride : null,
    });
  }

  _summary(entry) {
    const state = this.snapshot(entry);
    return {
      id: entry.id,
      status: state.winner ? 'finished' : 'playing',
      winner: state.winner,
      moveCount: state.moveCount,
      createdAt: toIso(entry.createdAt),
      updatedAt: toIso(entry.updatedAt),
    };
  }

  _remember(entry) {
    // Map 天然保持插入顺序：delete + set 即可把最近访问的条目移到末尾实现 LRU。
    if (this.games.has(entry.id)) this.games.delete(entry.id);
    this.games.set(entry.id, entry);
    while (this.games.size > this.maxGames) {
      const oldestKey = this.games.keys().next().value;
      if (oldestKey === undefined) break;
      this.games.delete(oldestKey);
    }
  }

  _touch(entry) {
    entry.updatedAt = new Date();
    this._remember(entry);
  }

  _isOver(entry) {
    const state = this.snapshot(entry);
    return Boolean(state.winner || state.result);
  }

  _providerOf(entry) {
    return normalizeProvider(entry && entry.aiProvider) || this.defaultProvider;
  }

  _warnAiProviderSchema(error) {
    if (this._aiProviderSchemaWarned) return;
    this._aiProviderSchemaWarned = true;
    console.warn(
      `[db] 当前数据库/生成客户端尚不支持 aiProvider 字段，已自动降级（Lead 集成时会执行 prisma generate/migrate）：${
        error && error.message ? error.message : error
      }`,
    );
  }

  // ------------------------------------------------------------ 持久化层

  _recordData(entry) {
    const state = this.snapshot(entry);
    return {
      gameType: 'go9',
      boardState: JSON.stringify(state.board),
      moveHistory: JSON.stringify(state.moves),
      status: state.winner ? 'finished' : 'playing',
      winner: state.winner,
      aiProvider: state.aiProvider,
    };
  }

  async _writeRecord(entry, data, { create = false } = {}) {
    const db = this.db;
    if (create) {
      await db.prisma.game.create({ data: { id: entry.id, ...data, createdAt: entry.createdAt } });
      return;
    }
    try {
      await db.prisma.game.update({ where: { id: entry.id }, data });
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      // 内存中新建但曾因数据库不可用未落库时，补一条 create。
      await db.prisma.game.create({ data: { id: entry.id, ...data, createdAt: entry.createdAt } });
    }
  }

  /**
   * 写库（best-effort）。数据库异常只降级，不抛出。
   * @returns {Promise<boolean>}
   */
  async _persist(entry, { create = false } = {}) {
    const db = this.db;
    if (!isDatabaseUsable(db)) return false;

    const data = this._recordData(entry);
    try {
      await this._writeRecord(entry, data, { create });
      return true;
    } catch (error) {
      // Lead 集成前的兼容：generated client / DB 尚无 aiProvider 时，去掉该字段重试一次。
      if (data.aiProvider !== undefined && isAiProviderSchemaError(error)) {
        this._warnAiProviderSchema(error);
        const { aiProvider, ...legacyData } = data;
        try {
          await this._writeRecord(entry, legacyData, { create });
          return true;
        } catch (retryError) {
          markDatabaseUnavailable(db, retryError);
          return false;
        }
      }
      markDatabaseUnavailable(db, error);
      return false;
    }
  }

  async _loadRecord(id) {
    const db = this.db;
    if (!isDatabaseUsable(db)) return null;

    const selectWithProvider = {
      id: true,
      boardState: true,
      moveHistory: true,
      analysisJson: true,
      status: true,
      winner: true,
      aiProvider: true,
      createdAt: true,
      updatedAt: true,
    };
    const { aiProvider: _ignored, ...selectLegacy } = selectWithProvider;

    try {
      return await db.prisma.game.findUnique({ where: { id }, select: selectWithProvider });
    } catch (error) {
      if (!isAiProviderSchemaError(error)) {
        markDatabaseUnavailable(db, error);
        return null;
      }
      this._warnAiProviderSchema(error);
      try {
        return await db.prisma.game.findUnique({ where: { id }, select: selectLegacy });
      } catch (retryError) {
        markDatabaseUnavailable(db, retryError);
        return null;
      }
    }
  }

  _rebuild(record) {
    const moves = normalizeMoves(safeParseJson(record.moveHistory, []));
    const game = replayGame(moves, { komi: this.komi });
    const entry = {
      id: record.id,
      game,
      createdAt: toDate(record.createdAt),
      updatedAt: toDate(record.updatedAt || record.createdAt),
      komi: typeof record.komi === 'number' ? record.komi : this.komi,
      playerColor: null,
      aiProvider: normalizeProvider(record.aiProvider) || this.defaultProvider,
      analysis: safeParseJson(record.analysisJson, null),
      winnerOverride: null,
      resultOverride: null,
    };

    // 认输无法从 moveHistory 回放出来：DB 里只有 winner/status，这里补出 result。
    const rawState = typeof game.getState === 'function' ? game.getState() : {};
    const storedWinner = normalizeWinner(record.winner);
    if ((record.status === 'finished' || storedWinner) && !normalizeWinner(rawState && rawState.winner) && storedWinner) {
      entry.winnerOverride = storedWinner;
      entry.resultOverride = inferResult(storedWinner, moves);
    }
    return entry;
  }

  // -------------------------------------------------------------- 公共 API

  /** 新建对局。 */
  async create(options = {}) {
    const id = crypto.randomUUID();
    const now = new Date();
    const aiProvider = normalizeProvider(options.aiProvider) || this.defaultProvider;
    const entry = {
      id,
      game: new Go9Game({ komi: this.komi }),
      createdAt: now,
      updatedAt: now,
      komi: this.komi,
      playerColor: COLORS.has(options.playerColor) ? options.playerColor : null,
      aiProvider,
      analysis: null,
      winnerOverride: null,
      resultOverride: null,
    };
    this._remember(entry);
    await this._persist(entry, { create: true });
    return entry;
  }

  /** 读取对局（内存优先，缺失时从 DB 回放重建）。 */
  async get(id) {
    if (typeof id !== 'string' || id.trim() === '') return null;
    const memoryEntry = this.games.get(id);
    if (memoryEntry) {
      this._remember(memoryEntry);
      return memoryEntry;
    }
    const record = await this._loadRecord(id);
    if (!record) return null;
    const entry = this._rebuild(record);
    this._remember(entry);
    return entry;
  }

  /** 最近对局列表（DB 优先，DB 不可用/未命中时合并内存对局）。 */
  async list(limit = DEFAULT_LIST_LIMIT) {
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, DEFAULT_MAX_LIMIT) : DEFAULT_LIST_LIMIT;
    let summaries = [];
    const seen = new Set();

    const db = this.db;
    if (isDatabaseUsable(db)) {
      try {
        const records = await db.prisma.game.findMany({
          orderBy: { updatedAt: 'desc' },
          take: safeLimit,
          select: {
            id: true,
            status: true,
            winner: true,
            moveHistory: true,
            createdAt: true,
            updatedAt: true,
          },
        });
        summaries = records.map((record) => {
          const moves = safeParseJson(record.moveHistory, []);
          return {
            id: record.id,
            status: record.status === 'finished' || normalizeWinner(record.winner) ? 'finished' : 'playing',
            winner: normalizeWinner(record.winner),
            moveCount: Array.isArray(moves) ? moves.length : 0,
            createdAt: toIso(record.createdAt),
            updatedAt: toIso(record.updatedAt || record.createdAt),
          };
        });
        for (const summary of summaries) seen.add(summary.id);
      } catch (error) {
        markDatabaseUnavailable(db, error);
      }
    }

    for (const entry of this.games.values()) {
      if (seen.has(entry.id)) continue;
      summaries.push(this._summary(entry));
    }

    summaries.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return summaries.slice(0, safeLimit);
  }

  /** 落子。 */
  async place(id, x, y) {
    const entry = await this.get(id);
    if (!entry) return { ok: false, reason: 'not_found' };
    if (this._isOver(entry)) return { ok: false, reason: 'game_over' };

    let result;
    try {
      result = entry.game.place(x, y);
    } catch {
      return { ok: false, reason: 'invalid_move' };
    }
    if (!result || result.ok !== true) {
      return { ok: false, reason: result && typeof result.reason === 'string' ? result.reason : 'invalid_move' };
    }
    this._touch(entry);
    await this._persist(entry);
    return { ok: true, state: this.snapshot(entry) };
  }

  /** 停一手；连续两次 pass 由引擎判终局。 */
  async pass(id) {
    const entry = await this.get(id);
    if (!entry) return { ok: false, reason: 'not_found' };
    if (this._isOver(entry)) return { ok: false, reason: 'game_over' };

    let result;
    try {
      result = entry.game.pass();
    } catch {
      return { ok: false, reason: 'internal_error' };
    }
    if (!result || result.ok === false) {
      return { ok: false, reason: result && typeof result.reason === 'string' ? result.reason : 'game_over' };
    }
    this._touch(entry);
    await this._persist(entry);
    const state = this.snapshot(entry);
    return { ok: true, state, gameOver: Boolean(result.gameOver || state.winner), winner: state.winner };
  }

  /** 认输。player 缺省为当前行棋方。 */
  async resign(id, player) {
    const entry = await this.get(id);
    if (!entry) return { ok: false, reason: 'not_found' };
    if (this._isOver(entry)) return { ok: false, reason: 'game_over' };

    const stateBefore = this.snapshot(entry);
    const resigning = COLORS.has(player) ? player : stateBefore.currentPlayer;
    let result;
    try {
      result = entry.game.resign(resigning);
    } catch {
      return { ok: false, reason: 'internal_error' };
    }
    if (result && result.ok === false) {
      return { ok: false, reason: typeof result.reason === 'string' ? result.reason : 'game_over' };
    }

    // 引擎若未写 winner/result（旧版/异常分支），在 store 层兜底，保证契约完整。
    const rawState = typeof entry.game.getState === 'function' ? entry.game.getState() : {};
    if (!normalizeWinner(rawState && rawState.winner)) {
      const winner = resigning === 'black' ? 'white' : 'black';
      entry.winnerOverride = winner;
      entry.resultOverride = { method: 'resign', black: null, white: null, winner, margin: null };
    } else {
      entry.winnerOverride = null;
      entry.resultOverride = null;
    }

    this._touch(entry);
    await this._persist(entry);
    return { ok: true, state: this.snapshot(entry) };
  }

  /** 悔棋（steps 已由 app 层限制在 1-20）；终局后仍可悔棋。 */
  async undo(id, steps = 1) {
    const entry = await this.get(id);
    if (!entry) return { ok: false, reason: 'not_found' };
    if (typeof entry.game.undo !== 'function') return { ok: false, reason: 'nothing_to_undo' };

    let result;
    try {
      result = entry.game.undo(steps);
    } catch {
      return { ok: false, reason: 'nothing_to_undo' };
    }
    if (!result || result.ok === false) {
      return { ok: false, reason: result && typeof result.reason === 'string' ? result.reason : 'nothing_to_undo' };
    }

    // 悔棋可能跨越终局：清掉 store 层的兜底终局状态。
    entry.winnerOverride = null;
    entry.resultOverride = null;
    entry.analysis = null;
    this._touch(entry);
    await this._persist(entry);
    return { ok: true, state: this.snapshot(entry) };
  }

  /**
   * AI 替当前行棋方走一手。
   *
   * @param {string} id
   * @param {{ difficulty?: string, provider?: string }|string} [options] 兼容旧的 (id, difficulty) 调用
   * @returns {Promise<{ok:true, move:{x:number,y:number}|null, provider:string, fallback:object|null, state:object, gameOver:boolean, winner:string|null}>}
   */
  async aiMove(id, options = {}) {
    const entry = await this.get(id);
    if (!entry) return { ok: false, reason: 'not_found' };
    if (this._isOver(entry)) return { ok: false, reason: 'game_over' };

    const opts = typeof options === 'string' ? { difficulty: options } : options || {};
    const difficulty = typeof opts.difficulty === 'string' ? opts.difficulty : 'medium';
    const configuredProvider = this._providerOf(entry);
    const requestedProvider = normalizeProvider(opts.provider) || configuredProvider;

    let recommendation = null;
    let providerId = requestedProvider;
    let fallback = null;

    if (this.registry && typeof this.registry.move === 'function') {
      let routed;
      try {
        routed = await this.registry.move(requestedProvider, entry.game, { difficulty });
      } catch (error) {
        routed = null;
        fallback = { from: requestedProvider, reason: error && error.message ? error.message : 'provider_error' };
      }
      if (routed && typeof routed === 'object') {
        recommendation = routed.move === undefined ? null : routed.move;
        providerId = normalizeProvider(routed.providerId) || this.defaultProvider;
        fallback = routed.fallback || fallback || null;
      } else if (!fallback) {
        fallback = { from: requestedProvider, reason: 'provider_unavailable' };
        providerId = this.defaultProvider;
      }
    } else if (this.agent && typeof this.agent.getMove === 'function') {
      // 兼容旧注入方式（测试 / 无 registry 场景）
      try {
        recommendation = await this.agent.getMove(entry.game, { difficulty });
      } catch {
        recommendation = null;
      }
      providerId = configuredProvider;
    } else {
      return { ok: false, reason: 'internal_error' };
    }

    let placed = null;
    if (recommendation && Number.isInteger(recommendation.x) && Number.isInteger(recommendation.y)) {
      const result = entry.game.place(recommendation.x, recommendation.y);
      if (result && result.ok === true) placed = { x: recommendation.x, y: recommendation.y };
    }

    // AI 给了非法着点：退而求其次选引擎给出的第一个合法着点。
    if (!placed && recommendation) {
      const legalMoves = typeof entry.game.getLegalMoves === 'function' ? entry.game.getLegalMoves() : [];
      if (Array.isArray(legalMoves) && legalMoves.length > 0) {
        const fallbackMove = legalMoves[0];
        const coords = Array.isArray(fallbackMove) ? { x: fallbackMove[0], y: fallbackMove[1] } : fallbackMove;
        if (coords && Number.isInteger(coords.x) && Number.isInteger(coords.y)) {
          const result = entry.game.place(coords.x, coords.y);
          if (result && result.ok === true) placed = { x: coords.x, y: coords.y };
        }
      }
    }

    let gameOver = Boolean(this._isOver(entry));
    let winner = this.snapshot(entry).winner;
    if (!placed) {
      // AI 选择停一手（或已无合法着点）：自动 pass。
      const result = entry.game.pass();
      if (!result || result.ok === false) {
        return { ok: false, reason: result && typeof result.reason === 'string' ? result.reason : 'game_over' };
      }
      gameOver = Boolean(result.gameOver || this._isOver(entry));
      winner = this.snapshot(entry).winner;
    }

    // 记录实际使用的 provider（回退时为 heuristic），并持久化。
    entry.aiProvider = providerId;
    this._touch(entry);
    await this._persist(entry);
    return { ok: true, move: placed, provider: providerId, fallback, state: this.snapshot(entry), gameOver, winner };
  }

  /**
   * 复盘分析：逐手回放局面并用启发式评分表与真实着法比较。
   * 返回 { totalMoves, comparedMoves, mismatches, accuracy, averageLoss, grade,
   *        phases, weaknesses, mistakes, summary } 并 best-effort 持久化。
   */
  async analyze(id) {
    const entry = await this.get(id);
    if (!entry) return { ok: false, reason: 'not_found' };

    const scorer = this.scorer || new HeuristicGoAgent({ seed: ANALYZE_SEED });
    const state = this.snapshot(entry);
    const analysis = analyzeGame({ moves: state.moves, komi: entry.komi, scorer });

    entry.analysis = analysis;
    await this.saveAnalysis(entry, analysis);
    return { ok: true, analysis };
  }

  /** 把分析结果写入 DB analysisJson（best-effort）。 */
  async saveAnalysis(entry, analysis) {
    const db = this.db;
    if (!entry || !isDatabaseUsable(db)) return false;
    try {
      await db.prisma.game.update({
        where: { id: entry.id },
        data: { analysisJson: JSON.stringify(analysis) },
      });
      return true;
    } catch (error) {
      markDatabaseUnavailable(db, error);
      return false;
    }
  }
}

module.exports = {
  GameStore,
  DEFAULT_KOMI,
  DEFAULT_MAX_GAMES,
  DEFAULT_LIST_LIMIT,
  DEFAULT_MAX_LIMIT,
  DEFAULT_PROVIDER,
  normalizeState,
  replayGame,
  inferResult,
};
