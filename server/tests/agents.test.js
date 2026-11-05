'use strict';

/**
 * AI provider 层测试（node:test + node:http）。
 *
 * 覆盖：
 * - HeuristicGoAgent#scoreMoves：合法点、降序、noise=false 确定性、不修改对局；
 * - registry：provider 列表 / 默认 provider / get / move 回退 / shutdown；
 * - httpAgent：OpenAI 兼容请求体、JSON/代码块/坐标解析、HTTP 错误与超时回退；
 * - katagoAgent：GTP 协议（clear_board/boardsize/komi/play/genmove）、坐标映射、
 *   pass/resign/超时/进程退出、进程复用，以及 registry 回退。
 *
 * 说明：KataGo 用例需要真实子进程管道。若运行环境禁止（例如受限沙箱的 spawn EPERM），
 * 这些用例会带原因 skip；在正常的开发机 / danger-full-access 环境下会完整执行。
 * 测试只监听 127.0.0.1 的临时端口（0），不访问外网；临时文件写在 os.tmpdir() 并清理。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const Go9Game = require('../src/games/go9');
const HeuristicGoAgent = require('../src/agents/heuristicGoAgent');
const httpAgent = require('../src/agents/httpAgent');
const katagoAgent = require('../src/agents/katagoAgent');
const { createAgentRegistry, PROVIDERS } = require('../src/agents/registry');

const CHILD_PROCESS_PIPES_AVAILABLE = (() => {
  try {
    const result = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 20000,
    });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
})();

const KATAGO_SKIP_REASON = '当前运行环境禁止子进程管道（spawn EPERM），跳过真实 KataGo 子进程测试';

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function createGame(moves = []) {
  const game = new Go9Game();
  for (const [x, y] of moves) {
    const result = game.place(x, y);
    assert.equal(result.ok, true, `测试局面落子 (${x},${y}) 失败：${JSON.stringify(result)}`);
  }
  return game;
}

function legalKeys(game) {
  return new Set(game.getLegalMoves().map((move) => `${move.x},${move.y}`));
}

function assertLegal(game, move, label) {
  if (move === null) return; // 合法结果：pass
  assert.ok(move && Number.isInteger(move.x) && Number.isInteger(move.y), `${label}: 着点必须是整数坐标或 null`);
  assert.ok(legalKeys(game).has(`${move.x},${move.y}`), `${label}: 返回了非法着点 ${JSON.stringify(move)}`);
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve(null);
      }
    });
  });
}

function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function completion(content) {
  return { choices: [{ message: { role: 'assistant', content } }] };
}

/** 启动一个临时的 OpenAI 兼容 mock 服务（端口 0），结束后关闭。 */
async function withMockChatServer(respond, fn) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = await readJsonBody(req);
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    try {
      await respond({ req, res, body, index: requests.length - 1, requests });
    } catch {
      if (!res.writableEnded) {
        try {
          res.end();
        } catch {
          // 客户端可能已断开
        }
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    return await fn({ base, requests });
  } finally {
    await new Promise((resolve) => {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      server.close(() => resolve());
    });
  }
}

// ---------------------------------------------------------------------------
// HeuristicGoAgent#scoreMoves
// ---------------------------------------------------------------------------

test('scoreMoves：只含合法点、按 score 降序、不修改对局', () => {
  const game = createGame([
    [4, 4],
    [3, 4],
    [5, 4],
    [4, 3],
    [2, 2],
  ]);
  const before = JSON.stringify(game.getState());
  const agent = new HeuristicGoAgent({ seed: 42 });

  const scored = agent.scoreMoves(game);
  const legal = game.getLegalMoves();
  assert.equal(scored.length, legal.length, '应为每个合法点给出一个评分');

  const keys = legalKeys(game);
  for (const entry of scored) {
    assert.ok(Number.isInteger(entry.x) && Number.isInteger(entry.y), '坐标必须是整数');
    assert.equal(typeof entry.score, 'number');
    assert.ok(Number.isFinite(entry.score), 'score 必须有限');
    assert.ok(keys.has(`${entry.x},${entry.y}`), `出现了非法点 ${entry.x},${entry.y}`);
  }
  for (let i = 1; i < scored.length; i += 1) {
    assert.ok(scored[i - 1].score >= scored[i].score, '结果必须按 score 降序');
  }
  assert.equal(JSON.stringify(game.getState()), before, 'scoreMoves 不得修改对局');
});

