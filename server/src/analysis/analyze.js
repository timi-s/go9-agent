'use strict';

/**
 * 复盘分析（纯函数，不依赖 HTTP / 数据库）。
 *
 * 输入：{ moves, komi, scorer }
 * - moves：完整着法历史（GameState.moves，含 pass）
 * - komi：贴目（默认 7.5）
 * - scorer：{ scoreMoves(game, { noise:false }) -> [{x,y,score}] }，通常为
 *   new HeuristicGoAgent({ seed: 1 })。也接受函数 (game) => ranked。
 *
 * 输出结构（固定契约）：
 * {
 *   totalMoves, comparedMoves, mismatches, accuracy, averageLoss, grade,   // A/B/C/D
 *   phases: { opening:{label:'布局',...}, middle:{label:'中盘',...}, endgame:{label:'收官',...} },
 *   weaknesses: [{ code, label, count, severity:'high'|'medium'|'low', advice }],
 *   mistakes: [{ moveIndex, played, recommended, loss, severity, reason }],  // 最多 10 条，最近优先
 *   summary: string
 * }
 *
 * 语义：
 * - pass 计入 totalMoves / phases.moves，但不参与比较。
 * - comparedMoves = 非 pass 手数；mismatches = 实手坐标与 AI 首选不同的手数。
 * - loss = max(0, best.score - played.score)，分级 inaccuracy(>=15) / mistake(>=40) / blunder(>=80)。
 * - weaknesses 聚合的是“非 good 手”（loss >= 15，即被分级的失误）的 reason code。
 */

const Go9Game = require('../games/go9');

const MAX_MISTAKES = 10;
const PHASE_BOUNDS = { openingEnd: 16, middleEnd: 50 };
const FIRST_LINE_WINDOW = 20;
const MISTAKE_MIN_LOSS = 15;
const MISTAKE_MISTAKE_LOSS = 40;
const MISTAKE_BLUNDER_LOSS = 80;

const WEAKNESS_META = {
  self_atari: {
    label: '自陷打吃',
    advice: '避免把己方棋块下到只剩一口气的位置，先保证有退路或能反提。',
  },
  missed_capture: {
    label: '漏掉提子',
    advice: '对方棋块只剩一口气时优先提子，不要放过送到嘴边的战果。',
  },
  filled_own_eye: {
    label: '填自己的眼',
    advice: '不要填自己的真眼，保留眼位才能保证棋块安全与做活。',
  },
  early_first_line: {
    label: '过早下在一线',
    advice: '前 20 手尽量避免一线落子，优先占角、星位与三/四线。',
  },
  inefficient: {
    label: '效率偏低',
    advice: '这一手与 AI 首选差距较大，注意棋块联络、全局效率与先后手价值。',
  },
};

function round2(value) {
  return Math.round(value * 100) / 100;
}

function isPassMove(move) {
  return (
    !move ||
    move.pass === true ||
    move.x === null ||
    move.x === undefined ||
    move.y === null ||
    move.y === undefined
  );
}

function phaseKeyForIndex(index) {
  if (index < PHASE_BOUNDS.openingEnd) return 'opening';
  if (index < PHASE_BOUNDS.middleEnd) return 'middle';
  return 'endgame';
}

function createPhase(label) {
  return { label, moves: 0, comparedMoves: 0, mismatches: 0, accuracy: 1, averageLoss: 0 };
}

function severityOfLoss(loss) {
  if (loss >= MISTAKE_BLUNDER_LOSS) return 'blunder';
  if (loss >= MISTAKE_MISTAKE_LOSS) return 'mistake';
  if (loss >= MISTAKE_MIN_LOSS) return 'inaccuracy';
  return null;
}

/**
 * 综合评级：以“平均损失 + 严重失误数”为主，避免出现
 * “只因为没下在 AI 第一选点、但每手只差 1 分”也被评为 D 的误导。
 * accuracy（首选一致率）保留为诊断指标，不作为评级门槛。
 */
