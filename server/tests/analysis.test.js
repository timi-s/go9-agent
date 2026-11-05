'use strict';

/**
 * 复盘分析（analysis/analyze.js）单元测试。
 *
 * 覆盖：
 * - 空对局
 * - 输出结构与契约字段
 * - 分级阈值（inaccuracy/mistake/blunder，15/40/80）
 * - 失误原因检测（自陷打吃 / 漏提子 / 填自己的眼 / 一线手 / inefficient）
 * - 弱点聚合与 severity
 * - 阶段统计（布局 <16 / 中盘 16-49 / 收官 >=50，pass 计入 moves 但不比较）
 * - mistakes 最多 10 条、最近优先
 * - 真实 HeuristicGoAgent(seed=1) 的确定性
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const Go9Game = require('../src/games/go9');
const HeuristicGoAgent = require('../src/agents/heuristicGoAgent');
const { analyzeGame, detectReason, gradeOf } = require('../src/analysis/analyze');

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function move(x, y, player, captured = 0) {
  return { x, y, player, captured };
}

function pass(player) {
  return { x: null, y: null, player, captured: 0, pass: true };
}

function replay(moves) {
  return Go9Game.replay(moves, { komi: 7.5 });
}

/** 用坐标 -> 分值的函数构造确定性的 scorer（内部只调用 game.getLegalMoves()）。 */
function makeScorer(scoreFn) {
  return {
    scoreMoves(game) {
      const ranked = game.getLegalMoves().map((point) => ({ x: point.x, y: point.y, score: scoreFn(point, game) }));
      ranked.sort((left, right) => right.score - left.score);
      return ranked;
    },
  };
}

/** 生成 count 手合法对局历史（取每步合法点中的第一个，保证可回放）。 */
function generateMoves(count) {
  const game = new Go9Game({ komi: 7.5 });
  const moves = [];
  while (moves.length < count) {
    const legal = game.getLegalMoves();
    if (legal.length === 0) break;
    const point = legal[0];
    const player = game.getState().currentPlayer;
    const result = game.place(point.x, point.y);
    if (!result || result.ok !== true) break;
    moves.push(move(point.x, point.y, player, result.captured || 0));
  }
  return moves;
}

function assertAnalysisShape(analysis) {
  assert.equal(typeof analysis.totalMoves, 'number');
  assert.equal(typeof analysis.comparedMoves, 'number');
  assert.equal(typeof analysis.mismatches, 'number');
  assert.equal(typeof analysis.accuracy, 'number');
  assert.ok(analysis.accuracy >= 0 && analysis.accuracy <= 1);
  assert.equal(typeof analysis.averageLoss, 'number');
  assert.ok(analysis.averageLoss >= 0);
  assert.ok(['A', 'B', 'C', 'D'].includes(analysis.grade));

  assert.ok(analysis.phases && typeof analysis.phases === 'object');
  for (const key of ['opening', 'middle', 'endgame']) {
    const phase = analysis.phases[key];
    assert.ok(phase, `missing phase ${key}`);
    assert.equal(typeof phase.label, 'string');
    assert.equal(typeof phase.moves, 'number');
    assert.equal(typeof phase.comparedMoves, 'number');
    assert.equal(typeof phase.mismatches, 'number');
    assert.equal(typeof phase.accuracy, 'number');
    assert.ok(phase.accuracy >= 0 && phase.accuracy <= 1);
    assert.equal(typeof phase.averageLoss, 'number');
  }
  assert.equal(analysis.phases.opening.label, '布局');
  assert.equal(analysis.phases.middle.label, '中盘');
  assert.equal(analysis.phases.endgame.label, '收官');

  assert.ok(Array.isArray(analysis.weaknesses));
  for (const weakness of analysis.weaknesses) {
    assert.equal(typeof weakness.code, 'string');
    assert.equal(typeof weakness.label, 'string');
    assert.equal(typeof weakness.count, 'number');
    assert.ok(['high', 'medium', 'low'].includes(weakness.severity));
    assert.equal(typeof weakness.advice, 'string');
    assert.ok(weakness.advice.length > 0);
  }

  assert.ok(Array.isArray(analysis.mistakes));
  assert.ok(analysis.mistakes.length <= 10);
  for (const mistake of analysis.mistakes) {
    assert.ok(Number.isInteger(mistake.moveIndex));
    assert.ok(mistake.played && Number.isInteger(mistake.played.x) && Number.isInteger(mistake.played.y));
    assert.ok(mistake.recommended === null || (Number.isInteger(mistake.recommended.x) && Number.isInteger(mistake.recommended.y)));
    assert.equal(typeof mistake.loss, 'number');
    assert.ok(mistake.loss >= 15);
    assert.ok(['inaccuracy', 'mistake', 'blunder'].includes(mistake.severity));
    assert.ok(['self_atari', 'missed_capture', 'filled_own_eye', 'early_first_line', 'inefficient'].includes(mistake.reason));
    assert.equal(typeof mistake.reasonLabel, 'string');
    assert.ok(mistake.reasonLabel.length > 0);
  }
  assert.equal(typeof analysis.summary, 'string');
  assert.ok(analysis.summary.length > 0);
}

