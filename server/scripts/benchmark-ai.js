'use strict';

/**
 * 内置 AI 强度基准：MCTS 内置 AI vs 旧静态启发式 AI，下 N 盘（黑白轮换）。
 *
 * 用法：
 *   cd server && node scripts/benchmark-ai.js [局数] [难度]
 *   默认：8 局，medium
 *
 * 只用于本地评估，不写入数据库、不依赖网络。
 */

const Go9Game = require('../src/games/go9');
const BuiltinGoAgent = require('../src/agents/builtinAgent');
const { createBuiltinAgent } = require('../src/agents/builtinAgent');
const HeuristicGoAgent = require('../src/agents/heuristicGoAgent');

const games = Math.max(1, Number(process.argv[2]) || 8);
const difficulty = ['easy', 'medium', 'hard'].includes(process.argv[3]) ? process.argv[3] : 'medium';
const engine = process.argv[4] === 'python' ? 'python' : 'js';
const MAX_MOVES = 180;

async function playOneGame(mctsColor, seedBase) {
  const game = new Go9Game();
  const mcts = engine === 'python' ? createBuiltinAgent({ seed: seedBase, env: process.env }) : new BuiltinGoAgent({ seed: seedBase });
  const baseline = new HeuristicGoAgent({ seed: seedBase + 1 });

  let mctsMoves = 0;
  let mctsTime = 0;
  let mctsPlayouts = 0;

  while (!game.winner && game.moves.length < MAX_MOVES) {
    const isMctsTurn = game.currentPlayer === mctsColor;
    const agent = isMctsTurn ? mcts : baseline;
    const started = Date.now();
    const move = await agent.getMove(game, { difficulty });
    if (isMctsTurn) {
      mctsTime += Date.now() - started;
      mctsMoves += 1;
      if (mcts.lastStats) mctsPlayouts += mcts.lastStats.playouts;
    }
    if (!move) {
      game.pass();
      continue;
    }
    const placed = game.place(move.x, move.y);
    if (!placed.ok) game.pass(); // 理论不会发生，防御性处理
  }

  if (!game.winner) {
    game.pass();
    game.pass();
  }

  const winner = game.winner;
  const mctsWon = winner === mctsColor;
  return {
    winner,
    mctsColor,
    mctsWon,
    moveCount: game.moves.length,
    mctsMoves,
    avgMctsMs: mctsMoves > 0 ? Math.round(mctsTime / mctsMoves) : 0,
    avgPlayouts: mctsMoves > 0 ? Math.round(mctsPlayouts / mctsMoves) : 0,
  };
}

async function main() {
  const engineLabel = engine === 'python' ? 'Python MCTS（server/ai/go_ai.py）' : 'JS MCTS';
  console.log(`内置 AI 基准：${engineLabel}(${difficulty}) vs 静态启发式，共 ${games} 局（黑白轮换）\n`);
  let mctsWins = 0;
  let baselineWins = 0;
  let draw = 0;
  let totalMs = 0;
  let totalPlayouts = 0;

  for (let i = 0; i < games; i += 1) {
    const mctsColor = i % 2 === 0 ? 'black' : 'white';
    const result = await playOneGame(mctsColor, 1000 + i * 37);
    if (result.mctsWon) mctsWins += 1;
    else if (result.winner === 'draw') draw += 1;
    else baselineWins += 1;
    totalMs += result.avgMctsMs;
    totalPlayouts += result.avgPlayouts;
    console.log(
      `第 ${i + 1} 局: MCTS=${mctsColor} 胜方=${result.winner} 手数=${result.moveCount} ` +
        `| MCTS 平均 ${result.avgMctsMs}ms/${result.avgPlayouts} playouts`,
    );
  }

  const decided = mctsWins + baselineWins;
  const rate = decided > 0 ? ((mctsWins / decided) * 100).toFixed(0) : '0';
  console.log(`\n结果：MCTS 胜 ${mctsWins}，静态启发式胜 ${baselineWins}，和棋 ${draw}`);
  console.log(`MCTS 胜率：${rate}%（排除和棋）`);
  console.log(`平均每手：${Math.round(totalMs / games)}ms，${Math.round(totalPlayouts / games)} playouts`);
  process.exitCode = 0;
}

main().catch((error) => {
  console.error('[benchmark-ai] 失败:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