test('scoreMoves：noise=false 时完全确定（与 seed 无关，两次调用一致）', () => {
  const game = createGame([
    [4, 4],
    [3, 4],
    [5, 4],
  ]);
  const first = new HeuristicGoAgent({ seed: 1 }).scoreMoves(game);
  const second = new HeuristicGoAgent({ seed: 999 }).scoreMoves(game);
  const again = new HeuristicGoAgent({ seed: 1 }).scoreMoves(game);
  assert.deepEqual(first, second);
  assert.deepEqual(first, again);
});

test('scoreMoves：空棋盘 81 个合法点；终局返回空数组；noise=true 仍只含合法点', () => {
  const agent = new HeuristicGoAgent({ seed: 7 });

  const empty = new Go9Game();
  assert.equal(agent.scoreMoves(empty).length, 81);

  const finished = new Go9Game();
  finished.pass();
  finished.pass();
  assert.deepEqual(agent.scoreMoves(finished), []);

  const game = createGame([
    [4, 4],
    [3, 4],
    [5, 4],
  ]);
  const noisy = agent.scoreMoves(game, { noise: true });
  const keys = legalKeys(game);
  for (const entry of noisy) {
    assert.ok(keys.has(`${entry.x},${entry.y}`));
  }
});

test('HeuristicGoAgent#getMove：保持返回合法点，同 seed 可复现', async () => {
  const game = createGame([
    [4, 4],
    [3, 4],
    [5, 4],
    [4, 3],
  ]);
  for (const difficulty of ['easy', 'medium', 'hard']) {
    const move = await new HeuristicGoAgent({ seed: 5 }).getMove(game, { difficulty });
    assertLegal(game, move, `getMove(${difficulty})`);
  }
  const first = await new HeuristicGoAgent({ seed: 123 }).getMove(game, { difficulty: 'medium' });
  const second = await new HeuristicGoAgent({ seed: 123 }).getMove(game, { difficulty: 'medium' });
  assert.deepEqual(first, second);
});

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

test('registry：list 三个 provider（顺序/kind/available）与 defaultProvider', () => {
  const registry = createAgentRegistry({ env: {} });
  assert.equal(registry.defaultProvider, 'heuristic');

  const list = registry.list();
  assert.deepEqual(list.map((provider) => provider.id), ['heuristic', 'http', 'katago']);
  assert.deepEqual(list.map((provider) => provider.kind), ['builtin', 'api', 'engine']);
  assert.deepEqual(list.map((provider) => provider.available), [true, false, false]);
  for (const provider of list) {
    assert.equal(typeof provider.label, 'string');
    assert.equal(typeof provider.description, 'string');
    assert.ok(Array.isArray(provider.requires));
  }

  assert.equal(createAgentRegistry({ env: { AI_PROVIDER_DEFAULT: 'http' } }).defaultProvider, 'http');
  assert.equal(createAgentRegistry({ env: { AI_PROVIDER_DEFAULT: 'katago' } }).defaultProvider, 'katago');
  assert.equal(createAgentRegistry({ env: { AI_PROVIDER_DEFAULT: 'nope' } }).defaultProvider, 'heuristic');

  assert.deepEqual(
    PROVIDERS.map((provider) => provider.meta.id),
    ['heuristic', 'http', 'katago'],
  );
});