// ---------------------------------------------------------------------------
// 空对局与结构
// ---------------------------------------------------------------------------

describe('analyzeGame 结构与空对局', () => {
  test('空对局：0 手、accuracy=1、grade=A、各阶段为空', () => {
    const analysis = analyzeGame({ moves: [], komi: 7.5, scorer: new HeuristicGoAgent({ seed: 1 }) });
    assert.deepEqual(analysis, {
      totalMoves: 0,
      comparedMoves: 0,
      mismatches: 0,
      accuracy: 1,
      averageLoss: 0,
      grade: 'A',
      phases: {
        opening: { label: '布局', moves: 0, comparedMoves: 0, mismatches: 0, accuracy: 1, averageLoss: 0 },
        middle: { label: '中盘', moves: 0, comparedMoves: 0, mismatches: 0, accuracy: 1, averageLoss: 0 },
        endgame: { label: '收官', moves: 0, comparedMoves: 0, mismatches: 0, accuracy: 1, averageLoss: 0 },
      },
      weaknesses: [],
      mistakes: [],
      summary: '共 0 手，一致率 100%，评级 A，暂无可分析内容；整体稳定。',
    });
  });

  test('真实启发式 scoring：输出结构合法且结果确定', () => {
    const moves = [move(4, 4, 'black'), move(2, 2, 'white'), move(6, 6, 'black'), move(2, 6, 'white')];
    const scorer = new HeuristicGoAgent({ seed: 1 });
    const first = analyzeGame({ moves, komi: 7.5, scorer });
    assertAnalysisShape(first);
    assert.equal(first.totalMoves, 4);
    assert.equal(first.comparedMoves, 4);

    const second = analyzeGame({ moves, komi: 7.5, scorer: new HeuristicGoAgent({ seed: 1 }) });
    assert.deepEqual(second, first, 'seed=1 + noise=false 应完全确定');
  });

  test('pass 计入 totalMoves/phases.moves，但不参与比较', () => {
    const moves = [move(4, 4, 'black'), move(2, 2, 'white'), pass('black')];
    const scorer = makeScorer((point) => (point.x === 4 && point.y === 4 ? 100 : 50));
    const analysis = analyzeGame({ moves, komi: 7.5, scorer });
    assert.equal(analysis.totalMoves, 3);
    assert.equal(analysis.comparedMoves, 2);
    assert.equal(analysis.phases.opening.moves, 3);
    assert.equal(analysis.phases.opening.comparedMoves, 2);
  });
});

// ---------------------------------------------------------------------------
// 分级阈值
// ---------------------------------------------------------------------------

