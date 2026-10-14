import { useEffect, useRef, useState } from 'react';
import {
  defaultSettings,
  type AppEvent,
  type AudioRole,
  type PublicSettings,
} from '../../shared/contracts';
import { DualAudioEngine } from './audio/dualAudioEngine';
import { useSessionStore } from './store/useSessionStore';
import { Pane } from './components/Pane';
import { ConfigModal } from './components/ConfigModal';

export default function App() {
  const state = useSessionStore();
  const [config, setConfig] = useState<PublicSettings>({
    settings: defaultSettings,
    hasAsrKey: false,
    hasLlmKey: false,
    encryptionAvailable: false,
  });
  const [modal, setModal] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [diagnostic, setDiagnostic] = useState(false);
  const [details, setDetails] = useState(false);
  const engine = useRef<DualAudioEngine | null>(null);
  const operation = useRef(0);
  const api = window.interviewApi;
  const running = ['starting', 'listening', 'degraded', 'stopping'].includes(state.status);
  useEffect(() => {
    if (!api) return;
    void api
      .getSettings()
      .then(setConfig)
      .catch((e) => setError(e.message));
    const queue: AppEvent[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = api.subscribe((event) => {
      queue.push(event);
      if (!timer)
        timer = setTimeout(() => {
          queue.splice(0).forEach((e) => useSessionStore.getState().event(e));
          timer = undefined;
        }, 35);
    });
    return () => {
      unsubscribe();
      clearTimeout(timer);
      void engine.current?.stop();
    };
  }, [api]);
  async function stop() {
    operation.current++;
    setBusy(true);
    try {
      await engine.current?.stop();
      await api?.stop();
    } catch (e) {
      setError(e instanceof Error ? e.message : '停止失败');
    } finally {
      setBusy(false);
    }
  }
  async function start(isDiagnostic: boolean) {
    if (!api || busy || running) return;
    if (!isDiagnostic && !config.hasAsrKey) {
      setError('请先在设置中填写百炼语音识别密钥，或使用音频检测。');
      setModal(true);
      return;
    }
    setBusy(true);
    setError('');
    setDiagnostic(isDiagnostic);
    const token = ++operation.current;
    const audio = new DualAudioEngine((role, reason) => api.channelEnded(role, reason));
    engine.current = audio;
    const capture = audio.capture(config.settings.micDeviceId);
    // Observe capture rejection immediately while IPC prepares the session.
    const captured = capture.then(
      () => ({ ok: true as const }),
      (e) => ({ ok: false as const, error: e }),
    );
    try {
      const session = await api.begin(isDiagnostic);
      const result = await captured;
      if (!result.ok) throw result.error;
      if (operation.current !== token) return;
      await api.connect(session.sessionId);
      if (operation.current !== token) return;
      await audio.mount(session.sessionId, (frame) => api.frame(frame));
    } catch (e) {
      await audio.stop();
      await api.stop().catch(() => {});
      setError(e instanceof Error ? e.message : '音频启动失败，请检查 Windows 麦克风权限');
    } finally {
      setBusy(false);
    }
  }
  async function font(delta: number) {
    const next = {
      ...config.settings,
      fontSize: Math.max(13, Math.min(24, config.settings.fontSize + delta)),
    };
    if (api) {
      try {
        setConfig(await api.saveSettings(next, {}));
      } catch (e) {
        setError((e as Error).message);
      }
    } else setConfig({ ...config, settings: next });
  }
  const renderTranscript = (role: AudioRole) => (
    <>
      {state.transcripts[role].map((t) => (
        <article className="turn" key={t.utteranceId}>
          <small>{new Date(t.receivedAt).toLocaleTimeString('zh-CN')}</small>
          <p>{t.text}</p>
        </article>
      ))}
      {state.interim[role] && (
        <article className="turn interim">
          <small>正在转录</small>
          <p>
            {state.interim[role]!.text}
            <i className="cursor" />
          </p>
        </article>
      )}
    </>
  );
  return (
    <div
      className="app"
      style={{ '--answer-size': `${config.settings.fontSize}px` } as React.CSSProperties}
    >
      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark">面</span>
          <div>
            <strong>面试助手</strong>
            <small>INTERVIEW WORKSPACE</small>
          </div>
        </div>
        <div className={'connection ' + state.status}>
          <i />
          {api ? state.message : '界面预览'}
        </div>
        <div className="toolbar">
          <button onClick={() => font(-0.5)} aria-label="缩小字号">
            A−
          </button>
          <button onClick={() => font(0.5)} aria-label="放大字号">
            A＋
          </button>
          <span className="separator" />
          <button
            disabled={!api}
            onClick={async () => {
              try {
                const r = await api!.clear();
                state.clear(r.epoch);
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            清屏
          </button>
          <button onClick={() => setModal(true)}>设置</button>
          <button
            className={running ? 'stop-button' : 'primary'}
            disabled={!api || busy}
            onClick={() => (running ? stop() : start(false))}
          >
            {busy ? '处理中…' : running ? '结束会话' : '开始会话'}
          </button>
        </div>
      </header>
      <div className="session-strip">
        <div>
          <span className="strip-label">当前工作台</span>
          <strong>{diagnostic && running ? '音频检测' : '实时面试'}</strong>
          <span className="strip-divider" />
          <span>腾讯会议 · Windows</span>
        </div>
        <div>
          {config.settings.contentProtection && <span>内容保护已开启</span>}
          <span className="local-badge">本机工作区</span>
        </div>
      </div>
      {(error || state.notice || !api) && (
        <div className="notice" role="status">
          {error ||
            state.notice ||
            '这是浏览器界面预览。双路采集与连接设置请在 Windows 桌面应用中使用。'}
          {error && <button onClick={() => setError('')}>关闭</button>}
        </div>
      )}
      <main className="workspace">
        <div className="transcript-column">
          <Pane
            title="面试者实时文本"
            subtitle={
              state.interim.candidate ? '正在说话' : state.channels.candidate || '本机麦克风'
            }
            accent="candidate"
            revision={[state.transcripts.candidate, state.interim.candidate]}
            empty={!state.transcripts.candidate.length && !state.interim.candidate}
          >
            {renderTranscript('candidate')}
          </Pane>
          <Pane
            title="面试官实时转录"
            subtitle={
              state.interim.interviewer
                ? '正在转录'
                : state.channels.interviewer || '腾讯会议 · 系统声音'
            }
            accent="interviewer"
            revision={[state.transcripts.interviewer, state.interim.interviewer]}
            empty={!state.transcripts.interviewer.length && !state.interim.interviewer}
          >
            {renderTranscript('interviewer')}
          </Pane>
        </div>
        <Pane
          title="AI 参考回答"
          subtitle={
            state.questionDraft
              ? '正在跟踪提问'
              : state.answers.at(-1)?.status === 'generating'
                ? 'DeepSeek 正在回答'
                : '提问后自动回答'
          }
          accent="ai"
          revision={[state.answers, state.questionDraft]}
          empty={!state.answers.length && !state.questionDraft}
          action={
            <button
              disabled={
                !api ||
                !running ||
                diagnostic ||
                busy ||
                (!state.questions.length && !state.questionDraft)
              }
              onClick={async () => {
                try {
                  await api!.answerLatest();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              回答最新问题
            </button>
          }
        >
          {state.answers.map((answer, i) => (
            <article
              className={'answer ' + (i === state.answers.length - 1 ? 'current-answer' : '')}
              key={answer.requestId}
            >
              <div className="answer-meta">
                <span>
                  问题 {i + 1}
                  {answer.revision > 1 ? ` · 修订 ${answer.revision}` : ''}
                </span>
                <span>
                  {answer.status === 'generating'
                    ? '生成中'
                    : answer.status === 'complete'
                      ? '已完成'
                      : answer.status === 'cancelled'
                        ? '已中断'
                        : '暂不可用'}
                </span>
              </div>
              <h3>{answer.question}</h3>
              {answer.reference && answer.source !== 'knowledge' && (
                <details className="reference" open>
                  <summary>本地题库参考</summary>
                  <p>{answer.reference}</p>
                </details>
              )}
              <div className="answer-text">
                {answer.text || (answer.status === 'generating' ? answer.progress + '…' : '')}
                {answer.status === 'generating' && <i className="cursor" />}
              </div>
              {answer.message && <p className="answer-message">{answer.message}</p>}
              <small className="source">
                {answer.source === 'knowledge'
                  ? '本地题库'
                  : answer.source === 'llm'
                    ? 'DeepSeek · 通用知识与已提供背景'
                    : '等待正文'}
              </small>
            </article>
          ))}
          {state.questionDraft && (
            <article className="question-draft" role="status">
              <small>正在跟踪面试官提问 · 稳定后自动回答</small>
              <p>
                {state.questionDraft}
                <i className="cursor" />
              </p>
            </article>
          )}
        </Pane>
      </main>
      <footer className="statusbar">
        <span>
          <i className="tiny-dot" />{' '}
          {running
            ? diagnostic
              ? '仅本地检测，不上传语音'
              : '双音源独立采集'
            : '准备好后，点击开始会话'}
        </span>
        <div>
          <button
            disabled={!api || running || busy}
            onClick={() => {
              setDetails(true);
              void start(true);
            }}
          >
            音频检测
          </button>
          <button onClick={() => setDetails(!details)}>{details ? '收起诊断' : '采集诊断'}</button>
          <span>v0.1.1 · H01 腾讯会议实测待验收</span>
        </div>
      </footer>
      {details && (
        <aside className="diagnostics">
          <header>
            <div>
              <strong>腾讯会议采集诊断</strong>
              <small>在真实共享时观察面试官声道，音量随远端发言变化；音频检测模式不做转录。</small>
            </div>
            <button
              disabled={!api}
              onClick={async () => {
                try {
                  await api!.exportDiagnostics();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              导出诊断记录
            </button>
            <button disabled={!running} onClick={() => engine.current?.pauseMicrophone()}>
              暂停本机麦克风做对照
            </button>
          </header>
          <div className="meters">
            {(['candidate', 'interviewer'] as const).map((role) => (
              <div key={role}>
                <span>{role === 'candidate' ? '面试者 · 麦克风' : '面试官 · 系统回环'}</span>
                <meter min={0} max={0.15} value={state.stats[role]?.rms ?? 0} />
                <small>
                  帧数 {state.stats[role]?.frames ?? 0} · RMS{' '}
                  {(state.stats[role]?.rms ?? 0).toFixed(4)} ·{' '}
                  {state.stats[role]?.speaking ? '有声活动' : '静音/等待'}
                </small>
              </div>
            ))}
          </div>
        </aside>
      )}
      {modal && <ConfigModal config={config} close={() => setModal(false)} saved={setConfig} />}
    </div>
  );
}