test('registry：provider 配置后 available 变为 true（不发请求）', () => {
  const httpRegistry = createAgentRegistry({
    env: { AI_HTTP_BASE_URL: 'http://127.0.0.1:9/v1', AI_HTTP_MODEL: 'test-model' },
  });
  assert.equal(httpRegistry.list().find((provider) => provider.id === 'http').available, true);

  const katagoRegistry = createAgentRegistry({ env: { KATAGO_CMD: process.execPath } });
  assert.equal(katagoRegistry.list().find((provider) => provider.id === 'katago').available, true);

  const missingBinary = createAgentRegistry({ env: { KATAGO_CMD: path.join(os.tmpdir(), 'go9-no-such-katago.exe') } });
  assert.equal(missingBinary.list().find((provider) => provider.id === 'katago').available, false);
});

test('registry：get 对未知/未配置 provider 返回 null，heuristic 始终可用', () => {
  const registry = createAgentRegistry({ env: {} });
  assert.equal(registry.get('nope'), null);
  assert.equal(registry.get('http'), null);
  assert.equal(registry.get('katago'), null);
  assert.equal(registry.get(''), null);
  const heuristic = registry.get('heuristic');
  assert.ok(heuristic && typeof heuristic.getMove === 'function');
  assert.equal(registry.get('heuristic'), heuristic, '同一个 provider 应复用实例');
});

test('registry：move 默认使用 heuristic，成功时 fallback=null', async () => {
  const registry = createAgentRegistry({ env: {} });
  const game = new Go9Game();

  const result = await registry.move(undefined, game, { difficulty: 'medium' });
  assert.equal(result.providerId, 'heuristic');
  assert.equal(result.fallback, null);
  assertLegal(game, result.move, 'default heuristic');

  // 兼容 move(game) 调用形式
  const byGame = await registry.move(game);
  assert.equal(byGame.providerId, 'heuristic');
  assert.equal(byGame.fallback, null);
  assertLegal(game, byGame.move, 'move(game)');
});

test('registry：未知 provider 回退 heuristic，fallback.reason 有值', async () => {
  const registry = createAgentRegistry({ env: {} });
  const game = new Go9Game();
  const result = await registry.move('no-such-provider', game);

  assert.equal(result.providerId, 'heuristic');
  assert.equal(result.fallback.from, 'no-such-provider');
  assert.equal(typeof result.fallback.reason, 'string');
  assert.ok(result.fallback.reason.length > 0);
  assertLegal(game, result.move, 'unknown fallback');
});

test('registry：未配置的 http / katago 回退 heuristic', async () => {
  const registry = createAgentRegistry({ env: {} });
  for (const id of ['http', 'katago']) {
    const game = new Go9Game();
    const result = await registry.move(id, game);
    assert.equal(result.providerId, 'heuristic');
    assert.equal(result.fallback.from, id);
    assert.ok(result.fallback.reason.length > 0);
    assertLegal(game, result.move, `${id} unconfigured fallback`);
  }
});

