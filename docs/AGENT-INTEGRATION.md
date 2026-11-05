# 接入自己的 AI（Agent 扩展指南）

本项目把"下棋 AI"抽象成 **provider（AI 提供方）**：内置 AI（Python 源码）只是一个 provider，
你可以通过环境变量接入任意语言实现的 AI 服务，无需改动业务代码。

```
前端（选择 provider） → POST /api/games/:id/ai-move {provider}
                          │
                   AgentRegistry（server/src/agents/registry.js）
                     ├─ heuristic  内置 AI：Python 源码 ai/go_ai.py（默认，永远可用）
                     │             （Python 不可用/超时 → 自动回退 JS MCTS）
                     ├─ http       OpenAI 兼容的 HTTP API（任意语言/任意大模型）
                     └─ katago     KataGo GTP 引擎（本地子进程）
                          │
                    统一接口 getMove(game, {difficulty}) → {x,y} | null
```

## 内置 AI（Python 源码）

内置 AI 的源码在 **[`server/ai/go_ai.py`](../server/ai/go_ai.py)**（纯标准库，无第三方依赖）：
静态启发式评分先验 + MCTS（PUCT/UCT + 随机模拟）+ 收官停一手。

- Node 通过子进程调用：stdin 传 JSON 请求，stdout 回 JSON 着点（协议见文件头注释）。
- 环境变量：`LOCAL_AI_PYTHON`（解释器，默认自动探测）、`LOCAL_AI_SCRIPT`（脚本路径）、
  `LOCAL_AI_TIMEOUT_MS`（默认 8000）、`LOCAL_AI_SEED`（固定随机种子）。
- 你可以直接修改 `go_ai.py` 里的 `DIFFICULTY`（模拟量/时间上限）、评分权重、MCTS 参数。
- 单独测试：`cd server && python ai/go_ai.py --selftest`。
- Python 不可用、超时或返回非法着点时，后端自动回退 JS 内置 MCTS，对局不中断。

## 统一接口

每个 provider 只暴露一个异步方法（`null` 表示 pass）：

```js
// agent.js
module.exports = {
  // 供 GET /api/agents 展示
  meta: {
    id: 'my-agent',
    label: '我的 AI',
    kind: 'api',          // builtin | api | engine
    description: '调用自建围棋服务的 AI',
    requires: ['MY_AI_URL'], // 需要的环境变量（用于提示）
  },
  available() { return Boolean(process.env.MY_AI_URL); },
  create({ env }) {
    return {
      async getMove(game, { difficulty = 'medium' } = {}) {
        // game 是 Go9Game 实例，只允许通过公开方法访问：
        //   game.getState()      当前盘面/行棋方/moves/captures...
        //   game.getLegalMoves() 全部合法着点（已排除自杀/劫）
        // 必须返回 { x, y }（0-8 整数）或 null（pass）
        return { x: 4, y: 4 };
      },
    };
  },
};
```

> 服务端拿到非法着点会自动回退到内置 AI（Python MCTS / JS MCTS），因此外部 AI 出错不会卡住对局。

## 方式一：OpenAI 兼容 HTTP API（推荐，任意语言）

任何实现了 `POST {baseUrl}/chat/completions` 的服务都可以接入：OpenAI、DeepSeek、
Ollama、LM Studio、vLLM，或你自己用 Python/Go/Java 写一个包装服务。

`server/.env`：

```ini
AI_PROVIDER_DEFAULT=http            # 默认 AI（heuristic | http | katago）
AI_HTTP_BASE_URL=https://api.deepseek.com/v1
AI_HTTP_MODEL=deepseek-chat
AI_HTTP_API_KEY=sk-xxxx             # 本地 Ollama 等可留空
AI_HTTP_TIMEOUT_MS=15000
```

请求（后端 → 你的 AI 服务）：

```http
POST {AI_HTTP_BASE_URL}/chat/completions
Authorization: Bearer {AI_HTTP_API_KEY}
Content-Type: application/json

{
  "model": "{AI_HTTP_MODEL}",
  "temperature": 0,
  "stream": false,
  "messages": [
    { "role": "system", "content": "你是围棋 AI……只输出 JSON" },
    { "role": "user", "content": "9 路棋盘，X=黑 O=白 .空\n...\n合法着点: E5, D4 ...\n请输出 {\"move\":\"E5\"}，停一手输出 {\"move\":\"pass\"}" }
  ]
}
```

