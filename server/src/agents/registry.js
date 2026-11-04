'use strict';

/**
 * AI provider 注册表：把「下棋 AI」做成可插拔 provider。
 *
 * 内置 provider（PROVIDERS，顺序固定）：
 *   1. heuristic  内置启发式（永远可用，也是所有失败场景的回退）
 *   2. http       OpenAI 兼容 HTTP API（env: AI_HTTP_*）
 *   3. katago     KataGo GTP 本地子进程（env: KATAGO_*）
 *
 * 对外工厂：
 *   const { createAgentRegistry } = require('./agents/registry');
 *   const registry = createAgentRegistry({ env: process.env });
 *   registry.defaultProvider  // env.AI_PROVIDER_DEFAULT 合法则用之，否则 'heuristic'
 *   registry.list()           // [{ id, label, kind, available, description, requires }]
 *   registry.get(id)          // agent 实例 | null（未知/未配置/创建失败）
 *   await registry.move(id, game, { difficulty }) // 永不抛错；失败回退 heuristic
 *   await registry.shutdown() // 关闭 katago 等持有资源的 provider
 *
 * provider 模块形状：{ meta, available(env), create({ env }) -> { getMove, close? } }
 * 新增 provider 只需实现该形状并加入下方 PROVIDERS 数组。
 */

const HeuristicGoAgent = require('./heuristicGoAgent');
const httpProvider = require('./httpAgent');
const katagoProvider = require('./katagoAgent');

const FALLBACK_PROVIDER_ID = 'heuristic';

/** 内置启发式 provider 适配层（按 provider 契约包装 HeuristicGoAgent 类）。 */
const heuristicProvider = {
  meta: {
    id: FALLBACK_PROVIDER_ID,
    label: '内置启发式',
    kind: 'builtin',
    description: '本地启发式评分 AI，永远可用；其它 provider 未配置或失败时自动回退到它。',
    requires: [],
  },
  available() {
    return true;
  },
  create() {
    return new HeuristicGoAgent();
  },
};

/** provider 注册顺序：heuristic、http、katago。新增 provider 加在这个数组里。 */
const PROVIDERS = [heuristicProvider, httpProvider, katagoProvider];

function isProviderDescriptor(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      value.meta &&
      typeof value.meta.id === 'string' &&
      value.meta.id.length > 0 &&
      typeof value.create === 'function',
  );
}

function normalizeProviders(providers) {
  const input = Array.isArray(providers) && providers.length > 0 ? providers : PROVIDERS;
  const seen = new Set();
  const result = [];

  for (const descriptor of input) {
    if (!isProviderDescriptor(descriptor)) continue;
    const { id } = descriptor.meta;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(descriptor);
  }

  // 回退 provider 必须始终存在，否则 move() 没有兜底。
  if (!seen.has(FALLBACK_PROVIDER_ID)) result.unshift(heuristicProvider);
  return result;
}

function formatError(error) {
  if (error instanceof Error && error.message) return error.message;
  const text = String(error);
  return !text || text === 'undefined' ? 'provider 执行失败' : text;
}

function isLegalResult(game, result) {
  if (result === null || result === undefined) return true; // null 表示 pass，是合法结果
  if (!Number.isInteger(result.x) || !Number.isInteger(result.y)) return false;
  if (!game || typeof game.getLegalMoves !== 'function') return false;
  const legalMoves = game.getLegalMoves();
  return Array.isArray(legalMoves) && legalMoves.some((move) => move.x === result.x && move.y === result.y);
}