function gradeOf(accuracy, averageLoss, counts = {}) {
  const blunders = Number.isFinite(counts.blunders) ? counts.blunders : 0;
  const mistakes = Number.isFinite(counts.mistakes) ? counts.mistakes : 0;
  if (averageLoss < 6 && blunders === 0 && mistakes <= 1) return 'A';
  if (averageLoss < 15 && blunders <= 1) return 'B';
  if (averageLoss < 30 && blunders <= 3) return 'C';
  return 'D';
}

function weaknessSeverity(count, maxLoss) {
  if (count >= 3 || maxLoss >= MISTAKE_BLUNDER_LOSS) return 'high';
  if (count >= 2 || maxLoss >= MISTAKE_MISTAKE_LOSS) return 'medium';
  return 'low';
}

function inBounds(board, x, y) {
  return y >= 0 && y < board.length && x >= 0 && x < board[y].length;
}

const NEIGHBOR_DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const AROUND_DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/** 棋盘上从 (x,y) 出发的棋块与气（只用于失误原因检测，不修改棋盘）。 */
function groupAndLiberties(board, x, y) {
  const color = board[y][x];
  if (color !== 'black' && color !== 'white') return null;
  const stones = [];
  const liberties = new Set();
  const visited = new Set([`${x},${y}`]);
  const stack = [[x, y]];
  while (stack.length > 0) {
    const [cx, cy] = stack.pop();
    stones.push({ x: cx, y: cy });
    for (const [dx, dy] of NEIGHBOR_DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!inBounds(board, nx, ny)) continue;
      const cell = board[ny][nx];
      if (cell === null || cell === undefined) {
        liberties.add(`${nx},${ny}`);
      } else if (cell === color) {
        const key = `${nx},${ny}`;
        if (!visited.has(key)) {
          visited.add(key);
          stack.push([nx, ny]);
        }
      }
    }
  }
  return { color, stones, liberties };
}

/** 四邻 + 对角都是己方（越界方向忽略）。 */
function isOwnEyeShape(board, x, y, color) {
  let ownNeighbors = 0;
  for (const [dx, dy] of AROUND_DIRS) {
    const nx = x + dx;
    const ny = y + dy;
    if (!inBounds(board, nx, ny)) continue;
    if (board[ny][nx] !== color) return false;
    ownNeighbors += 1;
  }
  return ownNeighbors > 0;
}

function boardOf(game) {
  const state = game && typeof game.getState === 'function' ? game.getState() : null;
  return state && Array.isArray(state.board) ? state.board : null;
}

function tryClone(game) {
  if (game && typeof game.clone === 'function') return game.clone();
  return null;
}

/**
 * 检测一手失误的原因（按契约优先级）：
 * self_atari > missed_capture > filled_own_eye > early_first_line > inefficient
 *
 * @param {{ game: object, move: object, best: {x:number,y:number}|null, loss: number, moveIndex: number }} context
 * @returns {string}
 */
function detectReason(context) {
  const { game, move, best, loss, moveIndex } = context;
  const player = move.player === 'white' ? 'white' : 'black';

  // 1) self_atari：落子后己方棋块只剩 1 气且未提子
  const trial = tryClone(game);
  if (trial) {
    try {
      const result = trial.place(move.x, move.y);
      if (result && result.ok === true && (result.captured || 0) === 0) {
        const board = boardOf(trial);
        const group = board ? groupAndLiberties(board, move.x, move.y) : null;
        if (group && group.liberties.size === 1) return 'self_atari';
      }
    } catch {
      // 忽略模拟失败，继续后面的检测
    }
  }

  // 2) missed_capture：AI 首选能提子，实手未提且损失 >= 40
  if (best && Number.isFinite(loss) && loss >= MISTAKE_MISTAKE_LOSS) {
    try {
      const bestTrial = tryClone(game);
      const playedTrial = tryClone(game);
      const bestResult = bestTrial ? bestTrial.place(best.x, best.y) : null;
      const playedResult = playedTrial ? playedTrial.place(move.x, move.y) : null;
      const bestCaptures = bestResult && bestResult.ok === true ? bestResult.captured || 0 : 0;
      const playedCaptures = playedResult && playedResult.ok === true ? playedResult.captured || 0 : 0;
      if (bestCaptures > 0 && playedCaptures === 0) return 'missed_capture';
    } catch {
      // 忽略模拟失败
    }
  }

  // 3) filled_own_eye：在落子前盘面上，四邻+对角都是己方
  const beforeBoard = boardOf(game);
  if (beforeBoard && isOwnEyeShape(beforeBoard, move.x, move.y, player)) return 'filled_own_eye';

  // 4) early_first_line：前 20 手落在一线
  if (moveIndex < FIRST_LINE_WINDOW && (move.x === 0 || move.x === 8 || move.y === 0 || move.y === 8)) {
    return 'early_first_line';
  }

  // 5) 兜底
  return 'inefficient';
}