响应解析（`choices[0].message.content` 中的 JSON，允许 ```json 代码块）：

```json
{ "move": "E5" }
```

坐标格式与界面一致：列 A–J（跳过 I），行 1–9（自下而上）；也接受 `{"move":{"x":4,"y":4}}`。
解析出的着点必须是 `game.getLegalMoves()` 中的点，否则自动回退。

> 大模型常把着点下到已占点/编造坐标。`http` provider 默认会把错误原因和"合法着点"列表
> 回灌给模型并**自动重试一次**（`AI_HTTP_RETRY=1`，设 0 关闭），仍失败才回退内置 AI。

> 用任意语言实现时，只要你的服务遵循上面这套"请求体 → 返回 `{"move":"E5"}`"的协议即可。

### 接入 DeepSeek（现成示例）

```ini
# server/.env
AI_PROVIDER_DEFAULT=http
AI_HTTP_BASE_URL=https://api.deepseek.com/v1
AI_HTTP_MODEL=deepseek-chat          # 或 deepseek-reasoner
AI_HTTP_API_KEY=sk-你的key
AI_HTTP_TIMEOUT_MS=20000
```

改完 `.env` 后先自检（脚本直接读 `.env`，无需重启后端）：

```bash
cd server
npm run ai:check
# 打印：provider 列表 / 默认 provider / 实际调用耗时 / 着点
# 回退内置 AI 时会打印具体原因（HTTP 401、超时、非法着点等）
```

自检通过后重启后端，前端「AI 来源」即可选择「OpenAI 兼容 HTTP」。
注意：`.env` 不会热重载；DeepSeek 属于通用大模型，围棋棋力有限，
主要用于验证"接入自己的 AI"链路，非法着点/超时会自动回退内置 AI。

## 方式二：KataGo（本地 GTP 引擎，棋力最强）

下载 [KataGo](https://github.com/lightvector/KataGo) release 与 9 路权重（如 `kata1-b18c384nbt`），然后：

```ini
AI_PROVIDER_DEFAULT=katago
KATAGO_CMD=C:\tools\katago\katago.exe
KATAGO_ARGS=gtp -model C:\tools\katago\model.bin.gz -config C:\tools\katago\gtp.cfg
KATAGO_TIMEOUT_MS=15000
```

后端会复用同一个 GTP 进程，按 `boardsize 9`、`komi 7.5`、`clear_board`、`play`/`genmove`
与引擎通信；超时或崩溃时自动回退内置 AI，并重启进程。

## 方式三：写一个 provider（新增代码，约 30 行）

1. 在 `server/src/agents/` 下新增 `myAgent.js`，实现上面的 `meta / available / create`；
2. 在 `server/src/agents/registry.js` 的 `PROVIDERS` 列表里注册；
3. 重启后端，`GET /api/agents` 就会出现该 provider，前端下拉框自动可选。

内置 AI 也按这个接口实现：`server/src/agents/builtinAgent.js`（组合 Python AI + JS MCTS 兜底）、
`server/src/agents/pythonAgent.js`（Python 子进程）与 `server/src/agents/heuristicGoAgent.js`
（复盘用的静态评分）。

## 选择与回退规则

- `AI_PROVIDER_DEFAULT` 指定全局默认 provider（无设置时 `heuristic`）；
  新建对局时也可通过 `POST /api/games {"aiProvider":"http"}` 指定并持久化。
- `POST /api/games/:id/ai-move` 可临时覆盖：`{"provider":"katago","difficulty":"hard"}`。
- provider 未配置/超时/返回非法着点 → 自动改用内置启发式 AI，并在响应里返回
  `fallback: { from: "http", reason: "..." }`，前端会提示一次。
- `GET /api/agents` 返回所有 provider 及 `available` 状态，前端据此置灰未配置项。

## 接口速查

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/agents` | 列出 provider、默认 provider、可用状态 |
| POST | `/api/games` | 新建对局，可选 `{ "aiProvider": "http" }` |
| POST | `/api/games/:id/ai-move` | `{ "provider": "http", "difficulty": "hard" }`（provider 可省略） |

详细请求/响应见 [API.md](API.md)。
