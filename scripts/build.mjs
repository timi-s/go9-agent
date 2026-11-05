#!/usr/bin/env node
/**
 * 构建前端产物到 client/dist。
 * 用法：node scripts/build.mjs
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT_DIR = path.join(ROOT, 'client');
const viteBin = path.join(CLIENT_DIR, 'node_modules', 'vite', 'bin', 'vite.js');

const result = spawnSync(process.execPath, [viteBin, 'build'], {
  cwd: CLIENT_DIR,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`[build] 启动 Vite 失败: ${result.error.message}`);
  console.error('[build] 请确认已执行 cd client && npm install');
  process.exit(1);
}
process.exit(result.status ?? 1);
