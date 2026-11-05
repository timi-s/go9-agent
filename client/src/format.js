// 展示层格式化工具（玩家名、结果、时间等）。

const PLAYER_NAMES = {
  black: '黑方',
  white: '白方',
};

export function playerName(player) {
  return PLAYER_NAMES[player] || '未知';
}

export function winnerName(winner) {
  if (winner === 'draw') return '和棋';
  if (winner === 'black' || winner === 'white') return `${playerName(winner)}胜`;
  return '对局结束';
}

export function formatNumber(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** 把 GameState.result 描述成一句可读文案。 */
export function describeResult(result) {
  if (!result) return '';
  if (result.method === 'resign') {
    return '一方认输，对局提前结束。';
  }
  if (result.method === 'score') {
    const black = formatNumber(result.black);
    const white = formatNumber(result.white);
    const margin = formatNumber(result.margin);
    return `数子：黑 ${black} 目 · 白 ${white} 目（白贴 7.5 目），${winnerName(result.winner)} ${margin} 目。`;
  }
  return '';
}

export function formatDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 对局列表项的状态展示。 */
export function gameStatus(game) {
  if (!game) return { text: '未知', tone: 'playing' };
  if (game.winner === 'black') return { text: '黑胜', tone: 'black' };
  if (game.winner === 'white') return { text: '白胜', tone: 'white' };
  if (game.winner === 'draw') return { text: '和棋', tone: 'draw' };
  return { text: '进行中', tone: 'playing' };
}