test('registry：注入自定义 provider（成功 / 抛错 / 非法点 / null=pass）', async () => {
  const game = new Go9Game();

  const successProvider = {
    meta: { id: 'fake-ok', label: 'Fake OK', kind: 'api', description: '测试 provider', requires: [] },
    available: () => true,
    create: () => ({ getMove: async () => ({ x: 2, y: 2 }) }),
  };
  const successRegistry = createAgentRegistry({ env: {}, providers: [successProvider] });
  assert.deepEqual(
    successRegistry.list().map((provider) => provider.id),
    ['heuristic', 'fake-ok'],
    '注入 provider 时仍保留 heuristic 兜底',
  );
  const ok = await successRegistry.move('fake-ok', game);
  assert.deepEqual(ok.move, { x: 2, y: 2 });
  assert.equal(ok.providerId, 'fake-ok');
  assert.equal(ok.fallback, null);

  const thrownProvider = {
    meta: { id: 'fake-throw', label: 'Fake Throw', kind: 'api', description: '', requires: [] },
    available: () => true,
    create: () => ({
      getMove: async () => {
        throw new Error('fake provider exploded');
      },
    }),
  };
  const thrownRegistry = createAgentRegistry({ env: {}, providers: [thrownProvider] });
  const thrown = await thrownRegistry.move('fake-throw', game);
  assert.equal(thrown.providerId, 'heuristic');
  assert.equal(thrown.fallback.from, 'fake-throw');
  assert.match(thrown.fallback.reason, /fake provider exploded/);
  assertLegal(game, thrown.move, 'thrown fallback');

  // 上游/自定义 provider 的错误信息可能带凭据，fallback.reason 必须脱敏。
  const leakyProvider = {
    meta: { id: 'fake-leaky', label: 'Fake Leaky', kind: 'api', description: '', requires: [] },
    available: () => true,
    create: () => ({
      getMove: async () => {
        throw new Error('upstream said Authorization: Bearer sk-test-key-123456789');
      },
    }),
  };
  const leakyRegistry = createAgentRegistry({ env: {}, providers: [leakyProvider] });
  const leaky = await leakyRegistry.move('fake-leaky', game);
  assert.doesNotMatch(leaky.fallback.reason, /sk-test-key-123456789/);
  assert.match(leaky.fallback.reason, /Bearer \*\*\*/);

  const occupiedGame = createGame([[4, 4]]);
  const illegalProvider = {
    meta: { id: 'fake-illegal', label: 'Fake Illegal', kind: 'api', description: '', requires: [] },
    available: () => true,
    create: () => ({ getMove: async () => ({ x: 4, y: 4 }) }),
  };
  const illegalRegistry = createAgentRegistry({ env: {}, providers: [illegalProvider] });
  const illegal = await illegalRegistry.move('fake-illegal', occupiedGame);
  assert.equal(illegal.providerId, 'heuristic');
  assert.equal(illegal.fallback.from, 'fake-illegal');
  assert.ok(illegal.fallback.reason.length > 0);
  assertLegal(occupiedGame, illegal.move, 'illegal move fallback');

  const passProvider = {
    meta: { id: 'fake-pass', label: 'Fake Pass', kind: 'api', description: '', requires: [] },
    available: () => true,
    create: () => ({ getMove: async () => null }),
  };
  const passRegistry = createAgentRegistry({ env: {}, providers: [passProvider] });
  const passed = await passRegistry.move('fake-pass', game);
  assert.equal(passed.move, null);
  assert.equal(passed.providerId, 'fake-pass');
  assert.equal(passed.fallback, null);
});

test('registry：shutdown 关闭已创建实例且可重复调用', async () => {
  let closed = 0;
  const closableProvider = {
    meta: { id: 'fake-closable', label: 'Fake Closable', kind: 'api', description: '', requires: [] },
    available: () => true,
    create: () => ({
      getMove: async () => null,
      close: async () => {
        closed += 1;
      },
    }),
  };
  const registry = createAgentRegistry({ env: {}, providers: [closableProvider] });
  await registry.move('fake-closable', new Go9Game());
  await registry.shutdown();
  assert.equal(closed, 1);

  await registry.shutdown();
  assert.equal(closed, 1, 'shutdown 应幂等');
});

// ---------------------------------------------------------------------------
// httpAgent
// ---------------------------------------------------------------------------

test('httpAgent：发送标准 chat completions 请求并解析 {"move":"E5"}', async () => {
  await withMockChatServer(
    async ({ res }) => sendJson(res, 200, completion('{"move":"E5"}')),
    async ({ base, requests }) => {
      // 黑 D6、白 F4，黑先；E5=(4,4) 为空点，合法。
      const game = createGame([
        [3, 3],
        [5, 5],
      ]);
      const env = {
        AI_HTTP_BASE_URL: `${base}/v1`,
        AI_HTTP_MODEL: 'test-model',
        AI_HTTP_API_KEY: 'sk-test',
      };
      const agent = httpAgent.create({ env });
      const move = await agent.getMove(game, { difficulty: 'medium' });

      assert.deepEqual(move, { x: 4, y: 4 });
      assert.equal(requests.length, 1);
      const request = requests[0];
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, 'Bearer sk-test');
      assert.equal(request.body.model, 'test-model');
      assert.equal(request.body.temperature, 0);
      assert.equal(request.body.stream, false);
      assert.equal(request.body.messages.length, 2);
      assert.equal(request.body.messages[0].role, 'system');
      assert.match(request.body.messages[0].content, /JSON/);
      const userPrompt = request.body.messages[1].content;
      assert.match(userPrompt, /合法着点/);
      assert.match(userPrompt, /X/); // 黑子
      assert.match(userPrompt, /O/); // 白子
      assert.match(userPrompt, /^9 /m); // 行号 9 在顶部
      assert.match(userPrompt, /E5/); // 合法着点坐标列表
    },
  );
});

