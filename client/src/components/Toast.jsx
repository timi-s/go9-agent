import { useEffect } from 'react';

const TOAST_DURATION = 6000;

/** 全局提示（错误/成功/信息），自动消失，可手动关闭。 */
export default function Toast({ toast, onClose }) {
  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(onClose, TOAST_DURATION);
    return () => window.clearTimeout(timer);
  }, [toast, onClose]);

  if (!toast) return null;

  return (
    <div className={`toast toast--${toast.type}`} role="alert">
      <span className="toast__dot" aria-hidden="true" />
      <p className="toast__message">{toast.message}</p>
      <button
        type="button"
        className="toast__close"
        onClick={onClose}
        aria-label="关闭提示"
      >
        ×
      </button>
    </div>
  );
}
