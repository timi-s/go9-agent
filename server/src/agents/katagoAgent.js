'use strict';

/**
 * KataGo GTP provider（本地子进程）。
 *
 * 环境变量：
 * - KATAGO_CMD        必填，KataGo 可执行文件路径（绝对路径时要求文件存在；也支持 PATH 中的命令）
 * - KATAGO_ARGS       可选，空格分隔的启动参数，例如：
 *                     "gtp -model C:\\tools\\katago\\model.bin.gz -config C:\\tools\\katago\\gtp.cfg"
 * - KATAGO_TIMEOUT_MS 可选，单条 GTP 命令超时，默认 15000
 *
 * 行为：
 * - 惰性 spawn 一个 GTP 进程并复用；命令串行化（同一时刻只有一条未完成命令）。
 * - 每次 getMove：clear_board → boardsize 9 → komi 7.5 → 按 moves 重放 play → genmove。
 * - genmove 的 "pass" 映射为 null；"resign" / 超时 / 进程退出 / 非法输出都会抛错，
 *   由 registry 回退到内置启发式；超时或崩溃后会 kill 进程，下次 getMove 自动重新 spawn。
 *
 * 导出的 provider 形状（见 docs/AGENT-INTEGRATION.md）：
 *   { meta, available(env), create({ env }) -> { getMove(game, { difficulty }), close() } }
 */

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const COLUMNS = 'ABCDEFGHJ'; // 9 路：A-H + J（跳过 I）
const BOARD_SIZE = 9;
const DEFAULT_TIMEOUT_MS = 15000;

const meta = {
  id: 'katago',
  label: 'KataGo GTP',
  kind: 'engine',
  description: '通过 GTP 协议调用本地 KataGo 引擎（棋力最强，需要自行安装引擎与 9 路权重）',
  requires: ['KATAGO_CMD'],
};

function available(env = process.env) {
  const cmd = typeof env.KATAGO_CMD === 'string' ? env.KATAGO_CMD.trim() : '';
  if (!cmd) return false;
  if (!path.isAbsolute(cmd)) return true; // 交给 PATH 解析
  try {
    return fs.existsSync(cmd);
  } catch {
    return false;
  }
}

function parseArgs(value) {
  if (typeof value !== 'string' || !value.trim()) return [];
  return value.trim().split(/\s+/);
}

function parseTimeoutMs(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_TIMEOUT_MS;
}

function formatGtpCoord(x, y, size = BOARD_SIZE) {
  return `${COLUMNS[x]}${size - y}`;
}

/** GTP 坐标（列 A-J 跳过 I，行 1-9 自下而上）→ 本项目 (x, y)，y=0 在顶部。 */
function parseGtpCoord(text, size = BOARD_SIZE) {
  const match = /^([A-Za-z])(\d{1,2})$/.exec(String(text).trim());
  if (!match) return null;
  const x = COLUMNS.indexOf(match[1].toUpperCase());
  const row = Number(match[2]);
  if (x < 0 || x >= size || !Number.isInteger(row) || row < 1 || row > size) return null;
  return { x, y: size - row };
}

function parseGenmoveResponse(response, size = BOARD_SIZE) {
  const text = String(response || '').trim();
  if (!text) throw new Error('KataGo genmove 未返回结果');
  const lowered = text.toLowerCase();
  if (lowered === 'pass') return null;
  if (lowered === 'resign') throw new Error('KataGo 选择认输（resign）');
  const coord = parseGtpCoord(text, size);
  if (!coord) throw new Error(`无法解析 KataGo genmove 结果：${text}`);
  return coord;
}

class KatagoGtpClient {
  constructor({ cmd, args, timeoutMs }) {
    this.cmd = cmd;
    this.args = args;
    this.timeoutMs = timeoutMs;
    this._process = null;
    this._buffer = '';
    this._stderr = '';
    this._pending = null;
    this._queue = Promise.resolve();
    this._closed = false;
  }

  /** 复用的 GTP 子进程；不存在/已退出时重新 spawn。 */
  _ensureProcess() {
    if (this._closed) throw new Error('KataGo 客户端已关闭');
    if (this._process !== null) return this._process;

    let child;
    try {
      child = childProcess.spawn(this.cmd, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      throw new Error(`无法启动 KataGo（${this.cmd}）：${error instanceof Error ? error.message : String(error)}`);
    }

    this._process = child;
    this._buffer = '';
    this._stderr = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this._stderr = (this._stderr + chunk).slice(-2000);
    });
    child.stdin.on('error', (streamError) => {
      this._failPending(new Error(`写入 KataGo 失败：${streamError instanceof Error ? streamError.message : String(streamError)}`));
    });
    child.on('error', (error) => {
      this._failPending(new Error(`KataGo 进程错误：${error instanceof Error ? error.message : String(error)}`));
      this._dropProcess();
    });
    child.on('exit', (code, signal) => {
      const stderr = this._stderr.trim();
      this._failPending(
        new Error(`KataGo 进程退出（code=${code}, signal=${signal}）${stderr ? `：${stderr.slice(-300)}` : ''}`),
      );
      this._dropProcess();
    });

