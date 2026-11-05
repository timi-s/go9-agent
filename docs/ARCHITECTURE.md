# 架构说明

## 总览

```
浏览器 (React 19 / Vite)
   │  fetch /api/*（开发时 Vite 代理到 :3001）
   ▼
Express 5 (server/src/app.js)
   │  ├─ GameStore（内存 Map + LRU，最多 20 局）
   │  ├─ Go9Game 规则引擎（纯函数式状态迁移）
   │  ├─ AgentRegistry ── 内置 AI（Python MCTS，子进程）/ HTTP / KataGo（失败自动回退）
   │  ├─ Analysis（逐手评分 → 失误分级 → 阶段/弱点）
   │  └─ SGF 序列化
   ▼
Prisma 7 + better-sqlite3 → server/dev.db
```

## 后端模块

| 模块 | 职责 |
| --- | --- |
| `src/app.js` | `createApp({ db, registry, agent, version })` 工厂：路由、参数校验、统一 JSON 错误处理。测试可注入内存实现。 |
| `src/index.js` | 读取配置、初始化数据库与 AI registry、启动 HTTP 服务、优雅退出（SIGINT/SIGTERM，同时关闭 AI 引擎子进程）。 |
| `src/db.js` | 延迟创建 PrismaClient；数据库文件绝对路径解析（`DATABASE_URL` 可覆盖）；初始化失败时返回降级标记。 |
| `src/gameStore.js` | 内存对局缓存 + 数据库读写；内存缺失时按 `moveHistory` 回放重建；持久化失败只记录警告，不影响对局。 |
| `src/sgf.js` | 把 `moves` / `result` 序列化为 SGF(FF[4]) 文本。 |
| `src/games/go9.js` | 规则引擎：落子、提子、自杀、超级劫、PASS 终局、认输、悔棋、数子。 |
| `src/agents/registry.js` | AI provider 注册表：内置（Python MCTS）/ OpenAI 兼容 HTTP / KataGo GTP；统一 `move()`，失败自动回退内置 AI。 |
| `src/agents/builtinAgent.js` | 内置 AI 组合：`getMove` 优先调用 Python AI（`server/ai/go_ai.py`），Python 不可用/超时/非法着点时回退 JS MCTS；`scoreMoves` 为复盘提供确定性静态评分。 |
| `src/agents/mctsAgent.js` | JS MCTS：静态先验 PUCT + UCT + 随机模拟 + 收官停一手。 |
| `src/agents/pythonAgent.js` | Python AI 子进程 provider：stdin/stdout JSON 协议、超时控制、着点合法性校验。 |
| `src/agents/httpAgent.js` | 通过环境变量接入任意 OpenAI 兼容 AI 服务（任意语言实现）。 |
| `src/agents/katagoAgent.js` | KataGo GTP 子进程适配（复用进程、超时/崩溃重启、自动回退）。 |
| `src/analysis/analyze.js` | 复盘分析：逐手评分 → 损失 → 失误分级 → 阶段统计 → 弱点聚合与建议。 |
| `ai/go_ai.py` | **内置 AI 的 Python 源码**：棋盘/规则/数子/静态评分/MCTS/pass 策略，仅标准库。 |

### 状态与还原

对局状态以 `Go9Game` 实例为唯一事实来源。持久化时写入两列：

- `boardState`：JSON 盘面快照（便于快速查看/调试）
- `moveHistory`：JSON 着法序列（用于重建与复盘，是真正可还原的数据）

内存中不存在某局时，`GameStore` 用 `Go9Game.replay(moves)` 重放 `moveHistory`，
因此服务重启后仍可读取历史对局。

### 错误处理与降级

- 规则拒绝（劫、自杀、占位等）→ `400 { ok:false, reason }`。
- 参数缺失/类型错误 → `400 invalid_body`。
- 数据库异常 → 记录日志，接口继续返回内存状态；`/api/health` 的 `db` 字段为 `false`。
- `DISABLE_DB=1` 时完全跳过 Prisma，测试与演示无需数据库文件。

## 前端结构

| 模块 | 职责 |
| --- | --- |
| `src/api.js` | 统一请求封装与错误解析（`{ok:false}` → 抛 `ApiError`）。 |
| `src/App.jsx` | 对局编排：加载/新建对局、落子、AI 自动应手、provider 选择与回退提示、悔棋、复盘、历史切换；终局后自动触发一次复盘。 |
| `src/components/GoBoard.jsx` | 纯展示 + 交互的 SVG 棋盘（星位、坐标、最后一手、悬停预落子）。 |
| `src/components/ModeBar.jsx` | 模式、AI provider、难度选择。 |
| `src/components/GameStatus.jsx` | 状态栏（行棋方、提子、手数、贴目、AI 来源）。 |
| `src/components/MoveList.jsx` | 手数列表。 |
| `src/components/AnalysisPanel.jsx` | 复盘报告：评级、一致率、平均损失、阶段统计、弱点建议、失误列表。 |
| `src/components/GameHistory.jsx` | 最近对局列表。 |
| `src/components/Toast.jsx` | 错误/回退提示。 |

前端不直接计算合法性：所有落子/悔棋/AI 决策都以服务端返回的 `state` 为准，
这样规则只有一份实现，避免前后端不一致。

## AI 接入与复盘

- AI provider 由 `AgentRegistry` 统一管理（内置 Python/JS MCTS、OpenAI 兼容 HTTP、KataGo GTP），
  前端通过 `GET /api/agents` 展示可选来源，未配置的 provider 置灰。
- **内置 AI 的默认实现是 Python**（`server/ai/go_ai.py`）：Node 用子进程 + stdin/stdout JSON 调用，
  每步加约 0.1 s 进程启动开销；Python 缺失、超时或返回非法着点时自动回退 JS MCTS，对局不中断。
- 外部 AI 未配置、超时或返回非法着点时，registry 自动回退内置 AI，
  返回 `fallback` 信息并在前端提示，对局不会中断。
- 复盘分析始终使用**本地确定性评估器**（`scoreMoves({noise:false})`），因此离线可用、
  结果可复现；它衡量"与 AI 首选的评分差距"，不是胜率，适合定位明显的坏手/弱点。
- 对局使用的 provider 记录在 `Game.aiProvider` 字段，便于回顾。

## 测试策略

- 引擎：确定性单元测试（提子/自杀/劫/终局/悔棋/认输）。
- AI：随机局面 fuzz，断言返回的着点一定合法；提子优先级；无合法着点时返回 `null`。
- API：`createApp` + 内存 store + 端口 0 的真实 HTTP 测试，覆盖路由、校验与错误码。
- 前端：oxlint + 生产构建作为回归门槛（CI 中执行）。

## 设计取舍与后续可做

- **位置超级劫**而非简单劫，规则更严格；界面 koPoint 仍可作提示。
- **内置 AI 默认是 Python MCTS**（`server/ai/go_ai.py`）；JS MCTS 仅作为 Python 不可用时的回退。
  内置 AI 由同一套启发式 `scoreMoves` 提供静态先验，但复盘不调用 MCTS，保证结果确定、快速、可复现。
- 复盘评分基于同一套启发式权重（而非蒙特卡洛/神经网络），能指出明显坏手与弱点，
  但不等价于职业级形势判断；后续可接入 KataGo 分析接口或 MCTS 做更深复盘。
- 内存 LRU 足够单机使用；若要多人联机，可将 `GameStore` 换成 Redis/数据库乐观锁。
- 数子未实现死子标记；可增加「标记死子 → 终局确认」流程。
