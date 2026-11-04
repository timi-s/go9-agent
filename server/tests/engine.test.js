'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const Go9Game = require('../src/games/go9');

const STATE_KEYS = [
  'board',
  'captures',
  'currentPlayer',
  'koPoint',
  'komi',
  'lastMove',
  'moveCount',
  'moves',
  'passCount',
  'result',
  'size',
  'winner',
];

function snapshot(game) {
  return JSON.stringify(game.getState());
}

function playSequence(game, sequence) {
  for (const move of sequence) {
    if (Array.isArray(move)) {
      const result = game.place(move[0], move[1]);
      assert.equal(result.ok, true, `预期合法着法 ${move.join(',')}，实际 ${JSON.stringify(result)}`);
    } else if (move === 'pass') {
      const result = game.pass();
      assert.equal(result.ok, true, `预期 pass 合法，实际 ${JSON.stringify(result)}`);
    } else if (move === 'resign') {
      const result = game.resign();
      assert.equal(result.ok, true, `预期认输合法，实际 ${JSON.stringify(result)}`);
    } else {
      throw new Error(`未知着法: ${JSON.stringify(move)}`);
    }
  }
}

function emptyBoardSnapshot() {
  return Array.from({ length: 9 }, () => Array(9).fill(null));
}

// ---------------------------------------------------------------------------
// GameState 契约
// ---------------------------------------------------------------------------

test('构造函数默认状态严格符合 GameState 契约', () => {
  const game = new Go9Game();
  const state = game.getState();

  assert.deepEqual(Object.keys(state).sort(), STATE_KEYS);
  assert.equal(state.size, 9);
  assert.equal(state.komi, 7.5);
  assert.equal(state.board.length, 9);
  assert.ok(state.board.every((row) => row.length === 9));
  assert.deepEqual(state.board, emptyBoardSnapshot());
  assert.equal(state.currentPlayer, 'black');
  assert.deepEqual(state.moves, []);
  assert.deepEqual(state.captures, { black: 0, white: 0 });
  assert.equal(state.winner, null);
  assert.equal(state.result, null);
  assert.equal(state.passCount, 0);
  assert.equal(state.koPoint, null);
  assert.equal(state.lastMove, null);
  assert.equal(state.moveCount, 0);
});

test('构造函数支持自定义 komi 与尺寸', () => {
  const game = new Go9Game({ size: 3, komi: 0.5 });
  const state = game.getState();
  assert.equal(state.size, 3);
  assert.equal(state.komi, 0.5);
  assert.equal(state.board.length, 3);
  assert.equal(game.getLegalMoves().length, 9);
});

test('getState 返回深拷贝，外部修改不会污染棋局', () => {
  const game = new Go9Game();
  game.place(4, 4);

  const state = game.getState();
  state.board[0][0] = 'black';
  state.moves[0].x = 8;
  state.captures.black = 99;
  state.koPoint = { x: 0, y: 0 };

  const fresh = game.getState();
  assert.equal(fresh.board[0][0], null);
  assert.equal(fresh.moves[0].x, 4);
  assert.equal(fresh.captures.black, 0);
  assert.equal(fresh.koPoint, null);
});

// ---------------------------------------------------------------------------
// 落子 / 提子 / 非法着法
// ---------------------------------------------------------------------------

test('提子：对方棋块无气时被提掉，captures 与着法记录同步更新', () => {
  const game = new Go9Game();
  playSequence(game, [
    [0, 1], // 黑
    [0, 0], // 白
    [1, 0], // 黑：提掉白 (0,0)
  ]);

  const state = game.getState();
  assert.equal(state.board[0][0], null);
  assert.deepEqual(state.captures, { black: 1, white: 0 });
  assert.equal(state.moves.length, 3);
  assert.deepEqual(state.moves[2], { x: 1, y: 0, player: 'black', captured: 1 });
  assert.deepEqual(state.lastMove, { x: 1, y: 0 });
  assert.equal(state.moveCount, 3);
  assert.equal(state.currentPlayer, 'white');
});

test('提子：多子棋块被整块提掉', () => {
  const game = new Go9Game();
  playSequence(game, [
    [0, 1], // 黑
    [0, 0], // 白
    [1, 1], // 黑
    [1, 0], // 白：两子相连，还剩 (2,0) 一口气
    [2, 0], // 黑：白两子无气，整块被提
  ]);

  const state = game.getState();
  assert.equal(state.board[0][0], null);
  assert.equal(state.board[0][1], null);
  assert.deepEqual(state.captures, { black: 2, white: 0 });
  assert.equal(state.moves[4].captured, 2);
});

