'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Go9Game = require('../src/games/go9');
const HeuristicGoAgent = require('../src/agents/heuristicGoAgent');

function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function playSequence(game, sequence) {
  for (const [x, y] of sequence) {
    const result = game.place(x, y);
    assert.equal(result.ok, true, `预期合法着法 ${x},${y}，实际 ${JSON.stringify(result)}`);
  }
}

/** 断言 AI 着法为 null 或落在 game.getLegalMoves() 中。 */
function assertLegalMove(game, move, label) {
  const legal = game.getLegalMoves();
  if (legal.length === 0) {
    assert.equal(move, null, `${label}: 无合法点时应返回 null`);
    return;
  }
  assert.ok(move !== null, `${label}: 有合法点时应返回着点`);
  assert.ok(Number.isInteger(move.x) && Number.isInteger(move.y), `${label}: 坐标应为整数`);
  assert.ok(
    legal.some((candidate) => candidate.x === move.x && candidate.y === move.y),
    `${label}: ${JSON.stringify(move)} 不在合法着点中`,
  );
}

function edgeDistance(move, size = 9) {
  return Math.min(move.x, move.y, size - 1 - move.x, size - 1 - move.y);
}

// ---------------------------------------------------------------------------
// 基本行为
// ---------------------------------------------------------------------------

test('空棋盘：medium 返回合法着点，且偏好三/四线或中腹', async () => {
  for (let seed = 1; seed <= 10; seed += 1) {
    const game = new Go9Game();
    const agent = new HeuristicGoAgent({ seed });
    const move = await agent.getMove(game, { difficulty: 'medium' });

    assertLegalMove(game, move, `seed=${seed}`);
    assert.ok(edgeDistance(move) >= 2, `seed=${seed}: 开局不应下在一/二线，实际 ${JSON.stringify(move)}`);
  }
});

test('easy/medium/hard 都只返回合法着点', async () => {
  const game = new Go9Game();
  playSequence(game, [
    [4, 4],
    [3, 4],
    [5, 4],
    [4, 3],
    [2, 2],
    [6, 6],
  ]);
  const agent = new HeuristicGoAgent({ seed: 2026 });

  for (const difficulty of ['easy', 'medium', 'hard']) {
    const move = await agent.getMove(game, { difficulty });
    assertLegalMove(game, move, difficulty);
    assert.equal(game.clone().place(move.x, move.y).ok, true, `${difficulty}: 返回着点应可落子`);
  }
});

test('AI 优先提子', async () => {
  const game = new Go9Game();
  playSequence(game, [
    [4, 4], // 黑（只剩 (4,5) 一口气）
    [3, 4], // 白
    [0, 0], // 黑
    [5, 4], // 白
    [8, 8], // 黑
    [4, 3], // 白：黑 (4,4) 被打吃
    [0, 1], // 黑
  ]);
  const agent = new HeuristicGoAgent({ seed: 7 });
  const move = await agent.getMove(game, { difficulty: 'medium' });

  assert.deepEqual(move, { x: 4, y: 5 });
  assert.equal(game.clone().place(move.x, move.y).captured, 1);
});

test('hard 不会把“劫点不能立即提回”误判成送吃而放弃提劫', async () => {
  const game = new Go9Game();
  playSequence(game, [
    [1, 0], // 黑
    [1, 1], // 白（劫材）
    [8, 0], // 黑
    [2, 0], // 白
    [0, 1], // 黑
    [2, 2], // 白
    [1, 2], // 黑
    [3, 1], // 白，黑先提劫
  ]);
  const agent = new HeuristicGoAgent({ seed: 21 });
  const move = await agent.getMove(game, { difficulty: 'hard' });

  assert.deepEqual(move, { x: 2, y: 1 });
  assert.equal(game.clone().place(move.x, move.y).captured, 1);
});

test('AI 优先救回被打吃的己方棋块', async () => {
  const game = new Go9Game();
  playSequence(game, [
    [3, 4], // 黑
    [4, 4], // 白（只剩 (4,5) 一口气）
    [5, 4], // 黑
    [8, 8], // 白
    [4, 3], // 黑：白 (4,4) 被打吃
  ]);
  const agent = new HeuristicGoAgent({ seed: 11 });
  const move = await agent.getMove(game, { difficulty: 'medium' });

  assert.deepEqual(move, { x: 4, y: 5 });
});

