'use strict';

/**
 * 数据库连接（Prisma 7 + better-sqlite3 driver adapter）。
 *
 * 关键点（修复初版严重 bug）：
 * - 运行时 SQLite 路径统一解析为绝对路径 `<server 目录>/dev.db`，不再使用
 *   `file:./prisma/dev.db` 这类随 cwd 漂移的相对路径；支持 `DATABASE_URL` 覆盖
 *   （`file:` 前缀，相对路径以 server 目录为基准解析）。
 * - 数据库不可用（文件缺失 / 无表 / 连接失败 / 查询异常）时不让进程崩溃：
 *   `available=false`，由 gameStore 自动降级为内存对局，/api/health 如实报告。
 * - `DISABLE_DB=1` 时不加载 Prisma 客户端，纯内存运行（测试/演示用）。
 */

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DB_FILENAME = 'dev.db';

function defaultServerDir() {
  // __dirname = <server>/src
  return path.resolve(__dirname, '..');
}

/**
 * 解析数据库 URL。
 * - 未设置 -> `file:<server>/dev.db`
 * - `file:./dev.db` / `file:dev.db` -> 相对 server 目录解析为绝对路径
 * - `file:C:/abs/path.db` -> 原样使用
 * - `file::memory:` -> 原样使用（内存库，测试用）
 * - 其他协议 -> 原样透传
 *
 * @param {string|undefined|null} rawUrl
 * @param {{ serverDir?: string }} [options]
 * @returns {string}
 */
function resolveDatabaseUrl(rawUrl, options = {}) {
  const serverDir = options.serverDir ? path.resolve(options.serverDir) : defaultServerDir();
  const fallback = `file:${path.join(serverDir, DEFAULT_DB_FILENAME)}`;

  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') return fallback;

  const value = rawUrl.trim();
  if (!/^file:/i.test(value)) return value; // 其他协议交给 Prisma/适配器处理

  const rest = value.slice('file:'.length);
  if (rest === '' || rest === ':memory:' || rest.startsWith(':memory:')) {
    return rest === '' ? fallback : `file::memory:${rest.slice(':memory:'.length)}`;
  }

  const queryIndex = rest.indexOf('?');
  const query = queryIndex >= 0 ? rest.slice(queryIndex) : '';
  const rawPath = (queryIndex >= 0 ? rest.slice(0, queryIndex) : rest).trim();
  if (!rawPath) return fallback;

  const absolute = path.isAbsolute(rawPath) ? rawPath : path.resolve(serverDir, rawPath);
  return `file:${absolute}${query}`;
}

/**
 * 从已解析的 URL 中取出 SQLite 文件绝对路径（非 file: 协议返回 null）。
 * @param {string} url
 * @returns {string|null}
 */
function databaseFilePath(url) {
  if (typeof url !== 'string' || !/^file:/i.test(url)) return null;
  const rest = url.slice('file:'.length);
  if (!rest || rest.startsWith(':memory:')) return null;
  const withoutQuery = rest.split('?')[0];
  return path.isAbsolute(withoutQuery) ? withoutQuery : path.resolve(defaultServerDir(), withoutQuery);
}

function envFlag(value) {
  if (value === undefined || value === null) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

/**
 * 创建数据库句柄。永远不抛异常（初始化失败返回不可用句柄）。
 *
 * @param {{ env?: NodeJS.ProcessEnv, serverDir?: string }} [options]
 * @returns {{
 *   enabled: boolean,
 *   available: boolean,
 *   url: string,
 *   filePath: string|null,
 *   prisma: import('../generated/prisma/client').PrismaClient | null,
 *   error: Error|null,
 *   markUnavailable(err?: unknown): void
 * }}
 */
function createDatabase(options = {}) {
  const env = options.env || process.env;
  const serverDir = options.serverDir ? path.resolve(options.serverDir) : defaultServerDir();
  const disabled = envFlag(env.DISABLE_DB);
  const url = resolveDatabaseUrl(env.DATABASE_URL, { serverDir });

  const db = {
    enabled: !disabled,
    available: false,
    url,
    filePath: databaseFilePath(url),
    prisma: null,
    error: null,
    markUnavailable(err) {
      markDatabaseUnavailable(db, err);
    },
  };

  if (disabled) return db;

  try {
    // 延迟 require：DISABLE_DB=1 或路径解析测试时无需加载生成客户端。
    const { PrismaClient } = require('../generated/prisma/client');
    const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');
    const adapter = new PrismaBetterSqlite3({ url });
    db.prisma = new PrismaClient({ adapter });
    db.available = true; // 先乐观标记，probeDatabase 会做真实校验
  } catch (error) {
    db.prisma = null;
    db.available = false;
    db.error = error instanceof Error ? error : new Error(String(error));
  }

  return db;
}

/**
 * 真实探测数据库是否可用（文件存在 + 能执行查询）。
 * @param {ReturnType<typeof createDatabase>|null|undefined} db
 * @returns {Promise<boolean>}
 */
async function probeDatabase(db) {
  if (!db || !db.enabled) {
    if (db) db.available = false;
    return false;
  }
  if (!db.prisma) {
    db.available = false;
    if (!db.error) db.error = new Error('Prisma 客户端不可用');
    return false;
  }
  if (db.filePath && !fs.existsSync(db.filePath)) {
    db.available = false;
    db.error = new Error(`数据库文件不存在：${db.filePath}（请先在 server 目录执行 prisma migrate deploy）`);
    return false;
  }
  try {
    await db.prisma.game.count();
    db.available = true;
    db.error = null;
    return true;
  } catch (error) {
    db.available = false;
    db.error = error instanceof Error ? error : new Error(String(error));
    return false;
  }
}

/**
 * 将数据库标记为不可用（运行时查询失败的降级路径）。
 * @param {ReturnType<typeof createDatabase>|null|undefined} db
 * @param {unknown} [error]
 */
function markDatabaseUnavailable(db, error) {
  if (!db) return;
  const wasAvailable = db.available;
  db.available = false;
  if (error) db.error = error instanceof Error ? error : new Error(String(error));
  if (wasAvailable) {
    const message = db.error && db.error.message ? db.error.message : String(error || 'unknown error');
    console.warn(`[db] 数据库不可用，已降级为纯内存模式（持久化暂停）：${message}`);
  }
}

/**
 * @param {ReturnType<typeof createDatabase>|null|undefined} db
 * @returns {boolean}
 */
function isDatabaseUsable(db) {
  return Boolean(db && db.enabled !== false && db.available === true && db.prisma);
}

/**
 * 断开数据库连接（优雅退出）。
 * @param {ReturnType<typeof createDatabase>|null|undefined} db
 */
async function disconnectDatabase(db) {
  if (!db || !db.prisma) return;
  try {
    await db.prisma.$disconnect();
  } catch {
    // 忽略关闭异常
  } finally {
    db.prisma = null;
    db.available = false;
  }
}

module.exports = {
  DEFAULT_DB_FILENAME,
  defaultServerDir,
  resolveDatabaseUrl,
  databaseFilePath,
  createDatabase,
  probeDatabase,
  markDatabaseUnavailable,
  isDatabaseUsable,
  disconnectDatabase,
};