test('拒绝越界、已占点与非整数坐标，且不改变棋局', () => {
  const game = new Go9Game();
  game.place(4, 4);
  const before = snapshot(game);

  assert.deepEqual(game.place(-1, 0), { ok: false, reason: 'out_of_board' });
  assert.deepEqual(game.place(0, 9), { ok: false, reason: 'out_of_board' });
  assert.deepEqual(game.place(4.5, 4), { ok: false, reason: 'out_of_board' });
  assert.deepEqual(game.place(4, 4), { ok: false, reason: 'occupied' });

  assert.equal(snapshot(game), before);
});

test('禁止自杀手，且失败的自杀手不改变棋局', () => {
  const game = new Go9Game();
  playSequence(game, [
    [0, 1], // 黑
    [8, 8], // 白
    [1, 0], // 黑，黑棋包住角上 (0,0)
  ]);
  const before = snapshot(game);

  // 白在 (0,0) 落子后自身无气、又提不掉黑棋 => 自杀
  assert.deepEqual(game.place(0, 0), { ok: false, reason: 'suicide' });
  assert.equal(snapshot(game), before);
  assert.ok(!game.getLegalMoves().some((move) => move.x === 0 && move.y === 0));
});

test('游戏结束后 place 返回 game_over 且不改变棋局', () => {
  const game = new Go9Game();
  playSequence(game, ['resign']);
  const before = snapshot(game);

  assert.deepEqual(game.place(0, 0), { ok: false, reason: 'game_over' });
  assert.equal(game.getState().winner, 'white');
  assert.equal(snapshot(game), before);
});

// ---------------------------------------------------------------------------
// 劫
// ---------------------------------------------------------------------------

/** 构造标准“单子提单子”的劫形，黑先提劫。 */
function createKoGame() {
  const game = new Go9Game();
  playSequence(game, [
    [1, 0], // 黑
    [1, 1], // 白（将被提的劫材）
    [8, 0], // 黑
    [2, 0], // 白
    [0, 1], // 黑
    [2, 2], // 白
    [1, 2], // 黑
    [3, 1], // 白
  ]);
  return game;
}

test('简单劫：提劫成功，立即提回被拒绝（reason=ko）', () => {
  const game = createKoGame();
  const capture = game.place(2, 1);

  assert.equal(capture.ok, true);
  assert.equal(capture.captured, 1);
  assert.deepEqual(game.koPoint, { x: 1, y: 1 });
  assert.equal(game.getState().board[1][1], null);

  const before = snapshot(game);
  assert.deepEqual(game.place(1, 1), { ok: false, reason: 'ko' });
  assert.equal(snapshot(game), before);
  assert.ok(!game.getLegalMoves().some((move) => move.x === 1 && move.y === 1));
});

test('位置超级劫：重复盘面被拒绝（含此前出现过的局面）', () => {
  // 3 路小棋盘上存在一个 3 手循环：第 14 手会让盘面回到第 11 手后的局面。
  const game = new Go9Game({ size: 3 });
  playSequence(game, [
    [0, 0],
    [1, 0],
    [2, 0],
    [0, 1],
    [1, 1],
    [0, 0],
    [2, 1],
    [1, 2],
    [0, 2],
    [0, 0],
    [1, 0],
    [0, 1],
    [0, 2],
  ]);
  assert.equal(game.getState().moveCount, 13);

  const before = snapshot(game);
  assert.deepEqual(game.place(0, 0), { ok: false, reason: 'superko' });
  assert.equal(snapshot(game), before);
});

test('位置超级劫：重复的并非初始局面时同样被拒绝', () => {
  // 上面的循环重复的是第 11 手后的盘面（并非初始空盘），验证“全部历史局面”都参与判定。
  const game = new Go9Game({ size: 3 });
  const cycle = [
    [0, 0],
    [1, 0],
    [2, 0],
    [0, 1],
    [1, 1],
    [0, 0],
    [2, 1],
    [1, 2],
    [0, 2],
    [0, 0],
    [1, 0],
    [0, 1],
    [0, 2],
  ];
  const boardHistory = [];
  for (const [x, y] of cycle) {
    game.place(x, y);
    boardHistory.push(JSON.stringify(game.getState().board));
  }
  const repeated = game.place(0, 0);
  assert.equal(repeated.ok, false);
  assert.equal(repeated.reason, 'superko');
  // 未被接受的着法不会写进历史
  assert.equal(game.getState().moveCount, cycle.length);
  assert.equal(boardHistory.length, cycle.length);
});

