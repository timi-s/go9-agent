'use strict';

/**
 * OpenAI 兼容的 HTTP AI provider。
 *
 * 对接任意实现了 `POST {AI_HTTP_BASE_URL}{AI_HTTP_PATH}` Chat Completions 协议的服务
 * （OpenAI / DeepSeek / Ollama / LM Studio / vLLM / 自建包装服务等）。
 *
 * 环境变量：
 * - AI_HTTP_BASE_URL  必填，例如 https://api.deepseek.com/v1
 * - AI_HTTP_MODEL     必填，例如 deepseek-chat
 * - AI_HTTP_API_KEY   可选，存在时发送 Authorization: Bearer <key>
 * - AI_HTTP_TIMEOUT_MS 可选，默认 15000
 * - AI_HTTP_PATH      可选，默认 /chat/completions
 * - AI_HTTP_RETRY     可选，默认 1：模型给出非法/无法解析的着点时，把错误反馈给它并重试一次
 *
 * 导出的 provider 形状（见 docs/AGENT-INTEGRATION.md）：
 *   { meta, available(env), create({ env }) -> { getMove(game, { difficulty }) } }
 *
 * 坐标约定与前端一致：列 A–J（跳过 I），行 1–9 自下而上；本引擎 y=0 在顶部，
 * 因此 row = size - y。
 */

const COLUMNS = 'ABCDEFGHJ'; // 9 路：A-H + J（跳过 I）
const BOARD_SIZE = 9;
const DEFAULT_PATH = '/chat/completions';
const DEFAULT_TIMEOUT_MS = 15000;

const meta = {
  id: 'http',
  label: 'OpenAI 兼容 HTTP',
  kind: 'api',
  description: '调用任意 OpenAI 兼容 Chat Completions 服务（OpenAI/DeepSeek/Ollama/vLLM 等）',
  requires: ['AI_HTTP_BASE_URL', 'AI_HTTP_MODEL'],
};

function available(env = process.env) {
  const baseUrl = typeof env.AI_HTTP_BASE_URL === 'string' ? env.AI_HTTP_BASE_URL.trim() : '';
  const model = typeof env.AI_HTTP_MODEL === 'string' ? env.AI_HTTP_MODEL.trim() : '';
  return Boolean(baseUrl && model);
}

function trimBaseUrl(value) {
  return String(value).trim().replace(/\/+$/, '');
}

function normalizePath(value) {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_PATH;
  return raw.startsWith('/') ? raw : `/${raw}`;
}

function parseTimeoutMs(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_TIMEOUT_MS;
}

/**
 * 上游错误体可能回显 Authorization / API Key；只把脱敏后的短摘要交给前端。
 * 正常产品路径不会把 key 放进 URL/请求体，但代理或异常服务可能回显。
 */
