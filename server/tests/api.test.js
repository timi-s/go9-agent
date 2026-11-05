'use strict';

/**
 * 后端 API 集成测试（node:test + fetch，端口 0 随机）。
 *
 * 测试不依赖真实 server/dev.db：
 * - 正常路径注入内存假持久化（record 存在 Map 中，模拟 Prisma Game 表）
 * - 数据库不可用 / 持久化失败路径注入 null / 抛错 db
 * - 覆盖 docs/API.md 的路由、GameState 结构、错误 reason、SGF 格式、参数校验
 */

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createApp } = require('../src/app');
const { GameStore } = require('../src/gameStore');
const {
  resolveDatabaseUrl,
  createDatabase,
  DEFAULT_DB_FILENAME,
} = require('../src/db');
const { sgfCoord, serializeSgf, sgfResult } = require('../src/sgf');
const HeuristicGoAgent = require('../src/agents/heuristicGoAgent');

const SERVER_DIR = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  });
}

function createFakePrisma() {
  const games = new Map();

  function copy(record) {
    return record ? { ...record } : record;
  }

  return {
    games,
    game: {
      async create({ data }) {
        const record = {
          gameType: 'go9',
          status: 'playing',
          winner: null,
          analysisJson: null,
          aiProvider: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        games.set(record.id, record);
        return copy(record);
      },
      async update({ where, data }) {
        const record = games.get(where.id);
        if (!record) {
          const error = new Error('Record not found');
          error.code = 'P2025';
          throw error;
        }
        Object.assign(record, data, { updatedAt: new Date() });
        return copy(record);
      },
      async findUnique({ where }) {
        return copy(games.get(where.id) || null);
      },
      async findMany({ take }) {
        return Array.from(games.values())
          .sort((left, right) => new Date(right.updatedAt) - new Date(left.updatedAt))
          .slice(0, take)
          .map(copy);
      },
      async count() {
        return games.size;
      },
    },
  };
}

function createFakeDb(prisma = createFakePrisma()) {
  return {
    enabled: true,
    available: true,
    url: 'file::fake:',
    filePath: null,
    prisma,
    error: null,
    markUnavailable(error) {
      this.available = false;
      this.error = error || new Error('unavailable');
    },
  };
}

/**
 * 假 provider registry：不依赖真实 http/katago。
 * - heuristic：默认，成功
 * - fake：测试用“可用外部 provider”，成功返回首个合法着点
 * - http/katago：模拟“已配置但不可用”，registry 层回退 heuristic 并带 fallback
 */
function createFakeRegistry() {
  const agents = [
    {
      id: 'heuristic',
      label: '内置启发式 AI',
      kind: 'builtin',
      available: true,
      description: '内置启发式 AI',
      requires: [],
    },
    {
      id: 'http',
      label: 'OpenAI 兼容 API',
      kind: 'api',
      available: false,
      description: '外部 HTTP AI',
      requires: ['AI_HTTP_BASE_URL'],
    },
    {
      id: 'katago',
      label: 'KataGo',
      kind: 'engine',
      available: false,
      description: '本地 KataGo',
      requires: ['KATAGO_CMD'],
    },
    {
      id: 'fake',
      label: '测试 AI',
      kind: 'api',
      available: true,
      description: '测试用 provider',
      requires: [],
    },
  ];

  const registry = {
    defaultProvider: 'heuristic',
    calls: [],
    shutdownCalled: false,
    list() {
      return agents.map((agent) => ({ ...agent }));
    },
    get(id) {
      const found = agents.find((agent) => agent.id === id);
      if (!found) return null;
      return {
        async getMove(game) {
          const legal = game.getLegalMoves();
          return legal.length > 0 ? { x: legal[0].x, y: legal[0].y } : null;
        },
      };
    },
    async move(providerId, game, { difficulty = 'medium' } = {}) {
      registry.calls.push({ providerId, difficulty });
      const legal = game.getLegalMoves();
      const move = legal.length > 0 ? { x: legal[0].x, y: legal[0].y } : null;
      if (providerId === 'fake') {
        return { move, providerId: 'fake', fallback: null };
      }
      // heuristic 正常；http/katago 模拟“未配置/不可用”回退
      if (providerId === 'heuristic') {
        return { move, providerId: 'heuristic', fallback: null };
      }
      return { move, providerId: 'heuristic', fallback: { from: providerId, reason: 'not_configured' } };
    },
    async shutdown() {
      registry.shutdownCalled = true;
    },
  };
  return registry;
}

function makeHarness({ db, agent, registry, version = '1.0.0-test' } = {}) {
  const actualAgent = agent === undefined ? new HeuristicGoAgent({ seed: 20261105 }) : agent;
  const store = new GameStore({ db: db === undefined ? null : db, agent: actualAgent, registry });
  const app = createApp({ db: db || null, agent: actualAgent, registry, version, store });
  return { app, store, agent: actualAgent, registry };
}

async function withHarness(options, fn) {
  const harness = makeHarness(options);
  const { server, base } = await listen(harness.app);
  try {
    return await fn(base, harness);
  } finally {
    await closeServer(server);
  }
}

function makeClient(base) {
  async function api(pathname, options = {}) {
    const init = { method: options.method || 'GET' };
    if (options.rawBody !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = options.rawBody;
    } else if (options.body !== undefined) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(options.body);
    }
    const response = await fetch(`${base}${pathname}`, init);
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, headers: response.headers, text, json };
  }

  async function createGame(body = {}) {
    const response = await api('/api/games', { method: 'POST', body });
    assert.equal(response.status, 201, `create game failed: ${response.text}`);
    return response.json;
  }

  return { api, createGame };
}

