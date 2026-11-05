# ============================================================================
# 协议适配层
# ----------------------------------------------------------------------------
# 平台/客户端可能用不同方式与 bot 通信，本文件自动识别三种常见协议：
#   1) GTP（围棋引擎标准协议）：输入 "boardsize 9" / "genmove b" 等命令；
#   2) 逐行 JSON：每行一个 JSON 请求（包含棋盘/着法/轮次等），返回 JSON 着点；
#   3) 单次 JSON：一次传入完整局面，返回一次着点（本项目 Web 后端使用的协议）。
# 另外提供最简单的“纯文本轮着走”模式作为兜底：每行一个对手着法，回一行自己的着法。
# ============================================================================

import os
import tempfile
import traceback
from itertools import chain

GTP_COLUMNS = "ABCDEFGHJKLMNOPQRSTUVWXYZ"  # GTP 坐标跳过 I
BOT_NAME = "go9-agent"
BOT_VERSION = "2.8.0"
GTP_COMMANDS = {
    "name", "version", "protocol_version", "list_commands", "known_command",
    "boardsize", "komi", "clear_board", "play", "genmove", "undo", "quit",
    "final_score", "time_settings", "time_left", "showboard",
}

DEBUG_LOG_PATH = os.environ.get("BOT_DEBUG_LOG") or os.path.join(tempfile.gettempdir(), "go9_bot_debug.log")


def _debug(kind, text):
    """把输入/输出/异常写入临时日志，便于排查平台协议不匹配问题。"""
    try:
        with open(DEBUG_LOG_PATH, "a", encoding="utf-8") as fh:
            stamp = time.strftime("%H:%M:%S")
            fh.write("[%s] %s %s\n" % (stamp, kind, str(text).replace("\n", "\\n")[:2000]))
    except OSError:
        pass


class _Tee:
    """把 stdout 同时写入调试日志，并保证每次输出立即 flush（GTP/JSON 需要）。"""

    def __init__(self, stream):
        self._stream = stream

    def write(self, data):
        try:
            self._stream.write(data)
            self._stream.flush()
        except (BrokenPipeError, OSError):
            pass
        if data:
            _debug("OUT", data)
        return len(data)

    def flush(self):
        try:
            self._stream.flush()
        except (BrokenPipeError, OSError):
            pass


def _logged_lines(stream):
    for line in stream:
        _debug("IN", line)
        yield line


def _read_meaningful(stream):
    for line in stream:
        if line.strip():
            return line
    return None


START_WORDS = {"start", "init", "begin", "new", "newgame", "new_game", "reset", "ready", "game_start", "gamestart"}


def _detect_mode(text):
    stripped = text.strip()
    if stripped.startswith("{") or stripped.startswith("["):
        return "json"
    parts = stripped.split()
    head = parts[0].lower() if parts else ""
    return "gtp" if head in GTP_COMMANDS else "plain"


def gtp_to_xy(text, size=SIZE):
    """GTP 坐标（如 E5）-> (x, y)；pass/空 返回 None。"""
    s = str(text).strip()
    if not s or s.lower() == "pass":
        return None
    col = s[0].upper()
    if col == "I" or col not in GTP_COLUMNS:
        raise ValueError("非法 GTP 着点: " + s)
    x = GTP_COLUMNS.index(col)
    try:
        row = int(s[1:])
    except (TypeError, ValueError):
        raise ValueError("非法 GTP 着点: " + s)
    if x >= size or row < 1 or row > size:
        raise ValueError("非法 GTP 着点: " + s)
    return x, size - row


def xy_to_gtp(x, y, size=SIZE):
    return "%s%d" % (GTP_COLUMNS[x], size - y)


def _color_of(value, default=BLACK):
    """把 'b'/'black'/'黑' 等统一成 BLACK/WHITE。"""
    if value is None:
        return default
    if isinstance(value, bool):
        return BLACK if value else WHITE
    text = str(value).strip().lower()
    if text.startswith(("b", "black", "1", "x", "●", "黑")):
        return BLACK
    if text.startswith(("w", "white", "2", "o", "○", "白")):
        return WHITE
    return default


