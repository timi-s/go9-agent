'use strict';

/**
 * Express 5 应用工厂：路由、参数校验、统一 JSON 错误响应。
 *
 * createApp({ db, registry, agent, version, store, corsOrigin }) -> express app
 * - db 由 src/db.js 创建（可为 null / 不可用，自动降级为内存模式）
 * - registry 为可插拔 AI provider 注册表（src/agents/registry.js）；缺省时创建
 *   heuristic-only registry（env 为空，不读取外部 provider 配置）
 * - agent 仅用于向后兼容旧测试注入（registry 缺失且 store 未注入时）
 * - store 可选，测试时注入内存/假持久化 store；缺省按 db + registry 创建
 *
 * 所有路由（SGF 导出除外）都返回 JSON；错误统一
 * { ok:false, reason, message? }，不泄漏堆栈。
 */

const express = require('express');
const cors = require('cors');

const { GameStore, DEFAULT_LIST_LIMIT } = require('./gameStore');
const { isDatabaseUsable } = require('./db');
const { serializeSgf } = require('./sgf');
const BuiltinGoAgent = require('./agents/builtinAgent');
const pkg = require('../package.json');

const DEFAULT_VERSION = (pkg && pkg.version) || '1.0.0';
const DIFFICULTIES = new Set(['easy', 'medium', 'hard']);
const PLAYER_COLORS = new Set(['black', 'white']);
const BOARD_SIZE = 9;