// ---------------------------------------------------------------------------
// 数据库路径与迁移（bug #1 / #2 回归）
// ---------------------------------------------------------------------------

describe('数据库配置', () => {
  test('默认数据库路径解析为 <server>/dev.db 绝对路径（bug #1）', () => {
    assert.equal(resolveDatabaseUrl(undefined), `file:${path.join(SERVER_DIR, DEFAULT_DB_FILENAME)}`);
    assert.equal(resolveDatabaseUrl(''), `file:${path.join(SERVER_DIR, DEFAULT_DB_FILENAME)}`);
  });

  test('DATABASE_URL 的 file: 相对路径以 server 目录为基准解析', () => {
    assert.equal(resolveDatabaseUrl('file:./dev.db'), `file:${path.join(SERVER_DIR, 'dev.db')}`);
    assert.equal(resolveDatabaseUrl('file:dev.db'), `file:${path.join(SERVER_DIR, 'dev.db')}`);
    assert.equal(
      resolveDatabaseUrl('file:./prisma/custom.db'),
      `file:${path.join(SERVER_DIR, 'prisma', 'custom.db')}`,
    );
  });

  test('DATABASE_URL 支持绝对路径与 :memory:', () => {
    assert.equal(resolveDatabaseUrl('file:C:/data/go9.db'), 'file:C:/data/go9.db');
    assert.equal(resolveDatabaseUrl('file::memory:'), 'file::memory:');
  });

  test('DISABLE_DB=1 时不加载 Prisma 客户端（纯内存）', () => {
    const db = createDatabase({ env: { DISABLE_DB: '1' } });
    assert.equal(db.enabled, false);
    assert.equal(db.available, false);
    assert.equal(db.prisma, null);
  });

  test('schema 与迁移包含 analysisJson / aiProvider 字段（bug #2 与新契约）', () => {
    const schema = fs.readFileSync(path.join(SERVER_DIR, 'prisma', 'schema.prisma'), 'utf8');
    assert.match(schema, /analysisJson\s+String\?/);
    assert.match(schema, /aiProvider\s+String\?/);

    const migrationDir = path.join(SERVER_DIR, 'prisma', 'migrations', '20261105120000_add_analysis_json');
    assert.equal(fs.existsSync(path.join(migrationDir, 'migration.sql')), true);
    const migration = fs.readFileSync(path.join(migrationDir, 'migration.sql'), 'utf8');
    assert.match(migration, /ALTER TABLE "Game" ADD COLUMN "analysisJson" TEXT/);

    const providerMigrationDir = path.join(
      SERVER_DIR,
      'prisma',
      'migrations',
      '20261105130000_add_ai_provider',
    );
    assert.equal(fs.existsSync(path.join(providerMigrationDir, 'migration.sql')), true);
    const providerMigration = fs.readFileSync(path.join(providerMigrationDir, 'migration.sql'), 'utf8');
    assert.match(providerMigration, /ALTER TABLE "Game" ADD COLUMN "aiProvider" TEXT/);
  });
});

// ---------------------------------------------------------------------------
// SGF 序列化
// ---------------------------------------------------------------------------