function createAgentRegistry({ env = process.env, providers } = {}) {
  const environments = env && typeof env === 'object' ? env : {};
  const registeredProviders = normalizeProviders(providers);
  const descriptors = new Map(registeredProviders.map((provider) => [provider.meta.id, provider]));
  const instances = new Map();

  const isAvailable = (provider) => {
    try {
      return typeof provider.available === 'function' ? Boolean(provider.available(environments)) : true;
    } catch {
      return false;
    }
  };

  const defaultProviderId = (() => {
    const configured =
      typeof environments.AI_PROVIDER_DEFAULT === 'string' ? environments.AI_PROVIDER_DEFAULT.trim() : '';
    return configured && descriptors.has(configured) ? configured : FALLBACK_PROVIDER_ID;
  })();

  const list = () =>
    registeredProviders.map((provider) => ({
      id: provider.meta.id,
      label: typeof provider.meta.label === 'string' ? provider.meta.label : provider.meta.id,
      kind: typeof provider.meta.kind === 'string' ? provider.meta.kind : 'api',
      available: isAvailable(provider),
      description: typeof provider.meta.description === 'string' ? provider.meta.description : '',
      requires: Array.isArray(provider.meta.requires) ? provider.meta.requires.slice() : [],
    }));

  const get = (id) => {
    if (typeof id !== 'string' || id.length === 0) return null;
    const provider = descriptors.get(id);
    if (!provider) return null;
    if (!isAvailable(provider)) return null;
    if (instances.has(id)) return instances.get(id);

    try {
      const agent = provider.create({ env: environments });
      if (!agent || typeof agent.getMove !== 'function') return null;
      instances.set(id, agent);
      return agent;
    } catch {
      return null;
    }
  };

  /** 调用内置启发式并校验结果；任何异常都返回 null（表示无法给出着点 → 由上层 pass）。 */
  const getHeuristicMove = async (game, difficulty) => {
    const heuristic = get(FALLBACK_PROVIDER_ID);
    if (!heuristic) return null;
    try {
      const move = await heuristic.getMove(game, { difficulty });
      if (move === null || move === undefined) return null;
      return isLegalResult(game, move) ? { x: move.x, y: move.y } : null;
    } catch {
      return null;
    }
  };

  const buildFallback = async (requestedId, game, difficulty, reason) => ({
    move: await getHeuristicMove(game, difficulty),
    providerId: FALLBACK_PROVIDER_ID,
    fallback: { from: requestedId, reason },
  });

  const runProvider = async (requestedId, game, difficulty) => {
    const agent = get(requestedId);
    if (!agent) {
      const reason = descriptors.has(requestedId)
        ? `provider "${requestedId}" 未配置或不可用`
        : `未知 provider "${requestedId}"`;
      return buildFallback(requestedId, game, difficulty, reason);
    }

    let result;
    try {
      result = await agent.getMove(game, { difficulty });
    } catch (error) {
      return buildFallback(requestedId, game, difficulty, formatError(error));
    }

    if (!isLegalResult(game, result)) {
      return buildFallback(requestedId, game, difficulty, `provider "${requestedId}" 返回了非法着点`);
    }
    if (result === null || result === undefined) {
      return { move: null, providerId: requestedId, fallback: null };
    }
    return { move: { x: result.x, y: result.y }, providerId: requestedId, fallback: null };
  };

  /**
   * 让指定 provider 走一手；永远不会抛错。
   * 成功：{ move: {x,y}|null, providerId, fallback: null }
   * 回退：{ move: {x,y}|null, providerId: 'heuristic', fallback: { from, reason } }
   */
  async function move(providerId, game, options = {}) {
    let requestedId = providerId;
    let targetGame = game;
    let moveOptions = options;

    // 兼容 move(game, { difficulty, provider }) 这种省略 provider 的调用形式。
    if (requestedId && typeof requestedId === 'object' && typeof requestedId.getState === 'function') {
      moveOptions = game && typeof game === 'object' && !Array.isArray(game) ? game : {};
      targetGame = requestedId;
      requestedId = undefined;
    }

    const explicitProvider =
      typeof requestedId === 'string' && requestedId.trim() ? requestedId.trim() : '';
    const optionProvider =
      moveOptions && typeof moveOptions.provider === 'string' && moveOptions.provider.trim()
        ? moveOptions.provider.trim()
        : '';
    const resolvedId = explicitProvider || optionProvider || defaultProviderId;
    const difficulty = moveOptions && typeof moveOptions.difficulty === 'string' ? moveOptions.difficulty : 'medium';

    try {
      return await runProvider(resolvedId, targetGame, difficulty);
    } catch (error) {
      // 双保险：runProvider 已兜底，这里捕获 game 异常等极端情况。
      return { move: null, providerId: FALLBACK_PROVIDER_ID, fallback: { from: resolvedId, reason: formatError(error) } };
    }
  }

  async function shutdown() {
    const agents = Array.from(instances.values());
    instances.clear();
    await Promise.all(
      agents.map(async (agent) => {
        if (agent && typeof agent.close === 'function') {
          try {
            await agent.close();
          } catch {
            // 关闭失败不影响进程退出
          }
        }
      }),
    );
  }

  return { defaultProvider: defaultProviderId, list, get, move, shutdown };
}

module.exports = { createAgentRegistry, PROVIDERS };