test('httpAgent：支持 ```json 代码块、{"move":{"x":4,"y":4}} 与 pass', async () => {
  const responses = [
    '```json\n{"move":"E5"}\n```',
    '```\n{"move":{"x":4,"y":4}}\n```',
    '{"move":"pass"}',
    '"pass"',
  ];
  await withMockChatServer(
    async ({ res, index }) => sendJson(res, 200, completion(responses[index])),
    async ({ base }) => {
      const agent = httpAgent.create({ env: { AI_HTTP_BASE_URL: base, AI_HTTP_MODEL: 'test-model' } });
      const game = new Go9Game();

      assert.deepEqual(await agent.getMove(game, { difficulty: 'medium' }), { x: 4, y: 4 });
      assert.deepEqual(await agent.getMove(game, { difficulty: 'medium' }), { x: 4, y: 4 });
      assert.equal(await agent.getMove(game, { difficulty: 'medium' }), null);
      assert.equal(await agent.getMove(game, { difficulty: 'medium' }), null);
    },
  );
});

test('httpAgent：坐标列 A–J 跳过 I、行 1–9 自下而上（J1=(8,8)、E9=(4,0)）', async () => {
  const responses = ['{"move":"J1"}', '{"move":"E9"}'];
  await withMockChatServer(
    async ({ res, index }) => sendJson(res, 200, completion(responses[index])),
    async ({ base }) => {
      const agent = httpAgent.create({ env: { AI_HTTP_BASE_URL: base, AI_HTTP_MODEL: 'test-model' } });
      const game = new Go9Game();
      assert.deepEqual(await agent.getMove(game, { difficulty: 'medium' }), { x: 8, y: 8 });
      assert.deepEqual(await agent.getMove(game, { difficulty: 'medium' }), { x: 4, y: 0 });
    },
  );
});

test('httpAgent：上游错误体中的 key 会被脱敏', async () => {
  await withMockChatServer(
    async ({ res }) => sendJson(res, 401, { error: 'bad key Authorization: Bearer sk-test-key-123456789' }),
    async ({ base }) => {
      const agent = httpAgent.create({ env: { AI_HTTP_BASE_URL: base, AI_HTTP_MODEL: 'test-model' } });
      await assert.rejects(agent.getMove(createGame(), { difficulty: 'medium' }), (error) => {
        assert.doesNotMatch(error.message, /sk-test-key-123456789/);
        assert.match(error.message, /HTTP 401/);
        assert.match(error.message, /Bearer \*\*\*/);
        return true;
      });
    },
  );
});

test('httpAgent：非法列/非法行/已占点/HTTP 500 都会抛错', async () => {
  const responses = ['{"move":"I5"}', '{"move":"Z9"}', '{"move":"A1"}'];
  await withMockChatServer(
    async ({ res, index }) => {
      if (index < responses.length) sendJson(res, 200, completion(responses[index]));
      else sendJson(res, 500, { error: 'boom' });
    },
    async ({ base }) => {
      const agent = httpAgent.create({
        env: { AI_HTTP_BASE_URL: base, AI_HTTP_MODEL: 'test-model', AI_HTTP_RETRY: '0' },
      });
      // 黑 A1 占位，白方行棋：A1 对白方是非法着点。
      const game = createGame([[0, 8]]);

      await assert.rejects(agent.getMove(game, { difficulty: 'medium' }), /无法解析/); // I 列被跳过
      await assert.rejects(agent.getMove(game, { difficulty: 'medium' }), /无法解析/); // 行 9/列 Z 非法
      await assert.rejects(agent.getMove(game, { difficulty: 'medium' }), /非法着点/); // A1 已占
      await assert.rejects(agent.getMove(game, { difficulty: 'medium' }), /HTTP 500/);
    },
  );
});