// ---------------------------------------------------------------------------
// pass / 终局 / 数子
// ---------------------------------------------------------------------------

test('pass：写入着法、切换行棋方、清除劫点并重置连 pass 计数', () => {
  const game = new Go9Game();
  const result = game.pass();

  assert.deepEqual(result, { ok: true, gameOver: false, winner: null });
  const state = game.getState();
  assert.equal(state.currentPlayer, 'white');
  assert.equal(state.passCount, 1);
  assert.deepEqual(state.moves[0], { x: null, y: null, player: 'black', captured: 0, pass: true });
  assert.deepEqual(state.lastMove, { x: null, y: null });

  // 对方落子会清空 passCount
  game.place(4, 4);
  assert.equal(game.getState().passCount, 0);
  assert.equal(game.getState().currentPlayer, 'black');
});

test('连续两次 pass 数子终局，result 形状与计分正确', () => {
  const game = new Go9Game();
  playSequence(game, [
    [0, 1], // 黑
    [8, 8], // 白
    [1, 1], // 黑
    [8, 7], // 白
    [1, 0], // 黑：封住角上空点 (0,0)
    [7, 8], // 白
    'pass', // 黑 pass
    'pass', // 白 pass => 终局
  ]);

  const state = game.getState();
  assert.equal(state.winner, 'white');
  assert.equal(state.passCount, 2);
  assert.equal(state.moves.length, 8);
  assert.deepEqual(state.moves[6], { x: null, y: null, player: 'black', captured: 0, pass: true });
  assert.deepEqual(state.moves[7], { x: null, y: null, player: 'white', captured: 0, pass: true });
  // 黑：3 子 + 1 目角空 = 4；白：3 子 + 贴目 7.5 = 10.5
  assert.deepEqual(state.result, { method: 'score', black: 4, white: 10.5, winner: 'white', margin: 6.5 });
  assert.equal(state.board[0][0], null);
});

test('和棋：komi=0 且双方无子时 winner=draw', () => {
  const game = new Go9Game({ komi: 0 });
  game.pass();
  game.pass();

  const state = game.getState();
  assert.equal(state.winner, 'draw');
  assert.deepEqual(state.result, { method: 'score', black: 0, white: 0, winner: 'draw', margin: 0 });
});

test('终局后 pass 返回 game_over', () => {
  const game = new Go9Game();
  game.pass();
  game.pass();
  assert.deepEqual(game.pass(), { ok: false, reason: 'game_over' });
  assert.deepEqual(game.getLegalMoves(), []);
});

// ---------------------------------------------------------------------------
// 认输
// ---------------------------------------------------------------------------

test('认输：默认当前行棋方认输，result 形状正确', () => {
  const game = new Go9Game();
  game.place(4, 4);
  const result = game.resign();

  assert.deepEqual(result, { ok: true, winner: 'black' });
  const state = game.getState();
  assert.equal(state.currentPlayer, 'white');
  assert.equal(state.winner, 'black');
  assert.deepEqual(state.result, { method: 'resign', black: null, white: null, winner: 'black', margin: null });
  assert.equal(state.board[4][4], 'black');
});

test('认输：可显式指定认输方，非法玩家不改变棋局', () => {
  const game = new Go9Game();
  game.place(4, 4);
  const before = snapshot(game);

  assert.deepEqual(game.resign('green'), { ok: false, reason: 'invalid_move' });
  assert.equal(snapshot(game), before);

  assert.deepEqual(game.resign('black'), { ok: true, winner: 'white' });
  assert.equal(game.getState().winner, 'white');
  assert.deepEqual(game.resign(), { ok: false, reason: 'game_over' });
});

// ---------------------------------------------------------------------------
// 悔棋
// ---------------------------------------------------------------------------