describe('失误分级阈值', () => {
  function analyzeSingleLoss(playedScore) {
    const moves = [move(1, 1, 'black')];
    const scorer = makeScorer((point) => {
      if (point.x === 8 && point.y === 8) return 100;
      if (point.x === 1 && point.y === 1) return playedScore;
      return 50;
    });
    return analyzeGame({ moves, komi: 7.5, scorer });
  }

  test('loss=14 不记录；loss=15 inaccuracy；40 mistake；80/100 blunder', () => {
    assert.equal(analyzeSingleLoss(86).mistakes.length, 0);
    assert.equal(analyzeSingleLoss(86).averageLoss, 14);

    const inaccuracy = analyzeSingleLoss(85);
    assert.equal(inaccuracy.mistakes.length, 1);
    assert.equal(inaccuracy.mistakes[0].loss, 15);
    assert.equal(inaccuracy.mistakes[0].severity, 'inaccuracy');

    const mistake = analyzeSingleLoss(60);
    assert.equal(mistake.mistakes[0].loss, 40);
    assert.equal(mistake.mistakes[0].severity, 'mistake');

    const blunder = analyzeSingleLoss(20);
    assert.equal(blunder.mistakes[0].loss, 80);
    assert.equal(blunder.mistakes[0].severity, 'blunder');

    const huge = analyzeSingleLoss(0);
    assert.equal(huge.mistakes[0].severity, 'blunder');
    assert.equal(huge.mistakes[0].loss, 100);
  });

  test('mismatches/accuracy 按坐标一致率精确统计；grade 以平均损失为主', () => {
    // 实手与首选一致 => accuracy 1 / grade A
    const perfect = analyzeGame({
      moves: [move(8, 8, 'black')],
      komi: 7.5,
      scorer: makeScorer((point) => (point.x === 8 && point.y === 8 ? 100 : 0)),
    });
    assert.equal(perfect.mismatches, 0);
    assert.equal(perfect.accuracy, 1);
    assert.equal(perfect.grade, 'A');

    // 与首选不同 => accuracy 0；若损失很小，评级不应被一棍子打成 D
    const lowLoss = analyzeGame({
      moves: [move(0, 0, 'black')],
      komi: 7.5,
      scorer: makeScorer((point) => (point.x === 8 && point.y === 8 ? 100 : 99)),
    });
    assert.equal(lowLoss.mismatches, 1);
    assert.equal(lowLoss.accuracy, 0);
    assert.equal(lowLoss.averageLoss, 1);
    assert.equal(lowLoss.grade, 'A');

    // 与首选不同且损失巨大 => 仍为 D
    const bad = analyzeGame({
      moves: [move(0, 0, 'black')],
      komi: 7.5,
      scorer: makeScorer((point) => (point.x === 8 && point.y === 8 ? 100 : 0)),
    });
    assert.equal(bad.mismatches, 1);
    assert.equal(bad.accuracy, 0);
    assert.equal(bad.grade, 'D');
  });

  test('gradeOf：平均损失与严重失误数共同决定评级', () => {
    assert.equal(gradeOf(0, 1.9, { blunders: 0, mistakes: 0 }), 'A');
    assert.equal(gradeOf(0, 10, { blunders: 1, mistakes: 2 }), 'B');
    assert.equal(gradeOf(0, 20, { blunders: 2, mistakes: 4 }), 'C');
    assert.equal(gradeOf(1, 50, { blunders: 0, mistakes: 0 }), 'D');
    assert.equal(gradeOf(1, 4, { blunders: 1, mistakes: 1 }), 'B');
  });
});

// ---------------------------------------------------------------------------
// 失误原因检测（直接调用 detectReason，用真实 Go9Game 局面）
// ---------------------------------------------------------------------------