test('httpAgent：非法着点会把错误回灌给模型并重试一次', async () => {
  const responses = ['{"move":"A1"}', '{"move":"E5"}'];
  await withMockChatServer(
    async ({ res, index }) => sendJson(res, 200, completion(responses[Math.min(index, responses.length - 1)])),
    async ({ base, requests }) => {
      const agent = httpAgent.create({ env: { AI_HTTP_BASE_URL: base, AI_HTTP_MODEL: 'test-model' } });
      // 黑 A1 占位，白方行棋：模型第一次给 A1 非法，重试应被纠正。
      const game = createGame([[0, 8]]);
      assert.deepEqual(await agent.getMove(game, { difficulty: 'medium' }), { x: 4, y: 4 });
      assert.equal(requests.length, 2, '非法着点后应重试一次');
      const retryPrompt = JSON.stringify(requests[1].body.messages);
      assert.match(retryPrompt, /不合法|不合规|非法/);
      assert.match(retryPrompt, /合法着点/);
    },
  );
});

test('httpAgent：AI_HTTP_PATH 自定义路径 + base 结尾斜杠归一化', async () => {
  await withMockChatServer(
    async ({ res }) => sendJson(res, 200, completion('{"move":"E5"}')),
    async ({ base, requests }) => {
      const agent = httpAgent.create({
        env: {
          AI_HTTP_BASE_URL: `${base}/v1/`,
          AI_HTTP_MODEL: 'test-model',
          AI_HTTP_PATH: 'custom/completions',
        },
      });
      assert.deepEqual(await agent.getMove(new Go9Game(), { difficulty: 'medium' }), { x: 4, y: 4 });
      assert.equal(requests[0].url, '/v1/custom/completions');
    },
  );
});

test('httpAgent：available/create 的 env 校验', () => {
  assert.equal(httpAgent.meta.id, 'http');
  assert.equal(httpAgent.meta.kind, 'api');
  assert.deepEqual(httpAgent.meta.requires, ['AI_HTTP_BASE_URL', 'AI_HTTP_MODEL']);

  assert.equal(httpAgent.available({}), false);
  assert.equal(httpAgent.available({ AI_HTTP_BASE_URL: 'http://127.0.0.1:9' }), false);
  assert.equal(httpAgent.available({ AI_HTTP_BASE_URL: 'http://127.0.0.1:9', AI_HTTP_MODEL: 'm' }), true);

  assert.throws(() => httpAgent.create({ env: {} }), /AI_HTTP_BASE_URL/);
  assert.throws(() => httpAgent.create({ env: { AI_HTTP_BASE_URL: 'http://x' } }), /AI_HTTP_MODEL/);
});

test('registry + http：成功走 http，HTTP 500/超时回退 heuristic', async () => {
  let callIndex = 0;
  await withMockChatServer(
    async ({ res }) => {
      callIndex += 1;
      if (callIndex === 1) sendJson(res, 200, completion('{"move":"E5"}'));
      else if (callIndex === 2) sendJson(res, 500, { error: 'boom' });
      else {
        await new Promise((resolve) => setTimeout(resolve, 300));
        sendJson(res, 200, completion('{"move":"E5"}'));
      }
    },
    async ({ base }) => {
      const env = { AI_HTTP_BASE_URL: base, AI_HTTP_MODEL: 'test-model', AI_HTTP_TIMEOUT_MS: '100' };
      const registry = createAgentRegistry({ env });
      try {
        const game = new Go9Game();
        const success = await registry.move('http', game, { difficulty: 'medium' });
        assert.equal(success.providerId, 'http');
        assert.equal(success.fallback, null);
        assert.deepEqual(success.move, { x: 4, y: 4 });

        const failed = await registry.move('http', game, { difficulty: 'medium' });
        assert.equal(failed.providerId, 'heuristic');
        assert.equal(failed.fallback.from, 'http');
        assert.ok(failed.fallback.reason.length > 0);
        assertLegal(game, failed.move, 'http 500 fallback');

        const timedOut = await registry.move('http', game, { difficulty: 'medium' });
        assert.equal(timedOut.providerId, 'heuristic');
        assert.equal(timedOut.fallback.from, 'http');
        assert.match(timedOut.fallback.reason, /超时/);
        assertLegal(game, timedOut.move, 'http timeout fallback');
      } finally {
        await registry.shutdown();
      }
    },
  );
});