def _state_from_board(board, komi):
    size = board.size
    rows = []
    for y in range(size):
        row = []
        for x in range(size):
            v = board.cells[y * size + x]
            row.append("black" if v == BLACK else "white" if v == WHITE else None)
        rows.append(row)
    ko = None
    if board.ko >= 0:
        ko = {"x": board.ko % size, "y": board.ko // size}
    return {
        "size": size,
        "board": rows,
        "currentPlayer": "black" if board.to_move == BLACK else "white",
        "koPoint": ko,
        "passCount": board.pass_count,
        "komi": komi,
    }


def _cgroup_cpu_limit():
    """读取容器 cgroup 的 CPU 配额；平台学生容器常见为 1 核。"""
    for path in ("/sys/fs/cgroup/cpu.max", "/sys/fs/cgroup/cpu/cpu.cfs_quota_us"):
        try:
            if path.endswith("cpu.max"):
                parts = open(path, encoding="utf-8").read().split()
                if not parts or parts[0] == "max":
                    continue
                quota, period = float(parts[0]), float(parts[1])
            else:
                quota = float(open(path, encoding="utf-8").read().strip())
                if quota <= 0:
                    continue
                period = float(open("/sys/fs/cgroup/cpu/cpu.cfs_period_us", encoding="utf-8").read().strip())
            if quota > 0 and period > 0:
                return max(1, int(quota / period))
        except (OSError, ValueError, IndexError):
            continue
    return None


def _bot_workers():
    raw = os.environ.get("BOT_WORKERS")
    if raw:
        try:
            return max(1, min(int(raw), 12))
        except ValueError:
            pass
    # 在 1 核学生容器内，多进程只会平分同一个核；用单进程深搜索更有效。
    limit = _cgroup_cpu_limit() or os.cpu_count() or 1
    return max(1, min(8, int(limit)))


def _call_ai(board, komi, budget_ms, seed=None):
    """调用共享的 MCTS 选择着点；返回 (x, y) 或 None（pass）。"""
    DIFFICULTY["_bot"] = {"max_playouts": 10 ** 9, "max_ms": max(120, int(budget_ms))}
    state = _state_from_board(board, komi)
    workers = _bot_workers()
    if workers > 1:
        result = choose_move_parallel(
            state,
            difficulty="_bot",
            seed=seed,
            workers=workers,
            budget_ms=max(120, int(budget_ms)),
        )
    else:
        result = choose_move(state, difficulty="_bot", seed=seed)
    move = result.get("move")
    if not move:
        return None
    return int(move["x"]), int(move["y"])


# ----------------------------------------------------------------------------
# 1) GTP 协议
# ----------------------------------------------------------------------------
class GtpSession:
    def __init__(self, size=SIZE, komi=KOMI, seed=None):
        self.size = size
        self.komi = komi
        self.seed = seed
        self.default_budget_ms = 1200
        self.reset()

    def reset(self):
        self.board = Board(self.size)
        self.board.to_move = BLACK
        self.history = []  # [(color, (x, y) | None)]

    def _apply(self, color, vertex):
        xy = gtp_to_xy(vertex, self.size)
        self.board.to_move = color
        if xy is None:
            self.board.pass_move()
        else:
            idx = xy[1] * self.size + xy[0]
            if not self.board.is_legal(idx, color):
                raise ValueError("非法着点: " + str(vertex))
            self.board.play(idx)
        self.history.append((color, xy))

    def handle(self, command, args):
        cmd = command.lower()
        if cmd == "quit":
            return ""
        if cmd == "name":
            return BOT_NAME
        if cmd == "version":
            return BOT_VERSION
        if cmd == "protocol_version":
            return "2"
        if cmd == "list_commands":
            return " ".join(sorted(GTP_COMMANDS))
        if cmd == "known_command":
            return "true" if args and args[0].lower() in GTP_COMMANDS else "false"
        if cmd == "boardsize":
            size = int(args[0])
            if size != self.size:
                raise ValueError("只支持 9 路棋盘")
            self.reset()
            return ""
        if cmd == "komi":
            self.komi = float(args[0])
            return ""
        if cmd == "clear_board":
            self.reset()
            return ""
        if cmd == "play":
            color = _color_of(args[0])
            self._apply(color, args[1] if len(args) > 1 else "pass")
            return ""
        if cmd == "genmove":
            color = _color_of(args[0])
            move = _call_ai(self.board, self.komi, self.default_budget_ms, self.seed)
            if move is None:
                self.board.to_move = color
                self.board.pass_move()
                self.history.append((color, None))
                return "pass"
            x, y = move
            self.board.to_move = color
            self.board.play(y * self.size + x)
            self.history.append((color, (x, y)))
            return xy_to_gtp(x, y, self.size)
        if cmd == "undo":
            if self.history:
                self.history.pop()
                self.reset()
                for color, xy in self.history:
                    if xy is None:
                        self.board.to_move = color
                        self.board.pass_move()
                    else:
                        self.board.to_move = color
                        self.board.play(xy[1] * self.size + xy[0])
            return ""
        if cmd == "time_settings":
            try:
                main_time = float(args[0])
                stones = int(args[1]) if len(args) > 1 else 0
                total_ms = max(200.0, main_time * 1000.0)
                self.default_budget_ms = max(200, min(4000, total_ms / max(1, stones + 20)))
            except (IndexError, ValueError):
                pass
            return ""
        if cmd == "time_left":
            try:
                left_ms = float(args[1]) * 1000.0
                self.default_budget_ms = max(200, min(4000, left_ms * 0.4))
            except (IndexError, ValueError):
                pass
            return ""
        if cmd == "showboard":
            lines = []
            for y in range(self.size):
                row = []
                for x in range(self.size):
                    v = self.board.cells[y * self.size + x]
                    row.append("X" if v == BLACK else "O" if v == WHITE else ".")
                lines.append(" ".join(row))
            return "\n".join(lines)
        if cmd == "final_score":
            black, white = self.board.score(self.komi)
            if black > white:
                return "B+%.1f" % (black - white)
            if white > black:
                return "W+%.1f" % (white - black)
            return "0"
        raise ValueError("未知命令: " + command)


def run_gtp(first_line, stream, seed=None):
    session = GtpSession(seed=seed)
    for line in chain([first_line], stream):
        text = line.strip()
        if not text:
            continue
        parts = text.split()
        if parts and parts[0].isdigit():  # GTP 允许命令前带 id
            parts = parts[1:]
        if not parts:
            continue
        try:
            response = session.handle(parts[0], parts[1:])
            sys.stdout.write("= %s\n\n" % response if response != "" else "= \n\n")
        except Exception as exc:  # noqa: BLE001
            sys.stdout.write("? %s\n\n" % exc)
        sys.stdout.flush()
        if parts[0].lower() == "quit":
            break




# ----------------------------------------------------------------------------
# arena.v1 协议（协会 AI 竞赛平台使用）
# 请求：{"protocol":"arena.v1","type":"move_request","request_id":...,"game":"go9",
#        "observation":{"board":9x9, "current_player":1|2, "komi":...},
#        "legal_moves":[{"kind":"PLACE","col":c,"row":r}, {"kind":"PASS"}], "time_limit_ms":...}
# 响应：{"action":{"col":c,"kind":"PLACE","row":r},"protocol":"arena.v1",
#        "request_id":...,"type":"move_response"}
# ----------------------------------------------------------------------------

def _arena_budget(obj, default_ms=1200):
    raw = obj.get("time_limit_ms")
    if raw is None:
        raw = (obj.get("observation") or {}).get("time_limit_ms")
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return default_ms
    if value <= 0:
        return default_ms
    # 预留启动/协议解析/进程池开销，尽量用满平台给的单手时限
    reserve = (900.0 if value >= 3500 else 700.0) if _bot_workers() > 1 else 200.0
    return max(20.0, min(6000.0, value - reserve))


def _arena_legal_moves(obj):
    """解析 legal_moves，返回 (允许的坐标集合, 是否允许 PASS)。"""
    raw = obj.get("legal_moves")
    if raw is None:
        raw = (obj.get("observation") or {}).get("legal_moves")
    allowed = set()
    pass_ok = False
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, dict):
                kind = str(item.get("kind") or "").upper()
                if kind == "PASS":
                    pass_ok = True
                    continue
                if "col" in item and "row" in item:
                    allowed.add((int(item["col"]), int(item["row"])))
                elif "x" in item and "y" in item:
                    allowed.add((int(item["x"]), int(item["y"])))
            elif isinstance(item, (list, tuple)) and len(item) >= 2:
                allowed.add((int(item[0]), int(item[1])))
    return allowed, pass_ok