describe('失误原因检测', () => {
  test('self_atari：落子后己方棋块只剩 1 气且未提子', () => {
    const history = [
      move(1, 1, 'black'),
      move(0, 1, 'white'),
      pass('black'),
      move(1, 0, 'white'),
      pass('black'),
      move(2, 0, 'white'),
      pass('black'),
      move(3, 1, 'white'),
      pass('black'),
      move(2, 2, 'white'),
    ];
    const game = replay(history);
    assert.equal(game.getState().currentPlayer, 'black');
    const reason = detectReason({ game, move: { x: 2, y: 1, player: 'black' }, best: { x: 8, y: 8 }, loss: 100, moveIndex: 10 });
    assert.equal(reason, 'self_atari');
  });

  test('missed_capture：AI 首选能提子、实手未提且 loss>=40', () => {
    const game = replay([move(0, 0, 'black'), move(1, 0, 'white'), pass('black')]);
    assert.equal(game.getState().currentPlayer, 'white');
    // 白在 (0,1) 可提黑 (0,0)，实手选择 (8,8)
    const reason = detectReason({ game, move: { x: 8, y: 8, player: 'white' }, best: { x: 0, y: 1 }, loss: 60, moveIndex: 3 });
    assert.equal(reason, 'missed_capture');
  });

  test('filled_own_eye：四邻+对角都是己方', () => {
    const history = [
      move(4, 3, 'black'),
      pass('white'),
      move(4, 5, 'black'),
      pass('white'),
      move(3, 4, 'black'),
      pass('white'),
      move(5, 4, 'black'),
      pass('white'),
      move(3, 3, 'black'),
      pass('white'),
      move(5, 3, 'black'),
      pass('white'),
      move(3, 5, 'black'),
      pass('white'),
      move(5, 5, 'black'),
      pass('white'),
    ];
    const game = replay(history);
    const reason = detectReason({ game, move: { x: 4, y: 4, player: 'black' }, best: { x: 8, y: 8 }, loss: 100, moveIndex: 16 });
    assert.equal(reason, 'filled_own_eye');
  });

  test('early_first_line：前 20 手落在一线', () => {
    const game = replay([]);
    assert.equal(
      detectReason({ game, move: { x: 0, y: 0, player: 'black' }, best: { x: 8, y: 8 }, loss: 50, moveIndex: 0 }),
      'early_first_line',
    );
  });

  test('inefficient：以上均不命中时的兜底', () => {
    const game = replay([]);
    assert.equal(
      detectReason({ game, move: { x: 2, y: 4, player: 'black' }, best: { x: 8, y: 8 }, loss: 50, moveIndex: 0 }),
      'inefficient',
    );
  });

  test('第 20 手之后的一线手不再标记 early_first_line', () => {
    const game = replay([]);
    assert.equal(
      detectReason({ game, move: { x: 0, y: 0, player: 'black' }, best: { x: 8, y: 8 }, loss: 50, moveIndex: 20 }),
      'inefficient',
    );
  });
});

// ---------------------------------------------------------------------------
// 弱点聚合
// ---------------------------------------------------------------------------

describe('弱点聚合与 severity', () => {
  /** 一局里放 n 手一线的“blunder/失误”，用 fake scorer 控制 loss。 */
  function analyzeFirstLineMoves(count, playedScore) {
    const coords = [
      [0, 0],
      [8, 0],
      [2, 0],
      [8, 2],
      [4, 0],
      [8, 4],
      [6, 0],
      [8, 6],
      [0, 2],
      [6, 8],
      [2, 8],
      [0, 4],
    ];
    const players = ['black', 'white'];
    const moves = coords.slice(0, count).map(([x, y], index) => move(x, y, players[index % 2]));
    const scorer = makeScorer((point) => (point.x === 4 && point.y === 4 ? 100 : playedScore));
    return analyzeGame({ moves, komi: 7.5, scorer });
  }

  test('count=1 → low', () => {
    const analysis = analyzeFirstLineMoves(1, 85);
    assert.equal(analysis.mistakes.length, 1);
    assert.equal(analysis.weaknesses.length, 1);
    assert.equal(analysis.weaknesses[0].code, 'early_first_line');
    assert.equal(analysis.weaknesses[0].count, 1);
    assert.equal(analysis.weaknesses[0].severity, 'low');
  });

  test('count=2 → medium；count>=3 → high', () => {
    const two = analyzeFirstLineMoves(2, 85);
    assert.equal(two.weaknesses[0].code, 'early_first_line');
    assert.equal(two.weaknesses[0].count, 2);
    assert.equal(two.weaknesses[0].severity, 'medium');

    const three = analyzeFirstLineMoves(3, 85);
    assert.equal(three.weaknesses[0].count, 3);
    assert.equal(three.weaknesses[0].severity, 'high');
  });

  test('单个 blunder（maxLoss>=80）也是 high', () => {
    const analysis = analyzeFirstLineMoves(1, 20);
    assert.equal(analysis.weaknesses[0].severity, 'high');
  });

  test('弱点按 count 降序排列', () => {
    // 3 手一线 + 1 手 inefficient（(1,1) 中腹），两者都算失误
    const moves = [
      move(0, 0, 'black'),
      move(8, 0, 'white'),
      move(2, 0, 'black'),
      move(1, 1, 'white'),
    ];
    const scorer = makeScorer((point) => (point.x === 4 && point.y === 4 ? 100 : 0));
    const analysis = analyzeGame({ moves, komi: 7.5, scorer });
    assert.equal(analysis.weaknesses.length, 2);
    assert.equal(analysis.weaknesses[0].code, 'early_first_line');
    assert.equal(analysis.weaknesses[0].count, 3);
    assert.equal(analysis.weaknesses[1].code, 'inefficient');
    assert.equal(analysis.weaknesses[1].count, 1);
  });
});

