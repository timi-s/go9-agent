import { formatDateTime, gameStatus } from '../format';

/** 最近对局列表，点击载入历史棋局。 */
export default function GameHistory({
  games,
  activeId,
  loading,
  disabled,
  onSelect,
  onRefresh,
}) {
  return (
    <section className="panel">
      <div className="panel__head">
        <h2 className="panel__title">对局历史</h2>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={onRefresh}
          disabled={loading}
        >
          {loading ? '刷新中…' : '刷新'}
        </button>
      </div>

      {games.length === 0 ? (
        <p className="hint">还没有对局记录，点击「新对局」开始。</p>
      ) : (
        <ul className="game-list">
          {games.map((game) => {
            const status = gameStatus(game);
            return (
              <li key={game.id}>
                <button
                  type="button"
                  className={`game-row${
                    game.id === activeId ? ' game-row--active' : ''
                  }`}
                  onClick={() => onSelect(game.id)}
                  disabled={disabled}
                  title={`对局 ${game.id}`}
                >
                  <span className={`game-tag game-tag--${status.tone}`}>
                    {status.text}
                  </span>
                  <span className="game-row__moves">{game.moveCount ?? 0} 手</span>
                  <span className="game-row__time">
                    {formatDateTime(game.updatedAt)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
