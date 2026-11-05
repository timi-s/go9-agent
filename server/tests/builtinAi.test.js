'use strict';

/**
 * 内置 AI（MCTS + 静态启发式）测试。
 *
 * 覆盖：
 * - MctsGoAgent：合法着点、同种子可复现、终局/满盘返回 null、lastStats 统计；
 * - BuiltinGoAgent：提子能力、scoreMoves 静态评分仍可用、终局主动 pass；
 * - 内置 AI 不会下非法着点。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const Go9Game = require('../src/games/go9');
const { MctsGoAgent } = require('../src/agents/mctsAgent');
const BuiltinGoAgent = require('../src/agents/builtinAgent');

function createGame(blackStones = [], whiteStones = [], currentPlayer = 'black') {
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

test('MctsGoAgent：空盘/中盘都只返回合法着点，并记录统计', async () => {
  const empty = new Go9Game();
  const agent = new MctsGoAgent({ seed: 11, playouts: { easy: 120 } });
  const move = await agent.getMove(empty, { difficulty: 'easy' });
  assertLegalMove(empty, move, '空盘');
  assert.ok(agent.lastStats && agent.lastStats.playouts > 0);
  assert.ok(agent.lastStats.elapsedMs >= 0);

  const mid = createGame(
    [[4, 4], [3, 4], [5, 4]],
    [[3, 3], [4, 3], [4, 5]],
    'black',
  );
  for (let i = 0; i < 4; i += 1) {
    const candidate = await agent.getMove(mid, { difficulty: 'easy' });
    assertLegalMove(mid, candidate, `中盘第 ${i + 1} 次`);
  }
});

test('MctsGoAgent：同种子同局面结果可复现', async () => {
  const game = createGame([[2, 2], [6, 6]], [[4, 4], [5, 5]], 'black');
  const first = await new MctsGoAgent({ seed: 2026, playouts: { easy: 150 } }).getMove(game, { difficulty: 'easy' });
  const second = await new MctsGoAgent({ seed: 2026, playouts: { easy: 150 } }).getMove(game, { difficulty: 'easy' });
  assert.deepEqual(first, second);
});

test('MctsGoAgent：满盘无合法点时返回 null，终局返回 null', async () => {
  const full = new Go9Game();
  for (let y = 0; y < 9; y += 1) {
    for (let x = 0; x < 9; x += 1) full.board[y][x] = (x + y) % 2 === 0 ? 'black' : 'white';
  }
  assert.equal(full.getLegalMoves().length, 0);
  assert.equal(await new MctsGoAgent({ seed: 5 }).getMove(full, { difficulty: 'easy' }), null);

  const finished = new Go9Game();
  finished.winner = 'black';
  assert.equal(await new MctsGoAgent({ seed: 5 }).getMove(finished, { difficulty: 'easy' }), null);
});

test('BuiltinGoAgent：会提掉被打吃的对方棋块', async () => {
  // 白 (4,4) 仅剩 (4,5) 一口气，黑先。
  const game = createGame(
    [[3, 4], [5, 4], [4, 3]],
    [[4, 4]],
    'black',
  );
  const agent = new BuiltinGoAgent({ seed: 99 });
  const move = await agent.getMove(game, { difficulty: 'easy' });
  assert.ok(move, 'AI 应给出着点');
  const probe = game.clone();
  const result = probe.place(move.x, move.y);
  assert.equal(result.ok, true);
  const state = probe.getState();
  assert.equal(state.captures.black > 0, true, `应提子，实际着点 ${JSON.stringify(move)}`);
  assert.equal(state.board[4][4], null, '白 (4,4) 应被提掉');
});

test('BuiltinGoAgent：保留静态 scoreMoves（复盘仍然可用且确定）', () => {
  const game = createGame([[4, 4]], [[3, 4]], 'black');
  const first = new BuiltinGoAgent({ seed: 1 }).scoreMoves(game, { noise: false });
  const second = new BuiltinGoAgent({ seed: 1 }).scoreMoves(game, { noise: false });
  assert.ok(first.length > 0);
  assert.deepEqual(first, second);
});

test('BuiltinGoAgent：对方停一手且我方已胜时主动 pass', async () => {
  // 黑 2 子、白 3 子，白领先（白 3+7.5 > 黑 2）；黑 pass 后轮到白，白应 pass 结束。
  const game = createGame(
    [[0, 0], [0, 1]],
    [[8, 8], [8, 7], [7, 8]],
    'black',
  );
  game.pass(); // 黑停一手 -> 轮到白，passCount = 1
  const state = game.getState();
  assert.equal(state.passCount, 1);
  assert.equal(state.currentPlayer, 'white');

  const agent = new BuiltinGoAgent({ seed: 3 });
  assert.ok(agent.shouldPass(game, state), '白方领先且对方已 pass，应选择结束对局');
});

test('BuiltinGoAgent：开局不会主动 pass', async () => {
  const game = new Go9Game();
  const agent = new BuiltinGoAgent({ seed: 17 });
  assert.equal(agent.shouldPass(game, game.getState()), null);
  const move = await agent.getMove(game, { difficulty: 'easy' });
  assertLegalMove(game, move, '开局');
  assert.ok(move, '开局必须落子');
});
