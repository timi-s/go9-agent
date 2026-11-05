import { useState } from 'react';
import {
  BOARD_SIZE,
  BOARD_VIEW,
  CELL,
  COLUMN_LABELS,
  ROW_LABELS,
  STAR_POINTS,
  gridPosition,
} from '../board';

const STONE_RADIUS = 17;
const STAR_RADIUS = 3.5;
const LAST_MARK_RADIUS = 4.5;
const HIT_SIZE = CELL;

function Stone({ x, y, player, isLast }) {
  const cx = gridPosition(x);
  const cy = gridPosition(y);
  return (
    <g>
      <circle
        cx={cx + 1.5}
        cy={cy + 2.5}
        r={STONE_RADIUS}
        fill="rgba(0, 0, 0, 0.38)"
      />
      <circle
        className="stone__body"
        cx={cx}
        cy={cy}
        r={STONE_RADIUS}
        fill={`url(#stone-${player})`}
      />
      {isLast ? (
        <circle className="stone__last" cx={cx} cy={cy} r={LAST_MARK_RADIUS} />
      ) : null}
    </g>
  );
}

/**
 * 纯展示 + 交互的 SVG 棋盘。
 * 只把点击位置交给上层，合法性完全由后端判定。
 */
export default function GoBoard({ state, disabled, onPlay }) {
  const [hover, setHover] = useState(null);

  const board = state.board;
  const lastMove = state.lastMove;
  const currentPlayer = state.currentPlayer;
  const interactive = !disabled && !state.winner;
  const hoverPoint =
    interactive && hover && !board[hover.y][hover.x] ? hover : null;

  const handleClick = (x, y) => {
    if (!interactive) return;
    if (board[y][x]) return;
    onPlay(x, y);
  };

  const handleEnter = (x, y) => {
    if (!interactive || board[y][x]) return;
    setHover({ x, y });
  };

  return (
    <svg
      className={`go-board${interactive ? '' : ' go-board--locked'}`}
      viewBox={`0 0 ${BOARD_VIEW} ${BOARD_VIEW}`}
      role="group"
      aria-label="九路围棋棋盘"
    >
      <title>九路围棋棋盘</title>
      <defs>
        <linearGradient id="board-wood" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#eccd98" />
          <stop offset="52%" stopColor="#dfb87c" />
          <stop offset="100%" stopColor="#cfa261" />
        </linearGradient>
        <radialGradient id="board-sheen" cx="32%" cy="18%" r="82%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.26" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="stone-black" cx="35%" cy="28%" r="78%">
          <stop offset="0%" stopColor="#616a79" />
          <stop offset="48%" stopColor="#262b33" />
          <stop offset="100%" stopColor="#05070a" />
        </radialGradient>
        <radialGradient id="stone-white" cx="35%" cy="28%" r="78%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="58%" stopColor="#eff2f5" />
          <stop offset="100%" stopColor="#c3c9d1" />
        </radialGradient>
      </defs>

      <rect width={BOARD_VIEW} height={BOARD_VIEW} rx="12" fill="url(#board-wood)" />
      <rect width={BOARD_VIEW} height={BOARD_VIEW} rx="12" fill="url(#board-sheen)" />
      <rect
        x="0.75"
        y="0.75"
        width={BOARD_VIEW - 1.5}
        height={BOARD_VIEW - 1.5}
        rx="12"
        fill="none"
        stroke="rgba(70, 45, 18, 0.45)"
        strokeWidth="1.5"
      />

      <g className="board-grid">
        {Array.from({ length: BOARD_SIZE }, (_, i) => (
          <line
            key={`grid-h-${i}`}
            className={i === 0 || i === BOARD_SIZE - 1 ? 'board-grid__edge' : ''}
            x1={gridPosition(0)}
            y1={gridPosition(i)}
            x2={gridPosition(BOARD_SIZE - 1)}
            y2={gridPosition(i)}
          />
        ))}
        {Array.from({ length: BOARD_SIZE }, (_, i) => (
          <line
            key={`grid-v-${i}`}
            className={i === 0 || i === BOARD_SIZE - 1 ? 'board-grid__edge' : ''}
            x1={gridPosition(i)}
            y1={gridPosition(0)}
            x2={gridPosition(i)}
            y2={gridPosition(BOARD_SIZE - 1)}
          />
        ))}
      </g>

      <g className="board-stars">
        {STAR_POINTS.map(([x, y]) => (
          <circle
            key={`star-${x}-${y}`}
            cx={gridPosition(x)}
            cy={gridPosition(y)}
            r={STAR_RADIUS}
          />
        ))}
      </g>

      <g className="board-coords">
        {COLUMN_LABELS.map((label, x) => (
          <g key={`col-${label}`}>
            <text
              className="board-coord"
              x={gridPosition(x)}
              y={10}
              textAnchor="middle"
              dominantBaseline="middle"
            >
              {label}
            </text>
            <text
              className="board-coord"
              x={gridPosition(x)}
              y={BOARD_VIEW - 10}
              textAnchor="middle"
              dominantBaseline="middle"
            >
              {label}
            </text>
          </g>
        ))}
        {ROW_LABELS.map((label, y) => (
          <g key={`row-${label}`}>
            <text
              className="board-coord"
              x={10}
              y={gridPosition(y)}
              textAnchor="middle"
              dominantBaseline="middle"
            >
              {label}
            </text>
            <text
              className="board-coord"
              x={BOARD_VIEW - 10}
              y={gridPosition(y)}
              textAnchor="middle"
              dominantBaseline="middle"
            >
              {label}
            </text>
          </g>
        ))}
      </g>

      <g className="board-stones">
        {board.map((row, y) =>
          row.map((cell, x) =>
            cell ? (
              <Stone
                key={`stone-${x}-${y}`}
                x={x}
                y={y}
                player={cell}
                isLast={Boolean(lastMove && lastMove.x === x && lastMove.y === y)}
              />
            ) : null,
          ),
        )}
      </g>

      {hoverPoint ? (
        <circle
          className={`board-ghost board-ghost--${currentPlayer}`}
          cx={gridPosition(hoverPoint.x)}
          cy={gridPosition(hoverPoint.y)}
          r={STONE_RADIUS}
        />
      ) : null}

      <g className="board-hits">
        {Array.from({ length: BOARD_SIZE }, (_, y) =>
          Array.from({ length: BOARD_SIZE }, (_, x) => (
            <rect
              key={`hit-${x}-${y}`}
              className="board-hit"
              x={gridPosition(x) - HIT_SIZE / 2}
              y={gridPosition(y) - HIT_SIZE / 2}
              width={HIT_SIZE}
              height={HIT_SIZE}
              onClick={() => handleClick(x, y)}
              onPointerEnter={() => handleEnter(x, y)}
              onPointerLeave={() => setHover(null)}
            />
          )),
        )}
      </g>
    </svg>
  );
}
