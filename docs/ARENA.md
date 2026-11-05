# 打榜与比赛提交（九路围棋）

平台地址：`http://139.196.148.174`（Association Arena，计算机协会 AI 竞赛平台）
赛道：**九路围棋（go9）**，协议 `arena.v1`，中国规则数子，黑贴 7.5 目，单位决策硬超时 10s。
注册需要协会邀请码；账号由用户自行保管，**不要提交密码或邀请码到仓库**。

## 1. 生成单文件 Python Bot

```bash
cd server
npm run ai:bot
# 默认输出 server/ai/dist/go9_bot.py
# 也可以指定输出路径：
node scripts/build-platform-bot.js C:/Users/你的用户名/Desktop/go9_bot.py
```

生成物 = `go_ai.py`（棋盘/MCTS/静态先验/停一手）
+ `learned_data.py`（KataGo 开局书、棋形先验、打榜胜局逐手复刻表）
+ `platform_adapter.py`（GTP / JSON / arena.v1 / 纯文本协议自动识别）。

自检（不需要平台/网络）：

```bash
python go9_bot.py --selftest
# {"ok": true, "selftest": "passed", "gtp": "ok", "json": "ok", "arena": "ok"}
```

## 2. 本地对战官方基准（Docker）

平台官方镜像为 `arena-official:<ai_hash>`，在本地 Docker 中可直接对弈：

```powershell
docker run --rm `
  -v "C:\Users\你的用户名\Desktop\go9_bot.py:/bot/go9_bot.py" `
  -v "C:\Users\你的用户名\Desktop\probe:/probe" `
  arena-official:d466786bbcf4d44f `
  python3 /probe/arena_match.py --time-ms 10000 --workers 8 --games 2 --verbose
```

`arena_match.py` 使用与平台相同的 `arena.v1` 请求/响应格式，黑白各一局。
比赛版会按 `time_limit_ms` 预留进程启动开销，并调用根节点并行 MCTS。

## 3. 提交与评测

网页 `http://139.196.148.174` 提供 Qt 学生客户端（`/client/ArenaStudent-Windows.zip`）：

1. 使用邀请码注册、登录客户端；
2. 选择 `go9_bot.py`（Python）上传为版本；
3. 点击“开始积分赛”，客户端在本机 Docker 中运行官方镜像对弈两局；
4. 客户端把棋谱/结果上传，服务器校验后更新 `go-score-v4` 分数与榜单。

评测环境要求本机 Docker 可用；官方镜像可由客户端下载（约 45 MB 内容层）。
详细 API/客户端协议见平台页面与本文档的 `arena.v1` 说明。

## 4. AI 设计要点

- **逐手复刻**：训练时从平台公开胜局提取“局面 → 下一手”，局面完全一致时直接复刻胜局下法；
- **开局书/棋形先验**：从 KataGo 9×9 自对弈与实战棋谱学习，作为 MCTS 先验；
- **并行 MCTS**：根节点多进程搜索合并访问量，尽量用满单手时限；
- **战术硬规则**：大块只剩一气时优先救棋；避免送吃/填自己的眼；收官停一手；
- **失败回退**：Python 子进程异常时 Node 端回退 JS MCTS；外部 Agent 失败时回退内置 AI。

## 5. 已知限制

- 打榜成绩受平台评测机资源、官方镜像版本与网络影响；
- Python MCTS 的绝对棋力仍低于成熟 C++/KataGo 引擎，胜局复刻依赖对手走出覆盖到的局面；
- 平台协议/评测规则若更新，需同步修改 `server/ai/platform_adapter.py` 并重新生成 bot。