// ---------------------------------------------------------------------------
// katagoAgent
// ---------------------------------------------------------------------------

const FAKE_GTP_SCRIPT = `'use strict';
const fs = require('node:fs');
const readline = require('node:readline');

const mode = process.argv[2] || 'move';
const logPath = process.argv[3] || '';

function reply(text) {
  process.stdout.write('= ' + text + '\\n\\n');
}

if (logPath) {
  try { fs.appendFileSync(logPath, '# start ' + process.pid + '\\n'); } catch {}
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const command = line.trim();
  if (!command) return;
  if (logPath) {
    try { fs.appendFileSync(logPath, command + '\\n'); } catch {}
  }
  const parts = command.split(/\\s+/);
  const name = parts[0].toLowerCase();
  const argument = parts[1] || '';
  switch (name) {
    case 'genmove':
      if (mode === 'pass') reply('pass');
      else if (mode === 'resign') reply('resign');
      else if (mode === 'hang') return;
      else if (mode === 'exit') process.exit(3);
      else reply(String(argument).toUpperCase() === 'B' ? 'E5' : 'D4');
      break;
    case 'quit':
      reply('');
      process.exit(0);
      break;
    default:
      reply('');
  }
});
`;

function setupFakeGtp(mode = 'move') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'go9-katago-'));
  const scriptPath = path.join(dir, 'fake-gtp.cjs');
  const logPath = path.join(dir, 'commands.log');
  fs.writeFileSync(scriptPath, FAKE_GTP_SCRIPT, 'utf8');
  const env = {
    KATAGO_CMD: process.execPath,
    KATAGO_ARGS: `${scriptPath} ${mode} ${logPath}`,
    KATAGO_TIMEOUT_MS: '5000',
  };
  return {
    dir,
    scriptPath,
    logPath,
    env,
    cleanup() {
      // Windows 上子进程刚被 kill 时临时目录可能短暂被占用，带重试删除。
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    },
  };
}

function readCommandLog(logPath) {
  const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/);
  return {
    starts: lines.filter((line) => line.startsWith('# start')),
    commands: lines.filter((line) => line.length > 0 && !line.startsWith('#')),
  };
}

test('katagoAgent：meta/available/create 的 env 校验', () => {
  assert.equal(katagoAgent.meta.id, 'katago');
  assert.equal(katagoAgent.meta.kind, 'engine');
  assert.deepEqual(katagoAgent.meta.requires, ['KATAGO_CMD']);

  assert.equal(katagoAgent.available({}), false);
  assert.equal(katagoAgent.available({ KATAGO_CMD: process.execPath }), true);
  assert.equal(katagoAgent.available({ KATAGO_CMD: path.join(os.tmpdir(), 'go9-missing-katago.exe') }), false);

  assert.throws(() => katagoAgent.create({ env: {} }), /KATAGO_CMD/);
});