def _arena_board(obj):
    obs = obj.get("observation") or {}
    size = int(obs.get("size") or SIZE)
    rows = _board_from_any(obs.get("board"), size)
    board = Board(size)
    for y in range(size):
        for x in range(size):
            cell = rows[y][x]
            if cell == "black":
                board.cells[y * size + x] = BLACK
            elif cell == "white":
                board.cells[y * size + x] = WHITE
    cp = obs.get("current_player")
    try:
        board.to_move = BLACK if int(cp) == 1 else WHITE
    except (TypeError, ValueError):
        board.to_move = BLACK
    ko = obs.get("ko_point")
    if isinstance(ko, dict) and "col" in ko and "row" in ko:
        board.ko = int(ko["row"]) * size + int(ko["col"])
    elif isinstance(ko, (list, tuple)) and len(ko) >= 2:
        board.ko = int(ko[1]) * size + int(ko[0])
    elif isinstance(ko, int) and ko >= 0:
        board.ko = ko
    try:
        board.pass_count = int(obs.get("pass_count") or 0)
    except (TypeError, ValueError):
        board.pass_count = 0
    komi = float(obs.get("komi") if obs.get("komi") is not None else KOMI)
    return board, komi


def _arena_pick(obj, board, komi, budget, seed):
    allowed, pass_ok = _arena_legal_moves(obj)
    if allowed:
        # 只在这些合法点里搜索：把非法点填满，构造临时棋盘不现实；先让 AI 走，再回退到允许点
        move = _call_ai(board, komi, budget, seed)
        if move is not None and (int(move[0]), int(move[1])) in allowed:
            return move
        scored = score_moves(board)
        best = None
        for x, y, score in sorted(scored, key=lambda item: item[2], reverse=True):
            if (x, y) in allowed:
                best = (x, y)
                break
        if best is not None:
            return best
        if pass_ok:
            return None
        return None

    move = _call_ai(board, komi, budget, seed)
    return move