function redactSensitive(text) {
  return String(text)
    .replace(/(authorization\s*[=:]\s*)(?:Bearer\s+)?[^\s,;"']+/gi, '$1Bearer ***')
    .replace(/((?:api[_-]?key)\s*[=:]\s*)[^\s,;"']+/gi, '$1***')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
    .slice(0, 200);
}

/** 把 (x, y) 转成界面坐标，例如 (4,4) -> "E5"。 */
function formatCoord(x, y, size = BOARD_SIZE) {
  return `${COLUMNS[x]}${size - y}`;
}

/** 把界面坐标解析成 (x, y)，非法返回 null。 */
function parseCoord(text, size = BOARD_SIZE) {
  const match = /^([A-Za-z])([1-9]\d?)$/.exec(String(text).trim());
  if (!match) return null;
  const x = COLUMNS.indexOf(match[1].toUpperCase());
  const row = Number(match[2]);
  if (x < 0 || x >= size || !Number.isInteger(row) || row < 1 || row > size) return null;
  return { x, y: size - row };
}

/** ASCII 棋盘：X=黑、O=白、.=空；行号 9→1（自上而下），底部附列号。 */
function buildBoardText(state) {
  const size = Number.isInteger(state.size) ? state.size : BOARD_SIZE;
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const cells = state.board[y]
      .map((cell) => (cell === 'black' ? 'X' : cell === 'white' ? 'O' : '.'))
      .join(' ');
    rows.push(`${size - y} ${cells}`);
  }
  rows.push(`  ${COLUMNS.slice(0, size).split('').join(' ')}`);
  return rows.join('\n');
}

function buildMessages(state, legalMoves) {
  const size = Number.isInteger(state.size) ? state.size : BOARD_SIZE;
  const player = state.currentPlayer === 'black' ? '黑' : '白';
  const legalText = legalMoves.map((move) => formatCoord(move.x, move.y, size)).join(', ');
  const userPrompt = [
    `当前行棋方：${player}（${state.currentPlayer}）`,
    '棋盘（X=黑棋，O=白棋，.=空点；行号 9 在上、1 在下；列号 A–J 跳过 I）：',
    buildBoardText(state),
    `合法着点（只能从中选择）：${legalText}`,
    '请只输出一个 JSON 对象：正常落子输出 {"move":"E5"}，停一手输出 {"move":"pass"}；不要输出解释或代码块。',
  ].join('\n');

  return [
    {
      role: 'system',
      content: '你是 9 路围棋 AI。根据棋盘局面与合法着点选择一手棋，只输出 JSON 对象，不要输出任何解释或 Markdown。',
    },
    { role: 'user', content: userPrompt },
  ];
}

/**
 * 重试消息：把模型上一手的输出和错误原因回灌，要求它从合法列表中重新选择。
 * 大模型（尤其通用模型）经常给出已占点/编造坐标，一次反馈重试可显著提高成功率。
 */
function buildRetryMessages(state, legalMoves, previousContent, error) {
  const size = Number.isInteger(state.size) ? state.size : BOARD_SIZE;
  const legalText = legalMoves.map((move) => formatCoord(move.x, move.y, size)).join(', ');
  const reason = error instanceof Error ? error.message : String(error);
  return [
    ...buildMessages(state, legalMoves),
    { role: 'assistant', content: String(previousContent).slice(0, 2000) },
    {
      role: 'user',
      content: [
        `你刚才的输出不合法：${reason}`,
        `请重新选择，并且只能从以下合法着点中选择：${legalText}`,
        '停一手输出 {"move":"pass"}；只输出一个 JSON 对象，不要输出解释。',
      ].join('\n'),
    },
  ];
}

function extractContent(data) {
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  const message = choice && choice.message ? choice.message : null;
  const content = message ? message.content : null;

  if (typeof content === 'string' && content.trim()) return content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (typeof part === 'string' ? part : part && typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim();
    if (text) return text;
  }
  throw new Error('HTTP AI 响应缺少 choices[0].message.content');
}

function extractJsonText(content) {
  const text = String(content).trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return fenced ? fenced[1].trim() : text;
}

/**
 * 解析模型输出：支持 {"move":"E5"}、{"move":{"x":4,"y":4}}、{"move":"pass"}、
 * 纯 "pass" 字符串、```json 代码块；返回 {x,y} 或 null（pass）。非法时抛错。
 */
function parseModelMove(content, state, legalMoves) {
  const text = extractJsonText(content);
  let parsed;
  if (/^pass$/i.test(text)) {
    parsed = 'pass';
  } else {
    try {
      parsed = JSON.parse(text);
    } catch {
      // 容错：有些模型会在 JSON 前后附带说明文字，截取第一个 JSON 对象再试。
      const match = /\{[\s\S]*\}/.exec(text);
      if (!match) throw new Error(`无法解析 HTTP AI 返回内容：${text.slice(0, 120)}`);
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        throw new Error(`无法解析 HTTP AI 返回内容：${text.slice(0, 120)}`);
      }
    }
  }

  const raw =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.prototype.hasOwnProperty.call(parsed, 'move')
      ? parsed.move
      : parsed;

  if (raw === null || raw === undefined) throw new Error('HTTP AI 返回内容缺少 move 字段');
  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'pass') return null;

  const size = Number.isInteger(state.size) ? state.size : BOARD_SIZE;
  let coord = null;
  if (typeof raw === 'string') {
    coord = parseCoord(raw, size);
  } else if (raw && typeof raw === 'object' && Number.isInteger(raw.x) && Number.isInteger(raw.y)) {
    if (raw.x >= 0 && raw.x < size && raw.y >= 0 && raw.y < size) coord = { x: raw.x, y: raw.y };
  }
  if (!coord) throw new Error(`HTTP AI 返回了无法解析的着点：${JSON.stringify(raw)}`);

  const legal = legalMoves.some((move) => move.x === coord.x && move.y === coord.y);
  if (!legal) throw new Error(`HTTP AI 返回了非法着点：${formatCoord(coord.x, coord.y, size)}`);
  return coord;
}

function create({ env = process.env } = {}) {
  const baseUrl = trimBaseUrl(env.AI_HTTP_BASE_URL || '');
  const model = typeof env.AI_HTTP_MODEL === 'string' ? env.AI_HTTP_MODEL.trim() : '';
  if (!baseUrl) throw new Error('缺少环境变量 AI_HTTP_BASE_URL');
  if (!model) throw new Error('缺少环境变量 AI_HTTP_MODEL');

  const apiKey = typeof env.AI_HTTP_API_KEY === 'string' ? env.AI_HTTP_API_KEY.trim() : '';
  const timeoutMs = parseTimeoutMs(env.AI_HTTP_TIMEOUT_MS);
  const requestUrl = `${baseUrl}${normalizePath(env.AI_HTTP_PATH)}`;
  // 非法着点重试次数：默认 1 次；设为 0 可关闭；留空仍按默认 1 处理。
  const retryRawText = env.AI_HTTP_RETRY;
  const retryRaw =
    retryRawText !== undefined && retryRawText !== null && String(retryRawText).trim() !== ''
      ? Number(retryRawText)
      : NaN;
  const retryCount = Number.isFinite(retryRaw) && retryRaw >= 0 ? Math.min(2, Math.floor(retryRaw)) : 1;

  async function postChatCompletion(messages) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      const response = await fetch(requestUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, temperature: 0, stream: false, messages }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`HTTP AI 返回 HTTP ${response.status}${detail ? `：${redactSensitive(detail)}` : ''}`);
      }

      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error('HTTP AI 响应不是合法 JSON');
      }
      return extractContent(data);
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`HTTP AI 请求超时（${timeoutMs}ms）`);
      if (error instanceof Error) throw error;
      throw new Error(`HTTP AI 请求失败：${String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async getMove(game) {
      if (!game || typeof game.getState !== 'function' || typeof game.getLegalMoves !== 'function') return null;

      const state = game.getState();
      if (state.winner !== null) return null;

      const legalMoves = game.getLegalMoves();
      if (!Array.isArray(legalMoves) || legalMoves.length === 0) return null;

      let content = await postChatCompletion(buildMessages(state, legalMoves));
      let lastError = null;
      for (let attempt = 0; attempt <= retryCount; attempt += 1) {
        try {
          return parseModelMove(content, state, legalMoves);
        } catch (error) {
          lastError = error;
          if (attempt >= retryCount) break;
          content = await postChatCompletion(buildRetryMessages(state, legalMoves, content, error));
        }
      }
      throw lastError;
    },
  };
}

module.exports = { meta, available, create };
