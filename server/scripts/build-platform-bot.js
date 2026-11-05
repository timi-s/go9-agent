'use strict';

/**
 * 生成「比赛平台单文件提交版」bot：
 *   server/ai/go_ai.py（AI 核心）+ server/ai/platform_adapter.py（协议适配）
 *   -> <out>.py（默认 server/ai/dist/go9_bot.py）
 *
 * 用法：
 *   node scripts/build-platform-bot.js                     # 输出到 server/ai/dist/go9_bot.py
 *   node scripts/build-platform-bot.js C:/path/go9_bot.py  # 输出到指定路径（例如桌面）
 */

const fs = require('node:fs');
const path = require('node:path');

const SERVER_DIR = path.resolve(__dirname, '..');
const CORE = path.join(SERVER_DIR, 'ai', 'go_ai.py');
const ADAPTER = path.join(SERVER_DIR, 'ai', 'platform_adapter.py');
const LEARNED = path.join(SERVER_DIR, 'ai', 'learned_data.py');
const ARGS = process.argv.slice(2);
const NO_LEARNED = ARGS.includes('--no-learned');
const OUT = ARGS.find((v) => !v.startsWith('--')) ? path.resolve(ARGS.find((v) => !v.startsWith('--'))) : path.join(SERVER_DIR, 'ai', 'dist', 'go9_bot.py');

const HEADER = `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""九路围棋 AI Bot（单文件提交版）。

上传平台：赛道「九路围棋」、语言 Python 3；单文件 .py 可直接提交（无需第三方依赖）。

本文件 = 内置 AI 核心（棋盘/规则/数子/MCTS/静态先验/pass 策略）
        + 协议适配（自动识别 GTP / 逐行 JSON / 单次 JSON / 纯文本轮着走）。

通信方式（平台客户端会选其一，本文件自动识别）：
  1) GTP：输入 "boardsize 9" / "komi 7.5" / "genmove b" 等命令，输出 "= E5"；
  2) 逐行 JSON：每行一个 JSON 请求（含棋盘或着法记录），返回 JSON 着点；
  3) 单次 JSON：一次传入完整局面，返回一次着点（本项目 Web 后端协议）；
  4) 纯文本：每行一个对手着法（如 "D4"），回一行自己的着法（可用 BOT_COLOR=white 指定执白）。

环境变量（可选）：
  BOT_COLOR=black|white     纯文本模式下自己的颜色（默认 black）
  BOT_TIME_MS=1500          每手思考时间（毫秒）
  BOT_SEED=2026             固定随机种子（复现用）
  BOT_JSON_FORMAT=both|coord|xy  JSON 模式的返回格式（默认 both）

自检：python go9_bot.py --selftest
"""

`;

function main() {
  const core = fs.readFileSync(CORE, 'utf8');
  const cut = core.indexOf('\ndef main():');
  if (cut < 0) throw new Error('go_ai.py 中找不到 def main()，无法生成单文件 bot');

  const adapter = fs.readFileSync(ADAPTER, 'utf8');
  const learned = (!NO_LEARNED && fs.existsSync(LEARNED)) ? fs.readFileSync(LEARNED, 'utf8') : '';
  const output = `${HEADER}${core.slice(0, cut)}\n\n${learned}\n\n${adapter}`;

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, output, 'utf8');
  console.log(`[build-platform-bot] 已生成: ${OUT} (${Buffer.byteLength(output)} bytes)`);
  console.log('[build-platform-bot] 自检: python <该文件> --selftest');
}

main();
