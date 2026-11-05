import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from './api';
import AnalysisPanel from './components/AnalysisPanel';
import BootScreen from './components/BootScreen';
import Controls from './components/Controls';
import GameHistory from './components/GameHistory';
import GameStatus from './components/GameStatus';
import GoBoard from './components/GoBoard';
import ModeBar from './components/ModeBar';
import MoveList from './components/MoveList';
import ResultBanner from './components/ResultBanner';
import Toast from './components/Toast';
import './App.css';

const GAMES_LIMIT = 20;
const MAX_AI_CHAIN = 3;
const PROVIDER_STORAGE_KEY = 'go9.aiProvider';
const DEFAULT_PROVIDER = 'heuristic';
const EMPTY_AGENTS = [];

// 后端未提供 /api/agents 时的兜底名称，保证状态栏始终能显示所用 AI。
const AGENT_LABELS = {
  heuristic: '内置 AI',
  http: '外部 API（OpenAI 兼容）',
  katago: 'KataGo',
};

function readStoredProvider() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return DEFAULT_PROVIDER;
    return window.localStorage.getItem(PROVIDER_STORAGE_KEY) || DEFAULT_PROVIDER;
  } catch {
    return DEFAULT_PROVIDER;
  }
}

function persistProvider(providerId) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(PROVIDER_STORAGE_KEY, providerId);
  } catch {
    // localStorage 不可用（如隐私模式）时静默降级，不影响对局。
  }
}

function isAgentAvailable(agent) {
  return Boolean(agent) && agent.available !== false;
}

/** 从 /api/agents 结果中挑一个可用的 provider：本地记忆 > 服务端默认 > 第一个可用项。 */
function resolveProvider(payload, storedProvider) {
  const list = payload && Array.isArray(payload.agents) ? payload.agents : [];
  const isAvailable = (id) =>
    list.some((agent) => agent && agent.id === id && isAgentAvailable(agent));

  if (storedProvider && isAvailable(storedProvider)) return storedProvider;
  if (payload && payload.default && isAvailable(payload.default)) return payload.default;
  const first = list.find((agent) => agent && isAgentAvailable(agent));
  if (first) return first.id;
  return storedProvider || DEFAULT_PROVIDER;
}

function agentLabel(providerId, agentList) {
  if (!providerId) return AGENT_LABELS[DEFAULT_PROVIDER];
  const match = agentList.find((agent) => agent && agent.id === providerId);
  if (match && match.label) return match.label;
  return AGENT_LABELS[providerId] || providerId;
}