const BUILTIN_META = {
  id: 'heuristic',
  label: '内置 AI（Python MCTS）',
  kind: 'builtin',
  available: true,
  description: '本地 Python MCTS AI（server/ai/go_ai.py），无需配置；Python 不可用时自动回退 JS 内置 AI。',
  requires: [],
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function wrap(handler) {
  return (req, res, next) => {
    try {
      Promise.resolve(handler(req, res, next)).catch(next);
    } catch (error) {
      next(error);
    }
  };
}

function jsonError(res, status, reason, message) {
  const body = { ok: false, reason };
  if (message) body.message = message;
  return res.status(status).json(body);
}

function readBody(req) {
  if (req.body === undefined || req.body === null) return {};
  return isPlainObject(req.body) ? req.body : null;
}

function parseCoord(value) {
  return Number.isInteger(value) && value >= 0 && value < BOARD_SIZE;
}

function parseLimit(rawLimit) {
  if (rawLimit === undefined) return { ok: true, value: DEFAULT_LIST_LIMIT };
  const text = String(rawLimit);
  if (!/^\d+$/.test(text)) return { ok: false };
  const value = Number.parseInt(text, 10);
  if (!Number.isInteger(value) || value < 1) return { ok: false };
  return { ok: true, value: Math.min(value, 100) };
}

/**
 * steps 解析：docs/API.md 规定“steps 必须为 1-20 的整数（超出按边界处理）”，
 * 因此非整数返回 invalid_body，整数越界则夹取到 [1, 20]。
 */
function parseSteps(rawSteps) {
  if (rawSteps === undefined || rawSteps === null) return { ok: true, value: 1 };
  if (typeof rawSteps !== 'number' || !Number.isInteger(rawSteps)) return { ok: false };
  return { ok: true, value: Math.min(20, Math.max(1, rawSteps)) };
}

function storeFailure(res, result) {
  if (result && result.reason === 'not_found') return jsonError(res, 404, 'not_found');
  const reason = result && typeof result.reason === 'string' ? result.reason : 'invalid_move';
  return jsonError(res, 400, reason);
}

/** heuristic-only registry：registry 模块尚未就绪 / 初始化失败时的兜底。 */
function createHeuristicOnlyRegistry({ agent } = {}) {
  const heuristicAgent = agent && typeof agent.getMove === 'function' ? agent : new BuiltinGoAgent();
  return {
    defaultProvider: 'heuristic',
    list() {
      return [{ ...BUILTIN_META }];
    },
    get(id) {
      return id === 'heuristic' ? heuristicAgent : null;
    },
    async move(providerId, game, { difficulty = 'medium' } = {}) {
      const move = await heuristicAgent.getMove(game, { difficulty });
      const usedHeuristic = providerId === 'heuristic';
      return {
        move,
        providerId: 'heuristic',
        fallback: usedHeuristic ? null : { from: providerId, reason: 'provider_unavailable' },
      };
    },
    async shutdown() {},
  };
}

/**
 * 创建默认 registry：优先使用真实 provider 注册表；模块缺失/初始化异常时退回
 * heuristic-only（不阻塞服务，便于并行开发与降级）。
 */
function createDefaultRegistry({ env = {}, agent } = {}) {
  try {
    // 延迟 require：registry 由并行队友提供，避免其未就绪时整个服务无法加载。
    const { createAgentRegistry } = require('./agents/registry');
    if (typeof createAgentRegistry === 'function') return createAgentRegistry({ env });
  } catch (error) {
    console.warn(`[agents] provider registry 不可用，使用内置 heuristic 兜底：${error && error.message ? error.message : error}`);
  }
  return createHeuristicOnlyRegistry({ agent });
}

function providerIdsOf(registry) {
  if (!registry || typeof registry.list !== 'function') return [];
  try {
    const list = registry.list();
    if (!Array.isArray(list)) return [];
    return list.map((item) => item && item.id).filter((id) => typeof id === 'string' && id !== '');
  } catch {
    return [];
  }
}

/**
 * @param {{
 *   db?: object|null,
 *   registry?: object|null,
 *   agent?: object|null,
 *   version?: string,
 *   store?: GameStore,
 *   corsOrigin?: string
 * }} [options]
 * @returns {import('express').Express}
 */
function createApp(options = {}) {
  const db = options.db || null;
  const agent = options.agent || null;
  const version = options.version || DEFAULT_VERSION;
  const registry = options.registry || createDefaultRegistry({ env: {}, agent });
  const store = options.store || new GameStore({ db, agent, registry });
  const corsOrigin = options.corsOrigin !== undefined ? options.corsOrigin : process.env.CORS_ORIGIN || '*';

  const app = express();
  app.disable('x-powered-by');
  app.locals.store = store;
  app.locals.db = db;
  app.locals.registry = registry;

  app.use(cors({ origin: corsOrigin }));
  app.use(express.json({ limit: '100kb' }));

  // ------------------------------------------------------------ 健康检查

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      version,
      db: isDatabaseUsable(db),
      uptime: Math.round(process.uptime() * 10) / 10,
    });
  });

  // ------------------------------------------------------------ AI providers

  app.get('/api/agents', wrap(async (req, res) => {
    const agents = typeof registry.list === 'function' ? registry.list() : [];
    const defaultProvider =
      registry && typeof registry.defaultProvider === 'string' && registry.defaultProvider ? registry.defaultProvider : 'heuristic';
    return res.json({ ok: true, default: defaultProvider, agents: Array.isArray(agents) ? agents : [] });
  }));

  // ------------------------------------------------------------ 对局列表

  app.get('/api/games', wrap(async (req, res) => {
    const limit = parseLimit(req.query.limit);
    if (!limit.ok) return jsonError(res, 400, 'invalid_body', 'limit 必须是 1-100 的整数');
    const games = await store.list(limit.value);
    return res.json({ ok: true, games });
  }));

  // ------------------------------------------------------------ 新建对局

  app.post('/api/games', wrap(async (req, res) => {
    const body = readBody(req);
    if (body === null) return jsonError(res, 400, 'invalid_body', '请求体必须是 JSON 对象');
    if (body.playerColor !== undefined && !PLAYER_COLORS.has(body.playerColor)) {
      return jsonError(res, 400, 'invalid_body', 'playerColor 必须是 black 或 white');
    }
    if (body.aiProvider !== undefined) {
      if (typeof body.aiProvider !== 'string' || !providerIdsOf(registry).includes(body.aiProvider)) {
        return jsonError(res, 400, 'invalid_body', '未知的 AI provider');
      }
    }
    const entry = await store.create({ playerColor: body.playerColor, aiProvider: body.aiProvider });
    const payload = { ok: true, id: entry.id, state: store.snapshot(entry) };
    if (body.playerColor !== undefined) payload.playerColor = body.playerColor;
    return res.status(201).json(payload);
  }));

  // ------------------------------------------------------------ 读取对局

  app.get('/api/games/:id', wrap(async (req, res) => {
    const entry = await store.get(req.params.id);
    if (!entry) return jsonError(res, 404, 'not_found', '对局不存在');
    return res.json({ ok: true, id: entry.id, state: store.snapshot(entry), analysis: entry.analysis || null });
  }));

  // ------------------------------------------------------------ 落子

  app.post('/api/games/:id/move', wrap(async (req, res) => {
    const body = readBody(req);
    if (body === null || !parseCoord(body.x) || !parseCoord(body.y)) {
      return jsonError(res, 400, 'invalid_body', 'x、y 必须是 0-8 的整数');
    }
    const result = await store.place(req.params.id, body.x, body.y);
    if (!result.ok) return storeFailure(res, result);
    return res.json({ ok: true, state: result.state });
  }));

  // ------------------------------------------------------------ 停一手

  app.post('/api/games/:id/pass', wrap(async (req, res) => {
    const body = readBody(req);
    if (body === null) return jsonError(res, 400, 'invalid_body', '请求体必须是 JSON 对象');
    const result = await store.pass(req.params.id);
    if (!result.ok) return storeFailure(res, result);
    return res.json({ ok: true, state: result.state, gameOver: result.gameOver, winner: result.winner });
  }));

  // ------------------------------------------------------------ 认输

  app.post('/api/games/:id/resign', wrap(async (req, res) => {
    const body = readBody(req);
    if (body === null) return jsonError(res, 400, 'invalid_body', '请求体必须是 JSON 对象');
    if (body.player !== undefined && !PLAYER_COLORS.has(body.player)) {
      return jsonError(res, 400, 'invalid_body', 'player 必须是 black 或 white');
    }
    const result = await store.resign(req.params.id, body.player);
    if (!result.ok) return storeFailure(res, result);
    return res.json({ ok: true, state: result.state });
  }));

  // ------------------------------------------------------------ 悔棋

  app.post('/api/games/:id/undo', wrap(async (req, res) => {
    const body = readBody(req);
    if (body === null) return jsonError(res, 400, 'invalid_body', '请求体必须是 JSON 对象');
    const steps = parseSteps(body.steps);
    if (!steps.ok) return jsonError(res, 400, 'invalid_body', 'steps 必须是 1-20 的整数');
    const result = await store.undo(req.params.id, steps.value);
    if (!result.ok) return storeFailure(res, result);
    return res.json({ ok: true, state: result.state });
  }));

  // ------------------------------------------------------------ AI 走一手

  app.post('/api/games/:id/ai-move', wrap(async (req, res) => {
    const body = readBody(req);
    if (body === null) return jsonError(res, 400, 'invalid_body', '请求体必须是 JSON 对象');
    const difficulty = body.difficulty === undefined ? 'medium' : body.difficulty;
    if (!DIFFICULTIES.has(difficulty)) {
      return jsonError(res, 400, 'invalid_body', 'difficulty 必须是 easy、medium 或 hard');
    }
    if (body.provider !== undefined) {
      if (typeof body.provider !== 'string' || !providerIdsOf(registry).includes(body.provider)) {
        return jsonError(res, 400, 'invalid_body', '未知的 AI provider');
      }
    }
    const result = await store.aiMove(req.params.id, { difficulty, provider: body.provider });
    if (!result.ok) return storeFailure(res, result);
    return res.json({
      ok: true,
      move: result.move,
      provider: result.provider,
      fallback: result.fallback,
      state: result.state,
      gameOver: result.gameOver,
      winner: result.winner,
    });
  }));

  // ------------------------------------------------------------ 复盘分析

  app.post('/api/games/:id/analyze', wrap(async (req, res) => {
    const body = readBody(req);
    if (body === null) return jsonError(res, 400, 'invalid_body', '请求体必须是 JSON 对象');
    const result = await store.analyze(req.params.id);
    if (!result.ok) return storeFailure(res, result);
    return res.json({ ok: true, analysis: result.analysis });
  }));

  // ------------------------------------------------------------ SGF 导出

  app.get('/api/games/:id/export', wrap(async (req, res) => {
    const entry = await store.get(req.params.id);
    if (!entry) return jsonError(res, 404, 'not_found', '对局不存在');
    const state = store.snapshot(entry);
    const sgf = serializeSgf({ ...state, createdAt: entry.createdAt });
    const filename = `${String(entry.id).replace(/[^A-Za-z0-9_-]/g, '_')}.sgf`;
    // 用 Buffer 发送，避免 Express 给 Content-Type 追加 charset，保持 docs/API.md 的精确值。
    res.setHeader('Content-Type', 'application/x-go-sgf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(Buffer.from(sgf, 'utf8'));
  }));

  // ------------------------------------------------------------ 404 / 错误

  app.use((req, res) => jsonError(res, 404, 'not_found', '接口不存在'));

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);

    // express.json 的解析/体积错误 -> 统一的 400 JSON，不返回 HTML 堆栈
    if (
      error &&
      (error.type === 'entity.parse.failed' ||
        error.type === 'entity.too.large' ||
        error.type === 'encoding.unsupported' ||
        error.status === 413)
    ) {
      const message = error.type === 'entity.too.large' ? '请求体过大（上限 100kb）' : '请求体不是合法的 JSON';
      return jsonError(res, 400, 'invalid_body', message);
    }

    // 仅在服务端日志记录堆栈，响应体绝不泄漏
    console.error('[api] 未处理错误:', error && error.stack ? error.stack : error);
    return jsonError(res, 500, 'internal_error', '服务器内部错误');
  });

  return app;
}

module.exports = { createApp, createDefaultRegistry, createHeuristicOnlyRegistry, DEFAULT_VERSION };