test('undo：恢复盘面、行棋方、提子数与着法历史', () => {
  const game = new Go9Game();
  playSequence(game, [
    [0, 1],
    [0, 0],
    [1, 0], // 提掉白 (0,0)
  ]);
  assert.deepEqual(game.getState().captures, { black: 1, white: 0 });

  assert.deepEqual(game.undo(1), { ok: true, undone: 1 });
  let state = game.getState();
  assert.equal(state.board[0][0], 'white');
  assert.equal(state.board[0][1], null);
  assert.deepEqual(state.captures, { black: 0, white: 0 });
  assert.equal(state.moves.length, 2);
  assert.equal(state.currentPlayer, 'black');

  assert.deepEqual(game.undo(1), { ok: true, undone: 1 });
  state = game.getState();
  assert.equal(state.board[0][0], null);
  assert.equal(state.moves.length, 1);
  assert.equal(state.currentPlayer, 'white');
});

test('undo：无棋可悔时返回 nothing_to_undo', () => {
  const game = new Go9Game();
  assert.deepEqual(game.undo(), { ok: false, reason: 'nothing_to_undo' });

  game.place(4, 4);
  assert.deepEqual(game.undo(5), { ok: true, undone: 1 });
  assert.deepEqual(game.undo(), { ok: false, reason: 'nothing_to_undo' });
});

test('undo：可跨两次 pass 的终局，恢复为进行中', () => {
  const game = new Go9Game();
  playSequence(game, [[4, 4], 'pass', 'pass']);
  // 盘上只有黑子，空区全部连到黑棋：黑 81 : 白 7.5
  assert.equal(game.getState().winner, 'black');

  assert.deepEqual(game.undo(1), { ok: true, undone: 1 });
  let state = game.getState();
  assert.equal(state.winner, null);
  assert.equal(state.result, null);
  assert.equal(state.passCount, 1);
  assert.equal(state.currentPlayer, 'black');
  assert.equal(state.moves.length, 2);

  // 跨终局之前再悔一步，回到第一次 pass 之前
  assert.deepEqual(game.undo(1), { ok: true, undone: 1 });
  state = game.getState();
  assert.equal(state.passCount, 0);
  assert.equal(state.currentPlayer, 'white');
  assert.equal(state.moves.length, 1);

  // 悔棋后可继续正常落子
  assert.equal(game.place(8, 8).ok, true);
});

test('undo：可撤销认输，恢复为进行中', () => {
  const game = new Go9Game();
  playSequence(game, [[4, 4], 'resign']);
  assert.equal(game.getState().winner, 'black');

  assert.deepEqual(game.undo(1), { ok: true, undone: 1 });
  const state = game.getState();
  assert.equal(state.winner, null);
  assert.equal(state.result, null);
  assert.equal(state.currentPlayer, 'white');
  assert.equal(state.moves.length, 1);
});

test('undo：同步恢复超级劫历史与劫点', () => {
  const game = createKoGame();
  assert.equal(game.place(2, 1).ok, true);
  assert.deepEqual(game.koPoint, { x: 1, y: 1 });

  assert.deepEqual(game.undo(1), { ok: true, undone: 1 });
  assert.equal(game.koPoint, null);
  // 悔棋后同一手可以再次落子（盘面历史已回滚）
  assert.equal(game.place(2, 1).ok, true);
  assert.deepEqual(game.place(1, 1), { ok: false, reason: 'ko' });
});

// ---------------------------------------------------------------------------
// 合法着点
// ---------------------------------------------------------------------------

test('getLegalMoves：排除已占点、自杀点与劫点', () => {
  const suicideBoard = new Go9Game();
  playSequence(suicideBoard, [
    [0, 1],
    [8, 8],
    [1, 0],
  ]);
  const suicideMoves = suicideBoard.getLegalMoves();
  assert.equal(suicideMoves.length, 77); // 81 - 3 子 - 1 个自杀点
  assert.ok(!suicideMoves.some((move) => move.x === 0 && move.y === 0));
  assert.ok(!suicideMoves.some((move) => move.x === 8 && move.y === 8)); // 已占点

  const koGame = createKoGame();
  koGame.place(2, 1);
  const koMoves = koGame.getLegalMoves();
  assert.ok(!koMoves.some((move) => move.x === 1 && move.y === 1));
  assert.ok(koMoves.every((move) => move.x >= 0 && move.x < 9 && move.y >= 0 && move.y < 9));
});