describe('SGF 序列化', () => {
  test('9 路坐标使用 a-i 且不跳过 i', () => {
    assert.equal(sgfCoord(0, 0), 'aa');
    assert.equal(sgfCoord(4, 4), 'ee');
    assert.equal(sgfCoord(8, 0), 'ia');
    assert.equal(sgfCoord(8, 8), 'ii');
    assert.equal(sgfCoord(9, 0), null);
    assert.equal(sgfCoord(0, 9), null);
  });

  test('RE 取 B+R / W+R / 比分 / 0', () => {
    assert.equal(sgfResult({ winner: 'black', result: { method: 'resign', winner: 'black' } }), 'B+R');
    assert.equal(sgfResult({ winner: 'white', result: { method: 'resign', winner: 'white' } }), 'W+R');
    assert.equal(sgfResult({ winner: 'black', result: { method: 'score', margin: 3.5 } }), 'B+3.5');
    assert.equal(sgfResult({ winner: 'white', result: { method: 'score', margin: 2.5 } }), 'W+2.5');
    assert.equal(sgfResult({ winner: 'draw', result: { method: 'score', margin: 0 } }), '0');
    assert.equal(sgfResult({ winner: null }), '');
  });

  test('完整 SGF 头与着法', () => {
    const sgf = serializeSgf({
      komi: 7.5,
      createdAt: new Date('2026-11-05T00:00:00.000Z'),
      moves: [
        { x: 4, y: 4, player: 'black', captured: 0 },
        { x: null, y: null, player: 'white', captured: 0, pass: true },
      ],
      winner: 'black',
      result: { method: 'score', black: 43, white: 39.5, winner: 'black', margin: 3.5 },
    });
    assert.match(sgf, /^\(;FF\[4\]GM\[1\]CA\[UTF-8\]SZ\[9\]KM\[7\.5\]PB\[黑方\]PW\[白方\]DT\[2026-11-05\]RE\[B\+3\.5\]/);
    assert.match(sgf, /;B\[ee\]/);
    assert.match(sgf, /;W\[\]/);
    assert.equal(sgf.endsWith(')'), true);
  });
});

// ---------------------------------------------------------------------------
// 主流程（假 DB，模拟 Prisma）
// ---------------------------------------------------------------------------

describe('HTTP API', () => {
  let server;
  let base;
  let client;
  let db;
  let prisma;

  before(async () => {
    prisma = createFakePrisma();
    db = createFakeDb(prisma);
    const harness = makeHarness({ db });
    ({ server, base } = await listen(harness.app));
    client = makeClient(base);
  });

  after(async () => {
    await closeServer(server);
  });

  test('GET /api/health 返回 version / db / uptime', async () => {
    const response = await client.api('/api/health');
    assert.equal(response.status, 200);
    assert.equal(response.json.ok, true);
    assert.equal(response.json.version, '1.0.0-test');
    assert.equal(response.json.db, true);
    assert.equal(typeof response.json.uptime, 'number');
  });

  test('POST /api/games 返回 201 与完整初始 GameState', async () => {
    const created = await client.createGame();
    assert.equal(created.ok, true);
    assert.equal(typeof created.id, 'string');
    assert.ok(created.id.length > 0);

    const state = created.state;
    assert.equal(state.size, 9);
    assert.equal(state.board.length, 9);
    assert.ok(state.board.every((row) => row.length === 9 && row.every((cell) => cell === null)));
    assert.equal(state.currentPlayer, 'black');
    assert.deepEqual(state.moves, []);
    assert.deepEqual(state.captures, { black: 0, white: 0 });
    assert.equal(state.winner, null);
    assert.equal(state.result, null);
    assert.equal(state.passCount, 0);
    assert.equal(state.koPoint, null);
    assert.equal(state.lastMove, null);
    assert.equal(state.moveCount, 0);
    assert.equal(state.komi, 7.5);
    assert.equal(state.aiProvider, 'heuristic');
  });

  test('POST /api/games 回显 playerColor，非法 playerColor 返回 400', async () => {
    const created = await client.api('/api/games', { method: 'POST', body: { playerColor: 'white' } });
    assert.equal(created.status, 201);
    assert.equal(created.json.playerColor, 'white');

    const invalid = await client.api('/api/games', { method: 'POST', body: { playerColor: 'red' } });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.ok, false);
    assert.equal(invalid.json.reason, 'invalid_body');
  });

  test('落子更新棋盘 / 行棋方 / lastMove / moveCount', async () => {
    const { id } = await client.createGame();
    const moved = await client.api(`/api/games/${id}/move`, { method: 'POST', body: { x: 4, y: 4 } });
    assert.equal(moved.status, 200);
    assert.equal(moved.json.ok, true);

    const state = moved.json.state;
    assert.equal(state.board[4][4], 'black');
    assert.equal(state.currentPlayer, 'white');
    assert.deepEqual(state.lastMove, { x: 4, y: 4 });
    assert.equal(state.moveCount, 1);
    assert.deepEqual(state.moves[0], { x: 4, y: 4, player: 'black', captured: 0 });

    const fetched = await client.api(`/api/games/${id}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.json.id, id);
    assert.equal(fetched.json.state.moveCount, 1);
  });

  test('非法落子返回 400 invalid_body 且不改变棋局', async () => {
    const { id } = await client.createGame();
    const badBodies = [
      {},
      { x: 9, y: 0 },
      { x: -1, y: 0 },
      { x: 1.5, y: 2 },
      { x: '1', y: 2 },
      { x: 1, y: null },
    ];
    for (const body of badBodies) {
      const response = await client.api(`/api/games/${id}/move`, { method: 'POST', body });
      assert.equal(response.status, 400, `body=${JSON.stringify(body)} should be rejected`);
      assert.equal(response.json.ok, false);
      assert.equal(response.json.reason, 'invalid_body');
    }
    const arrayBody = await client.api(`/api/games/${id}/move`, { method: 'POST', body: [1, 2] });
    assert.equal(arrayBody.status, 400);
    assert.equal(arrayBody.json.reason, 'invalid_body');

    const fetched = await client.api(`/api/games/${id}`);
    assert.equal(fetched.json.state.moveCount, 0);
    assert.equal(fetched.json.state.board[1][1], null);
  });

  test('规则拒绝（occupied）返回 400 引擎 reason', async () => {
    const { id } = await client.createGame();
    await client.api(`/api/games/${id}/move`, { method: 'POST', body: { x: 4, y: 4 } });
    const occupied = await client.api(`/api/games/${id}/move`, { method: 'POST', body: { x: 4, y: 4 } });
    assert.equal(occupied.status, 400);
    assert.equal(occupied.json.ok, false);
    assert.equal(occupied.json.reason, 'occupied');

    const state = (await client.api(`/api/games/${id}`)).json.state;
    assert.equal(state.moveCount, 1);
    assert.equal(state.currentPlayer, 'white');
  });

  test('undo：默认 1 手、越界夹取、无棋可悔返回 nothing_to_undo', async () => {
    const { id } = await client.createGame();
    await client.api(`/api/games/${id}/move`, { method: 'POST', body: { x: 0, y: 0 } });
    await client.api(`/api/games/${id}/move`, { method: 'POST', body: { x: 8, y: 8 } });

    const undoOne = await client.api(`/api/games/${id}/undo`, { method: 'POST', body: {} });
    assert.equal(undoOne.status, 200);
    assert.equal(undoOne.json.state.moveCount, 1);

    // docs：steps 超出按边界处理（夹取到 20），这里只剩 1 手可悔
    const undoMany = await client.api(`/api/games/${id}/undo`, { method: 'POST', body: { steps: 99 } });
    assert.equal(undoMany.status, 200);
    assert.equal(undoMany.json.state.moveCount, 0);

    const nothing = await client.api(`/api/games/${id}/undo`, { method: 'POST', body: { steps: 1 } });
    assert.equal(nothing.status, 400);
    assert.equal(nothing.json.reason, 'nothing_to_undo');

    const invalid = await client.api(`/api/games/${id}/undo`, { method: 'POST', body: { steps: 'two' } });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.reason, 'invalid_body');
  });

  test('连续两次 pass 自动数子终局，可悔棋恢复进行中', async () => {
    const { id } = await client.createGame();

    const firstPass = await client.api(`/api/games/${id}/pass`, { method: 'POST' });
    assert.equal(firstPass.status, 200);
    assert.equal(firstPass.json.gameOver, false);
    assert.equal(firstPass.json.winner, null);
    assert.equal(firstPass.json.state.passCount, 1);
    assert.equal(firstPass.json.state.currentPlayer, 'white');
    assert.equal(firstPass.json.state.moves[0].pass, true);
    assert.equal(firstPass.json.state.moves[0].player, 'black');

    const secondPass = await client.api(`/api/games/${id}/pass`, { method: 'POST' });
    assert.equal(secondPass.status, 200);
    assert.equal(secondPass.json.gameOver, true);
    assert.equal(secondPass.json.winner, 'white');
    const state = secondPass.json.state;
    assert.equal(state.winner, 'white');
    assert.equal(state.result.method, 'score');
    assert.equal(state.result.black, 0);
    assert.equal(state.result.white, 7.5);
    assert.equal(state.result.margin, 7.5);
    assert.equal(state.result.winner, 'white');
    assert.equal(state.moveCount, 2);

    const moveAfter = await client.api(`/api/games/${id}/move`, { method: 'POST', body: { x: 0, y: 0 } });
    assert.equal(moveAfter.status, 400);
    assert.equal(moveAfter.json.reason, 'game_over');

    const undo = await client.api(`/api/games/${id}/undo`, { method: 'POST', body: { steps: 2 } });
    assert.equal(undo.status, 200);
    assert.equal(undo.json.state.winner, null);
    assert.equal(undo.json.state.result, null);
    assert.equal(undo.json.state.moveCount, 0);
  });

  test('resign：默认当前行棋方认输，终局后仍可悔棋', async () => {
    const first = await client.createGame();
    // 黑先落一手 -> 白方行棋 -> 默认白认输 => 黑胜
    await client.api(`/api/games/${first.id}/move`, { method: 'POST', body: { x: 0, y: 0 } });
    const resigned = await client.api(`/api/games/${first.id}/resign`, { method: 'POST', body: {} });
    assert.equal(resigned.status, 200);
    assert.equal(resigned.json.state.winner, 'black');
    assert.deepEqual(resigned.json.state.result, {
      method: 'resign',
      black: null,
      white: null,
      winner: 'black',
      margin: null,
    });

    const undo = await client.api(`/api/games/${first.id}/undo`, { method: 'POST' });
    assert.equal(undo.status, 200);
    assert.equal(undo.json.state.winner, null);
    assert.equal(undo.json.state.result, null);
    assert.equal(undo.json.state.currentPlayer, 'white');

    const withPlayer = await client.createGame();
    const blackResign = await client.api(`/api/games/${withPlayer.id}/resign`, { method: 'POST', body: { player: 'black' } });
    assert.equal(blackResign.status, 200);
    assert.equal(blackResign.json.state.winner, 'white');

    const invalid = await client.api(`/api/games/${withPlayer.id}/resign`, { method: 'POST', body: { player: 'green' } });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.reason, 'invalid_body');

    const afterResign = await client.api(`/api/games/${withPlayer.id}/resign`, { method: 'POST', body: {} });
    assert.equal(afterResign.status, 400);
    assert.equal(afterResign.json.reason, 'game_over');
  });

  test('AI 走一手：着点合法、写入历史、difficulty 校验', async () => {
    const { id } = await client.createGame();
    const response = await client.api(`/api/games/${id}/ai-move`, { method: 'POST', body: { difficulty: 'medium' } });
    assert.equal(response.status, 200);
    assert.equal(response.json.ok, true);

    const { move, state } = response.json;
    assert.equal(state.moveCount, 1);
    if (move === null) {
      assert.equal(state.moves[0].pass, true);
      assert.equal(state.passCount, 1);
    } else {
      assert.ok(Number.isInteger(move.x) && Number.isInteger(move.y));
      assert.equal(state.board[move.y][move.x], 'black');
      assert.deepEqual(state.lastMove, move);
    }

    const invalidDifficulty = await client.api(`/api/games/${id}/ai-move`, {
      method: 'POST',
      body: { difficulty: 'brutal' },
    });
    assert.equal(invalidDifficulty.status, 400);
    assert.equal(invalidDifficulty.json.reason, 'invalid_body');

    const missing = await client.api('/api/games/does-not-exist/ai-move', { method: 'POST', body: {} });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.reason, 'not_found');
  });

  test('analyze 返回 mismatches/accuracy/mistakes/summary 并写入 analysisJson', async () => {
    const { id } = await client.createGame();
    for (const [x, y] of [[0, 0], [8, 8], [2, 2], [6, 6]]) {
      const moved = await client.api(`/api/games/${id}/move`, { method: 'POST', body: { x, y } });
      assert.equal(moved.status, 200);
    }

    const response = await client.api(`/api/games/${id}/analyze`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.equal(response.json.ok, true);

    const analysis = response.json.analysis;
    assert.equal(analysis.totalMoves, 4);
    assert.equal(analysis.comparedMoves, 4);
    assert.ok(Number.isInteger(analysis.mismatches));
    assert.ok(analysis.mismatches >= 0 && analysis.mismatches <= analysis.comparedMoves);
    assert.equal(typeof analysis.accuracy, 'number');
    assert.ok(analysis.accuracy >= 0 && analysis.accuracy <= 1);
    assert.equal(typeof analysis.averageLoss, 'number');
    assert.ok(analysis.averageLoss >= 0);
    assert.ok(['A', 'B', 'C', 'D'].includes(analysis.grade));

    // 新结构：阶段统计
    assert.ok(analysis.phases && typeof analysis.phases === 'object');
    assert.equal(analysis.phases.opening.label, '布局');
    assert.equal(analysis.phases.middle.label, '中盘');
    assert.equal(analysis.phases.endgame.label, '收官');
    const phaseMoves =
      analysis.phases.opening.moves + analysis.phases.middle.moves + analysis.phases.endgame.moves;
    assert.equal(phaseMoves, analysis.totalMoves);

    // 新结构：弱点
    assert.ok(Array.isArray(analysis.weaknesses));
    for (const weakness of analysis.weaknesses) {
      assert.equal(typeof weakness.code, 'string');
      assert.equal(typeof weakness.label, 'string');
      assert.ok(Number.isInteger(weakness.count) && weakness.count > 0);
      assert.ok(['high', 'medium', 'low'].includes(weakness.severity));
      assert.equal(typeof weakness.advice, 'string');
    }

    // 新结构：失误分级 + 原因
    assert.ok(Array.isArray(analysis.mistakes));
    assert.ok(analysis.mistakes.length <= 10);
    for (const mistake of analysis.mistakes) {
      assert.ok(Number.isInteger(mistake.moveIndex));
      assert.ok(mistake.played && Number.isInteger(mistake.played.x) && Number.isInteger(mistake.played.y));
      assert.ok(mistake.recommended === null || (Number.isInteger(mistake.recommended.x) && Number.isInteger(mistake.recommended.y)));
      assert.equal(typeof mistake.loss, 'number');
      assert.ok(mistake.loss >= 15);
      assert.ok(['inaccuracy', 'mistake', 'blunder'].includes(mistake.severity));
      assert.ok(
        ['self_atari', 'missed_capture', 'filled_own_eye', 'early_first_line', 'inefficient'].includes(mistake.reason),
      );
    }
    assert.match(analysis.summary, /一致率/);
    assert.match(analysis.summary, /评级/);

    // 持久化到 Game.analysisJson（bug #2 的核心验证）
    const record = prisma.games.get(id);
    assert.ok(record, 'game record should exist in fake db');
    assert.equal(typeof record.analysisJson, 'string');
    assert.deepEqual(JSON.parse(record.analysisJson), analysis);

    // GET /api/games/:id 必须带回已保存的 analysis，前端才能避免每次刷新重复复盘。
    const reloaded = await client.api(`/api/games/${id}`);
    assert.equal(reloaded.status, 200);
    assert.deepEqual(reloaded.json.analysis, analysis);

    const missing = await client.api('/api/games/does-not-exist/analyze', { method: 'POST' });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.reason, 'not_found');
  });

  test('SGF 导出：头部、坐标、pass、Content-Type/Disposition', async () => {
    const { id } = await client.createGame();
    await client.api(`/api/games/${id}/move`, { method: 'POST', body: { x: 4, y: 4 } });
    await client.api(`/api/games/${id}/pass`, { method: 'POST' });

    const response = await client.api(`/api/games/${id}/export`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/x-go-sgf');
    assert.equal(response.headers.get('content-disposition'), `attachment; filename="${id}.sgf"`);
    assert.match(
      response.text,
      /^\(;FF\[4\]GM\[1\]CA\[UTF-8\]SZ\[9\]KM\[7\.5\]PB\[黑方\]PW\[白方\]DT\[\d{4}-\d{2}-\d{2}\]RE\[/,
    );
    assert.ok(response.text.includes(';B[ee]'), '9 路中心坐标应为 ee');
    assert.ok(response.text.includes(';W[]'), 'pass 应输出为空坐标');
    assert.ok(response.text.endsWith(')'));

    // 终局后 RE 带比分
    const finished = await client.createGame();
    await client.api(`/api/games/${finished.id}/pass`, { method: 'POST' });
    await client.api(`/api/games/${finished.id}/pass`, { method: 'POST' });
    const finishedSgf = await client.api(`/api/games/${finished.id}/export`);
    assert.ok(finishedSgf.text.includes('RE[W+7.5]'), `unexpected RE: ${finishedSgf.text}`);

    const missing = await client.api('/api/games/does-not-exist/export');
    assert.equal(missing.status, 404);
    assert.equal(missing.json.ok, false);
    assert.equal(missing.json.reason, 'not_found');
  });

  test('对局列表按 updatedAt 倒序并支持 limit', async () => {
    const first = await client.createGame();
    const second = await client.createGame();
    // 让 first 的 updatedAt 严格更新（后落子）；sleep 避免同一毫秒导致排序不确定
    await new Promise((resolve) => setTimeout(resolve, 5));
    await client.api(`/api/games/${first.id}/move`, { method: 'POST', body: { x: 0, y: 0 } });

    const list = await client.api('/api/games');
    assert.equal(list.status, 200);
    assert.equal(list.json.ok, true);
    assert.ok(Array.isArray(list.json.games));
    assert.ok(list.json.games.length >= 2);
    const ids = list.json.games.map((game) => game.id);
    assert.ok(ids.indexOf(first.id) < ids.indexOf(second.id), '最近更新的对局应排在最前');

    const summary = list.json.games.find((game) => game.id === first.id);
    assert.equal(summary.status, 'playing');
    assert.equal(summary.winner, null);
    assert.equal(summary.moveCount, 1);
    assert.match(summary.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(summary.updatedAt, /^\d{4}-\d{2}-\d{2}T/);

    const limited = await client.api('/api/games?limit=1');
    assert.equal(limited.status, 200);
    assert.equal(limited.json.games.length, 1);
    assert.equal(limited.json.games[0].id, first.id);

    for (const badLimit of ['abc', '0', '-1', '1.5']) {
      const invalid = await client.api(`/api/games?limit=${encodeURIComponent(badLimit)}`);
      assert.equal(invalid.status, 400, `limit=${badLimit} should be rejected`);
      assert.equal(invalid.json.reason, 'invalid_body');
    }
  });

  test('未知路由与不存在对局返回 JSON 404', async () => {
    const unknown = await client.api('/api/unknown-route');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.ok, false);
    assert.equal(unknown.json.reason, 'not_found');

    const missing = await client.api('/api/games/does-not-exist');
    assert.equal(missing.status, 404);
    assert.equal(missing.json.ok, false);
    assert.equal(missing.json.reason, 'not_found');

    const root = await client.api('/');
    assert.equal(root.status, 404);
    assert.equal(root.json.reason, 'not_found');
  });

  test('请求体不是合法 JSON 时返回 400 JSON（不返回 HTML 堆栈）', async () => {
    const response = await client.api('/api/games', { method: 'POST', rawBody: '{"playerColor":' });
    assert.equal(response.status, 400);
    assert.equal(response.json.ok, false);
    assert.equal(response.json.reason, 'invalid_body');
    assert.ok(!response.text.includes('<html'), 'must not return HTML error page');
  });
});

// ---------------------------------------------------------------------------
// AI Provider API（注入假 registry，不依赖真实 http/katago）
// ---------------------------------------------------------------------------

describe('AI Provider API', () => {
  let server;
  let base;
  let client;
  let db;
  let prisma;
  let registry;

  before(async () => {
    prisma = createFakePrisma();
    db = createFakeDb(prisma);
    registry = createFakeRegistry();
    const harness = makeHarness({ db, registry });
    ({ server, base } = await listen(harness.app));
    client = makeClient(base);
  });

  after(async () => {
    await closeServer(server);
  });

  test('GET /api/agents 返回 default 与 provider 列表', async () => {
    const response = await client.api('/api/agents');
    assert.equal(response.status, 200);
    assert.equal(response.json.ok, true);
    assert.equal(response.json.default, 'heuristic');
    assert.ok(Array.isArray(response.json.agents));

    const ids = response.json.agents.map((agent) => agent.id);
    assert.ok(ids.includes('heuristic'));
    assert.ok(ids.includes('http'));
    assert.ok(ids.includes('katago'));
    for (const agent of response.json.agents) {
      assert.equal(typeof agent.id, 'string');
      assert.equal(typeof agent.label, 'string');
      assert.ok(['builtin', 'api', 'engine'].includes(agent.kind));
      assert.equal(typeof agent.available, 'boolean');
      assert.equal(typeof agent.description, 'string');
      assert.ok(Array.isArray(agent.requires));
    }
  });

  test('默认 registry（未注入）也可用：GET /api/agents 至少包含 heuristic', async () => {
    await withHarness({ db: null }, async (newBase) => {
      const newClient = makeClient(newBase);
      const response = await newClient.api('/api/agents');
      assert.equal(response.status, 200);
      assert.equal(response.json.ok, true);
      assert.equal(response.json.default, 'heuristic');
      const ids = response.json.agents.map((agent) => agent.id);
      assert.ok(ids.includes('heuristic'));
    });
  });

  test('POST /api/games 支持 aiProvider 并持久化；未知 provider 返回 400', async () => {
    const created = await client.api('/api/games', {
      method: 'POST',
      body: { aiProvider: 'http', playerColor: 'black' },
    });
    assert.equal(created.status, 201);
    assert.equal(created.json.state.aiProvider, 'http');
    assert.equal(created.json.playerColor, 'black');
    const record = prisma.games.get(created.json.id);
    assert.ok(record, 'game record should exist');
    assert.equal(record.aiProvider, 'http');

    const fetched = await client.api(`/api/games/${created.json.id}`);
    assert.equal(fetched.status, 200);
    assert.equal(fetched.json.state.aiProvider, 'http');

    const invalid = await client.api('/api/games', { method: 'POST', body: { aiProvider: 'openai' } });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.reason, 'invalid_body');

    const invalidType = await client.api('/api/games', { method: 'POST', body: { aiProvider: 123 } });
    assert.equal(invalidType.status, 400);
    assert.equal(invalidType.json.reason, 'invalid_body');
  });

  test('ai-move 省略 provider 时用该局 aiProvider；回退信息与 state.aiProvider 正确', async () => {
    const created = await client.api('/api/games', { method: 'POST', body: { aiProvider: 'http' } });
    const id = created.json.id;
    registry.calls.length = 0;

    const moved = await client.api(`/api/games/${id}/ai-move`, {
      method: 'POST',
      body: { difficulty: 'hard' },
    });
    assert.equal(moved.status, 200);
    assert.equal(registry.calls[0].providerId, 'http');
    assert.equal(registry.calls[0].difficulty, 'hard');
    assert.equal(moved.json.provider, 'heuristic');
    assert.deepEqual(moved.json.fallback, { from: 'http', reason: 'not_configured' });
    assert.equal(moved.json.state.aiProvider, 'heuristic');
    assert.equal(typeof moved.json.gameOver, 'boolean');
    assert.ok('winner' in moved.json);

    // 实际 provider 已更新并持久化，下一次省略 provider 时使用 heuristic
    const record = prisma.games.get(id);
    assert.equal(record.aiProvider, 'heuristic');
    registry.calls.length = 0;
    const second = await client.api(`/api/games/${id}/ai-move`, { method: 'POST', body: {} });
    assert.equal(second.status, 200);
    assert.equal(registry.calls[0].providerId, 'heuristic');
    assert.equal(second.json.provider, 'heuristic');
    assert.equal(second.json.fallback, null);
  });

  test('ai-move 显式 provider=fake 成功并更新 aiProvider', async () => {
    const created = await client.createGame();
    const id = created.id;
    registry.calls.length = 0;

    const moved = await client.api(`/api/games/${id}/ai-move`, {
      method: 'POST',
      body: { provider: 'fake', difficulty: 'easy' },
    });
    assert.equal(moved.status, 200);
    assert.equal(registry.calls[0].providerId, 'fake');
    assert.equal(moved.json.provider, 'fake');
    assert.equal(moved.json.fallback, null);
    assert.equal(moved.json.state.aiProvider, 'fake');
    assert.ok(moved.json.move && Number.isInteger(moved.json.move.x) && Number.isInteger(moved.json.move.y));
    assert.equal(moved.json.state.board[moved.json.move.y][moved.json.move.x], 'black');
    assert.equal(prisma.games.get(id).aiProvider, 'fake');
  });

  test('ai-move 对已配置但不可用的 provider 走回退；未知 provider 400', async () => {
    const created = await client.createGame();
    const id = created.id;

    const moved = await client.api(`/api/games/${id}/ai-move`, { method: 'POST', body: { provider: 'katago' } });
    assert.equal(moved.status, 200);
    assert.equal(moved.json.provider, 'heuristic');
    assert.equal(moved.json.fallback.from, 'katago');
    assert.equal(typeof moved.json.fallback.reason, 'string');

    const unknown = await client.api(`/api/games/${id}/ai-move`, { method: 'POST', body: { provider: 'nope' } });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.json.reason, 'invalid_body');

    const invalidDifficulty = await client.api(`/api/games/${id}/ai-move`, {
      method: 'POST',
      body: { difficulty: 'brutal' },
    });
    assert.equal(invalidDifficulty.status, 400);
    assert.equal(invalidDifficulty.json.reason, 'invalid_body');
  });

  test('重启后从 DB 恢复 aiProvider', async () => {
    const created = await client.api('/api/games', { method: 'POST', body: { aiProvider: 'fake' } });
    const id = created.json.id;
    await client.api(`/api/games/${id}/move`, { method: 'POST', body: { x: 0, y: 0 } });

    // 新 store / 新 app：内存为空，只能从 DB 回放
    await withHarness({ db, registry }, async (newBase) => {
      const newClient = makeClient(newBase);
      const restored = await newClient.api(`/api/games/${id}`);
      assert.equal(restored.status, 200);
      assert.equal(restored.json.state.aiProvider, 'fake');
      assert.equal(restored.json.state.moveCount, 1);
    });
  });

  test('重启后从 DB 恢复已保存的 analysis（无需重复复盘）', async () => {
    const created = await client.api('/api/games', { method: 'POST', body: { aiProvider: 'heuristic' } });
    const id = created.json.id;
    for (const [x, y] of [[0, 0], [8, 8], [2, 2], [6, 6]]) {
      await client.api(`/api/games/${id}/move`, { method: 'POST', body: { x, y } });
    }
    const analyzed = await client.api(`/api/games/${id}/analyze`, { method: 'POST' });
    assert.equal(analyzed.status, 200);
    const expected = analyzed.json.analysis;

    await withHarness({ db, registry }, async (newBase) => {
      const newClient = makeClient(newBase);
      const restored = await newClient.api(`/api/games/${id}`);
      assert.equal(restored.status, 200);
      assert.ok(restored.json.analysis, 'analysis should be restored from analysisJson');
      assert.equal(restored.json.analysis.grade, expected.grade);
      assert.equal(restored.json.analysis.totalMoves, expected.totalMoves);
      assert.deepEqual(restored.json.analysis, expected);
    });
  });
});

// ---------------------------------------------------------------------------
// 数据库不可用 / 持久化失败降级
// ---------------------------------------------------------------------------

describe('数据库降级', () => {
  test('db=null 时 /api/health 返回 db:false 但对局照常可玩', async () => {
    await withHarness({ db: null }, async (base) => {
      const client = makeClient(base);

      const health = await client.api('/api/health');
      assert.equal(health.status, 200);
      assert.equal(health.json.ok, true);
      assert.equal(health.json.db, false);

      const created = await client.createGame();
      const moved = await client.api(`/api/games/${created.id}/move`, { method: 'POST', body: { x: 4, y: 4 } });
      assert.equal(moved.status, 200);
      assert.equal(moved.json.state.moveCount, 1);

      const list = await client.api('/api/games');
      assert.equal(list.status, 200);
      assert.equal(list.json.games.length, 1);
      assert.equal(list.json.games[0].id, created.id);

      const analyzed = await client.api(`/api/games/${created.id}/analyze`, { method: 'POST' });
      assert.equal(analyzed.status, 200);
      assert.equal(analyzed.json.ok, true);
    });
  });

  test('持久化失败时降级为 db:false，对局不崩溃', async () => {
    const failingPrisma = {
      game: {
        async create() {
          throw new Error('SQLITE_IOERR: disk I/O error');
        },
        async update() {
          throw new Error('SQLITE_IOERR: disk I/O error');
        },
        async findUnique() {
          throw new Error('SQLITE_IOERR: disk I/O error');
        },
        async findMany() {
          throw new Error('SQLITE_IOERR: disk I/O error');
        },
      },
    };
    const failingDb = createFakeDb(failingPrisma);

    await withHarness({ db: failingDb }, async (base) => {
      const client = makeClient(base);

      const created = await client.createGame();
      assert.equal(created.ok, true);

      const health = await client.api('/api/health');
      assert.equal(health.json.db, false);

      const moved = await client.api(`/api/games/${created.id}/move`, { method: 'POST', body: { x: 2, y: 2 } });
      assert.equal(moved.status, 200);
      assert.equal(moved.json.state.moveCount, 1);
    });
  });
});

// ---------------------------------------------------------------------------
// 重启后从 DB 回放重建
// ---------------------------------------------------------------------------

describe('持久化与回放重建', () => {
  test('重启后可按 moveHistory 回放；认输局可从 winner 还原 result', async () => {
    const prisma = createFakePrisma();
    const db = createFakeDb(prisma);

    let playingId;
    let resignedId;
    await withHarness({ db }, async (base) => {
      const client = makeClient(base);
      const playing = await client.createGame();
      playingId = playing.id;
      await client.api(`/api/games/${playing.id}/move`, { method: 'POST', body: { x: 0, y: 0 } });
      await client.api(`/api/games/${playing.id}/move`, { method: 'POST', body: { x: 8, y: 8 } });
      await client.api(`/api/games/${playing.id}/pass`, { method: 'POST' });

      const resigned = await client.createGame();
      resignedId = resigned.id;
      await client.api(`/api/games/${resigned.id}/move`, { method: 'POST', body: { x: 4, y: 4 } });
      await client.api(`/api/games/${resigned.id}/resign`, { method: 'POST', body: { player: 'black' } });
    });

    // 新 store / 新 app：内存里没有对局，只能从 DB 回放
    await withHarness({ db }, async (base) => {
      const client = makeClient(base);

      const restored = await client.api(`/api/games/${playingId}`);
      assert.equal(restored.status, 200);
      assert.equal(restored.json.id, playingId);
      assert.equal(restored.json.state.moveCount, 3);
      assert.equal(restored.json.state.board[0][0], 'black');
      assert.equal(restored.json.state.board[8][8], 'white');
      assert.equal(restored.json.state.moves[2].pass, true);
      assert.equal(restored.json.state.winner, null);

      const restoredResigned = await client.api(`/api/games/${resignedId}`);
      assert.equal(restoredResigned.status, 200);
      assert.equal(restoredResigned.json.state.winner, 'white');
      assert.equal(restoredResigned.json.state.result.method, 'resign');
      assert.equal(restoredResigned.json.state.result.winner, 'white');

      // 回放出的认输局同样不可继续落子
      const blocked = await client.api(`/api/games/${resignedId}/move`, { method: 'POST', body: { x: 0, y: 0 } });
      assert.equal(blocked.status, 400);
      assert.equal(blocked.json.reason, 'game_over');

      const list = await client.api('/api/games');
      assert.equal(list.status, 200);
      assert.equal(list.json.games.length, 2);
    });
  });
});