def _arena_response(request_id, move):
    if move is None:
        action = {"kind": "PASS"}
    else:
        action = {"kind": "PLACE", "col": int(move[0]), "row": int(move[1])}
    return json.dumps(
        {
            "action": action,
            "protocol": "arena.v1",
            "request_id": request_id,
            "type": "move_response",
        },
        ensure_ascii=False,
    )


def _arena_handle(obj, seed):
    request_id = obj.get("request_id")
    board, komi = _arena_board(obj)
    budget = _arena_budget(obj)
    move = _arena_pick(obj, board, komi, budget, seed)
    return _arena_response(request_id, move)


def run_arena_stream(first_obj, stream, seed=None):
    sys.stdout.write(_arena_handle(first_obj, seed) + "\n")
    sys.stdout.flush()
    for line in stream:
        text = line.strip()
        if not text:
            continue
        try:
            obj = json.loads(text)
        except json.JSONDecodeError:
            continue
        if not isinstance(obj, dict) or obj.get("protocol") != "arena.v1":
            continue
        if obj.get("type") != "move_request":
            continue
        try:
            sys.stdout.write(_arena_handle(obj, seed) + "\n")
        except Exception as exc:  # noqa: BLE001
            _debug("ARENA_ERROR", "%s: %s" % (type(exc).__name__, exc))
            sys.stdout.write(_arena_response(obj.get("request_id"), None) + "\n")
        sys.stdout.flush()


