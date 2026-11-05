import { useEffect, useRef } from 'react';
import { intersectionLabel } from '../board';
import { playerName } from '../format';

/** 手数列表：可滚动、最后一手高亮、PASS 与提子有标记。 */
export default function MoveList({ moves }) {
  const listRef = useRef(null);
  const lastIndex = moves.length - 1;

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [moves.length]);

  return (
    <section className="panel">
      <div className="panel__head">
        <h2 className="panel__title">手数</h2>
        <span className="badge">{moves.length} 手</span>
      </div>
      <ol className="moves" ref={listRef}>
        {moves.length === 0 ? (
          <li className="moves__empty">还没有落子，点击棋盘开始对局。</li>
        ) : (
          moves.map((item, index) => (
            <li
              key={`move-${index}`}
              className={`move${index === lastIndex ? ' move--last' : ''}`}
            >
              <span className="move__index">{index + 1}</span>
              <span
                className={`stone-dot stone-dot--${item.player}`}
                aria-hidden="true"
              />
              <span className={`move__coord${item.pass ? ' move__coord--pass' : ''}`}>
                {item.pass ? 'PASS' : intersectionLabel(item.x, item.y)}
              </span>
              <span className="move__captured">
                {item.captured > 0 ? `提 ${item.captured}` : ''}
              </span>
              <span className="move__player">{playerName(item.player)}</span>
            </li>
          ))
        )}
      </ol>
    </section>
  );
}
