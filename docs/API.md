# HTTP API 契约（v1.2）

服务端默认监听 `http://localhost:3001`（可用环境变量 `PORT` 覆盖）。
所有响应均为 JSON（SGF 导出除外）。错误统一为：

```json
{ "ok": false, "reason": "invalid_body", "message": "可选的人类可读说明" }
```

`reason` 取值（引擎/规则）：`game_over` `out_of_board` `occupied` `ko` `superko`
`suicide` `not_found` `invalid_body` `invalid_move` `db_error` `internal_error`。

---

## 数据结构

### GameState

```jsonc
{
  "size": 9,
  "board": [[null, "black", "white", ...], ...], // 9x9，行优先，board[y][x]
  "currentPlayer": "black",                      // "black" | "white"
  "moves": [                                     // 完整落子历史
    { "x": 4, "y": 4, "player": "black", "captured": 0 },
    { "x": null, "y": null, "player": "white", "captured": 0, "pass": true }
  ],
  "captures": { "black": 0, "white": 0 },        // 双方提子数
  "winner": null,                                 // null | "black" | "white" | "draw"
  "result": null,                                 // 见下
  "passCount": 0,
  "koPoint": null,                                // { "x": 2, "y": 2 } | null
  "lastMove": { "x": 4, "y": 4 },                 // null 表示尚无落子
  "moveCount": 0,
  "komi": 7.5,
  "aiProvider": "heuristic"                        // heuristic | http | katago（该局使用的 AI）
}
```

`result`（终局后非空）：

```jsonc
{ "method": "score",  "black": 43, "white": 39.5, "winner": "black", "margin": 3.5 }
{ "method": "resign", "black": null, "white": null, "winner": "white", "margin": null }
```

计分规则：中国规则数子（盘面棋子 + 单方围空），白贴 7.5 目；不标记死子。

