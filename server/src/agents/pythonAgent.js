'use strict';

/**
 * 本地 Python AI provider：把 server/ai/go_ai.py 作为子进程调用。
 *
 * 协议（见 ai/go_ai.py 顶部注释）：
 *   stdin  <- {"state": GameState 子集, "difficulty": "medium", "seed": 可选}
 *   stdout -> {"move": {"x":4,"y":4}} | {"move": null} | {"error": "..."}
 *
 * 环境变量：
 * - LOCAL_AI_PYTHON    Python 解释器（默认自动探测：Windows 用 python/py，其它用 python3/python）
 * - LOCAL_AI_SCRIPT    AI 脚本路径（默认 server/ai/go_ai.py）
 * - LOCAL_AI_TIMEOUT_MS 单次调用超时（默认 8000）
 * - LOCAL_AI_SEED      传给 Python AI 的随机种子（可选，便于复现）
 *
 * 失败（Python 缺失 / 超时 / 非法输出）时抛错，由 BuiltinWithPython 回退到 JS 内置 AI。
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SCRIPT = path.join(__dirname, '..', '..', 'ai', 'go_ai.py');
const DEFAULT_TIMEOUT_MS = 8000;

let resolveCache = { key: null, command: null };

/** 探测可用的 Python 解释器（带缓存，避免每次请求都 spawn）。 */
function resolvePythonCommand(env = process.env) {
  const explicit = typeof env.LOCAL_AI_PYTHON === 'string' ? env.LOCAL_AI_PYTHON.trim() : '';
  const cacheKey = explicit || '<auto>';
  if (resolveCache.key === cacheKey) return resolveCache.command;

  const candidates = explicit
    ? [explicit]
    : process.platform === 'win32'
      ? ['python', 'py', 'python3']
      : ['python3', 'python'];

  for (const candidate of candidates) {
    try {
      const result = spawnSync(candidate, ['--version'], {
        timeout: 3000,
        encoding: 'utf8',
        windowsHide: true,
      });
      if (result.status === 0) {
        resolveCache = { key: cacheKey, command: candidate };
        return candidate;
      }
    } catch {
      // 继续尝试下一个
    }
  }
  resolveCache = { key: cacheKey, command: null };
  return null;
}

function resolveScriptPath(env = process.env) {
  const configured = typeof env.LOCAL_AI_SCRIPT === 'string' ? env.LOCAL_AI_SCRIPT.trim() : '';
  return configured ? path.resolve(configured) : DEFAULT_SCRIPT;
}

function parseTimeout(env = process.env) {
  const value = Number(env.LOCAL_AI_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_TIMEOUT_MS;
}

function parseSeed(value) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.floor(parsed) >>> 0 : undefined;
}

function isAvailable(env = process.env) {
  try {
    if (!fs.existsSync(resolveScriptPath(env))) return false;
    return Boolean(resolvePythonCommand(env));
  } catch {
    return false;
  }
}

class PythonGoAgent {
  /**
   * @param {{ env?: NodeJS.ProcessEnv, seed?: number }} [options]
   */
  constructor({ env = process.env, seed } = {}) {
    this.env = env;
    const explicitSeed = parseSeed(seed);
    const envSeed = parseSeed(env && env.LOCAL_AI_SEED);
    this.seed = explicitSeed !== undefined ? explicitSeed : envSeed;
    this.command = resolvePythonCommand(env);
    this.script = resolveScriptPath(env);
    this.timeoutMs = parseTimeout(env);
    this.lastStats = null;
  }

  static isAvailable(env) {
    return isAvailable(env);
  }

  /**
   * @param {object} game Go9Game 实例（不会被修改）
   * @param {{ difficulty?: 'easy'|'medium'|'hard' }} [options]
   * @returns {Promise<{x:number,y:number}|null>}
   */
  async getMove(game, { difficulty = 'medium' } = {}) {
    if (!this.command) throw new Error('未找到 Python 解释器（可用 LOCAL_AI_PYTHON 指定）');
    if (!game || typeof game.getState !== 'function') return null;

    const state = game.getState();
    if (state.winner !== null && state.winner !== undefined) return null;

    const request = {
      state: {
        size: state.size,
        board: state.board,
        currentPlayer: state.currentPlayer,
        koPoint: state.koPoint,
        passCount: state.passCount,
        komi: state.komi,
      },
      difficulty,
      seed: this.seed,
    };

    const started = Date.now();
    const output = await this._run(JSON.stringify(request));
    const elapsedMs = Date.now() - started;

    let parsed;
    try {
      parsed = JSON.parse(output);
    } catch {
      throw new Error(`Python AI 返回的不是合法 JSON：${String(output).slice(0, 200)}`);
    }
    if (parsed && parsed.error) throw new Error(`Python AI 出错：${parsed.error}`);

    const move = parsed ? parsed.move : undefined;
    this.lastStats = {
      provider: 'python',
      elapsedMs,
      ...(parsed && parsed.stats ? parsed.stats : {}),
    };

    if (move === null || move === undefined) return null;
    if (!Number.isInteger(move.x) || !Number.isInteger(move.y)) {
      throw new Error(`Python AI 返回了无法解析的着点：${JSON.stringify(move)}`);
    }
    // 用真实规则引擎校验（Python 内部是简化盘面，最终以 Node 规则为准）。
    const legal = game.getLegalMoves();
    if (!legal.some((item) => item.x === move.x && item.y === move.y)) {
      throw new Error(`Python AI 返回了非法着点：(${move.x},${move.y})`);
    }
    return { x: move.x, y: move.y };
  }

  _run(input) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, [this.script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: this.env,
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');

      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };

      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // 忽略
        }
        finish(new Error(`Python AI 调用超时（${this.timeoutMs}ms）`));
      }, this.timeoutMs);

      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', (error) => {
        finish(new Error(`无法启动 Python AI（${this.command}）：${error.message}`));
      });
      child.stdin.on('error', (error) => {
        finish(new Error(`向 Python AI 写入请求失败：${error.message}`));
      });
      child.on('close', (code) => {
        const text = stdout.trim();
        if (code !== 0) {
          // Python 异常时会先在 stdout 写 {"error": ...} 再以非 0 退出，优先保留该诊断。
          let detail = '';
          try {
            const parsed = JSON.parse(text);
            if (parsed && parsed.error) detail = String(parsed.error);
          } catch {
            // 不是 JSON，退回 stderr
          }
          if (!detail) detail = stderr.trim();
          finish(new Error(`Python AI 退出码 ${code}${detail ? `：${detail.slice(0, 300)}` : ''}`));
          return;
        }
        finish(null, text);
      });

      try {
        child.stdin.write(input);
        child.stdin.end();
      } catch (error) {
        finish(new Error(`向 Python AI 写入请求失败：${error.message}`));
      }
    });
  }
}

module.exports = {
  PythonGoAgent,
  isAvailable,
  resolvePythonCommand,
  resolveScriptPath,
  DEFAULT_SCRIPT,
};
