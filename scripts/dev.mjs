#!/usr/bin/env node
/**
 * 一键启动开发环境：后端（node --watch）+ 前端（Vite dev server）。
 *
 * 用法：
 *   node scripts/dev.mjs                 同时启动前后端
 *   node scripts/dev.mjs --only server   只启动后端
 *   node scripts/dev.mjs --only client   只启动前端
 *
 * 不引入额外依赖（concurrently 等），只用 Node 内置模块。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = path.join(ROOT, 'server');
const CLIENT_DIR = path.join(ROOT, 'client');

const onlyIndex = process.argv.indexOf('--only');
const only = onlyIndex !== -1 ? process.argv[onlyIndex + 1] : null;
if (only && !['server', 'client'].includes(only)) {
  console.error(`[dev] --only 只接受 server 或 client，收到: ${only}`);
  process.exit(1);
}

function requireDeps(dir, label) {
  if (!existsSync(path.join(ROOT, dir, 'node_modules'))) {
    console.error(`[dev] 未找到 ${label} 依赖，请先执行：`);
    console.error(`      cd ${dir} && npm install`);
    process.exit(1);
  }
}
if (!only || only === 'server') requireDeps('server', '后端');
if (!only || only === 'client') requireDeps('client', '前端');

/** 记录子进程，Ctrl+C 时统一退出 */
const children = [];
let shuttingDown = false;

function run(label, command, args, cwd, env = {}) {
  const child = spawn(command, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    // Windows 下 node 直接作为可执行文件即可
    shell: false,
  });
  children.push({ label, child });
  child.on('error', (err) => {
    console.error(`[dev:${label}] 启动失败: ${err.message}`);
    shutdown(1);
  });
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.log(`[dev:${label}] 已退出 (code=${code ?? 'null'}, signal=${signal ?? 'null'})`);
    shutdown(code ?? 0);
  });
  return child;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    if (!child.killed) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* 进程可能已退出 */
      }
    }
  }
  // 给子进程一点时间退出（Windows 下 SIGTERM 立即生效）
  setTimeout(() => process.exit(code), 200);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const PORT = process.env.PORT || 3001;

if (!only || only === 'server') {
  run('server', process.execPath, ['--watch', 'src/index.js'], SERVER_DIR);
  console.log(`[dev:server] Express  → http://localhost:${PORT}`);
}
if (!only || only === 'client') {
  const viteBin = path.join(CLIENT_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!existsSync(viteBin)) {
    console.error('[dev:client] 未找到 vite，请先执行 cd client && npm install');
    process.exit(1);
  }
  run('client', process.execPath, [viteBin], CLIENT_DIR);
  console.log('[dev:client] Vite     → http://localhost:5173（/api 已代理到后端）');
}
