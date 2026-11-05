'use strict';

/**
 * AI 接入自检：用当前 server/.env 配置真实调用一次 AI，打印 provider 与耗时。
 *
 * 用法：cd server && npm run ai:check
 * 退出码：0 = 选中的 AI 正常给出合法着点；1 = 回退到了内置 AI（会打印原因）。
 *
 * 注意：脚本直接读取 server/.env，因此改完 .env 不必重启后端也能先验证连通性；
 * 验证通过后仍需重启后端，前端「AI 来源」才会出现可选的外部 AI。
 */

const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const Go9Game = require('../src/games/go9');
const { createAgentRegistry } = require('../src/agents/registry');

async function main() {
  const registry = createAgentRegistry({ env: process.env });
  const agents = registry.list();

  console.log('=== AI provider 配置 ===');
  for (const agent of agents) {
    const flag = agent.available ? '可用  ' : '未配置';
    console.log(`- [${flag}] ${agent.id} (${agent.label})${agent.requires.length ? `  需要: ${agent.requires.join(', ')}` : ''}`);
  }
  console.log(`默认 provider: ${registry.defaultProvider}`);

  if (!registry.defaultProvider || registry.defaultProvider === 'heuristic') {
    console.log('\n提示：当前默认是内置启发式 AI。要接入 DeepSeek，请在 server/.env 里配置：');
    console.log('  AI_PROVIDER_DEFAULT=http');
    console.log('  AI_HTTP_BASE_URL=https://api.deepseek.com/v1');
    console.log('  AI_HTTP_MODEL=deepseek-chat');
    console.log('  AI_HTTP_API_KEY=sk-xxxx');
    console.log('然后重新执行 npm run ai:check 验证。');
  }

  const game = new Go9Game();
  const started = Date.now();
  const result = await registry.move(undefined, game, { difficulty: 'medium' });
  const elapsed = Date.now() - started;

  console.log('\n=== 实际调用 ===');
  console.log(`使用 provider: ${result.providerId}（耗时 ${elapsed} ms）`);
  console.log(`着点: ${result.move ? `${result.move.x},${result.move.y}` : 'pass'}`);

  if (result.fallback) {
    console.log(`\n⚠ 已回退内置 AI。原因: ${result.fallback.reason}`);
    console.log('请检查：BASE_URL / MODEL / API_KEY 是否正确、网络是否可达、超时是否过短。');
    console.log('DeepSeek 常见值：AI_HTTP_BASE_URL=https://api.deepseek.com/v1、AI_HTTP_MODEL=deepseek-chat。');
    process.exitCode = 1;
  } else if (result.providerId === 'heuristic' && registry.defaultProvider === 'heuristic') {
    console.log('\n✅ 内置 AI 工作正常（当前未接入外部 AI，可按上方提示配置 DeepSeek）。');
    process.exitCode = 0;
  } else {
    console.log('\n✅ 外部 AI 工作正常；修改 .env 后重启后端，即可在界面「AI 来源」中选择它。');
    process.exitCode = 0;
  }

  await registry.shutdown();
}

main().catch(async (error) => {
  console.error('[ai:check] 执行失败:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
