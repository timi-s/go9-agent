#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""go9-agent 的本地内置 AI（Python 源码实现）。

由 Node 后端以子进程方式调用：从 stdin 读取一个 JSON 请求，向 stdout 输出一个 JSON 结果，
后端负责规则校验与兜底，因此本文件可以独立修改、单独测试。

请求（stdin）::

    {
      "state": { "board": [["black"|"white"|null, ...], ...],  // 9x9，board[y][x]
                 "currentPlayer": "black"|"white",
                 "koPoint": {"x":..,"y":..} | null,
                 "passCount": 0,
                 "komi": 7.5 },
      "difficulty": "easy"|"medium"|"hard",
      "seed": 12345
    }

响应（stdout）::

    { "move": {"x": 4, "y": 4} }      # 落子
    { "move": null }                   # 停一手（pass）
    { "error": "..." }                 # 出错（后端会回退到 JS 内置 AI）

算法：静态启发式评分作为先验 + 蒙特卡洛树搜索（UCT/PUCT）+ 随机模拟，
收官阶段在「对方已停一手 / 空点很少且落子不再提高己方数子优势」时主动 pass。

只使用标准库，无第三方依赖。
"""

import json
import math
import os
import random
import sys
import time

# 可选加载“从 KataGo 自对弈/实战棋谱学习”的棋形与开局知识。
# 单文件比赛 bot 会把 learned_data.py 拼接到本文件之前，此时下面的 import 失败，
# 但相关表已经存在于 globals()，_learned_table() 仍能正常取到。
# Web 路径（Node 直接调用 go_ai.py）通过这个 import 获得同样的知识。
try:
    from learned_data import (  # noqa: F401
        KATAGO_BOOK_BLACK,
        KATAGO_BOOK_WHITE,
        PATTERN_TABLES,
        SHAPE_TABLES,
        SHAPE_MEANS,
        SCRIPTS_BLACK,
        SCRIPTS_WHITE,
    )
except Exception:  # pragma: no cover - 缺少 learned_data.py 时退化为纯 MCTS
    pass

SIZE = 9
EMPTY = 0
BLACK = 1
WHITE = 2
KOMI = 7.5

# 每档难度的「模拟次数上限」和「时间上限（毫秒）」——Python 比 JS 慢，
# 因此按时间做硬上限，保证每手响应时间可控。
DIFFICULTY = {
    "easy": {"max_playouts": 300, "max_ms": 500},
    "medium": {"max_playouts": 1500, "max_ms": 1300},
    "hard": {"max_playouts": 4000, "max_ms": 2600},
}

UCT_C = 0.7
PUCT_C = 2.0
MAX_PLAYOUT_MOVES = 120
MARGIN_PASS = 0.5


def build_neighbors(size):
    table = [()] * (size * size)
    rows = []
    for y in range(size):
        for x in range(size):
            idx = y * size + x
            nbs = []
            if x > 0:
                nbs.append(idx - 1)
            if x < size - 1:
                nbs.append(idx + 1)
            if y > 0:
                nbs.append(idx - size)
            if y < size - 1:
                nbs.append(idx + size)
            rows.append(tuple(nbs))
    table = rows
    return table


NEIGHBORS = build_neighbors(SIZE)


class Board:
    """轻量棋盘：落子 / 提子 / 简单劫 / 停一手 / 数子。"""

    __slots__ = (
        "size", "n", "cells", "ko", "to_move", "pass_count",
        "_mark", "_lib_seen", "_gen", "_stack", "_group", "_visited",
    )

    def __init__(self, size=SIZE):
        self.size = size
        self.n = size * size
        self.cells = [EMPTY] * self.n
        self.ko = -1
        self.to_move = BLACK
        self.pass_count = 0
        self._mark = [0] * self.n
        self._lib_seen = [0] * self.n
        self._gen = 0
        self._stack = [0] * self.n
        self._group = [0] * self.n
        self._visited = [0] * self.n

    def clone(self):
        b = Board(self.size)
        b.cells = self.cells[:]
        b.ko = self.ko
        b.to_move = self.to_move
        b.pass_count = self.pass_count
        return b

    def load_from(self, other):
        self.cells[:] = other.cells
        self.ko = other.ko
        self.to_move = other.to_move
        self.pass_count = other.pass_count

    def collect(self, idx):
        """收集 idx 所在棋块，返回 (棋子数, 气数)；棋子索引写入 self._group。"""
        cells = self.cells
        color = cells[idx]
        self._gen += 1
        gen = self._gen
        mark = self._mark
        lib_seen = self._lib_seen
        stack = self._stack
        group = self._group
        sp = 0
        gc = 0
        libs = 0
        mark[idx] = gen
        stack[sp] = idx
        sp += 1
        while sp > 0:
            sp -= 1
            cur = stack[sp]
            group[gc] = cur
            gc += 1
            for nb in NEIGHBORS[cur]:
                v = cells[nb]
                if v == EMPTY:
                    if lib_seen[nb] != gen:
                        lib_seen[nb] = gen
                        libs += 1
                elif v == color and mark[nb] != gen:
                    mark[nb] = gen
                    stack[sp] = nb
                    sp += 1
        return gc, libs

    def group_has_liberty(self, idx):
        """快速判断 idx 所在棋块是否有气（找到第一口气就返回 True）。"""
        cells = self.cells
        color = cells[idx]
        self._gen += 1
        gen = self._gen
        mark = self._mark
        stack = self._stack
        sp = 0
        mark[idx] = gen
        stack[sp] = idx
        sp += 1
        while sp > 0:
            sp -= 1
            cur = stack[sp]
            for nb in NEIGHBORS[cur]:
                v = cells[nb]
                if v == EMPTY:
                    return True
                if v == color and mark[nb] != gen:
                    mark[nb] = gen
                    stack[sp] = nb
                    sp += 1
        return False

    def is_legal(self, idx, color):
        cells = self.cells
        if cells[idx] != EMPTY:
            return False
        if idx == self.ko:
            return False
        nbs = NEIGHBORS[idx]
        for nb in nbs:
            if cells[nb] == EMPTY:
                return True
        for nb in nbs:
            v = cells[nb]
            if v == EMPTY:
                continue
            count, libs = self.collect(nb)
            if v == color:
                if libs > 1:
                    return True
            elif libs == 1:
                return True
        return False

    def play(self, idx):
        cells = self.cells
        color = self.to_move
        opponent = WHITE if color == BLACK else BLACK
        cells[idx] = color
        captured = 0
        captured_idx = -1
        for nb in NEIGHBORS[idx]:
            if cells[nb] != opponent:
                continue
            count, libs = self.collect(nb)
            if libs != 0:
                continue
            for k in range(count):
                stone = self._group[k]
                cells[stone] = EMPTY
                captured += 1
                if captured == 1:
                    captured_idx = stone
        if captured == 1:
            count, libs = self.collect(idx)
            self.ko = captured_idx if (count == 1 and libs == 1) else -1
        else:
            self.ko = -1
        self.to_move = opponent
        self.pass_count = 0
        return captured

    def pass_move(self):
        self.ko = -1
        self.pass_count += 1
        self.to_move = WHITE if self.to_move == BLACK else BLACK

    def is_eye(self, idx, color):
        cells = self.cells
        for nb in NEIGHBORS[idx]:
            if cells[nb] != color:
                return False
        size = self.size
        x = idx % size
        y = idx // size
        for dy in (-1, 1):
            for dx in (-1, 1):
                nx = x + dx
                ny = y + dy
                if nx < 0 or nx >= size or ny < 0 or ny >= size:
                    continue
                if cells[ny * size + nx] != color:
                    return False
        return True

    def legal_moves(self):
        color = self.to_move
        return [i for i in range(self.n) if self.cells[i] == EMPTY and self.is_legal(i, color)]

    def score(self, komi=KOMI):
        """中国规则数子：棋子 + 单方围空，白加 komi。返回 (黑, 白)。"""
        cells = self.cells
        size = self.size
        self._gen += 1
        gen = self._gen
        visited = self._visited
        black = 0
        white = 0
        for idx in range(self.n):
            v = cells[idx]
            if v == BLACK:
                black += 1
                continue
            if v == WHITE:
                white += 1
                continue
            if visited[idx] == gen:
                continue
            stack = self._stack
            sp = 0
            stack[sp] = idx
            sp += 1
            visited[idx] = gen
            region = 0
            touches_black = False
            touches_white = False
            while sp > 0:
                sp -= 1
                cur = stack[sp]
                region += 1
                for nb in NEIGHBORS[cur]:
                    nv = cells[nb]
                    if nv == BLACK:
                        touches_black = True
                    elif nv == WHITE:
                        touches_white = True
                    elif visited[nb] != gen:
                        visited[nb] = gen
                        stack[sp] = nb
                        sp += 1
            if touches_black and not touches_white:
                black += region
            elif touches_white and not touches_black:
                white += region
        return black, white + komi

    def winner(self, komi=KOMI):
        black, white = self.score(komi)
        if black > white:
            return BLACK
        if white > black:
            return WHITE
        return EMPTY

    def rollout(self, rng, komi=KOMI, max_moves=MAX_PLAYOUT_MOVES):
        limit = min(self.n * 2, max_moves)
        last_move = -1
        random_candidate = self.random_candidate
        rollout_play = self.rollout_play
        pass_move = self.pass_move
        for _ in range(limit):
            if self.pass_count >= 2:
                break
            move = random_candidate(rng, last_move)
            if move < 0:
                pass_move()
                continue
            if rollout_play(move):
                last_move = move
        return self.winner(komi)

    def random_candidate(self, rng, last_move=-1):
        """随机选一个空点（不保证不自杀），由 rollout_play 负责回滚。"""
        cells = self.cells
        color = self.to_move
        n = self.n
        rand = rng.random
        if last_move >= 0 and rand() < 0.5:
            nbs = NEIGHBORS[last_move]
            start = int(rand() * len(nbs))
            for k in range(len(nbs)):
                idx = nbs[(start + k) % len(nbs)]
                if cells[idx] == EMPTY and not self.is_eye(idx, color):
                    return idx
        for _ in range(16):
            idx = int(rand() * n)
            if cells[idx] == EMPTY and not self.is_eye(idx, color):
                return idx
        start = int(rand() * n)
        for k in range(n):
            idx = (start + k) % n
            if cells[idx] == EMPTY and not self.is_eye(idx, color):
                return idx
        return -1

    def rollout_play(self, idx):
        """模拟用落子：自杀则回滚并返回 False；正式对局规则（打劫/超级劫）由 Node 端校验。"""
        cells = self.cells
        me = self.to_move
        opponent = WHITE if me == BLACK else BLACK
        cells[idx] = me
        captured = 0
        for nb in NEIGHBORS[idx]:
            if cells[nb] != opponent:
                continue
            if self.group_has_liberty(nb):
                continue
            count, libs = self.collect(nb)
            for k in range(count):
                cells[self._group[k]] = EMPTY
            captured += count
        if captured == 0:
            has_liberty = False
            for nb in NEIGHBORS[idx]:
                if cells[nb] == EMPTY:
                    has_liberty = True
                    break
            if not has_liberty and not self.group_has_liberty(idx):
                cells[idx] = EMPTY
                return False
        self.ko = -1
        self.to_move = opponent
        self.pass_count = 0
        return True


class Node:
    __slots__ = ("parent", "mover", "move", "cells", "ko", "to_move", "pass_count",
                 "children", "untried", "visits", "wins", "prior")

    def __init__(self, parent, mover, move, board):
        self.parent = parent
        self.mover = mover
        self.move = move
        self.cells = board.cells[:]
        self.ko = board.ko
        self.to_move = board.to_move
        self.pass_count = board.pass_count
        self.children = []
        self.untried = None
        self.visits = 0
        self.wins = 0
        self.prior = 0.0


def softmax_priors(scored, legal, size):
    """把静态评分转成根节点先验概率。legal 为合法点索引列表。"""
    if not scored:
        return None
    legal_set = set(legal)
    usable = [(y * size + x, score) for (x, y, score) in scored if (y * size + x) in legal_set]
    if not usable:
        return None
    best = max(score for (_i, score) in usable)
    weights = []
    total = 0.0
    for idx, score in usable:
        w = math.exp((score - best) / 10.0)
        weights.append((idx, w))
        total += w
    if total <= 0:
        return None
    priors = {idx: w / total for idx, w in weights}
    for idx in legal_set:
        priors.setdefault(idx, 1e-6)
    return priors


def score_moves(board):
    """轻量静态评分（先验用）：提子 / 救棋 / 打吃 / 自陷打吃 / 填眼 / 布局。"""
    cells = board.cells
    me = board.to_move
    opponent = WHITE if me == BLACK else BLACK
    # 黑棋贴目吃紧，必须主动进攻；白棋领先贴目，优先防守
    attack_factor = 1.15 if me == BLACK else 0.85
    defense_factor = 1.00 if me == BLACK else 1.45

    own_atari_stones = set()
    weak_own_stones = set()
    seen = set()
    for i in range(board.n):
        if cells[i] != me or i in seen:
            continue
        cnt, libs = board.collect(i)
        stones = [board._group[k] for k in range(cnt)]
        seen.update(stones)
        if libs == 1:
            own_atari_stones.update(stones)
        if libs <= 2 and cnt >= 3:
            weak_own_stones.update(stones)

    scored = []
    for idx in range(board.n):
        if cells[idx] != EMPTY:
            continue
        if not board.is_legal(idx, me):
            continue
        x = idx % board.size
        y = idx // board.size
        probe = board.clone()
        captured = probe.play(idx)

        score = captured * 60.0
        count, libs = probe.collect(idx)
        score += min(libs, 4) * 2.0
        if libs == 1 and captured == 0:
            # 虎口/自送：己方棋块只剩 1 气，白送对手提子
            score -= (45.0 + 18.0 * count) * defense_factor
            if me == BLACK:
                score -= 10.0
        if board.is_eye(idx, me):
            score -= 70.0

        # 攻防棋形：打吃/紧气/分断（进攻），救棋/接应/护弱（防守）
        own_atari_groups = 0
        opp_atari_groups = 0
        for nb in NEIGHBORS[idx]:
            if cells[nb] == opponent:
                cnt, olibs = board.collect(nb)
                opp_atari_groups += 1
                if olibs == 1:
                    score += (18.0 + cnt * 4.0) * attack_factor
                elif olibs == 2:
                    score += (12.0 + cnt * 2.5) * attack_factor
                elif olibs == 3:
                    score += (5.0 + cnt * 1.2) * attack_factor
            elif cells[nb] == me:
                cnt, olibs = board.collect(nb)
                if olibs == 1:
                    own_atari_groups += 1
                    score += (30.0 + cnt * 8.0) * defense_factor
                elif olibs == 2:
                    score += (9.0 + cnt * 2.0) * defense_factor
        if opp_atari_groups >= 2:
            score += 6.0 * attack_factor * opp_atari_groups
        if own_atari_groups >= 2:
            score += 4.0 * defense_factor * own_atari_groups

        # 己方弱棋就在旁边：不要脱先/乱跳，优先接应（保持战斗稳定性）
        local_own = 0
        for nb in NEIGHBORS[idx]:
            if cells[nb] == me:
                local_own += 1
        adjacent_weak = 0
        for nb in NEIGHBORS[idx]:
            if nb in weak_own_stones:
                adjacent_weak += 1
        if adjacent_weak:
            if captured == 0 and own_atari_groups == 0 and libs <= 2:
                score -= 12.0 * defense_factor
            if local_own >= 2:
                score += 8.0 * defense_factor

        # 接上两块以上己方棋（连接成一块，战斗更稳）
        if local_own >= 2:
            score += 7.0 * defense_factor

        # 自己有棋块被打吃却脱先（且不是提子解围）：重罚，尤其白棋
        if own_atari_stones and captured == 0 and own_atari_groups == 0:
            score -= 30.0 * defense_factor

        # 大师棋理：避免“团子/空三角”这类愚形（黑棋容易越下越重）
        own_neighbors = 0
        own_list = []
        for nb in NEIGHBORS[idx]:
            if cells[nb] == me:
                own_neighbors += 1
                own_list.append(nb)
        if own_neighbors >= 3:
            score -= (own_neighbors - 2) * 14.0
            if me == BLACK:
                score -= 6.0
        elif own_neighbors == 2 and len(own_list) >= 2:
            if any(own_list[1] in NEIGHBORS[own_list[0]] for _ in (0,)):
                score -= 10.0

        # 轻灵：不贴身的斜日/飞/大飞走法（避免一路贴着对方走成重形）
        if own_neighbors == 0 and captured == 0:
            jump = False
            for dx, dy in _KNIGHT_OFFSETS:
                nx, ny = x + dx, y + dy
                if 0 <= nx < 9 and 0 <= ny < 9 and cells[ny * 9 + nx] == me:
                    jump = True
                    break
            if not jump:
                for dx, dy in _DIAG1_OFFSETS:
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < 9 and 0 <= ny < 9 and cells[ny * 9 + nx] == me:
                        jump = True
                        break
            if jump:
                score += 7.0 if not weak_own_stones else 2.0

        edge = min(x, y, board.size - 1 - x, board.size - 1 - y)
        score += {0: -14.0, 1: -5.0, 2: 8.0, 3: 7.0}.get(edge, 3.0)
        center = (board.size - 1) / 2.0
        score += max(0.0, 5.0 - abs(x - center) - abs(y - center)) * 0.6

        nearest = 99
        for j in range(board.n):
            if cells[j] != EMPTY:
                d = abs(j % board.size - x) + abs(j // board.size - y)
                if d < nearest:
                    nearest = d
        if nearest == 1:
            score += 3.0
        elif nearest == 2:
            score += 2.0

        score += pattern_score_bonus(board, x, y)
        _guide = globals().get("_PRIOR_GUIDE")
        if _guide is not None and (x, y) == _guide:
            score += globals().get("_PRIOR_BONUS", 0.0)
        score += shape_score_bonus(board, x, y)

        scored.append((x, y, score))
    return scored


def should_pass(board, legal, komi):
    """终局判断：只有对手刚停一手时才考虑停手。
    - 只有己方明显领先（>5 目）才主动停手，避免“以为领先”提前结束；
    - 落后/接近时继续找能改善局面的点，防止把可翻盘的对局直接判死。"""
    if board.pass_count < 1:
        return False

    me = board.to_move
    black, white = board.score(komi)
    margin = (black - white) if me == BLACK else (white - black)
    if margin <= 5.0:
        return False

    probe = board.clone()
    probe.pass_move()
    if probe.winner(komi) != me:
        return False
    return True


OPENING_BOOK_BLACK = {
    (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0): (4, 5),
    (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0): (5, 4),
    (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0): (6, 3),
    (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0): (2, 4),
    (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1, 2, 0, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0): (5, 5),
    (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0): (6, 5),
    (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 1, 2, 2, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0): (3, 7),
    (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 0, 0, 0, 0, 0, 2, 0, 0, 1, 2, 0, 0, 0, 0, 1, 1, 0, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 2, 0, 2, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0): (6, 6),
    (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 0, 0, 0, 0, 0, 2, 0, 0, 1, 2, 0, 0, 0, 0, 1, 1, 0, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 2, 0, 2, 0, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0): (6, 7),
    (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 0, 0, 0, 0, 2, 2, 0, 0, 1, 2, 0, 0, 0, 0, 1, 1, 0, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 2, 0, 2, 0, 1, 2, 0, 0, 0, 0, 0, 0, 0, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0): (1, 4),
    (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 2, 0, 0, 0, 2, 2, 0, 0, 1, 2, 0, 0, 0, 1, 1, 1, 0, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 2, 0, 2, 0, 1, 2, 0, 0, 0, 0, 0, 0, 0, 1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0): (5, 1),
    (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 0, 0, 0, 2, 0, 2, 0, 1, 2, 0, 0, 0, 0, 0, 2, 0, 1, 1, 0, 0, 1, 1, 1, 0, 1, 2, 0, 0, 0, 2, 2, 0, 0, 1, 2, 0, 0, 0, 0, 0, 0, 2, 1, 2, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0): (3, 5),
}

OPENING_BOOK_WHITE = {
    (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0): (4, 6),
    (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0): (3, 2),
    (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0): (6, 5),
    (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0): (7, 4),
    (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0): (2, 2),
    (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 1, 0, 2, 0, 0, 0, 0, 2, 0, 1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0): (7, 6),
    (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 2, 0, 0, 0, 2, 0, 1, 0, 0, 0, 0, 0, 2, 0, 0, 1, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 2, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0): (1, 2),
    (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 1, 1, 0, 1, 1, 2, 0, 0, 0, 0, 0, 1, 0, 2, 0, 0, 0, 0, 2, 0, 1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0): (1, 1),
    (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 2, 1, 1, 0, 1, 1, 2, 0, 0, 0, 2, 0, 1, 0, 0, 0, 0, 0, 2, 0, 0, 1, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 2, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0): (1, 6),
    (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 2, 1, 1, 0, 1, 1, 2, 0, 0, 0, 2, 0, 1, 0, 0, 0, 0, 0, 2, 0, 0, 1, 0, 2, 0, 0, 0, 0, 2, 0, 1, 0, 0, 0, 0, 0, 2, 1, 0, 1, 0, 2, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0): (5, 7),
    (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 2, 1, 1, 0, 1, 1, 2, 0, 0, 0, 2, 0, 1, 0, 0, 0, 0, 0, 2, 0, 0, 1, 0, 2, 0, 0, 0, 0, 2, 0, 1, 0, 0, 0, 0, 0, 2, 1, 0, 1, 0, 2, 0, 0, 0, 0, 1, 1, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0): (1, 1),
    (0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 0, 0, 0, 2, 0, 2, 0, 1, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 2, 0, 2, 1, 0, 0, 0, 1, 2, 0, 2, 0, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0): (1, 8),
}

_TRANSFORMS = (
    lambda x, y: (x, y),
    lambda x, y: (8 - y, x),
    lambda x, y: (8 - x, 8 - y),
    lambda x, y: (y, 8 - x),
    lambda x, y: (8 - x, y),
    lambda x, y: (x, 8 - y),
    lambda x, y: (y, x),
    lambda x, y: (8 - y, 8 - x),
)
_INVERSE = (0, 3, 2, 1, 4, 5, 6, 7)


def opening_book_move(board):
    """开局棋谱：来自击败官方 baseline 的实战对局（含 8 种对称）。"""
    cells = board.cells
    stones = sum(1 for v in cells if v != EMPTY)
    if stones > 24:
        return None
    table = OPENING_BOOK_BLACK if board.to_move == BLACK else OPENING_BOOK_WHITE
    if not table:
        return None
    for sym in range(8):
        transform = _TRANSFORMS[sym]
        key = []
        for y in range(9):
            base = y * 9
            for x in range(9):
                tx, ty = transform(x, y)
                key.append(cells[ty * 9 + tx])
        move = table.get(tuple(key))
        if move is not None:
            inv = _TRANSFORMS[_INVERSE[sym]]
            return inv(move[0], move[1])
    return None


_KNIGHT_OFFSETS = ((-1, -2), (1, -2), (-1, 2), (1, 2), (-2, -1), (2, -1), (-2, 1), (2, 1))
_DIAG1_OFFSETS = ((-1, -1), (1, -1), (-1, 1), (1, 1))
_ORTH2_OFFSETS = ((0, -2), (0, 2), (-2, 0), (2, 0))
PATTERN_WEIGHT = 30.0
SHAPE_WEIGHT = 6.0


def _learned_table(name):
    return globals().get(name)


def _phase_of(board):
    stones = sum(1 for v in board.cells if v != EMPTY)
    if stones < 24:
        return 0
    if stones < 60:
        return 1
    return 2


def pattern_score_bonus(board, x, y):
    """分阶段（布局/中盘/收官）的 3x3 棋形偏好。"""
    tables = _learned_table("PATTERN_TABLES")
    if not tables:
        return 0.0
    table = tables.get(_phase_of(board)) or {}
    if not table:
        return 0.0
    cells = board.cells
    me = board.to_move
    values = []
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dx == 0 and dy == 0:
                continue
            nx = x + dx
            ny = y + dy
            if nx < 0 or ny < 0 or nx >= 9 or ny >= 9:
                values.append(3)
            else:
                v = cells[ny * 9 + nx]
                values.append(0 if v == EMPTY else (1 if v == me else 2))
    edge = min(x, y, 8 - x, 8 - y)
    prob = table.get((min(edge, 2), tuple(values)))
    if prob is None:
        return 0.0
    return (prob - 0.5) * PATTERN_WEIGHT


def shape_score_bonus(board, x, y):
    """分阶段的斜日/飞/大飞关系（含斜日走法）。"""
    tables = _learned_table("SHAPE_TABLES")
    means = _learned_table("SHAPE_MEANS") or {}
    if not tables:
        return 0.0
    ph = _phase_of(board)
    table = tables.get(ph) or {}
    mean = means.get(ph) or 0.0
    if not table or mean <= 0:
        return 0.0
    cells = board.cells
    me = board.to_move
    opp = WHITE if me == BLACK else BLACK
    bits = 0
    for offsets, shift in ((_KNIGHT_OFFSETS, 0), (_DIAG1_OFFSETS, 2), (_ORTH2_OFFSETS, 4)):
        own = False
        other = False
        for dx, dy in offsets:
            nx = x + dx
            ny = y + dy
            if 0 <= nx < 9 and 0 <= ny < 9:
                v = cells[ny * 9 + nx]
                if v == me:
                    own = True
                elif v == opp:
                    other = True
        if own:
            bits |= (1 << shift)
        if other:
            bits |= (1 << (shift + 1))
    prob = table.get(str(bits))
    if prob is None:
        return 0.0
    return math.log(prob / mean) * SHAPE_WEIGHT


def katago_book_move(board):
    """KataGo 自对弈开局书（在实战棋谱之后作为补充）。"""
    black_book = _learned_table("KATAGO_BOOK_BLACK") or {}
    white_book = _learned_table("KATAGO_BOOK_WHITE") or {}
    cells = board.cells
    stones = sum(1 for v in cells if v != EMPTY)
    if stones > 28:
        return None
    table = black_book if board.to_move == BLACK else white_book
    if not table:
        return None
    for sym in range(8):
        transform = _TRANSFORMS[sym]
        key = []
        for y in range(9):
            for x in range(9):
                tx, ty = transform(x, y)
                key.append(cells[ty * 9 + tx])
        move = table.get(tuple(key))
        if move is not None:
            inv = _TRANSFORMS[_INVERSE[sym]]
            return inv(move[0], move[1])
    return None


_RECORDS_LOADED = False


def _tables_json_path():
    try:
        here = os.path.dirname(os.path.abspath(__file__))
    except NameError:
        here = os.getcwd()
    for candidate in (
        os.path.join(here, 'tables.json'),
        os.path.join(here, 'data', 'tables.json'),
        os.path.join(os.getcwd(), 'tables.json'),
    ):
        if os.path.exists(candidate):
            return candidate
    return None


def _load_tables_json(path):
    try:
        data = json.load(open(path, encoding='utf-8'))
    except Exception:
        return False

    def cell_tuple(text):
        return tuple(int(v) for v in text.split(','))

    def script_table(src):
        out = {}
        for key, mv in (src or {}).items():
            out[cell_tuple(key)] = mv if mv == 'PASS' else (int(mv[0]), int(mv[1]))
        return out

    def book_table(src):
        return {cell_tuple(k): (int(v[0]), int(v[1])) for k, v in (src or {}).items()}

    pattern = {}
    for ph, table in (data.get('pattern') or {}).items():
        conv = {}
        for key, prob in table.items():
            nums = [int(v) for v in key.split(',')]
            conv[(nums[0], tuple(nums[1:]))] = prob
        pattern[int(ph)] = conv
    shape = {}
    for ph, table in (data.get('shape') or {}).items():
        shape[int(ph)] = {str(k): v for k, v in table.items()}
    means = {int(k): v for k, v in (data.get('means') or {}).items()}

    globals()['SCRIPTS_BLACK'] = script_table(data.get('scripts_black'))
    globals()['SCRIPTS_WHITE'] = script_table(data.get('scripts_white'))
    globals()['KATAGO_BOOK_BLACK'] = book_table(data.get('book_black'))
    globals()['KATAGO_BOOK_WHITE'] = book_table(data.get('book_white'))
    globals()['PATTERN_TABLES'] = pattern
    globals()['SHAPE_TABLES'] = shape
    globals()['SHAPE_MEANS'] = means
    return True


def _records_path():
    try:
        here = os.path.dirname(os.path.abspath(__file__))
    except NameError:
        here = os.getcwd()
    for candidate in (
        os.path.join(here, 'records.json'),
        os.path.join(here, 'data', 'records.json'),
        os.path.join(os.getcwd(), 'records.json'),
    ):
        if os.path.exists(candidate):
            return candidate
    return None


def _pattern_key_from_cells(cells, x, y, me):
    opp = WHITE if me == BLACK else BLACK
    values = []
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dx == 0 and dy == 0:
                continue
            nx = x + dx
            ny = y + dy
            if nx < 0 or ny < 0 or nx >= 9 or ny >= 9:
                values.append(3)
            else:
                v = cells[ny * 9 + nx]
                values.append(0 if v == EMPTY else (1 if v == me else 2))
    edge = min(x, y, 8 - x, 8 - y)
    return (min(edge, 2), tuple(values))


def _shape_bits_from_cells(cells, x, y, me):
    opp = WHITE if me == BLACK else BLACK
    bits = 0
    for offsets, shift in ((_KNIGHT_OFFSETS, 0), (_DIAG1_OFFSETS, 2), (_ORTH2_OFFSETS, 4)):
        own = False
        other = False
        for dx, dy in offsets:
            nx = x + dx
            ny = y + dy
            if 0 <= nx < 9 and 0 <= ny < 9:
                v = cells[ny * 9 + nx]
                if v == me:
                    own = True
                elif v == opp:
                    other = True
        if own:
            bits |= (1 << shift)
        if other:
            bits |= (1 << (shift + 1))
    return bits


def _build_from_records(path):
    """从随包棋谱库（records.json）现场构建开局复刻/棋形表。"""
    try:
        payload = json.load(open(path, encoding='utf-8'))
    except Exception:
        return None
    games = payload.get('games') or []
    scripts = {BLACK: {}, WHITE: {}}
    pattern_total = {0: {}, 1: {}, 2: {}}
    pattern_pos = {0: {}, 1: {}, 2: {}}
    shape_total = {0: {}, 1: {}, 2: {}}
    shape_pos = {0: {}, 1: {}, 2: {}}
    wins = 0
    for game in games:
        winner = game.get('winner')
        student = game.get('student')
        moves = game.get('moves') or []
        if winner is None or winner != student:
            continue
        board = Board(9)
        ok = True
        for entry in moves:
            color = int(entry[0])
            board.to_move = color
            if len(entry) < 3:
                continue
            x, y = int(entry[1]), int(entry[2])
            idx = y * 9 + x
            if not board.is_legal(idx, color):
                ok = False
                break
            if color == winner:
                key = tuple(board.cells)
                scripts[color][key] = (x, y)
                stones = sum(1 for v in board.cells if v != EMPTY)
                ph = 0 if stones < 24 else (1 if stones < 60 else 2)
                for yy in range(9):
                    for xx in range(9):
                        if board.cells[yy * 9 + xx] != EMPTY:
                            continue
                        pk = _pattern_key_from_cells(board.cells, xx, yy, color)
                        sk = _shape_bits_from_cells(board.cells, xx, yy, color)
                        pattern_total[ph][pk] = pattern_total[ph].get(pk, 0) + 1
                        shape_total[ph][sk] = shape_total[ph].get(sk, 0) + 1
                        if xx == x and yy == y:
                            pattern_pos[ph][pk] = pattern_pos[ph].get(pk, 0) + 1
                            shape_pos[ph][sk] = shape_pos[ph].get(sk, 0) + 1
            board.play(idx)
        if ok:
            wins += 1

    pattern_tables = {}
    shape_tables = {}
    means = {}
    for ph in (0, 1, 2):
        out = {}
        for key, cnt in pattern_total[ph].items():
            if cnt < 5:
                continue
            prob = (pattern_pos[ph].get(key, 0) + 0.5) / (cnt + 1.0)
            if abs(prob - 0.5) >= 0.07:
                out[key] = round(prob, 4)
        pattern_tables[ph] = out
        sout = {}
        total_points = sum(shape_total[ph].values())
        positives = sum(shape_pos[ph].values())
        means[ph] = round(positives / total_points, 6) if total_points else 0.0
        for key, cnt in shape_total[ph].items():
            if cnt < 40:
                continue
            sout[str(key)] = round((shape_pos[ph].get(key, 0) + 0.5) / (cnt + 1.0), 5)
        shape_tables[ph] = sout
    return {'scripts': scripts, 'pattern': pattern_tables, 'shape': shape_tables, 'means': means, 'wins': wins}


def _ensure_record_tables():
    global _RECORDS_LOADED
    if _RECORDS_LOADED:
        return
    _RECORDS_LOADED = True
    tables_path = _tables_json_path()
    if tables_path and _load_tables_json(tables_path):
        return
    path = _records_path()
    if not path:
        return
    built = _build_from_records(path)
    if not built:
        return
    globals()['SCRIPTS_BLACK'] = built['scripts'][BLACK]
    globals()['SCRIPTS_WHITE'] = built['scripts'][WHITE]
    globals()['PATTERN_TABLES'] = built['pattern']
    globals()['SHAPE_TABLES'] = built['shape']
    globals()['SHAPE_MEANS'] = built['means']


def scripted_move(board):
    """打榜胜局逐手复刻：局面与赢棋方的局面完全一致时，直接走当时的下一手。"""
    table = None
    if board.to_move == BLACK:
        table = _learned_table("SCRIPTS_BLACK")
    else:
        table = _learned_table("SCRIPTS_WHITE")
    if not table:
        return None
    move = table.get(tuple(board.cells))
    if move is None:
        return None
    return move


def critical_save_move(board, children):
    """防守硬规则：己方有 5 子以上的棋块只剩 1 气时，优先走能救活它的点。
    避免大龙被一手提掉（白棋被吃崩的主要形态）。"""
    me = board.to_move
    groups = []
    seen = set()
    for i in range(board.n):
        if board.cells[i] != me or i in seen:
            continue
        cnt, libs = board.collect(i)
        stones = [board._group[k] for k in range(cnt)]
        seen.update(stones)
        if libs == 1:
            lib_pts = set()
            for s in stones:
                for nb in NEIGHBORS[s]:
                    if board.cells[nb] == EMPTY:
                        lib_pts.add(nb)
            groups.append((stones, lib_pts))
    if not groups:
        return None
    groups.sort(key=lambda item: len(item[0]), reverse=True)
    if len(groups[0][0]) < 5:
        return None

    candidates = set()
    for stones, lib_pts in groups:
        if len(stones) < 5:
            continue
        for mv in lib_pts:
            if not board.is_legal(mv, me):
                continue
            probe = board.clone()
            probe.play(mv)
            cnt, libs = probe.collect(mv)
            if libs >= 2:
                candidates.add(mv)
    if not candidates:
        return None

    child_map = {child.move: child for child in children}
    best = None
    for mv in candidates:
        child = child_map.get(mv)
        if child is None:
            continue
        if best is None or (child.visits, child.wins) > (best[1].visits, best[1].wins):
            best = (mv, child)
    if best is not None:
        return best[0]

    # 搜索里没访问到救棋点时，直接选一个能救活的点
    mv = min(candidates)
    return mv


def choose_move(state, difficulty="medium", seed=None, root_stats=False, max_ms_override=None):
    global _PRIOR_GUIDE, _PRIOR_BONUS
    size = int(state.get("size") or SIZE)
    if size != SIZE:
        raise ValueError(f"只支持 {SIZE} 路棋盘，收到 size={size}")
    komi = float(state.get("komi") if state.get("komi") is not None else KOMI)
    board = Board(size)
    cells = board.cells
    raw_board = state.get("board") or []
    for y in range(size):
        row = raw_board[y] if y < len(raw_board) else []
        base = y * size
        for x in range(size):
            value = row[x] if x < len(row) else None
            if value == "black":
                cells[base + x] = BLACK
            elif value == "white":
                cells[base + x] = WHITE
    board.to_move = WHITE if state.get("currentPlayer") == "white" else BLACK
    ko = state.get("koPoint")
    if ko:
        board.ko = int(ko["y"]) * size + int(ko["x"])
    board.pass_count = int(state.get("passCount") or 0)

    legal = board.legal_moves()
    if not legal:
        return {"move": None, "stats": {"playouts": 0, "elapsedMs": 0, "reason": "no_legal_move"}}

    script_move = scripted_move(board)
    _PRIOR_GUIDE = None
    _PRIOR_BONUS = 0.0
    if isinstance(script_move, tuple):
        _PRIOR_GUIDE = (int(script_move[0]), int(script_move[1]))
        _PRIOR_BONUS = 65.0
    else:
        _kbook = katago_book_move(board)
        if _kbook is not None:
            _PRIOR_GUIDE = (int(_kbook[0]), int(_kbook[1]))
            _PRIOR_BONUS = 45.0
        else:
            _obook = opening_book_move(board)
            if _obook is not None:
                _PRIOR_GUIDE = (int(_obook[0]), int(_obook[1]))
                _PRIOR_BONUS = 35.0
    if False:  # 软棋谱：交给 MCTS 决定
        if script_move == "PASS":
            return {"move": None, "stats": {"playouts": 0, "elapsedMs": 0, "reason": "script_pass"}}
        sx, sy = int(script_move[0]), int(script_move[1])
        if 0 <= sx < size and 0 <= sy < size and board.is_legal(sy * size + sx, board.to_move):
            return {"move": {"x": sx, "y": sy}, "stats": {"playouts": 0, "elapsedMs": 0, "reason": "script"}}

    if should_pass(board, legal, komi):
        return {"move": None, "stats": {"playouts": 0, "elapsedMs": 0, "reason": "endgame_pass"}}

    # 开局棋谱（来自击败 baseline 的实战）；没有匹配则占天元
    book_move = opening_book_move(board)
    if False:  # 软棋谱：交给 MCTS 决定
        bx, by = book_move
        if 0 <= bx < size and 0 <= by < size and board.is_legal(by * size + bx, board.to_move):
            return {"move": {"x": bx, "y": by}, "stats": {"playouts": 0, "elapsedMs": 0, "reason": "book"}}
    kg_move = katago_book_move(board)
    if False:  # 软棋谱：交给 MCTS 决定
        kx, ky = kg_move
        if 0 <= kx < size and 0 <= ky < size and board.is_legal(ky * size + kx, board.to_move):
            return {"move": {"x": kx, "y": ky}, "stats": {"playouts": 0, "elapsedMs": 0, "reason": "katago_book"}}
    if False and all(v == EMPTY for v in board.cells):  # 软开局
        center = size // 2
        return {"move": {"x": center, "y": center}, "stats": {"playouts": 0, "elapsedMs": 0, "reason": "opening"}}

    level = difficulty if difficulty in DIFFICULTY else "medium"
    cfg = DIFFICULTY[level]
    max_ms = cfg["max_ms"] if max_ms_override is None else max_ms_override
    rng = random.Random((seed if seed is not None else 2026) ^ hash_state(board))

    _ensure_record_tables()

    priors = softmax_priors(score_moves(board), legal, size)
    root = Node(None, 0, -1, board)
    work = Board(size)
    started = time.monotonic()
    deadline = started + max_ms / 1000.0
    playouts = 0

    for _ in range(cfg["max_playouts"]):
        if time.monotonic() >= deadline:
            break
        work.load_from(root)
        node = root
        while node.untried is not None and not node.untried:
            if not node.children:
                break
            node = select(node)
            work.load_from(node)

        if node.untried is None:
            moves = work.legal_moves()
            rand = rng.random
            for i in range(len(moves) - 1, 0, -1):
                j = int(rand() * (i + 1))
                moves[i], moves[j] = moves[j], moves[i]
            node.untried = moves

        if node.untried:
            move = node.untried.pop()
            work.load_from(node)
            work.play(move)
            child = Node(node, node.to_move, move, work)
            if node is root and priors is not None:
                child.prior = priors.get(move, 1e-6)
            node.children.append(child)
            node = child

        winner = work.winner(komi) if work.pass_count >= 2 else work.rollout(rng, komi)
        playouts += 1
        cur = node
        while cur is not None:
            cur.visits += 1
            if cur.mover != 0 and cur.mover == winner:
                cur.wins += 1
            cur = cur.parent

    if not root.children:
        return {"move": None, "stats": {"playouts": playouts, "elapsedMs": int((time.monotonic() - started) * 1000)}}

    safe_children = []
    for child in root.children:
        probe = board.clone()
        probe.to_move = board.to_move
        captured = probe.play(child.move)
        cnt, clibs = probe.collect(child.move)
        if captured == 0 and clibs == 1:
            continue
        safe_children.append(child)
    if safe_children:
        root.children = safe_children

    save_move = critical_save_move(board, root.children)
    if save_move is not None:
        return {"move": {"x": save_move % size, "y": save_move // size},
                "stats": {"playouts": playouts, "elapsedMs": int((time.monotonic() - started) * 1000),
                          "reason": "save_group"}}

    children = root.children
    stone_count = sum(1 for v in board.cells if v != EMPTY)
    if stone_count <= 20:
        filtered = []
        for child in children:
            cx = child.move % size
            cy = child.move // size
            if min(cx, cy, size - 1 - cx, size - 1 - cy) == 0:
                probe = board.clone()
                probe.to_move = board.to_move
                captured = probe.play(child.move)
                if captured == 0:
                    continue
            filtered.append(child)
        if filtered:
            children = filtered
    best = max(children, key=lambda c: (c.visits, c.wins))
    x = best.move % size
    y = best.move // size
    legal_set = {(m % size, m // size) for m in legal}
    if (x, y) not in legal_set:
        x, y = legal[0] % size, legal[0] // size
    result = {
        "move": {"x": x, "y": y},
        "stats": {
            "playouts": playouts,
            "elapsedMs": int((time.monotonic() - started) * 1000),
            "visits": best.visits,
            "winRate": round(best.wins / best.visits, 3) if best.visits else None,
            "difficulty": level,
        },
    }
    if root_stats:
        result["root"] = [(child.move, child.visits, child.wins) for child in root.children]
    return result


def _parallel_worker(args):
    state, difficulty, seed, budget_ms = args
    return choose_move(state, difficulty=difficulty, seed=seed, root_stats=True, max_ms_override=budget_ms)


def choose_move_parallel(state, difficulty="medium", seed=None, workers=1, budget_ms=None):
    """根节点并行 MCTS：多个进程独立搜索后合并根节点访问量，墙钟时间不变、模拟量 × workers。"""
    cpu = os.cpu_count() or 1
    workers = max(1, min(int(workers or 1), cpu, 12))
    if workers <= 1:
        return choose_move(state, difficulty=difficulty, seed=seed, max_ms_override=budget_ms)

    try:
        import multiprocessing as mp

        context = mp.get_context("fork")
    except Exception:
        return choose_move(state, difficulty=difficulty, seed=seed, max_ms_override=budget_ms)

    base_seed = 2026 if seed is None else int(seed)
    tasks = [(state, difficulty, (base_seed + i * 7919) & 0xFFFFFFFF, budget_ms) for i in range(workers)]
    try:
        with context.Pool(processes=workers) as pool:
            results = pool.map(_parallel_worker, tasks)
    except Exception:
        return choose_move(state, difficulty=difficulty, seed=seed, max_ms_override=budget_ms)

    merged = {}
    total_visits = 0
    for result in results:
        for move, visits, wins in result.get("root") or []:
            old = merged.get(move, (0, 0.0))
            merged[move] = (old[0] + visits, old[1] + wins)
            total_visits += visits
    if not merged:
        return choose_move(state, difficulty=difficulty, seed=seed, max_ms_override=budget_ms)

    best_move, (best_visits, best_wins) = max(merged.items(), key=lambda item: (item[1][0], item[1][1]))
    size = int(state.get("size") or SIZE)
    return {
        "move": {"x": best_move % size, "y": best_move // size},
        "stats": {
            "playouts": sum((r.get("stats") or {}).get("playouts", 0) for r in results),
            "elapsedMs": max((r.get("stats") or {}).get("elapsedMs", 0) for r in results),
            "visits": best_visits,
            "winRate": round(best_wins / best_visits, 3) if best_visits else None,
            "difficulty": difficulty,
            "workers": workers,
            "totalVisits": total_visits,
        },
    }


def select(node):
    """UCT / PUCT 选择。根节点有先验时按 PUCT 计算。"""
    use_prior = any(child.prior > 0 for child in node.children)
    if use_prior:
        sqrt_parent = math.sqrt(node.visits or 1)
        best = None
        best_score = -1e9
        for child in node.children:
            if child.visits == 0:
                return child
            q = child.wins / child.visits
            u = PUCT_C * child.prior * sqrt_parent / (1 + child.visits)
            s = q + u
            if s > best_score:
                best_score = s
                best = child
        return best
    log_visits = math.log(node.visits or 1)
    best = None
    best_score = -1e9
    for child in node.children:
        if child.visits == 0:
            return child
        s = child.wins / child.visits + UCT_C * math.sqrt(log_visits / child.visits)
        if s > best_score:
            best_score = s
            best = child
    return best


def hash_state(board):
    h = 2166136261 ^ board.to_move
    for i, v in enumerate(board.cells):
        h ^= v + i
        h = (h * 16777619) & 0xFFFFFFFF
    h ^= board.ko + 1
    return h & 0xFFFFFFFF


def selftest():
    board = Board()
    legal = board.legal_moves()
    assert len(legal) == 81, legal
    result = choose_move(
        {
            "board": [[None] * 9 for _ in range(9)],
            "currentPlayer": "black",
            "koPoint": None,
            "passCount": 0,
            "komi": 7.5,
        },
        difficulty="easy",
        seed=7,
    )
    assert result["move"] is not None
    move = result["move"]
    assert 0 <= move["x"] < 9 and 0 <= move["y"] < 9
    # 提子能力：白 (4,4) 只剩 (4,5) 一口气
    rows = [[None] * 9 for _ in range(9)]
    rows[4][4] = "white"
    rows[3][4] = "black"
    rows[5][4] = "black"
    rows[4][3] = "black"
    capture = choose_move(
        {"board": rows, "currentPlayer": "black", "koPoint": None, "passCount": 0, "komi": 7.5},
        difficulty="easy",
        seed=3,
    )
    assert capture["move"] == {"x": 5, "y": 4}, capture
    print(json.dumps({"ok": True, "selftest": "passed", "emptyMove": move}, ensure_ascii=False))


def main():
    argv = sys.argv[1:]
    if "--selftest" in argv:
        selftest()
        return 0
    try:
        raw = sys.stdin.read()
        request = json.loads(raw) if raw.strip() else {}
        state = request.get("state") or request
        result = choose_move(
            state,
            difficulty=request.get("difficulty") or "medium",
            seed=request.get("seed"),
        )
        sys.stdout.write(json.dumps(result, ensure_ascii=False))
        sys.stdout.flush()
        return 0
    except Exception as exc:  # noqa: BLE001
        sys.stdout.write(json.dumps({"error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False))
        sys.stdout.flush()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
