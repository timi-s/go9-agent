import { describeResult, winnerName } from '../format';

/** 终局结果横幅（替代 alert）。 */
export default function ResultBanner({ state }) {
  if (!state || !state.winner) return null;

  return (
    <div className={`result result--${state.winner}`} role="status">
      <span className="result__tag">对局结束</span>
      <strong className="result__winner">{winnerName(state.winner)}</strong>
      <span className="result__detail">{describeResult(state.result)}</span>
    </div>
  );
}
