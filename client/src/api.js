// 统一的后端请求封装：所有接口都走 /api（开发时由 Vite 代理到 :3001）。
// 失败时统一抛 ApiError，{ ok:false, reason, message } 不会被静默吞掉。

const BASE = import.meta.env.VITE_API_BASE || '/api';
const REQUEST_TIMEOUT = 20000;

const REASON_MESSAGES = {
  network: '无法连接服务器，请确认后端已启动。',
  timeout: '请求超时，请稍后重试。',
  game_over: '对局已经结束。',
  out_of_board: '落子超出棋盘范围。',
  occupied: '该交叉点已经有棋子了。',
  ko: '打劫：此手不能立即提回。',
  superko: '全局同形禁着，请换个位置。',
  suicide: '禁着点：不能自杀。',
  not_found: '对局不存在或已被删除。',
  invalid_body: '请求参数无效。',
  invalid_move: '落子不合法。',
  nothing_to_undo: '没有可以悔的棋。',
  provider_unavailable: '该 AI 未配置或不可用，已回退内置 AI。',
  db_error: '数据库异常，对局暂时无法保存。',
  internal_error: '服务器内部错误，请稍后重试。',
};

export class ApiError extends Error {
  constructor(reason, message, status = 0) {
    const text = message || REASON_MESSAGES[reason] || `请求失败（${reason || 'unknown'}）`;
    super(text);
    this.name = 'ApiError';
    this.reason = reason || 'internal_error';
    this.status = status;
  }
}

/** 把任意异常转换成可以直接展示给用户的中文说明。 */
export function describeError(error) {
  if (!error) return '发生未知错误。';
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return '发生未知错误。';
}

function apiPath(path) {
  return `${BASE.replace(/\/+$/, '')}${path}`;
}

function gamePath(id, suffix = '') {
  return `/games/${encodeURIComponent(id)}${suffix}`;
}

async function request(path, { method = 'GET', body } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  let response;
  try {
    response = await fetch(apiPath(path), {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    throw controller.signal.aborted
      ? new ApiError('timeout')
      : new ApiError('network');
  } finally {
    clearTimeout(timer);
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok || !payload || payload.ok === false) {
    const reason = payload && payload.reason ? payload.reason : `http_${response.status}`;
    throw new ApiError(reason, payload && payload.message, response.status);
  }
  return payload;
}

export function health() {
  return request('/health');
}

export function listGames(limit = 20) {
  return request(`/games?limit=${limit}`);
}

/** AI provider 列表（含默认项与可用状态）；后端未实现时请求会抛错，调用方需降级。 */
export function listAgents() {
  return request('/agents');
}

export function createGame(playerColor = 'black', aiProvider) {
  const body = { playerColor };
  if (aiProvider) body.aiProvider = aiProvider;
  return request('/games', { method: 'POST', body });
}

export function getGame(id) {
  return request(gamePath(id));
}

export function move(id, x, y) {
  return request(gamePath(id, '/move'), { method: 'POST', body: { x, y } });
}

export function pass(id) {
  return request(gamePath(id, '/pass'), { method: 'POST' });
}

export function resign(id, player) {
  return request(gamePath(id, '/resign'), {
    method: 'POST',
    body: player ? { player } : {},
  });
}

export function undo(id, steps = 1) {
  return request(gamePath(id, '/undo'), { method: 'POST', body: { steps } });
}

export function aiMove(id, difficulty = 'medium', provider) {
  const body = { difficulty };
  if (provider) body.provider = provider;
  return request(gamePath(id, '/ai-move'), {
    method: 'POST',
    body,
  });
}

export function analyze(id) {
  return request(gamePath(id, '/analyze'), { method: 'POST' });
}

/** SGF 导出是浏览器直接下载，不经过 fetch。 */
export function exportUrl(id) {
  return apiPath(gamePath(id, '/export'));
}