function normalizeRanked(ranked) {
  if (!Array.isArray(ranked)) return [];
  return ranked
    .filter((item) => item && Number.isInteger(item.x) && Number.isInteger(item.y) && Number.isFinite(item.score))
    .map((item) => ({ x: item.x, y: item.y, score: item.score }));
}

function scoreMovesOf(scorer, game) {
  if (typeof scorer === 'function') return normalizeRanked(scorer(game));
  if (!scorer || typeof scorer.scoreMoves !== 'function') {
    throw new Error('analyzeGame 需要 scorer.scoreMoves(game, { noise:false })');
  }
  return normalizeRanked(scorer.scoreMoves(game, { noise: false }));
}

/**
 * 生成复盘分析结果。
 *
 * @param {{ moves?: Array<object>, komi?: number, scorer: object }} options
 * @returns {object}
 */
function analyzeGame(options = {}) {
  const moves = Array.isArray(options.moves) ? options.moves : [];
  const komi = typeof options.komi === 'number' && Number.isFinite(options.komi) ? options.komi : 7.5;
  const scorer = options.scorer;

  const phases = {
    opening: createPhase('布局'),
    middle: createPhase('中盘'),
    endgame: createPhase('收官'),
  };
  const phaseAccumulators = {
    opening: { mismatches: 0, lossSum: 0 },
    middle: { mismatches: 0, lossSum: 0 },
    endgame: { mismatches: 0, lossSum: 0 },
  };

  const totalMoves = moves.length;
  let comparedMoves = 0;
  let mismatches = 0;
  let lossSum = 0;
  const gradedMistakes = [];
  const allMistakes = [];

  for (let i = 0; i < moves.length; i += 1) {
    const move = moves[i];
    const phaseKey = phaseKeyForIndex(i);
    phases[phaseKey].moves += 1;

    if (isPassMove(move)) continue; // pass 参与手数统计，但不与 AI 首选比较

    let replay = null;
    try {
      replay = Go9Game.replay(moves.slice(0, i), { komi });
    } catch {
      replay = null;
    }
    if (!replay) continue;

    let ranked = [];
    try {
      ranked = scoreMovesOf(scorer, replay);
    } catch {
      ranked = [];
    }
    if (ranked.length === 0) continue; // 无可比较着点（理论上仅出现在异常历史）

    comparedMoves += 1;
    phases[phaseKey].comparedMoves += 1;

    const best = ranked[0];
    const playedEntry = ranked.find((item) => item.x === move.x && item.y === move.y) || null;
    const loss = playedEntry ? Math.max(0, best.score - playedEntry.score) : 0;
    const isMismatch = best.x !== move.x || best.y !== move.y;

    if (isMismatch) {
      mismatches += 1;
      phases[phaseKey].mismatches += 1;
      phaseAccumulators[phaseKey].mismatches += 1;
    }
    lossSum += loss;
    phaseAccumulators[phaseKey].lossSum += loss;

    const severity = severityOfLoss(loss);
    if (severity) {
      const reason = detectReason({ game: replay, move, best, loss, moveIndex: i });
      const reasonMeta = WEAKNESS_META[reason] || WEAKNESS_META.inefficient;
      allMistakes.push({
        moveIndex: i,
        played: { x: move.x, y: move.y },
        recommended: best ? { x: best.x, y: best.y } : null,
        loss: round2(loss),
        severity,
        reason,
        reasonLabel: reasonMeta.label,
      });
      gradedMistakes.push({ reason, loss });
    }
  }

  // 阶段统计
  for (const key of ['opening', 'middle', 'endgame']) {
    const phase = phases[key];
    const acc = phaseAccumulators[key];
    phase.accuracy = phase.comparedMoves > 0 ? round2((phase.comparedMoves - acc.mismatches) / phase.comparedMoves) : 1;
    phase.averageLoss = phase.comparedMoves > 0 ? round2(acc.lossSum / phase.comparedMoves) : 0;
  }

  // 弱点聚合（按 reason code 聚合被分级的失误手）
  const weaknessMap = new Map();
  for (const item of gradedMistakes) {
    const entry = weaknessMap.get(item.reason) || { code: item.reason, count: 0, maxLoss: 0 };
    entry.count += 1;
    entry.maxLoss = Math.max(entry.maxLoss, item.loss);
    weaknessMap.set(item.reason, entry);
  }
  const weaknesses = Array.from(weaknessMap.values())
    .map((entry) => {
      const meta = WEAKNESS_META[entry.code] || WEAKNESS_META.inefficient;
      return {
        code: entry.code,
        label: meta.label,
        count: entry.count,
        severity: weaknessSeverity(entry.count, entry.maxLoss),
        advice: meta.advice,
        maxLoss: entry.maxLoss,
      };
    })
    .sort((left, right) => right.count - left.count || right.maxLoss - left.maxLoss)
    .map(({ code, label, count, severity, advice }) => ({ code, label, count, severity, advice }));

  // 总体指标
  const accuracyRaw = comparedMoves > 0 ? (comparedMoves - mismatches) / comparedMoves : 1;
  const averageLossRaw = comparedMoves > 0 ? lossSum / comparedMoves : 0;
  const accuracy = round2(accuracyRaw);
  const averageLoss = round2(averageLossRaw);
  const blunderCount = allMistakes.filter((item) => item.severity === 'blunder').length;
  const grade = gradeOf(accuracyRaw, averageLossRaw, {
    blunders: blunderCount,
    mistakes: allMistakes.length,
  });

  // 最近优先：取最后 10 条并倒序
  const mistakes = allMistakes.slice(-MAX_MISTAKES).reverse();

  // 中文总结：手数、首选一致率、平均损失、等级、Top2 弱点（样本少时注明仅供参考）
  const accuracyPercent = Math.round(accuracyRaw * 100);
  const topWeaknesses = weaknesses.slice(0, 2).map((item) => `${item.label}（${item.count} 次）`);
  const sampleNote = comparedMoves > 0 && comparedMoves < 5 ? '（样本较少，仅供参考）' : '';
  let summary;
  if (totalMoves === 0) {
    summary = '共 0 手，一致率 100%，评级 A，暂无可分析内容；整体稳定。';
  } else if (topWeaknesses.length === 0) {
    const mismatchNote = mismatches > 0 ? '（多数手与 AI 首选不同，但损失未达失误阈值）' : '';
    summary = `共 ${totalMoves} 手（可分析 ${comparedMoves} 手），AI 首选一致率 ${accuracyPercent}%，平均损失 ${averageLoss}，评级 ${grade}${sampleNote}，整体稳定${mismatchNote}。`;
  } else {
    summary = `共 ${totalMoves} 手（可分析 ${comparedMoves} 手），AI 首选一致率 ${accuracyPercent}%，平均损失 ${averageLoss}，评级 ${grade}${sampleNote}，主要弱点：${topWeaknesses.join('、')}。`;
  }

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
    summary,
  };
}

module.exports = {
  analyzeGame,
  detectReason,
  gradeOf,
  severityOfLoss,
  weaknessSeverity,
  WEAKNESS_META,
  MAX_MISTAKES,
  MISTAKE_MIN_LOSS,
  MISTAKE_MISTAKE_LOSS,
  MISTAKE_BLUNDER_LOSS,
};