test('getLegalMoves：每个合法点都能真正落子，终局与满盘返回空数组', () => {
  const game = new Go9Game();
  playSequence(game, [
    [4, 4],
    [3, 4],
    [5, 4],
    [4, 3],
  ]);
  const legalMoves = game.getLegalMoves();
  assert.equal(legalMoves.length, 81 - 4);
  for (const move of legalMoves) {
    assert.equal(game.clone().place(move.x, move.y).ok, true, `合法点 ${move.x},${move.y} 应可落子`);
  }

  const tiny = new Go9Game({ size: 1 });
  tiny.place(0, 0);
  assert.deepEqual(tiny.getLegalMoves(), []);
});

// ---------------------------------------------------------------------------
// clone / replay
// ---------------------------------------------------------------------------

test('clone：深拷贝且与原对局互不影响', () => {
  const game = new Go9Game();
  playSequence(game, [[4, 4], [3, 4]]);
  const copy = game.clone();

  assert.deepEqual(copy.getState(), game.getState());

  copy.place(5, 5);
  assert.equal(game.getState().board[5][5], null);
  assert.equal(copy.getState().board[5][5], 'black');

  game.place(2, 2);
  assert.equal(copy.getState().board[2][2], null);

  copy.undo(1);
  assert.equal(copy.getState().moves.length, 2);
  assert.equal(game.getState().moves.length, 3);
});

test('clone：保留劫点与超级劫历史', () => {
  const game = createKoGame();
  game.place(2, 1);
  const copy = game.clone();

  assert.deepEqual(copy.koPoint, { x: 1, y: 1 });
  assert.deepEqual(copy.place(1, 1), { ok: false, reason: 'ko' });

  copy.undo(1);
  assert.equal(copy.place(2, 1).ok, true);
  // 原对局不受副本影响
  assert.equal(game.getState().moves.length, 9);
});

test('static replay：重建完整对局状态（含 pass 终局）', () => {
  const game = new Go9Game();
  playSequence(game, [
    [0, 1],
    [8, 8],
    [1, 1],
    [8, 7],
    [1, 0],
    [7, 8],
    'pass',
    'pass',
  ]);

  const replayed = Go9Game.replay(game.getState().moves);
  assert.deepEqual(replayed.getState(), game.getState());

  const customKomi = Go9Game.replay(game.getState().moves, { komi: 0.5 });
  assert.equal(customKomi.getState().komi, 0.5);
  assert.deepEqual(customKomi.getState().result, { method: 'score', black: 4, white: 3.5, winner: 'black', margin: 0.5 });
});

test('static replay：遇到非法着法时停止并返回已重建部分', () => {
  const replayed = Go9Game.replay([
    { x: 4, y: 4 },
    { x: 4, y: 4 }, // 已占点，回放应在此停止
    { x: 0, y: 0 },
  ]);
  assert.equal(replayed.getState().moveCount, 1);
  assert.equal(replayed.getState().board[4][4], 'black');
});

// ---------------------------------------------------------------------------
// 坐标 / SGF 无关性
// ---------------------------------------------------------------------------

test('坐标与 SGF 映射无关：a-i 全覆盖，第 9 路 (8,8) 可正常落子', () => {
  const SGF_LETTERS = 'abcdefghi';
  assert.equal(SGF_LETTERS.length, 9);
  assert.equal(SGF_LETTERS.indexOf('i'), 8);

  const game = new Go9Game();
  const x = SGF_LETTERS.indexOf('i');
  const y = SGF_LETTERS.indexOf('i');
  assert.equal(game.place(x, y).ok, true);
  assert.equal(game.getState().board[8][8], 'black');
  assert.equal(game.getState().moves[0].x, 8);
  assert.equal(game.getState().moves[0].y, 8);
});

test('非法 place/pass/resign 不改变内部状态', () => {
  const game = new Go9Game();
  playSequence(game, [[0, 1], [8, 8], [1, 0]]);
  const before = snapshot(game);

  assert.equal(game.place(0, 0).ok, false); // 自杀
  assert.equal(game.place(-1, 0).ok, false); // 越界
  assert.equal(game.place(0, 1).ok, false); // 已占
  assert.equal(game.resign('green').ok, false); // 非法认输方
  assert.equal(snapshot(game), before);

  game.pass();
  game.pass();
  const finished = snapshot(game);
  assert.equal(game.place(4, 4).ok, false);
  assert.equal(game.pass().ok, false);
  assert.equal(game.resign().ok, false);
  assert.equal(snapshot(game), finished);
});
