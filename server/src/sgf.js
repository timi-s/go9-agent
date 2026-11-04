'use strict';

/**
 * SGF 序列化（docs/API.md 要求）。
 *
 * 格式：
 *   (;FF[4]GM[1]CA[UTF-8]SZ[9]KM[7.5]PB[黑方]PW[白方]DT[YYYY-MM-DD]RE[...]
 *    ;B[ee];W[]...)
 * 9 路坐标使用 a-i（不跳过 i）；pass 走 ;B[] / ;W[]。
 */

const COLUMNS = 'abcdefghi';

function formatDate(value) {
  const date = value instanceof Date ? value : new Date(value === undefined ? Date.now() : value);
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  return safeDate.toISOString().slice(0, 10);
}

function formatKomi(komi) {
  const value = typeof komi === 'number' && Number.isFinite(komi) ? komi : 7.5;
  return Number.isInteger(value) ? String(value) : String(value);
}

/** 坐标 -> SGF 字母（9 路：a-i，不跳过 i）。 */
function sgfCoord(x, y) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= COLUMNS.length || y < 0 || y >= COLUMNS.length) {
    return null;
  }
  return `${COLUMNS[x]}${COLUMNS[y]}`;
}

/**
 * 计算 RE 值：B+R / W+R / B+3.5 / W+2.5 / 0（和棋）。
 * 未终局返回空字符串（SGF 中写作 RE[]）。
 */
function sgfResult(state) {
  if (!state) return '';
  const winner = state.winner;
  if (winner === 'draw') return '0';
  if (winner !== 'black' && winner !== 'white') return '';
  const letter = winner === 'black' ? 'B' : 'W';
  const result = state.result && typeof state.result === 'object' ? state.result : null;
  if (result && result.method === 'resign') return `${letter}+R`;
  const margin = result && typeof result.margin === 'number' && Number.isFinite(result.margin) ? result.margin : null;
  if (margin !== null) return `${letter}+${margin}`;
  // 只有 winner、没有 result 细则时退化为认输格式，保证 RE 非空。
  return `${letter}+R`;
}

function formatMove(move) {
  const player = move && move.player === 'white' ? 'W' : 'B';
  if (!move || move.pass || move.x === null || move.x === undefined || move.y === null || move.y === undefined) {
    return `;${player}[]`;
  }
  const coord = sgfCoord(move.x, move.y);
  return coord ? `;${player}[${coord}]` : `;${player}[]`;
}

/**
 * 生成整局 SGF 文本。
 *
 * @param {object} game
 * @param {{ moves?: Array<object>, winner?: string|null, result?: object|null, komi?: number, createdAt?: string|Date, date?: string|Date }} [game]
 *        game 可以是 public GameState，也可以带 createdAt/date 的对局元信息。
 * @returns {string}
 */
function serializeSgf(game = {}) {
  const moves = Array.isArray(game.moves) ? game.moves : [];
  const header = [
    '(;FF[4]',
    'GM[1]',
    'CA[UTF-8]',
    'SZ[9]',
    `KM[${formatKomi(game.komi)}]`,
    'PB[黑方]',
    'PW[白方]',
    `DT[${formatDate(game.createdAt !== undefined ? game.createdAt : game.date)}]`,
    `RE[${sgfResult(game)}]`,
  ].join('');
  const body = moves.map(formatMove).join('');
  return `${header}${body})`;
}

module.exports = {
  COLUMNS,
  formatDate,
  formatKomi,
  sgfCoord,
  sgfResult,
  formatMove,
  serializeSgf,
};