export default function App() {
  const [gameId, setGameId] = useState(null);
  const [state, setState] = useState(null);
  const [mode, setMode] = useState('ai');
  const [difficulty, setDifficulty] = useState('medium');
  const [agents, setAgents] = useState(null);
  const [provider, setProvider] = useState(readStoredProvider);
  const [games, setGames] = useState([]);
  const [analysis, setAnalysis] = useState(null);
  const [analysisError, setAnalysisError] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [loadingGames, setLoadingGames] = useState(false);
  const [toast, setToast] = useState(null);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState(null);
  const [dbOk, setDbOk] = useState(null);

  const busyRef = useRef(false);
  const analyzingRef = useRef(false);
  const toastIdRef = useRef(0);
  const bootStartedRef = useRef(false);
  const fallbackNotifiedRef = useRef(new Set());
  const autoAnalyzedRef = useRef(new Set());

  const showToast = useCallback((message, type = 'info') => {
    toastIdRef.current += 1;
    setToast({ id: toastIdRef.current, type, message });
  }, []);

  const showError = useCallback(
    (error) => {
      showToast(api.describeError(error), 'error');
    },
    [showToast],
  );

  const closeToast = useCallback(() => setToast(null), []);

  const agentList = agents && Array.isArray(agents.agents) ? agents.agents : EMPTY_AGENTS;
  const providersAvailable = agentList.length > 0;

  /** 串行化请求：同一时刻只允许一个棋局操作，避免重复落子。 */
  const run = useCallback(
    async (task) => {
      if (busyRef.current) return false;
      busyRef.current = true;
      setBusy(true);
      try {
        await task();
        return true;
      } catch (error) {
        showError(error);
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [showError],
  );

  const refreshGames = useCallback(
    async ({ showLoading = false, showErrors = false } = {}) => {
      if (showLoading) setLoadingGames(true);
      try {
        const payload = await api.listGames(GAMES_LIMIT);
        setGames(payload.games || []);
      } catch (error) {
        if (showErrors) showError(error);
      } finally {
        if (showLoading) setLoadingGames(false);
      }
    },
    [showError],
  );

  const resetAnalysis = useCallback(() => {
    setAnalysis(null);
    setAnalysisError(null);
  }, []);

  /** ai-move 返回 fallback 时只提示一次（按 provider + 原因去重，避免自动应手刷屏）。 */
  const noteFallback = useCallback(
    (fallback) => {
      if (!fallback || typeof fallback !== 'object') return;
      const from = fallback.from || 'external';
      const reason = fallback.reason || '原因未知';
      const key = `${from}::${reason}`;
      if (fallbackNotifiedRef.current.has(key)) return;
      fallbackNotifiedRef.current.add(key);
      showToast(
        `外部 AI（${agentLabel(from, agentList)}）不可用，已回退内置 AI（${reason}）`,
        'warn',
      );
    },
    [agentList, showToast],
  );

  /** 应用新状态；人机模式下若轮到白方（AI），自动应手直到轮回玩家。 */
  const applyStateAndAutoRespond = useCallback(
    async (next, activeMode = mode) => {
      setState(next);
      if (next && next.winner) refreshGames();

      if (!next || activeMode !== 'ai') return;

      let current = next;
      try {
        for (let i = 0; i < MAX_AI_CHAIN; i += 1) {
          if (current.winner || current.currentPlayer !== 'white') break;
          setThinking(true);
          const payload = await api.aiMove(gameId, difficulty, provider);
          noteFallback(payload.fallback);
          current = payload.state;
          setState(current);
        }
      } finally {
        setThinking(false);
      }
      // 刷新历史列表中的手数/更新时间，避免进行中的对局一直显示 0 手。
      refreshGames();
    },
    [mode, gameId, difficulty, provider, refreshGames, noteFallback],
  );

  const boot = useCallback(async () => {
    setBooting(true);
    setBootError(null);
    try {
      // agents 与 games 并行拉取；/api/agents 失败（旧后端）不阻塞对局。
      const [gamesResult, agentsResult] = await Promise.allSettled([
        api.listGames(GAMES_LIMIT),
        api.listAgents(),
      ]);
      if (gamesResult.status !== 'fulfilled') throw gamesResult.reason;

      const recent = gamesResult.value.games || [];
      setGames(recent);

      const agentsPayload = agentsResult.status === 'fulfilled' ? agentsResult.value : null;
      const agentsFromApi =
        agentsPayload && Array.isArray(agentsPayload.agents) ? agentsPayload.agents : [];
      let activeProvider = readStoredProvider();
      if (agentsFromApi.length > 0) {
        setAgents(agentsPayload);
        activeProvider = resolveProvider(agentsPayload, activeProvider);
        setProvider(activeProvider);
        persistProvider(activeProvider);
      } else {
        // 旧接口没有 /api/agents：隐藏 provider 选择，固定使用内置 AI。
        setAgents(null);
        activeProvider = DEFAULT_PROVIDER;
        setProvider(activeProvider);
      }

      let nextId = null;
      let nextState = null;
      let nextAnalysis = null;
      if (recent.length > 0) {
        try {
          const loaded = await api.getGame(recent[0].id);
          nextId = loaded.id;
          nextState = loaded.state;
          nextAnalysis = loaded.analysis || null;
        } catch {
          // 历史对局读取失败时退回新建对局。
          nextState = null;
        }
      }
      if (!nextState) {
        const created = await api.createGame('black', activeProvider);
        nextId = created.id;
        nextState = created.state;
        refreshGames();
      }
      setGameId(nextId);
      setState(nextState);
      setAnalysis(nextAnalysis);
      setAnalysisError(null);
    } catch (error) {
      setBootError(api.describeError(error));
    } finally {
      setBooting(false);
    }

    // 健康检查只用于展示持久化状态，失败不影响对局。
    api
      .health()
      .then((payload) => setDbOk(payload.db !== false))
      .catch(() => setDbOk(null));
  }, [refreshGames]);

  useEffect(() => {
    if (bootStartedRef.current) return;
    bootStartedRef.current = true;
    boot();
  }, [boot]);

  const playAt = async (x, y) => {
    if (!gameId || !state || state.winner) return;
    if (mode === 'ai' && state.currentPlayer !== 'black') return;
    await run(async () => {
      const payload = await api.move(gameId, x, y);
      resetAnalysis();
      await applyStateAndAutoRespond(payload.state);
    });
  };

  const handlePass = async () => {
    if (!gameId || !state || state.winner) return;
    if (mode === 'ai' && state.currentPlayer !== 'black') return;
    await run(async () => {
      const payload = await api.pass(gameId);
      resetAnalysis();
      await applyStateAndAutoRespond(payload.state);
    });
  };

  const handleUndo = async () => {
    if (!gameId || !state) return;
    const played = state.moveCount ?? state.moves.length;
    if (played === 0) return;
    // 人机模式一次回退 2 手（不足 2 手时回退 1 手）。
    const steps = mode === 'ai' ? Math.min(2, played) : 1;
    await run(async () => {
      const payload = await api.undo(gameId, steps);
      setState(payload.state);
      resetAnalysis();
      refreshGames();
      showToast(`已回退 ${steps} 手。`, 'success');
    });
  };

  const handleResign = async () => {
    if (!gameId || !state || state.winner) return;
    const player = mode === 'ai' ? 'black' : undefined;
    await run(async () => {
      const payload = await api.resign(gameId, player);
      setState(payload.state);
      resetAnalysis();
      refreshGames();
    });
  };

  const handleAiStep = async () => {
    if (!gameId || !state || state.winner) return;
    await run(async () => {
      setThinking(true);
      try {
        const payload = await api.aiMove(gameId, difficulty, provider);
        noteFallback(payload.fallback);
        resetAnalysis();
        await applyStateAndAutoRespond(payload.state);
      } finally {
        setThinking(false);
      }
    });
  };

  const handleNewGame = async () => {
    await run(async () => {
      const payload = await api.createGame('black', provider);
      setGameId(payload.id);
      setState(payload.state);
      resetAnalysis();
      setToast(null);
      refreshGames();
      showToast('已开始新对局。', 'success');
    });
  };

  const handleAnalyze = useCallback(async () => {
    if (!gameId || analyzingRef.current || busyRef.current) return;
    analyzingRef.current = true;
    setAnalyzing(true);
    setAnalysisError(null);
    try {
      const payload = await api.analyze(gameId);
      if (payload.analysis) {
        setAnalysis(payload.analysis);
      } else {
        setAnalysis(null);
        setAnalysisError('服务器没有返回分析结果。');
      }
    } catch (error) {
      setAnalysis(null);
      setAnalysisError(api.describeError(error));
    } finally {
      analyzingRef.current = false;
      setAnalyzing(false);
    }
  }, [gameId]);

  // 终局后自动生成一次复盘报告，让玩家落子结束即可看到缺点与改进建议。
  // 手动复盘过或正在复盘时不再重复触发；同一局按 winner+moveCount 去重。
  useEffect(() => {
    if (!gameId || !state?.winner || analysis || analyzing || busy || thinking) return;
    const key = `${gameId}:${state.moveCount ?? 0}`;
    if (autoAnalyzedRef.current.has(key)) return;
    autoAnalyzedRef.current.add(key);
    handleAnalyze();
  }, [gameId, state?.winner, state?.moveCount, analysis, analyzing, busy, thinking, handleAnalyze]);

  const handleSelectGame = async (id) => {
    if (!id || id === gameId) return;
    await run(async () => {
      const payload = await api.getGame(id);
      setGameId(payload.id);
      setState(payload.state);
      setAnalysis(payload.analysis || null);
      setAnalysisError(null);
      setToast(null);
    });
  };

  const handleModeChange = async (nextMode) => {
    if (nextMode === mode || busyRef.current) return;
    setMode(nextMode);
    if (
      nextMode === 'ai' &&
      state &&
      !state.winner &&
      state.currentPlayer === 'white'
    ) {
      await run(async () => {
        await applyStateAndAutoRespond(state, nextMode);
      });
    }
  };

  const handleProviderChange = (nextProvider) => {
    if (!nextProvider || nextProvider === provider) return;
    setProvider(nextProvider);
    persistProvider(nextProvider);
  };

  const handleRefreshGames = () => {
    refreshGames({ showLoading: true, showErrors: true });
  };

  const retryBoot = () => {
    bootStartedRef.current = true;
    boot();
  };

  if (booting || !state) {
    const error = bootError || (booting ? null : '未能获取对局状态，请重试。');
    return <BootScreen loading={!error} error={error} onRetry={retryBoot} />;
  }

  const gameOver = Boolean(state.winner);
  const locked = busy || thinking || analyzing;
  const myTurn = mode === 'pvp' || state.currentPlayer === 'black';
  const canAiStep = mode === 'pvp' || state.currentPlayer === 'white';
  const moveCount = state.moveCount ?? state.moves.length;
  const exportHref = gameId ? api.exportUrl(gameId) : null;
  // 状态栏展示“当前选择的 AI”：切换来源后下一次 AI 应手立即生效。
  // 服务端 state.aiProvider 记录的是上一手实际使用的 provider，可能滞后。
  const gameProviderLabel = agentLabel(provider, agentList);

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">
            九
          </span>
          <div className="brand__text">
            <h1 className="brand__title">九路围棋</h1>
            <p className="brand__subtitle">SVG 棋盘 · 人机对弈 · 复盘分析</p>
          </div>
        </div>
        <div className="app-header__meta">
          {dbOk === false ? (
            <span className="chip chip--warn">持久化降级</span>
          ) : null}
          {dbOk === true ? <span className="chip chip--ok">服务已连接</span> : null}
          {providersAvailable ? null : (
            <span className="chip" title="后端未提供 /api/agents，使用内置 AI">
              AI：内置 AI
            </span>
          )}
          <ModeBar
            mode={mode}
            difficulty={difficulty}
            provider={provider}
            agents={agentList}
            providersAvailable={providersAvailable}
            disabled={locked}
            onModeChange={handleModeChange}
            onDifficultyChange={setDifficulty}
            onProviderChange={handleProviderChange}
          />
        </div>
      </header>

      <main className="layout">
        <section className="board-column">
          <ResultBanner state={state} />
          <div className="board-card">
            <GoBoard
              state={state}
              disabled={locked || gameOver || !myTurn}
              onPlay={playAt}
            />
          </div>
          <GameStatus
            state={state}
            mode={mode}
            thinking={thinking}
            providerLabel={gameProviderLabel}
          />
          <Controls
            mode={mode}
            locked={locked}
            gameOver={gameOver}
            myTurn={myTurn}
            canAiStep={canAiStep}
            canUndo={moveCount > 0}
            canAnalyze={moveCount > 0}
            analyzing={analyzing}
            exportHref={exportHref}
            onPass={handlePass}
            onUndo={handleUndo}
            onResign={handleResign}
            onAiMove={handleAiStep}
            onNewGame={handleNewGame}
            onAnalyze={handleAnalyze}
          />
        </section>

        <aside className="sidebar">
          <MoveList moves={state.moves} />
          <AnalysisPanel
            analysis={analysis}
            analyzing={analyzing}
            error={analysisError}
            canAnalyze={moveCount > 0}
            onAnalyze={handleAnalyze}
          />
          <GameHistory
            games={games}
            activeId={gameId}
            loading={loadingGames}
            disabled={locked}
            onSelect={handleSelectGame}
            onRefresh={handleRefreshGames}
          />
        </aside>
      </main>

      <Toast toast={toast} onClose={closeToast} />
    </div>
  );
}
