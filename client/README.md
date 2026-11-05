# 九路围棋 · 前端

React 19 + Vite 8 实现的九路围棋 Web 客户端，通过 `/api/*` 与 Express 后端交互。

## 功能

- SVG 棋盘：`viewBox 0 0 360 360`（padding 20、cell 40），星位、A-J / 1-9 坐标（列字母跳过 I）、最后一手标记、悬停预落子，响应式宽度（最大 560px）。
- 人机对战（玩家执黑，可选 easy / medium / hard 难度，AI 自动应手）与双人对弈。
- AI provider（内置 AI / 外部 OpenAI 兼容 API / KataGo）：下拉选择未配置项置灰，
  选择记忆在 localStorage（`go9.aiProvider`），外部 AI 不可用时自动回退内置 AI 并提示一次；
  后端没有 `/api/agents`（旧接口）时自动隐藏 provider 选择。
- PASS、悔棋（人机模式一次回退 2 手）、认输、AI 走一步、新对局、复盘、SGF 导出。
- 状态栏（行棋方 / 提子数 / 手数 / 贴目 / 当前 AI）、手数列表、最近对局历史。
- 赛后分析报告：终局后自动生成（也可手动重跑）；A/B/C/D 评级徽章、首选一致率 / 平均损失 /
  可分析手数、布局-中盘-收官阶段对比、弱点建议（严重度 + 建议）、失误列表
  （实下 → 推荐、严重度、损失、原因），兼容旧分析结构。
- 终局结果横幅、错误 toast、首屏加载与可重试错误界面。

## 目录

```
client/
├─ src/
│  ├─ api.js               # /api 请求封装（VITE_API_BASE 或默认 /api）与错误解析
│  ├─ board.js             # 棋盘几何常量与坐标换算
│  ├─ format.js            # 玩家 / 结果 / 时间等展示格式化
│  ├─ App.jsx              # 对局编排：加载、落子、AI 应手、悔棋、复盘、历史
│  ├─ App.css              # 布局与组件样式（深色 + 木色，CSS Grid 响应式）
│  ├─ index.css            # 主题变量与全局样式
│  └─ components/
│     ├─ GoBoard.jsx       # SVG 棋盘（纯展示 + 交互）
│     ├─ GameStatus.jsx    # 状态栏
│     ├─ Controls.jsx      # 操作按钮
│     ├─ ModeBar.jsx       # 模式切换 / AI 来源（provider）/ AI 难度
│     ├─ MoveList.jsx      # 手数列表
│     ├─ AnalysisPanel.jsx # 赛后分析报告（评级 / 阶段 / 弱点 / 失误）
│     ├─ GameHistory.jsx   # 最近对局
│     ├─ ResultBanner.jsx  # 终局横幅
│     ├─ Toast.jsx         # 错误提示
│     └─ BootScreen.jsx    # 首屏加载 / 连接失败
└─ vite.config.js          # /api -> http://localhost:3001 代理
```

## 命令

```bash
# 开发（需先启动后端，默认 :3001）
node node_modules/vite/bin/vite.js

# 校验与构建
node node_modules/oxlint/bin/oxlint src
node node_modules/vite/bin/vite.js build
```

> 也可以使用 `npm run dev` / `npm run lint` / `npm run build`（或根目录的一键脚本 `npm run dev`）。
> 若在禁止子进程管道的受限沙箱中构建，Vite 在 Windows 会执行 `exec("net use")` 而报 `spawn EPERM`，
> 这是运行环境限制，普通终端不受影响。

## 接口

严格遵循 `docs/API.md`（GameState、`{ ok:false, reason, message }` 错误格式、SGF 导出、分析结构）
与 `docs/AGENT-INTEGRATION.md`（`/api/agents`、`aiProvider` / `provider`、`fallback`）。
前端不计算合法性，落子 / 悔棋 / AI 决策都以服务端返回的 `state` 为准。