test('katagoAgent：GTP 协议、坐标映射与进程复用', async (t) => {
  if (!CHILD_PROCESS_PIPES_AVAILABLE) {
    t.skip(KATAGO_SKIP_REASON);
    return;
  }

  const fake = setupFakeGtp('move');
  const agent = katagoAgent.create({ env: fake.env });
  try {
    // 黑 D6、白 F4，黑先；mock 引擎对 B 返回 E5 -> (4,4)。
    const game = createGame([
      [3, 3],
      [5, 5],
    ]);
    const move = await agent.getMove(game, { difficulty: 'medium' });
    assert.deepEqual(move, { x: 4, y: 4 });
    assertLegal(game, move, 'katago');

    const first = readCommandLog(fake.logPath);
    assert.deepEqual(first.commands, [
      'clear_board',
      'boardsize 9',
      'komi 7.5',
      'play B D6',
      'play W F4',
      'genmove B',
    ]);

    // 第二次调用：复用同一进程（不重新 spawn），并重新 clear_board。
    const second = await agent.getMove(game, { difficulty: 'medium' });
    assert.deepEqual(second, move);
    const afterSecond = readCommandLog(fake.logPath);
    assert.equal(afterSecond.commands.length, 12);
    assert.deepEqual(afterSecond.commands.slice(6), first.commands);
    assert.equal(afterSecond.starts.length, 1, 'GTP 进程应被复用');
  } finally {
    await agent.close();
    fake.cleanup();
  }
});

test('katagoAgent：genmove pass → null，registry 视为成功', async (t) => {
  if (!CHILD_PROCESS_PIPES_AVAILABLE) {
    t.skip(KATAGO_SKIP_REASON);
    return;
  }

  const fake = setupFakeGtp('pass');
  try {
    const game = createGame([[3, 3]]); // 白方行棋
    const agent = katagoAgent.create({ env: fake.env });
    try {
      assert.equal(await agent.getMove(game, { difficulty: 'medium' }), null);
    } finally {
      await agent.close();
    }

    const registry = createAgentRegistry({ env: fake.env });
    try {
      const result = await registry.move('katago', game, { difficulty: 'medium' });
      assert.equal(result.move, null);
      assert.equal(result.providerId, 'katago');
      assert.equal(result.fallback, null);
    } finally {
      await registry.shutdown();
    }
  } finally {
    fake.cleanup();
  }
});

test('katagoAgent：resign / 进程退出 / 超时 → 抛错，registry 回退 heuristic', async (t) => {
  if (!CHILD_PROCESS_PIPES_AVAILABLE) {
    t.skip(KATAGO_SKIP_REASON);
    return;
  }

  // resign：getMove 抛错；registry 回退 heuristic。
  const resignFake = setupFakeGtp('resign');
  try {
    const agent = katagoAgent.create({ env: resignFake.env });
    try {
      await assert.rejects(agent.getMove(createGame(), { difficulty: 'medium' }), /resign|认输/);
    } finally {
      await agent.close();
    }

    const registry = createAgentRegistry({ env: resignFake.env });
    try {
      const game = new Go9Game();
      const result = await registry.move('katago', game, { difficulty: 'medium' });
      assert.equal(result.providerId, 'heuristic');
      assert.equal(result.fallback.from, 'katago');
      assert.ok(result.fallback.reason.length > 0);
      assertLegal(game, result.move, 'katago resign fallback');
    } finally {
      await registry.shutdown();
    }
  } finally {
    resignFake.cleanup();
  }

  // 进程退出：pending 命令被 reject。
  const exitFake = setupFakeGtp('exit');
  try {
    const agent = katagoAgent.create({ env: exitFake.env });
    try {
      await assert.rejects(agent.getMove(createGame(), { difficulty: 'medium' }), /退出|进程/);
    } finally {
      await agent.close();
    }
  } finally {
    exitFake.cleanup();
  }

  // 命令超时：hang 模式不应答 genmove，超时后报错并 kill 进程。
  const hangFake = setupFakeGtp('hang');
  try {
    const agent = katagoAgent.create({ env: { ...hangFake.env, KATAGO_TIMEOUT_MS: '600' } });
    try {
      await assert.rejects(agent.getMove(createGame(), { difficulty: 'medium' }), /超时/);
    } finally {
      await agent.close();
    }
  } finally {
    hangFake.cleanup();
  }
});
