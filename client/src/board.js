// 9 路棋盘的几何常量与坐标换算（与渲染、接口层共享）。

export const BOARD_SIZE = 9;
export const CELL = 40;
const PADDING = 20;
export const BOARD_VIEW = PADDING * 2 + CELL * (BOARD_SIZE - 1);

// 星位使用 0 起点坐标：(2,2) (2,6) (6,2) (6,6)
export const STAR_POINTS = [
  [2, 2],
  [2, 6],
  [6, 2],
  [6, 6],
];

// 围棋习惯：列字母跳过 I，行号自下而上 1-9。
export const COLUMN_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J'];
export const ROW_LABELS = [9, 8, 7, 6, 5, 4, 3, 2, 1];

/** 交叉点在 SVG 中的像素坐标。 */
export function gridPosition(index) {
  return PADDING + index * CELL;
}

/** 把 0 起点坐标转成人类可读坐标，如 (4, 4) -> "E5"；PASS 返回 "PASS"。 */
export function intersectionLabel(x, y) {
  if (x === null || x === undefined || y === null || y === undefined) return 'PASS';
  const column = COLUMN_LABELS[x];
  const row = ROW_LABELS[y];
  if (!column || !row) return '—';
  return `${column}${row}`;
}