# ----------------------------------------------------------------------------
# 2) JSON 协议
# ----------------------------------------------------------------------------
def _norm_cell(value):
    if value is None:
        return None
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return "black" if int(value) == 1 else "white" if int(value) == 2 else None
    text = str(value).strip().lower()
    if text in ("black", "b", "x", "1", "#", "●", "黑", "黑棋"):
        return "black"
    if text in ("white", "w", "o", "2", "○", "白", "白棋"):
        return "white"
    return None


def _board_from_any(raw, size):
    if isinstance(raw, dict):
        for key in ("cells", "grid", "board", "map", "position"):
            if key in raw:
                return _board_from_any(raw[key], size)
        raise ValueError("无法解析棋盘 dict")
    if isinstance(raw, str):
        chars = [ch for ch in raw if ch not in " \t\r\n,;"]
        if len(chars) < size * size:
            raise ValueError("棋盘字符串长度不足")
        return [[_norm_cell(chars[y * size + x]) for x in range(size)] for y in range(size)]
    if isinstance(raw, list):
        if len(raw) == size and all(isinstance(r, (list, str)) for r in raw):
            rows = []
            for r in raw:
                cells = list(r) if not isinstance(r, str) else list(r)
                if len(cells) != size:
                    raise ValueError("棋盘行长度不是 %d" % size)
                rows.append([_norm_cell(c) for c in cells])
            return rows
        if len(raw) >= size * size:
            flat = list(raw)[: size * size]
            return [[_norm_cell(flat[y * size + x]) for x in range(size)] for y in range(size)]
    raise ValueError("无法解析棋盘")


def _moves_from_any(raw, size):
    result = []
    if not isinstance(raw, list):
        return result
    for item in raw:
        color = None
        move = None
        if isinstance(item, str):
            text = item.strip()
            if ":" in text:
                prefix, vertex = text.split(":", 1)
                color = _color_of(prefix, None)
                move = vertex
            elif text.lower() == "pass":
                move = None
            else:
                move = text
        elif isinstance(item, dict):
            color = item.get("color") or item.get("player") or item.get("side") or item.get("who")
            if item.get("pass") or str(item.get("type", "")).lower() == "pass":
                move = None
            elif "vertex" in item or "coord" in item or "move" in item:
                move = item.get("vertex", item.get("coord", item.get("move")))
            elif "x" in item and "y" in item:
                move = (int(item["x"]), int(item["y"]))
        elif isinstance(item, (list, tuple)) and len(item) >= 2:
            if isinstance(item[0], (int, float)) and isinstance(item[1], (int, float)):
                move = (int(item[0]), int(item[1]))
                if len(item) > 2:
                    color = _color_of(item[2], None)
            else:
                move = str(item[0])
        result.append((color, move))
    return result


def _board_from_moves(moves, size, komi):
    board = Board(size)
    board.to_move = BLACK
    color = BLACK
    for item_color, move in moves:
        if item_color is not None:
            color = item_color
        board.to_move = color
        if move is None:
            board.pass_move()
        else:
            if isinstance(move, tuple):
                x, y = move
                idx = y * size + x
            else:
                xy = gtp_to_xy(str(move), size)
                idx = -1 if xy is None else xy[1] * size + xy[0]
            if idx < 0:
                board.pass_move()
            elif board.is_legal(idx, color):
                board.play(idx)
            else:
                raise ValueError("历史着法非法: " + str(move))
        color = WHITE if color == BLACK else BLACK
    board.to_move = color
    return board


