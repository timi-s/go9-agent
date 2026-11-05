'use strict';

/**
 * 本地 Python AI（server/ai/go_ai.py）与 Python provider 测试。
 *
 * 若本机没有 Python，相关用例会跳过（skip），不影响其它测试。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');

const Go9Game = require('../src/games/go9');
const { PythonGoAgent, isAvailable, resolvePythonCommand, DEFAULT_SCRIPT } = require('../src/agents/pythonAgent');
const { createBuiltinAgent } = require('../src/agents/builtinAgent');

const python = resolvePythonCommand(process.env);
const pythonReady = Boolean(python && fs.existsSync(DEFAULT_SCRIPT));

function makeGame(blackStones, whiteStones, currentPlayer = 'black') {
  const game = new Go9Game();
  for (const [x, y] of blackStones) game.board[y][x] = 'black';
  for (const [x, y] of whiteStones) game.board[y][x] = 'white';
  game.currentPlayer = currentPlayer;
  return game;
}

function assertLegalMove(game, move, label) {
  if (move === null) return;
  const legal = game.getLegalMoves();
  assert.ok(
    legal.some((item) => item.x === move.x && item.y === move.y),
    `${label}：返回了非法着点 ${JSON.stringify(move)}`,
  );
}

test('go_ai.py：内置自检通过', { skip: !pythonReady && 'python 不可用' }, () => {
  const result = spawnSync(python, [DEFAULT_SCRIPT, '--selftest'], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.selftest, 'passed');
});

test('PythonGoAgent：空盘/中盘返回合法着点并带统计', { skip: !pythonReady && 'python 不可用' }, async () => {
  const agent = new PythonGoAgent({ env: { ...process.env, LOCAL_AI_TIMEOUT_MS: '20000' }, seed: 5 });
  const empty = new Go9Game();
  const move = await agent.getMove(empty, { difficulty: 'easy' });
  assertLegalMove(empty, move, 'Python 空盘');
  assert.equal(agent.lastStats.provider, 'python');
  assert.ok(agent.lastStats.elapsedMs >= 0);

  const mid = makeGame([[4, 4], [3, 4]], [[4, 3], [5, 4]], 'black');
  const midMove = await agent.getMove(mid, { difficulty: 'easy' });
  assertLegalMove(mid, midMove, 'Python 中盘');
});

test('PythonGoAgent：同状态同种子结果一致', { skip: !pythonReady && 'python 不可用' }, async () => {
  const game = makeGame([[2, 2], [6, 6]], [[4, 4], [5, 5]], 'black');
  const first = new PythonGoAgent({ env: process.env, seed: 2026 });
  const second = new PythonGoAgent({ env: process.env, seed: 2026 });
  assert.deepEqual(await first.getMove(game, { difficulty: 'easy' }), await second.getMove(game, { difficulty: 'easy' }));
});

test('PythonGoAgent：领先且对方已 pass 时选择停一手', { skip: !pythonReady && 'python 不可用' }, async () => {
  // 黑 2 子、白 3 子（白 + 7.5 目领先）；黑 pass 后轮到白，白应 pass 结束对局。
  const game = makeGame([[0, 0], [0, 1]], [[8, 8], [8, 7], [7, 8]], 'black');
  game.pass();
  const agent = new PythonGoAgent({ env: process.env, seed: 3 });
  assert.equal(await agent.getMove(game, { difficulty: 'medium' }), null);
});

test('内置 provider：优先使用 Python，失败时回退 JS', { skip: !pythonReady && 'python 不可用' }, async () => {
  const agent = createBuiltinAgent({ env: process.env, seed: 11 });
  assert.equal(agent.backend, 'python');
  const game = new Go9Game();
  const move = await agent.getMove(game, { difficulty: 'easy' });
  assertLegalMove(game, move, '内置 provider（Python）');
  assert.equal(agent.lastStats.backend, 'python');

  // 指定不存在的解释器 -> 回退 JS 内置 AI，仍然能出招。
  const fallback = createBuiltinAgent({ env: { ...process.env, LOCAL_AI_PYTHON: 'definitely-not-python' }, seed: 12 });
  assert.equal(fallback.backend, 'js');
  const fallbackMove = await fallback.getMove(new Go9Game(), { difficulty: 'easy' });
  assertLegalMove(new Go9Game(), fallbackMove, '内置 provider（JS 回退）');
});

test('PythonGoAgent：脚本缺失时不可用', () => {
  assert.equal(isAvailable({ ...process.env, LOCAL_AI_SCRIPT: 'C:/definitely/not/exists/go_ai.py' }), false);
});