    return child;
  }

  _dropProcess() {
    this._process = null;
    this._buffer = '';
  }

  _onStdout(chunk) {
    this._buffer += chunk;
    let separator = this._buffer.indexOf('\n\n');
    while (separator >= 0) {
      const block = this._buffer.slice(0, separator);
      this._buffer = this._buffer.slice(separator + 2);
      this._handleBlock(block);
      separator = this._buffer.indexOf('\n\n');
    }
  }

  /** GTP 响应块：以 "= "（成功）或 "? "（失败）开头的多行文本，以空行结束。 */
  _handleBlock(block) {
    const lines = block.replace(/\r/g, '').split('\n');
    const statusIndex = lines.findIndex((line) => /^[=?](\s|$)/.test(line));
    if (statusIndex < 0) return; // 忽略引擎启动横幅等非 GTP 输出

    const statusLine = lines[statusIndex].trim();
    const status = statusLine[0];
    const content = [statusLine.slice(1).trim(), ...lines.slice(statusIndex + 1).map((line) => line.trim())]
      .filter(Boolean)
      .join('\n');

    if (this._pending === null) return;
    const pending = this._pending;
    this._pending = null;
    clearTimeout(pending.timer);
    if (status === '?') pending.reject(new Error(`KataGo 返回错误：${content || statusLine}`));
    else pending.resolve(content);
  }

  /** 串行化发送 GTP 命令（前一条完成/失败后才发下一条）。 */
  _send(command) {
    const run = this._queue.then(() => this._sendNow(command));
    this._queue = run.then(() => undefined, () => undefined);
    return run;
  }

  _sendNow(command) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this._ensureProcess();
      } catch (error) {
        reject(error);
        return;
      }
      if (this._pending !== null) {
        reject(new Error('KataGo 命令队列异常：存在未完成的请求'));
        return;
      }

      const pending = { resolve, reject, command, timer: null };
      pending.timer = setTimeout(() => {
        this._failPending(new Error(`KataGo 命令超时（${this.timeoutMs}ms）：${command}`));
        this._killProcess();
      }, this.timeoutMs);
      if (typeof pending.timer.unref === 'function') pending.timer.unref();
      this._pending = pending;

      try {
        child.stdin.write(`${command}\n`);
      } catch (error) {
        this._failPending(new Error(`写入 KataGo 失败：${error instanceof Error ? error.message : String(error)}`));
        this._killProcess();
      }
    });
  }

  _failPending(error) {
    if (this._pending === null) return;
    const pending = this._pending;
    this._pending = null;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  _killProcess() {
    const child = this._process;
    this._process = null;
    this._buffer = '';
    if (child) {
      try {
        child.kill('SIGKILL');
      } catch {
        // 进程可能已退出，忽略
      }
    }
  }

  async getMove(game) {
    if (!game || typeof game.getState !== 'function') return null;
    const state = game.getState();
    if (state.winner !== null) return null;

    const size = Number.isInteger(state.size) ? state.size : BOARD_SIZE;
    const komi = typeof state.komi === 'number' ? state.komi : 7.5;

    await this._send('clear_board');
    await this._send(`boardsize ${size}`);
    await this._send(`komi ${komi}`);
    for (const move of state.moves) {
      const color = move.player === 'white' ? 'W' : 'B';
      if (move.pass === true || move.x === null || move.y === null) {
        await this._send(`play ${color} pass`);
      } else {
        await this._send(`play ${color} ${formatGtpCoord(move.x, move.y, size)}`);
      }
    }

    const color = state.currentPlayer === 'white' ? 'W' : 'B';
    const response = await this._send(`genmove ${color}`);
    return parseGenmoveResponse(response, size);
  }

  async close() {
    this._closed = true;
    const child = this._process;
    this._failPending(new Error('KataGo 客户端已关闭'));
    if (!child) {
      this._killProcess();
      return;
    }

    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // 进程可能已退出
        }
        finish();
      }, 500);
      if (typeof timer.unref === 'function') timer.unref();
      child.once('exit', finish);
      try {
        child.stdin.write('quit\n');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          // 忽略
        }
        finish();
      }
    });

    this._process = null;
    this._buffer = '';
  }
}

function create({ env = process.env } = {}) {
  const cmd = typeof env.KATAGO_CMD === 'string' ? env.KATAGO_CMD.trim() : '';
  if (!cmd) throw new Error('缺少环境变量 KATAGO_CMD');
  return new KatagoGtpClient({
    cmd,
    args: parseArgs(env.KATAGO_ARGS),
    timeoutMs: parseTimeoutMs(env.KATAGO_TIMEOUT_MS),
  });
}

module.exports = { meta, available, create };