def _find_key(obj, names):
    if not isinstance(obj, dict):
        return None
    for name in names:
        if name in obj and obj[name] is not None:
            return obj[name]
    return None


def _budget_from_request(obj, default_ms=1500):
    raw = _find_key(
        obj,
        ("time", "timeLeft", "time_left", "timeout", "timeLimit", "limit", "remainingTime", "deadline"),
    )
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return default_ms
    if value <= 0:
        return default_ms
    # 小于 60 视为秒，否则视为毫秒
    ms = value * 1000.0 if value <= 60 else value
    return max(150.0, min(4000.0, ms * 0.5))


def _parse_request(obj, size=SIZE, komi=KOMI):
    """把各种 JSON 请求统一解析成 (board, our_color, budget_ms)。"""
    if not isinstance(obj, dict):
        raise ValueError("请求不是 JSON 对象")

    # 本项目后端的格式：{"state": {...}}
    inner = obj.get("state") if isinstance(obj.get("state"), dict) else None
    source = inner if inner is not None else obj
    requests = source.get("requests") if isinstance(source, dict) else None
    if isinstance(requests, list) and requests:
        candidate = requests[-1]
        if isinstance(candidate, dict):
            merged = dict(candidate)
            for key, value in source.items():
                if key not in merged and key not in ("requests", "responses"):
                    merged[key] = value
            source = merged

    board_raw = _find_key(source, ("board", "grid", "map", "position", "cells", "boardState"))
    moves_raw = _find_key(source, ("moves", "history", "moveHistory", "records", "log", "actions"))

    explicit_color = _find_key(
        source,
        ("color", "side", "player", "ourColor", "selfColor", "botColor", "colorToPlay"),
    )
    if explicit_color is None and "isBlack" in source:
        explicit_color = "black" if source["isBlack"] else "white"

    if board_raw is not None:
        board_rows = _board_from_any(board_raw, size)
        board = Board(size)
        board.to_move = BLACK
        for y in range(size):
            for x in range(size):
                cell = board_rows[y][x]
                if cell == "black":
                    board.cells[y * size + x] = BLACK
                elif cell == "white":
                    board.cells[y * size + x] = WHITE
        move_list = _moves_from_any(moves_raw, size)
        # 有完整棋盘时，历史只用于判断轮次/劫争（可选）
    elif moves_raw is not None:
        move_list = _moves_from_any(moves_raw, size)
        board = _board_from_moves(move_list, size, komi)
    else:
        raise ValueError("请求里找不到棋盘或着法记录")

    current = _find_key(source, ("currentPlayer", "toMove", "turn", "playerToMove", "nextPlayer"))
    if current is not None:
        board.to_move = _color_of(current)
    elif explicit_color is not None and board_raw is not None:
        # 无轮次信息时，默认请求方（我们的颜色）行棋
        board.to_move = _color_of(explicit_color)

    our_color = _color_of(explicit_color) if explicit_color is not None else board.to_move
    budget = _budget_from_request(obj)
    return board, our_color, budget


def _json_reply(move, size=SIZE):
    fmt = (os.environ.get("BOT_JSON_FORMAT") or "both").lower()
    if move is None:
        vertex = "pass"
        obj = {"move": "pass", "response": "pass", "coord": "pass"}
        if fmt in ("xy", "coord", "both"):
            obj.update({"x": -1, "y": -1})
        return json.dumps(obj, ensure_ascii=False)
    x, y = move
    vertex = xy_to_gtp(x, y, size)
    if fmt == "coord":
        return json.dumps({"move": vertex}, ensure_ascii=False)
    if fmt == "xy":
        return json.dumps({"move": {"x": x, "y": y}}, ensure_ascii=False)
    return json.dumps(
        {"move": vertex, "response": vertex, "coord": vertex, "x": x, "y": y},
        ensure_ascii=False,
    )


