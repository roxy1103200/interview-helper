import { useEffect, useRef, useState, type ReactNode } from 'react';
export function Pane({
  title,
  subtitle,
  accent,
  children,
  revision,
  empty,
  action,
}: {
  title: string;
  subtitle: string;
  accent: string;
  children: ReactNode;
  revision: unknown;
  empty: boolean;
  action?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (el && following.current) el.scrollTop = el.scrollHeight;
  }, [revision]);
  return (
    <section className={'pane ' + accent}>
      <header className="pane-header">
        <div>
          <i className="dot" />
          <h2>{title}</h2>
        </div>
        <div className="pane-tools">
          <span>{subtitle}</span>
          {action}
        </div>
      </header>
      <div
        className="stream"
        ref={ref}
        onScroll={() => {
          const el = ref.current!;
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 80;
          setShowLatest(!following.current);
        }}
      >
        {empty ? (
          <div className="empty">
            <div className="empty-lines">
              <span />
              <span />
              <span />
            </div>
            <p>
              {title === 'AI 参考回答'
                ? '问题出现后，在这里阅读回答'
                : '开始会话后，文字将实时显示'}
            </p>
            <small>
              {title === 'AI 参考回答'
                ? '八股题直接由 AI 回答，题库补充项目背景'
                : '当前没有转录记录'}
            </small>
          </div>
        ) : (
          children
        )}
      </div>
      {showLatest && (
        <button
          className="latest"
          onClick={() => {
            following.current = true;
            ref.current!.scrollTop = ref.current!.scrollHeight;
            setShowLatest(false);
          }}
        >
          回到最新 ↓
        </button>
      )}
    </section>
  );
}
