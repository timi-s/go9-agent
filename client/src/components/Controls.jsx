/**
 * 操作按钮区。所有按钮的可用状态由 App 计算后传入，
 * 组件本身只负责展示与回调。
 */
export default function Controls({
  mode,
  locked,
  gameOver,
  myTurn,
  canAiStep,
  canUndo,
  canAnalyze,
  analyzing,
  exportHref,
  onPass,
  onUndo,
  onResign,
  onAiMove,
  onNewGame,
  onAnalyze,
}) {
  const actionDisabled = locked || gameOver;
  const passDisabled = actionDisabled || !myTurn;

  return (
    <div className="controls">
      <div className="controls__group">
        <button
          type="button"
          className="btn btn--primary"
          onClick={onPass}
          disabled={passDisabled}
          title="停一手（连续两次 PASS 结束对局）"
        >
          PASS
        </button>
        <button
          type="button"
          className="btn"
          onClick={onUndo}
          disabled={locked || !canUndo}
          title={mode === 'ai' ? '人机模式一次回退 2 手' : '回退 1 手'}
        >
          悔棋{mode === 'ai' ? '（2 手）' : ''}
        </button>
        <button
          type="button"
          className="btn"
          onClick={onAiMove}
          disabled={actionDisabled || !canAiStep}
          title="让 AI 替当前行棋方走一手"
        >
          AI 走一步
        </button>
        <button
          type="button"
          className="btn btn--danger"
          onClick={onResign}
          disabled={actionDisabled}
        >
          认输
        </button>
      </div>

      <div className="controls__group controls__group--end">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={onNewGame}
          disabled={locked}
        >
          新对局
        </button>
        <button
          type="button"
          className="btn btn--ghost"
          onClick={onAnalyze}
          disabled={locked || !canAnalyze || analyzing}
        >
          {analyzing ? '分析中…' : '复盘'}
        </button>
        {exportHref ? (
          <a
            className="btn btn--ghost"
            href={exportHref}
            target="_blank"
            rel="noreferrer"
            download
          >
            导出 SGF
          </a>
        ) : (
          <span className="btn btn--ghost btn--disabled">导出 SGF</span>
        )}
      </div>
    </div>
  );
}