def run_json_stream(first_line, stream, seed=None):
    buffer = first_line
    line_iter = iter(chain([], stream))
    while True:
        text = buffer.strip()
        if text:
            try:
                obj = json.loads(text)
            except json.JSONDecodeError:
                # 可能是多行 JSON：继续读，拼到能解析为止（也兼容本项目后端的一次性请求）
                merged = text
                for extra in line_iter:
                    merged += extra
                    try:
                        obj = json.loads(merged)
                        text = merged
                        break
                    except json.JSONDecodeError:
                        continue
                else:
                    sys.stdout.write(json.dumps({"error": "无法解析 JSON 请求"}, ensure_ascii=False) + "\n")
                    sys.stdout.flush()
                    return
            try:
                if isinstance(obj, dict) and obj.get("protocol") == "arena.v1":
                    run_arena_stream(obj, line_iter, seed=seed)
                    return
                if isinstance(obj, dict) and isinstance(obj.get("state"), dict):
                    # 本项目 Web 后端的一次性协议
                    state = obj["state"]
                    size = int(state.get("size") or SIZE)
                    board_rows = _board_from_any(state.get("board"), size)
                    board = Board(size)
                    for y in range(size):
                        for x in range(size):
                            cell = board_rows[y][x]
                            if cell == "black":
                                board.cells[y * size + x] = BLACK
                            elif cell == "white":
                                board.cells[y * size + x] = WHITE
                    board.to_move = WHITE if state.get("currentPlayer") == "white" else BLACK
                    ko = state.get("koPoint")
                    if ko:
                        board.ko = int(ko["y"]) * size + int(ko["x"])
                    board.pass_count = int(state.get("passCount") or 0)
                    komi = float(state.get("komi") or KOMI)
                    level = obj.get("difficulty") or "medium"
                    budget = {"easy": 500, "medium": 1200, "hard": 2400}.get(level, 1300)
                    move = _call_ai(board, komi, budget, obj.get("seed") if obj.get("seed") is not None else seed)
                    if move is None:
                        reply = json.dumps({"move": None}, ensure_ascii=False)
                    else:
                        reply = json.dumps({"move": {"x": move[0], "y": move[1]}}, ensure_ascii=False)
                    sys.stdout.write(reply)
                    sys.stdout.flush()
                    return
                board, our_color, budget = _parse_request(obj)
                move = _call_ai(board, KOMI, budget, seed)
                sys.stdout.write(_json_reply(move) + "\n")
                sys.stdout.flush()
            except Exception as exc:  # noqa: BLE001
                sys.stdout.write(json.dumps({"error": "%s: %s" % (type(exc).__name__, exc)}, ensure_ascii=False) + "\n")
                sys.stdout.flush()
                return
        buffer = next(line_iter, None)
        if buffer is None:
            return


# ----------------------------------------------------------------------------
# 3) 纯文本“轮着走”兜底模式：每行一个对手着法/指令，回一行自己的着法
# ----------------------------------------------------------------------------
def run_plain_stream(first_line, stream, seed=None):
    our_color = _color_of(os.environ.get("BOT_COLOR", "black"))
    board = Board(SIZE)
    board.to_move = BLACK
    lines = chain([first_line], stream)
    started = False

    def my_move():
        budget = float(os.environ.get("BOT_TIME_MS") or 1200)
        move = _call_ai(board, KOMI, budget, seed)
        board.to_move = our_color
        if move is None:
            board.pass_move()
            return "pass"
        board.play(move[1] * SIZE + move[0])
        return xy_to_gtp(move[0], move[1], SIZE)

    for raw in lines:
        text = raw.strip()
        if not text:
            continue
        low = text.lower()
        if low in ("start", "new", "newgame", "begin", "init", "reset"):
            board = Board(SIZE)
            board.to_move = BLACK
            started = True
            if our_color == BLACK:
                sys.stdout.write(my_move() + "\n")
                sys.stdout.flush()
            continue
        # 对手着法
        try:
            xy = gtp_to_xy(text, SIZE)
        except ValueError:
            continue
        board.to_move = WHITE if our_color == BLACK else BLACK
        if xy is None:
            board.pass_move()
        else:
            idx = xy[1] * SIZE + xy[0]
            if board.is_legal(idx, board.to_move):
                board.play(idx)
        board.to_move = our_color
        sys.stdout.write(my_move() + "\n")
        sys.stdout.flush()


