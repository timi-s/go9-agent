import { playerName } from '../format';

/** 棋盘下方的状态栏：当前行棋方、提子数、手数、贴目与所用 AI。 */
export default function GameStatus({ state, mode, thinking, providerLabel }) {
  const gameOver = Boolean(state.winner);
  const turnText = gameOver
    ? '对局结束'
    : thinking
      ? 'AI 思考中…'
      : playerName(state.currentPlayer);
  const captures = state.captures || { black: 0, white: 0 };
  const aiLabel = providerLabel || '内置 AI';

  return (
    <div
      className={`status-bar${thinking ? ' status-bar--thinking' : ''}`}
      role="status"
      aria-live="polite"
    >
      <div className="status-item">
        <span className="status-label">当前行棋</span>
        <span className="status-value status-value--turn">
          <span
            className={`stone-dot stone-dot--${
              gameOver ? 'draw' : state.currentPlayer
            }`}
            aria-hidden="true"
          />
          {turnText}
          {thinking ? <span className="spinner spinner--sm" aria-hidden="true" /> : null}
        </span>
      </div>
      <div className="status-item">
        <span className="status-label">提子</span>
        <span className="status-value">
          黑 {captures.black ?? 0} · 白 {captures.white ?? 0}
        </span>
      </div>
      <div className="status-item">
        <span className="status-label">手数</span>
        <span className="status-value">{state.moveCount ?? 0}</span>
      </div>
      <div className="status-item">
        <span className="status-label">贴目</span>
        <span className="status-value">{state.komi}</span>
      </div>
      <div className="status-item">
        <span className="status-label">模式</span>
        <span className="status-value status-value--mode" title={aiLabel}>
          {mode === 'ai' ? `人机对战 · ${aiLabel}` : '双人对弈'}
        </span>
      </div>
    </div>
  );
}
