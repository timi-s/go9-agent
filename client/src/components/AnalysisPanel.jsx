import { intersectionLabel } from '../board';

const GRADE_ORDER = ['A', 'B', 'C', 'D'];
const PHASE_KEYS = ['opening', 'middle', 'endgame'];
const PHASE_LABELS = { opening: '布局', middle: '中盘', endgame: '收官' };
const SEVERITY_ORDER = ['inaccuracy', 'mistake', 'blunder'];
const SEVERITY_LABELS = {
  inaccuracy: '小失误',
  mistake: '失误',
  blunder: '严重失误',
};
const WEAKNESS_ORDER = ['high', 'medium', 'low'];
const WEAKNESS_SEVERITY_LABELS = { high: '高', medium: '中', low: '低' };
const REASON_LABELS = {
  self_atari: '自陷打吃',
  missed_capture: '漏掉提子',
  filled_own_eye: '填自己的眼',
  early_first_line: '过早下在一线',
  inefficient: '效率偏低',
};
const GRADE_NOTES = {
  A: '平均损失低，整体质量高',
  B: '整体稳健，个别手可改进',
  C: '有明显可提升空间',
  D: '失误较多，建议重点复盘',
};
const MAX_MISTAKES = 10;

function toNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function formatPercent(accuracy) {
  if (accuracy === null) return '—';
  return `${Math.round(accuracy * 1000) / 10}%`;
}

function formatLoss(loss) {
  if (loss === null) return '—';
  return `${Math.round(loss * 10) / 10}`;
}

function deriveGrade(accuracy, averageLoss) {
  if (averageLoss !== null) {
    if (averageLoss < 6) return 'A';
    if (averageLoss < 15) return 'B';
    if (averageLoss < 30) return 'C';
    return 'D';
  }
  if (accuracy === null) return null;
  if (accuracy >= 0.9) return 'A';
  if (accuracy >= 0.75) return 'B';
  if (accuracy >= 0.6) return 'C';
  return 'D';
}

function pointLabel(point) {
  if (!point) return 'PASS';
  return intersectionLabel(point.x, point.y);
}

function normalizePhases(phases) {
  if (!phases || typeof phases !== 'object') return [];
  return PHASE_KEYS.map((key) => {
    const phase = phases[key];
    if (!phase || typeof phase !== 'object') return null;
    return {
      key,
      label: phase.label || PHASE_LABELS[key],
      accuracy: toNumber(phase.accuracy),
      averageLoss: toNumber(phase.averageLoss),
      comparedMoves: toNumber(phase.comparedMoves),
    };
  }).filter(Boolean);
}

function normalizeWeakness(weakness) {
  const severity = WEAKNESS_ORDER.includes(weakness.severity)
    ? weakness.severity
    : 'medium';
  return {
    code: weakness.code || '',
    label: weakness.label || weakness.code || '弱点',
    count: toNumber(weakness.count) ?? 0,
    severity,
    advice: weakness.advice || '',
  };
}

function normalizeMistake(mistake) {
  const severity = SEVERITY_ORDER.includes(mistake.severity)
    ? mistake.severity
    : null;
  return {
    moveIndex: toNumber(mistake.moveIndex) ?? 0,
    played: mistake.played || null,
    recommended: mistake.recommended || null,
    loss: toNumber(mistake.loss),
    severity,
    reason: mistake.reason || '',
    reasonLabel: mistake.reasonLabel || REASON_LABELS[mistake.reason] || mistake.reason || '',
  };
}

/** 兼容新报告结构（评级/阶段/弱点/严重度）与旧结构（accuracy/mismatches/mistakes）。 */
function normalizeAnalysis(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const totalMoves = toNumber(raw.totalMoves) ?? 0;
  const mismatches = toNumber(raw.mismatches) ?? 0;
  const comparedMoves = toNumber(raw.comparedMoves) ?? totalMoves;
  const accuracy = toNumber(raw.accuracy);
  const averageLoss = toNumber(raw.averageLoss);
  const grade = GRADE_ORDER.includes(raw.grade) ? raw.grade : deriveGrade(accuracy, averageLoss);
  const phases = normalizePhases(raw.phases);
  const weaknesses = Array.isArray(raw.weaknesses)
    ? raw.weaknesses.filter(Boolean).map(normalizeWeakness)
    : [];
  const mistakes = Array.isArray(raw.mistakes)
    ? raw.mistakes.filter(Boolean).slice(0, MAX_MISTAKES).map(normalizeMistake)
    : [];

  return {
    totalMoves,
    comparedMoves,
    mismatches,
    accuracy,
    averageLoss,
    grade,
    phases,
    weaknesses,
    mistakes,
    summary: raw.summary || '',
  };
}

function PhaseRow({ phase }) {
  return (
    <li className="phase">
      <div className="phase__head">
        <span className="phase__label">{phase.label}</span>
        <span className="phase__value">{formatPercent(phase.accuracy)}</span>
      </div>
      <progress
        className="analysis__progress phase__progress"
        value={phase.accuracy === null ? 0 : Math.round(phase.accuracy * 1000) / 10}
        max="100"
        aria-label={`${phase.label}首选一致率`}
      />
      <div className="phase__meta">
        <span>平均损失 {formatLoss(phase.averageLoss)}</span>
        {phase.comparedMoves !== null ? (
          <span>可分析 {phase.comparedMoves} 手</span>
        ) : null}
      </div>
    </li>
  );
}

