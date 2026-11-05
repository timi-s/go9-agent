const MODES = [
  { value: 'ai', label: '人机对战' },
  { value: 'pvp', label: '双人对弈' },
];

const DIFFICULTIES = [
  { value: 'easy', label: '简单' },
  { value: 'medium', label: '普通' },
  { value: 'hard', label: '困难' },
];

function agentTitle(agent) {
  if (!agent) return '';
  const requires = Array.isArray(agent.requires) ? agent.requires : [];
  if (requires.length > 0) return `需要环境变量：${requires.join('、')}`;
  return agent.description || '';
}

/** 模式切换、AI 难度与 AI 来源（provider）选择。 */
export default function ModeBar({
  mode,
  difficulty,
  provider,
  agents,
  providersAvailable,
  disabled,
  onModeChange,
  onDifficultyChange,
  onProviderChange,
}) {
  const aiMode = mode === 'ai';
  const providerList = Array.isArray(agents) ? agents : [];
  const activeAgent = providerList.find((agent) => agent && agent.id === provider);

  return (
    <div className="mode-bar">
      <div className="seg" role="group" aria-label="对局模式">
        {MODES.map((item) => (
          <button
            key={item.value}
            type="button"
            className={`seg__btn${mode === item.value ? ' seg__btn--active' : ''}`}
            aria-pressed={mode === item.value}
            disabled={disabled}
            onClick={() => onModeChange(item.value)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {providersAvailable ? (
        <label
          className={`field${aiMode ? '' : ' field--muted'}`}
          title={agentTitle(activeAgent)}
        >
          <span className="field__label">AI 来源</span>
          <select
            className="field__select"
            value={provider}
            disabled={disabled || !aiMode}
            onChange={(event) => onProviderChange(event.target.value)}
          >
            {providerList.map((agent) => {
              const available = agent.available !== false;
              return (
                <option
                  key={agent.id}
                  value={agent.id}
                  disabled={!available}
                  title={agentTitle(agent)}
                >
                  {agent.label || agent.id}
                  {available ? '' : '（未配置）'}
                </option>
              );
            })}
          </select>
        </label>
      ) : null}

      <label className={`field${aiMode ? '' : ' field--muted'}`}>
        <span className="field__label">AI 难度</span>
        <select
          className="field__select"
          value={difficulty}
          disabled={disabled || !aiMode}
          onChange={(event) => onDifficultyChange(event.target.value)}
        >
          {DIFFICULTIES.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