# ----------------------------------------------------------------------------
# 入口：自动识别协议
# ----------------------------------------------------------------------------
def main():
    if "_ensure_record_tables" in globals():
        try:
            _ensure_record_tables()
        except Exception:  # noqa: BLE001
            pass

    args = sys.argv[1:]
    if "--selftest" in args:
        selftest()
        session = GtpSession()
        assert session.handle("boardsize", ["9"]) == ""
        vertex = session.handle("genmove", ["b"])
        assert gtp_to_xy(vertex, 9) is not None, vertex
        assert xy_to_gtp(*gtp_to_xy("E5", 9), size=9) == "E5"
        req = {
            "board": [["black" if (x == 4 and y == 4) else None for x in range(9)] for y in range(9)],
            "color": "white",
            "time": 30,
        }
        board, color, budget = _parse_request(req)
        assert color == WHITE and board.to_move == WHITE and budget > 0
        arena_req = {
            "protocol": "arena.v1",
            "type": "move_request",
            "request_id": "t1",
            "game": "go9",
            "observation": {"board": [[0] * 9 for _ in range(9)], "current_player": 1, "komi": 7.5},
            "legal_moves": [{"kind": "PLACE", "col": 4, "row": 4}],
            "time_limit_ms": 200,
        }
        arena_out = _arena_handle(arena_req, None)
        arena_resp = json.loads(arena_out)
        assert arena_resp["type"] == "move_response" and arena_resp["request_id"] == "t1"
        assert arena_resp["action"]["kind"] == "PLACE"
        print(json.dumps({"ok": True, "selftest": "passed", "gtp": "ok", "json": "ok", "arena": "ok"}, ensure_ascii=False))
        return 0

    forced = None
    if "--protocol" in args:
        idx = args.index("--protocol")
        if idx + 1 < len(args):
            forced = args[idx + 1]

    _debug("START", "cwd=%s argv=%s python=%s log=%s" % (os.getcwd(), args, sys.version.split()[0], DEBUG_LOG_PATH))
    stdin_lines = _logged_lines(sys.stdin)
    first_line = _read_meaningful(stdin_lines)
    if first_line is None:
        _debug("EXIT", "no input")
        return 0

    sys.stdout = _Tee(sys.stdout)

    start_buffer = []
    current = first_line
    while current is not None and current.strip().lower() in START_WORDS:
        start_buffer.append(current)
        current = _read_meaningful(stdin_lines)
    if current is None:
        _debug("EXIT", "only start words, no protocol line")
        return 0

    seed_env = os.environ.get("BOT_SEED")
    seed = int(seed_env) if seed_env and seed_env.isdigit() else None
    mode = forced or _detect_mode(current)
    _debug("MODE", mode)

    try:
        if mode == "json":
            run_json_stream(current, stdin_lines, seed=seed)
        elif mode == "gtp":
            run_gtp(current, stdin_lines, seed=seed)
        else:
            if start_buffer:
                first_plain = start_buffer[0]
                rest = chain(start_buffer[1:] + [current], stdin_lines)
            else:
                first_plain = current
                rest = stdin_lines
            run_plain_stream(first_plain, rest, seed=seed)
    except Exception as exc:  # noqa: BLE001
        _debug("ERROR", "%s: %s\n%s" % (type(exc).__name__, exc, traceback.format_exc()))
        raise
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
