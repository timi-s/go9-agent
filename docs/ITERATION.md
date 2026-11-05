# 迭代与版本意识

这份文档记录本项目如何从骨架演进到可交付版本，以及每次迭代的验收方式。
Git 历史是主证据；本文件只做索引，方便快速理解“为什么这样改”。

## 迭代原则

1. **一步一个可验证目标**：规则引擎 → 前后端联通 → 持久化 → AI → 复盘/导出 → Agent 接入 → 体验优化。
2. **每次提交都尽量保持可运行**：提交前至少执行 `npm test`；前端改动执行 `npm run lint && npm run build`。
3. **先测试，再扩展**：规则、AI 合法性、API 契约、复盘分级都有自动化测试；E2E 覆盖真实浏览器。
4. **明确回退路径**：Python AI 失败回退 JS MCTS；外部 Agent 失败回退内置 AI；数据库失败降级内存模式。

## 提交脉络

| 阶段 | 关键提交/内容 | 验收 |
| --- | --- | --- |
| 骨架 | 初始化前后端、规则引擎、启发式 AI | `node --test` 规则/引擎测试 |
| 联通 | React SVG 棋盘 + Express API | 浏览器可落子、AI 应手 |
| 持久化 | Prisma + SQLite 对局、迁移 | 刷新/重启恢复对局 |
| 复盘 | 逐手评分、失误分级、阶段/弱点 | `/api/games/:id/analyze` + UI 报告 |
| 导出 | SGF(FF[4]) | 下载文件可被棋谱工具打开 |
| AI 升级 | Python MCTS、开局知识、三档难度 | Python 自检 + Node 子进程测试 |
| Agent | OpenAI 兼容 HTTP / KataGo、注册表与回退 | `/api/agents` + mock provider 测试 |
| 体验 | 自动复盘、公平评级、状态栏修复 | E2E + 130 项后端测试 |

## 本地复现一次迭代

```bash
# 1. 安装
cd server && npm install
cd ../client && npm install
cd ..

# 2. 生成数据库
cd server && npx prisma generate && npx prisma migrate deploy && cd ..

# 3. 测试与构建
npm test
cd client && npm run lint && npm run build && cd ..

# 4. 启动
npm run dev
```

## 推送记录

每次阶段性提交都会尝试 `git push origin main`。如果网络到 GitHub 的 443 不稳定，
本地 Git 历史仍然完整保留；恢复网络后执行：

```bash
git push -u origin main --tags
```
