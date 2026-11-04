'use strict';

/**
 * 服务端启动入口。
 *
 * - 加载 server/.env（与启动 cwd 无关）
 * - 创建数据库连接并真实探测；不可用时降级为纯内存模式，服务照常启动
 * - 创建 AI provider registry（heuristic/http/katago），优雅退出时关闭资源
 */

const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const { createDatabase, probeDatabase, disconnectDatabase } = require('./db');
const { createApp } = require('./app');
const pkg = require('../package.json');

function parsePort(value) {
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 3001;
}

/**
 * 创建真实 provider registry；模块缺失或初始化失败时返回 undefined，
 * 由 createApp 退回 heuristic-only registry（不阻塞服务启动）。
 */
function createRegistry() {
  try {
    const { createAgentRegistry } = require('./agents/registry');
    const registry = createAgentRegistry({ env: process.env });
    const agents = typeof registry.list === 'function' ? registry.list() : [];
    const available = Array.isArray(agents) ? agents.filter((item) => item && item.available) : [];
    console.log(
      `[agents] 默认 provider: ${registry.defaultProvider}；可用: ${
        available.map((item) => item.id).join(', ') || '无'
      }`,
    );
    return registry;
  } catch (error) {
    console.warn(`[agents] provider registry 不可用，使用内置 heuristic 兜底：${error && error.message ? error.message : error}`);
    return undefined;
  }
}

async function main() {
  const db = createDatabase();

  if (!db.enabled) {
    console.log('[db] DISABLE_DB=1，服务以纯内存模式启动（不连接数据库）');
  } else {
    const available = await probeDatabase(db);
    if (available) {
      console.log(`[db] SQLite 已连接: ${db.filePath || db.url}`);
    } else {
      console.warn(`[db] 数据库不可用，持久化降级为内存模式：${db.error ? db.error.message : '未知原因'}`);
    }
  }

  const registry = createRegistry();
  const app = createApp({ db, registry, version: pkg.version });
  const port = parsePort(process.env.PORT);

  const server = app.listen(port, () => {
    const address = server.address();
    const actualPort = address && typeof address === 'object' ? address.port : port;
    console.log(`✅ 后端启动: http://localhost:${actualPort}`);
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[server] 收到 ${signal}，正在关闭...`);
    const forceTimer = setTimeout(() => {
      console.warn('[server] 优雅关闭超时，强制退出');
      process.exit(0);
    }, 5000);
    forceTimer.unref();

    server.close(async () => {
      try {
        if (registry && typeof registry.shutdown === 'function') await registry.shutdown();
      } catch (error) {
        console.warn(`[agents] 关闭 provider 资源失败：${error && error.message ? error.message : error}`);
      } finally {
        try {
          await disconnectDatabase(db);
        } finally {
          clearTimeout(forceTimer);
          process.exit(0);
        }
      }
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[server] 启动失败:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}

module.exports = { main, parsePort, createRegistry };