function WeaknessItem({ weakness }) {
  return (
    <li className={`weakness weakness--${weakness.severity}`}>
      <div className="weakness__head">
        <span className="weakness__label">{weakness.label}</span>
        <span className="weakness__count">{weakness.count} 次</span>
        <span className={`sev sev--${weakness.severity}`}>
          {WEAKNESS_SEVERITY_LABELS[weakness.severity]}
        </span>
      </div>
      {weakness.advice ? <p className="weakness__advice">{weakness.advice}</p> : null}
    </li>
  );
}

function MistakeItem({ mistake }) {
  return (
    <li className="mistake">
      <span className="mistake__index">第 {mistake.moveIndex + 1} 手</span>
      {mistake.severity ? (
        <span className={`sev sev--${mistake.severity}`}>
          {SEVERITY_LABELS[mistake.severity]}
        </span>
      ) : null}
      <span className="mistake__played">实下 {pointLabel(mistake.played)}</span>
      <span className="mistake__arrow" aria-hidden="true">
        →
      </span>
      <span className="mistake__recommended">
        推荐 {pointLabel(mistake.recommended)}
      </span>
      {mistake.loss !== null ? (
        <span className="mistake__loss">损失 {formatLoss(mistake.loss)}</span>
      ) : null}
      {mistake.reasonLabel ? (
        <span className="mistake__reason">{mistake.reasonLabel}</span>
      ) : null}
    </li>
  );
}

/** 赛后分析报告：评级、阶段对比、弱点建议与失误列表（含旧数据兼容）。 */
export default function AnalysisPanel({
  analysis,
  analyzing,
  error,
  canAnalyze,
  onAnalyze,
}) {
  const view = normalizeAnalysis(analysis);

  return (
    <section className="panel">
      <div className="panel__head">
        <h2 className="panel__title">复盘分析</h2>
        {view ? <span className="badge">{view.mismatches} 手与首选不同</span> : null}
      </div>

      {analyzing ? (
        <p className="hint hint--row">
          <span className="spinner spinner--sm" aria-hidden="true" />
          正在与 AI 首选着法比对…
        </p>
      ) : null}

      {!analyzing && error ? (
        <>
          <p className="hint hint--error">{error}</p>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={onAnalyze}
            disabled={!canAnalyze}
          >
            重试分析
          </button>
        </>
      ) : null}

      {!analyzing && !view && !error ? (
        <>
          <p className="hint">
            {canAnalyze
              ? '点击复盘，查看评级、阶段表现与失误原因。'
              : '落子之后就可以开始复盘了。'}
          </p>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={onAnalyze}
            disabled={!canAnalyze}
          >
            开始复盘
          </button>
        </>
      ) : null}

      {!analyzing && view ? (
        <div className="analysis">
          {view.comparedMoves === 0 ? (
            <p className="hint">没有可分析的手数（对局只有停一手）。</p>
          ) : (
            <>
              <div className="report__hero">
                <span className={`grade${view.grade ? ` grade--${view.grade}` : ' grade--none'}`}>
                  {view.grade || '—'}
                </span>
                <div className="report__hero-text">
                  <span className="report__hero-label">综合评级（按损失）</span>
                  <span className="report__hero-note">
                    {view.grade ? GRADE_NOTES[view.grade] : '暂无评级'}
                  </span>
                </div>
              </div>

              <div className="report__stats">
                <div className="report__stat">
                  <span className="report__stat-label">首选一致率</span>
                  <span className="report__stat-value">{formatPercent(view.accuracy)}</span>
                </div>
                <div className="report__stat">
                  <span className="report__stat-label">平均损失</span>
                  <span className="report__stat-value">{formatLoss(view.averageLoss)}</span>
                </div>
                <div className="report__stat">
                  <span className="report__stat-label">可分析手数</span>
                  <span className="report__stat-value">
                    {view.comparedMoves}/{view.totalMoves}
                  </span>
                </div>
              </div>

              <p className="hint">
                评级按平均损失与严重失误数计算；首选一致率只表示是否猜中 AI 第一选点。
              </p>

              {view.phases.length > 0 ? (
                <div className="report__section">
                  <h3 className="report__section-title">阶段对比</h3>
                  <ul className="phases">
                    {view.phases.map((phase) => (
                      <PhaseRow key={phase.key} phase={phase} />
                    ))}
                  </ul>
                </div>
              ) : null}

              {view.weaknesses.length > 0 ? (
                <div className="report__section">
                  <h3 className="report__section-title">弱点建议</h3>
                  <ul className="weaknesses">
                    {view.weaknesses.map((weakness, index) => (
                      <WeaknessItem
                        key={`${weakness.code || weakness.label}-${index}`}
                        weakness={weakness}
                      />
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="report__section">
                <h3 className="report__section-title">
                  失误列表
                  <span className="report__section-count">{view.mistakes.length}</span>
                </h3>
                {view.mistakes.length > 0 ? (
                  <ul className="mistakes">
                    {view.mistakes.map((mistake, index) => (
                      <MistakeItem
                        key={`${mistake.moveIndex}-${pointLabel(mistake.played)}-${index}`}
                        mistake={mistake}
                      />
                    ))}
                  </ul>
                ) : (
                  <p className="hint">没有明显失误。</p>
                )}
              </div>
            </>
          )}

          {view.summary ? <p className="analysis__summary">{view.summary}</p> : null}

          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={onAnalyze}
            disabled={!canAnalyze || analyzing}
          >
            重新分析
          </button>
        </div>
      ) : null}
    </section>
  );
}