test('AI 不填自己的真眼', async () => {
  const game = new Go9Game();
  playSequence(game, [
    [0, 1], // 黑
    [8, 0], // 白
    [2, 1], // 黑
    [8, 2], // 白
    [1, 0], // 黑
    [6, 8], // 白
    [1, 2], // 黑
    [6, 6], // 白
    [0, 0], // 黑
    [4, 8], // 白
    [0, 2], // 黑
    [2, 8], // 白
    [2, 0], // 黑
    [0, 8], // 白
    [2, 2], // 黑，围出真眼 (1,1)
    [8, 4], // 白
  ]);
  // (1,1) 是黑棋真眼，落子合法但属于自填
  assert.ok(game.getLegalMoves().some((move) => move.x === 1 && move.y === 1));

  const agent = new HeuristicGoAgent({ seed: 3 });
  const move = await agent.getMove(game, { difficulty: 'medium' });
  assertLegalMove(game, move, 'avoid-eye');
  assert.notDeepEqual(move, { x: 1, y: 1 });
});

test('对局结束或无合法点时返回 null', async () => {
  const agent = new HeuristicGoAgent({ seed: 5 });

  const resigned = new Go9Game();
  resigned.place(4, 4);
  resigned.resign();
  assert.equal(await agent.getMove(resigned, { difficulty: 'medium' }), null);

  const singlePoint = new Go9Game({ size: 1 });
  singlePoint.place(0, 0);
  assert.deepEqual(singlePoint.getLegalMoves(), []);
  assert.equal(await agent.getMove(singlePoint, { difficulty: 'hard' }), null);

  // 直接构造满盘（无空点）验证“满盘返回 null”
  const full = new Go9Game();
  const board = Array.from({ length: 9 }, (_, y) => Array.from({ length: 9 }, (_, x) => ((x + y) % 2 === 0 ? 'black' : 'white')));
  full.board = board;
  full.currentPlayer = 'black';
  assert.deepEqual(full.getLegalMoves(), []);
  assert.equal(await agent.getMove(full, { difficulty: 'medium' }), null);
});

test('AI 不会修改传入的对局', async () => {
  const game = new Go9Game();
  playSequence(game, [[4, 4], [3, 4], [5, 4], [4, 3]]);
  const before = JSON.stringify(game.getState());
  const agent = new HeuristicGoAgent({ seed: 99 });

  for (const difficulty of ['easy', 'medium', 'hard']) {
    await agent.getMove(game, { difficulty });
    assert.equal(JSON.stringify(game.getState()), before);
  }
});

test('相同 seed 的 AI 在同一局面下选择相同', async () => {
  const game = new Go9Game();
  playSequence(game, [[4, 4], [3, 4], [5, 4], [4, 3], [2, 2], [6, 6]]);

  for (const difficulty of ['easy', 'medium', 'hard']) {
    const first = await new HeuristicGoAgent({ seed: 123 }).getMove(game, { difficulty });
    const second = await new HeuristicGoAgent({ seed: 123 }).getMove(game, { difficulty });
    assert.deepEqual(first, second, `${difficulty}: 相同 seed 应可复现`);
  }
});

test('不同 seed 的开局选择存在随机扰动', async () => {
  const moves = new Set();
  for (let seed = 0; seed < 12; seed += 1) {
    const move = await new HeuristicGoAgent({ seed }).getMove(new Go9Game(), { difficulty: 'medium' });
    moves.add(`${move.x},${move.y}`);
  }
  assert.ok(moves.size >= 2, `12 个 seed 只产生了 ${moves.size} 种开局，随机扰动可能失效`);
});

// ---------------------------------------------------------------------------
// fuzz：随机局面下 AI 始终返回合法着点
// ---------------------------------------------------------------------------

test('fuzz：30 局随机局面下 AI 着点始终合法', async () => {
  const agent = new HeuristicGoAgent({ seed: 20261104 });

  for (let round = 0; round < 30; round += 1) {
    const game = new Go9Game();
    const random = mulberry32(1000 + round * 97);
    const steps = 8 + Math.floor(random() * 40);

    for (let i = 0; i < steps; i += 1) {
      if (game.getState().winner !== null) break;
      const legal = game.getLegalMoves();

      if (legal.length === 0) {
        // 满盘：两次 pass 结束
        game.pass();
        if (game.getState().winner === null) game.pass();
        break;
      }

      if (random() < 0.8) {
        const move = legal[Math.floor(random() * legal.length)];
        assert.equal(game.place(move.x, move.y).ok, true);
      } else {
        const move = await agent.getMove(game, { difficulty: 'easy' });
        assertLegalMove(game, move, `round ${round} 随机段`);
        if (move === null) game.pass();
        else assert.equal(game.place(move.x, move.y).ok, true);
      }
    }

    if (game.getState().winner !== null) continue;

    for (const difficulty of ['medium', 'hard']) {
      const move = await agent.getMove(game, { difficulty });
      assertLegalMove(game, move, `round ${round} ${difficulty}`);
      if (move !== null) {
        assert.equal(game.clone().place(move.x, move.y).ok, true);
      }
    }
  }
});
