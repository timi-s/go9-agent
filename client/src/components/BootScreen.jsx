/** 首屏加载 / 连接失败的可重试界面。 */
export default function BootScreen({ loading, error, onRetry }) {
  if (!loading && !error) return null;

  return (
    <div className="boot">
      <div className="boot__card">
        <span className="brand__mark boot__mark" aria-hidden="true">
          九
        </span>
        <h1 className="boot__title">九路围棋</h1>
        {error ? (
          <>
            <p className="boot__error">{error}</p>
            <button type="button" className="btn btn--primary" onClick={onRetry}>
              重试连接
            </button>
          </>
        ) : (
          <>
            <span className="spinner" aria-hidden="true" />
            <p className="boot__hint">正在连接服务器…</p>
          </>
        )}
      </div>
    </div>
  );
}