// ---------------------------------------------------------------------------
// mistakes 上限 / 最近优先 / 阶段统计
// ---------------------------------------------------------------------------

describe('mistakes 与阶段统计', () => {
  test('mistakes 最多 10 条、最近优先（moveIndex 倒序）', () => {
    const coords = [
      [0, 0],
      [8, 0],
      [2, 0],
      [8, 2],
      [4, 0],
      [8, 4],
      [6, 0],
      [8, 6],
      [0, 2],
      [6, 8],
      [2, 8],
      [0, 4],
    ];
    const players = ['black', 'white'];
    const moves = coords.map(([x, y], index) => move(x, y, players[index % 2]));
    const scorer = makeScorer((point) => (point.x === 4 && point.y === 4 ? 100 : 0));
    const analysis = analyzeGame({ moves, komi: 7.5, scorer });
    assert.equal(analysis.mistakes.length, 10);
    assert.equal(analysis.mistakes[0].moveIndex, 11);
    assert.equal(analysis.mistakes[analysis.mistakes.length - 1].moveIndex, 2);
    for (let i = 1; i < analysis.mistakes.length; i += 1) {
      assert.ok(analysis.mistakes[i - 1].moveIndex > analysis.mistakes[i].moveIndex);
    }
  });

  test('阶段划分：<16 布局、16-49 中盘、>=50 收官；pass 计入 moves', () => {
    const placements = generateMoves(60);
    assert.equal(placements.length, 60);
    const moves = placements.concat([pass('black'), pass('white')]);
    const scorer = makeScorer((point) => point.x * 9 + point.y);
    const analysis = analyzeGame({ moves, komi: 7.5, scorer });
    assertAnalysisShape(analysis);

    assert.equal(analysis.totalMoves, 62);
    assert.equal(analysis.comparedMoves, 60);
    assert.equal(analysis.phases.opening.moves, 16);
    assert.equal(analysis.phases.middle.moves, 34);
    assert.equal(analysis.phases.endgame.moves, 12);
    assert.equal(analysis.phases.opening.comparedMoves, 16);
    assert.equal(analysis.phases.middle.comparedMoves, 34);
    assert.equal(analysis.phases.endgame.comparedMoves, 10);

    const phaseMoves = analysis.phases.opening.moves + analysis.phases.middle.moves + analysis.phases.endgame.moves;
    assert.equal(phaseMoves, analysis.totalMoves);
    const phaseCompared =
      analysis.phases.opening.comparedMoves + analysis.phases.middle.comparedMoves + analysis.phases.endgame.comparedMoves;
    assert.equal(phaseCompared, analysis.comparedMoves);
    const phaseMismatches =
      analysis.phases.opening.mismatches + analysis.phases.middle.mismatches + analysis.phases.endgame.mismatches;
    assert.equal(phaseMismatches, analysis.mismatches);
    for (const phase of Object.values(analysis.phases)) {
      assert.ok(phase.mismatches <= phase.comparedMoves);
      assert.ok(phase.averageLoss >= 0);
    }
  });

  test('总结包含手数、一致率、评级与弱点（或整体稳定）', () => {
    const stable = analyzeGame({
      moves: [move(8, 8, 'black')],
      komi: 7.5,
      scorer: makeScorer((point) => (point.x === 8 && point.y === 8 ? 100 : 0)),
    });
    assert.match(stable.summary, /共 1 手/);
    assert.match(stable.summary, /AI 首选一致率 100%/);
    assert.match(stable.summary, /平均损失 0/);
    assert.match(stable.summary, /评级 A/);
    assert.match(stable.summary, /整体稳定/);

    const weak = analyzeGame({
      moves: [move(0, 0, 'black')],
      komi: 7.5,
      scorer: makeScorer((point) => (point.x === 8 && point.y === 8 ? 100 : 0)),
    });
    assert.match(weak.summary, /主要弱点/);
    assert.match(weak.summary, /过早下在一线/);
  });
});