---

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/agents` | 列出可用的 AI provider |
| GET | `/api/games?limit=20` | 最近对局列表 |
| POST | `/api/games` | 新建对局（可指定 AI provider） |
| GET | `/api/games/:id` | 读取对局状态 |
| POST | `/api/games/:id/move` | 落子 |
| POST | `/api/games/:id/pass` | 停一手 |
| POST | `/api/games/:id/resign` | 认输 |
| POST | `/api/games/:id/undo` | 悔棋 |
| POST | `/api/games/:id/ai-move` | 让 AI 替当前行棋方走一手（可指定 provider） |
| POST | `/api/games/:id/analyze` | 复盘分析（评级/阶段/弱点/失误） |
| GET | `/api/games/:id/export` | 导出 SGF |

---

### `GET /api/health`

```json
{ "ok": true, "version": "2.4.0", "db": true, "uptime": 12.3 }
```

`db=false` 表示数据库不可用，但内存对局仍可正常游玩（持久化降级）；
`DISABLE_DB=1` 时恒为 `false`。

### `GET /api/agents`

返回所有 AI provider 及其可用状态（不可用的 provider 在界面上置灰）：

```json
{
  "ok": true,
  "default": "heuristic",
  "agents": [
    { "id": "heuristic", "label": "内置 AI（Python MCTS）", "kind": "builtin", "available": true,
      "description": "本地 Python MCTS AI（server/ai/go_ai.py），无需配置；Python 不可用时自动回退 JS 内置 AI。", "requires": [] },
    { "id": "http", "label": "OpenAI 兼容 HTTP", "kind": "api", "available": false,
      "description": "通过 AI_HTTP_BASE_URL / AI_HTTP_MODEL 接入任意语言实现的 AI 服务", "requires": ["AI_HTTP_BASE_URL", "AI_HTTP_MODEL"] },
    { "id": "katago", "label": "KataGo GTP", "kind": "engine", "available": false,
      "description": "通过 GTP 协议调用本地 KataGo 引擎（棋力最强，需要自行安装引擎与 9 路权重）", "requires": ["KATAGO_CMD"] }
  ]
}
```

接入方式见 [AGENT-INTEGRATION.md](AGENT-INTEGRATION.md)。

### `GET /api/games?limit=20`

```json
{
  "ok": true,
  "games": [
    { "id": "…", "status": "playing", "winner": null, "moveCount": 12,
      "createdAt": "2026-11-04T14:00:00.000Z", "updatedAt": "2026-11-04T14:03:00.000Z" }
  ]
}
```

按 `updatedAt` 倒序；`limit` 默认 20，最大 100。数据库不可用时返回内存中的对局。

### `POST /api/games`

请求体可选：`{ "playerColor": "black", "aiProvider": "heuristic" }`
（`playerColor` 仅回显，服务端固定黑先；`aiProvider` 必须是 `/api/agents` 返回的 id，否则 400 `invalid_body`）。
响应 `201`：

```json
{ "ok": true, "id": "…", "state": { /* GameState，含 aiProvider */ }, "playerColor": "black" }
```

### `GET /api/games/:id`

`200 { "ok": true, "id": "…", "state": { … } }`
`404 { "ok": false, "reason": "not_found" }`

内存中不存在时尝试从数据库回放 `moveHistory` 重建；都失败返回 404。

### `POST /api/games/:id/move`

请求体 `{ "x": 0-8, "y": 0-8 }`，必须为整数；缺失/越界返回 400 `invalid_body`。
响应 `200`：

```json
{ "ok": true, "state": { … } }
```

规则拒绝时 `400`：`{ "ok": false, "reason": "ko" }`（`occupied` / `suicide` /
`superko` / `game_over` …）。非法请求不得改变棋局。

### `POST /api/games/:id/pass`

```json
{ "ok": true, "state": { … }, "gameOver": true, "winner": "white" }
```

连续两次 pass 自动终局（数子）。pass 会写入 `moves`（`{ "pass": true }`）并切换行棋方。

### `POST /api/games/:id/resign`

请求体 `{ "player": "black" }` 可选，默认当前行棋方认输。
`200 { "ok": true, "state": { …, "winner": "white", "result": { "method": "resign", … } } }`

### `POST /api/games/:id/undo`

请求体 `{ "steps": 1 }` 可选，默认 1；`steps` 必须为 1-20 的整数（超出按边界处理）。
终局后仍可悔棋（对局恢复进行中）。

`200 { "ok": true, "state": { … } }`
`400 { "ok": false, "reason": "nothing_to_undo" }`

### `POST /api/games/:id/ai-move`

请求体可选：`{ "difficulty": "easy" | "medium" | "hard", "provider": "heuristic" | "http" | "katago" }`。
`provider` 省略时使用该局 `aiProvider`（再缺省用全局默认）；`difficulty` 默认 `medium`。

```json
{ "ok": true, "move": { "x": 4, "y": 4 }, "provider": "heuristic", "fallback": null, "state": { … } }
```

- AI 一定返回**合法**着点；`move=null` 表示 AI 选择 pass（服务端自动停一手）。
- provider 未配置、超时或返回非法着点 → 自动回退内置 AI，此时
  `provider` 为实际使用的 provider（`"heuristic"`），`fallback` 形如
  `{ "from": "http", "reason": "..." }`，且棋局照常继续。
- 未知 provider id → `400 { "ok": false, "reason": "invalid_body" }`。
- 内置 AI 的 `difficulty` 对应 Python 端模拟量/时间上限：easy≈0.3-0.5s、medium≈1.2s、hard≈2.4s。

### `POST /api/games/:id/analyze`

对局结束后（或任意时刻）复盘。逐手用本地评估器（`HeuristicGoAgent.scoreMoves`，确定性无随机）
给当前局面所有合法点打分，与实手比较得出损失，再聚合成评级、阶段统计、弱点与失误列表。
分析不依赖外部 AI，离线可用。

```json
{
  "ok": true,
  "analysis": {
    "totalMoves": 68,
    "comparedMoves": 66,
    "mismatches": 20,
    "accuracy": 0.70,
    "averageLoss": 12.3,
    "grade": "B",
    "phases": {
      "opening":  { "label": "布局", "moves": 16, "comparedMoves": 16, "mismatches": 4, "accuracy": 0.75, "averageLoss": 17.2 },
      "middle":   { "label": "中盘", "moves": 34, "comparedMoves": 33, "mismatches": 10, "accuracy": 0.70, "averageLoss": 24.1 },
      "endgame":  { "label": "收官", "moves": 18, "comparedMoves": 17, "mismatches": 6, "accuracy": 0.65, "averageLoss": 28.4 }
    },
    "weaknesses": [
      { "code": "self_atari", "label": "自陷打吃", "count": 3, "severity": "high",
        "advice": "落子前确认己方棋块至少有两口气，避免送吃。" }
    ],
    "mistakes": [
      { "moveIndex": 12, "played": { "x": 2, "y": 2 }, "recommended": { "x": 6, "y": 6 },
        "loss": 95, "severity": "blunder", "reason": "自陷打吃" }
    ],
    "summary": "共 68 手（可分析 66 手），AI 首选一致率 70%，平均损失 12.3，评级 B。主要短板：自陷打吃 3 次、漏提子 2 次。"
  }
}
```

- `accuracy = (comparedMoves - mismatches) / comparedMoves`（无比较手时为 1），保留两位小数；
  它是“与 AI 第一选点完全相同”的比例，仅作诊断，**不是**评级依据。
- `loss` 为启发式评分差（非胜率），仅用于横向比较；`averageLoss` 为全部比较手的平均损失。
- 失误分级：`loss >= 80` → `blunder`，`>= 40` → `mistake`，`>= 15` → `inaccuracy`；
  `mistakes` 只保留这三类，最多 10 条、按手数倒序（最近的在最前），`recommended=null` 表示 AI 建议 pass。
- `weaknesses` 按失误原因聚合并按次数降序，`severity` 取 `high`/`medium`/`low`。
- 阶段划分（按手数索引）：布局 `<16`，中盘 `16-49`，收官 `>=50`。
- 等级：主要看平均损失与严重失误数——A（平均损失<6 且无 blunder、mistake≤1）、
  B（<15 且 blunder≤1）、C（<30 且 blunder≤3），其余 D。这样“没猜中 AI 第一选点但损失很小”
  不会被误判为 D。
- 结果同时写入数据库 `Game.analysisJson`；数据库不可用时仅返回不持久化。

### `GET /api/games/:id/export`

`200`，`Content-Type: application/x-go-sgf`，`Content-Disposition: attachment; filename="<id>.sgf"`。

SGF 要求：`(;FF[4]GM[1]CA[UTF-8]SZ[9]KM[7.5]PB[黑方]PW[白方]DT[YYYY-MM-DD]RE[...]` +
`AB`/`AW` 无需输出，逐手 `;B[ee]` / `;W[]`，`RE` 取 `B+R`、`W+R`、`B+3.5`、`W+2.5`、`0`（和棋）；
对局未结束时 `RE[]`。坐标必须使用 SGF 小写字母（9 路：a-i，**不跳过 i**）。

---

## 兼容性说明

- 旧版 `/api/go9/*` 接口已被上述 REST 接口取代（v1.0 破坏性变更），客户端同步更新。
- 服务端保持 CommonJS，无新增运行时依赖。
