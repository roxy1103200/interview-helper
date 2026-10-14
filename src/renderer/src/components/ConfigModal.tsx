import { useEffect, useState } from 'react';
import type {
  Knowledge,
  PublicSettings,
  Secrets,
  Settings,
  SessionSummary,
} from '../../../shared/contracts';
const api = () => window.interviewApi!;
export function ConfigModal({
  config,
  close,
  saved,
}: {
  config: PublicSettings;
  close: () => void;
  saved: (config: PublicSettings) => void;
}) {
  const [tab, setTab] = useState('audio');
  const [draft, setDraft] = useState<Settings>({ ...config.settings });
  const [keys, setKeys] = useState<Partial<Secrets>>({});
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [entries, setEntries] = useState<Knowledge[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [entry, setEntry] = useState<Knowledge | null>(null);
  const [filter, setFilter] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then((d) => setDevices(d.filter((x) => x.kind === 'audioinput')));
  }, []);
  useEffect(() => {
    if (window.interviewApi) {
      void api()
        .listKnowledge()
        .then(setEntries)
        .catch((e) => setMessage(e.message));
      void api()
        .sessions()
        .then(setSessions)
        .catch((e) => setMessage(e.message));
    }
  }, []);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) close();
    };
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, [busy, close]);
  const field = (key: keyof Settings, value: unknown) => setDraft((s) => ({ ...s, [key]: value }));
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setMessage('');
    try {
      const result = await action();
      if (typeof result === 'string') setMessage(result);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!window.interviewApi) {
      setMessage('请在 Windows 桌面应用中保存设置');
      return;
    }
    await run(async () => {
      saved(await api().saveSettings(draft, keys));
      close();
    });
  }
  const secret = (kind: 'asr' | 'llm') => (
    <label>
      API 密钥
      <input
        type="password"
        autoComplete="off"
        value={keys[kind] ?? ''}
        placeholder={
          (kind === 'asr' ? config.hasAsrKey : config.hasLlmKey)
            ? '已保存 · 留空保持原密钥'
            : '在此填写密钥'
        }
        onChange={(e) => setKeys((s) => ({ ...s, [kind]: e.target.value || undefined }))}
      />
      <span className="field-note">
        {config.encryptionAvailable
          ? '使用 Windows 系统加密保存'
          : '系统加密不可用，密钥仅本次运行有效'}
      </span>
      <button className="text-button" onClick={() => setKeys((s) => ({ ...s, [kind]: '' }))}>
        清除已保存密钥{keys[kind] === '' ? '（待保存）' : ''}
      </button>
    </label>
  );
  return (
    <div
      className="modal-mask"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) close();
      }}
    >
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="modal-head">
          <div>
            <small>WORKSPACE SETTINGS</small>
            <h2 id="settings-title">工作台设置</h2>
          </div>
          <button aria-label="关闭设置" onClick={close} disabled={busy}>
            ×
          </button>
        </header>
        <nav className="tabs">
          {[
            ['audio', '音频与识别'],
            ['llm', 'AI 与简历'],
            ['knowledge', '我的题库'],
            ['display', '显示与记录'],
          ].map(([id, title]) => (
            <button key={id} className={tab === id ? 'selected' : ''} onClick={() => setTab(id)}>
              {title}
            </button>
          ))}
        </nav>
        <div className="modal-content">
          {tab === 'audio' && (
            <>
              <div className="info-box">
                面试者使用本机麦克风；面试官使用 Windows
                系统声音。腾讯会议共享期间的捕获效果，需要按 H01 实测。
              </div>
              <label>
                麦克风
                <select
                  value={draft.micDeviceId}
                  onChange={(e) => field('micDeviceId', e.target.value)}
                >
                  <option value="">系统默认麦克风</option>
                  {devices
                    .filter((d) => d.deviceId && d.deviceId !== 'default')
                    .map((d, i) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || `麦克风 ${i + 1}`}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                百炼 WebSocket 地址
                <input
                  value={draft.asrEndpoint}
                  onChange={(e) => field('asrEndpoint', e.target.value)}
                />
              </label>
              <label>
                实时识别模型
                <input readOnly value={draft.asrModel} />
              </label>
              {secret('asr')}
              <div className="inline">
                <label>
                  语音活动能量阈值
                  <input
                    type="number"
                    min="0.002"
                    max="0.1"
                    step="0.001"
                    value={draft.vadThreshold}
                    onChange={(e) => field('vadThreshold', Number(e.target.value))}
                  />
                </label>
                <button
                  disabled={busy || !window.interviewApi}
                  onClick={() => run(() => api().testProvider('asr', draft, keys.asr))}
                >
                  测试识别连接
                </button>
              </div>
              <p className="field-note">
                地址与密钥须属于同一地域/工作空间。建议使用耳机，避免外放串音。
              </p>
            </>
          )}
          {tab === 'llm' && (
            <>
              <div className="info-box">
                八股题直接使用 DeepSeek 的通用知识，题库用于补充项目和个人背景。
                保存后，下一个问题立即使用新的模型、密钥与背景设置。
              </div>
              <label>
                DeepSeek 请求地址
                <input
                  value={draft.llmEndpoint}
                  onChange={(e) => field('llmEndpoint', e.target.value)}
                />
              </label>
              <label>
                模型名称
                <input value={draft.llmModel} onChange={(e) => field('llmModel', e.target.value)} />
              </label>
              {secret('llm')}
              <button
                disabled={busy || !window.interviewApi}
                onClick={() => run(() => api().testProvider('llm', draft, keys.llm))}
              >
                测试模型连接
              </button>
              <label>
                真实简历与项目背景
                <textarea
                  rows={8}
                  value={draft.resume}
                  placeholder="粘贴你的真实经历、项目职责与已确认的指标。未提供的经历不会作为个人事实生成。"
                  onChange={(e) => field('resume', e.target.value)}
                />
              </label>
            </>
          )}
          {tab === 'knowledge' && (
            <>
              <div className="inline">
                <input
                  aria-label="搜索题库"
                  placeholder="搜索题目或关键词"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
                <button
                  onClick={() =>
                    setEntry({
                      id: crypto.randomUUID(),
                      title: '',
                      keywords: [],
                      answer: '',
                      category: '技术题',
                      enabled: true,
                    })
                  }
                >
                  新建
                </button>
                <button
                  disabled={!window.interviewApi || busy}
                  onClick={() =>
                    run(async () => {
                      const n = await api().importKnowledge();
                      setEntries(await api().listKnowledge());
                      return n === null ? '已取消' : `已导入 ${n} 条`;
                    })
                  }
                >
                  导入
                </button>
                <button
                  disabled={!window.interviewApi || busy}
                  onClick={() =>
                    run(async () => ((await api().exportKnowledge()) ? '题库已导出' : '已取消'))
                  }
                >
                  导出
                </button>
              </div>
              {entry ? (
                <div className="entry-editor">
                  <label>
                    题目
                    <input
                      value={entry.title}
                      onChange={(e) => setEntry({ ...entry, title: e.target.value })}
                    />
                  </label>
                  <label>
                    关键词（用竖线分隔）
                    <input
                      value={entry.keywords.join('|')}
                      onChange={(e) => setEntry({ ...entry, keywords: e.target.value.split('|') })}
                    />
                  </label>
                  <label>
                    完整答案
                    <textarea
                      rows={8}
                      value={entry.answer}
                      onChange={(e) => setEntry({ ...entry, answer: e.target.value })}
                    />
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={entry.enabled}
                      onChange={(e) => setEntry({ ...entry, enabled: e.target.checked })}
                    />
                    启用此条目
                  </label>
                  <div className="inline">
                    <button
                      className="primary"
                      disabled={!window.interviewApi || busy}
                      onClick={() =>
                        run(async () => {
                          await api().saveKnowledge({
                            ...entry,
                            keywords: entry.keywords.map((x) => x.trim()).filter(Boolean),
                          });
                          setEntries(await api().listKnowledge());
                          setEntry(null);
                          return '条目已保存';
                        })
                      }
                    >
                      保存题库条目
                    </button>
                    <button onClick={() => setEntry(null)}>取消编辑</button>
                  </div>
                  <p className="field-note">题库条目单独保存，与底部连接设置保存分开生效。</p>
                </div>
              ) : (
                <div className="knowledge-list">
                  {entries
                    .filter((e) =>
                      (e.title + e.keywords.join(' ')).toLowerCase().includes(filter.toLowerCase()),
                    )
                    .map((e) => (
                      <div className="knowledge-row" key={e.id}>
                        <button onClick={() => setEntry({ ...e, keywords: [...e.keywords] })}>
                          <strong>{e.title}</strong>
                          <small>
                            {e.keywords.join(' · ')}
                            {!e.enabled ? ' · 已停用' : ''}
                          </small>
                        </button>
                        <button
                          className="text-button"
                          disabled={busy}
                          onClick={() =>
                            run(async () => {
                              await api().removeKnowledge(e.id);
                              setEntries(await api().listKnowledge());
                              return '条目已删除';
                            })
                          }
                        >
                          删除
                        </button>
                      </div>
                    ))}
                  {!entries.length && (
                    <p className="quiet">还没有题库。创建第一条，或导入 JSON / 旧版文本题库。</p>
                  )}
                </div>
              )}
            </>
          )}
          {tab === 'display' && (
            <>
              <label>
                回答字号
                <input
                  type="number"
                  min="13"
                  max="24"
                  step="0.5"
                  value={draft.fontSize}
                  onChange={(e) => field('fontSize', Number(e.target.value))}
                />
              </label>
              {[
                ['alwaysOnTop', '窗口置顶'],
                ['contentProtection', '窗口内容保护（需在腾讯会议中实测）'],
                ['recordText', '保存会话文本（不保存原始音频）'],
              ].map(([key, label]) => (
                <label className="check" key={key}>
                  <input
                    type="checkbox"
                    checked={draft[key as keyof Settings] as boolean}
                    onChange={(e) => field(key as keyof Settings, e.target.checked)}
                  />
                  {label}
                </label>
              ))}
              <h3>最近会话</h3>
              <div className="history-list">
                {sessions.map((s) => (
                  <div key={s.id}>
                    <span>
                      {new Date(s.startedAt).toLocaleString('zh-CN')}
                      <small>
                        {s.status === 'active'
                          ? '进行中'
                          : s.status === 'interrupted'
                            ? '异常结束'
                            : '已结束'}
                      </small>
                    </span>
                    <button
                      onClick={() =>
                        run(async () =>
                          (await api().exportSession(s.id)) ? '会话已导出' : '已取消',
                        )
                      }
                    >
                      导出 Markdown
                    </button>
                  </div>
                ))}
                {!sessions.length && <p className="quiet">启用文本记录后，会话将保存在本机。</p>}
              </div>
            </>
          )}
          {message && (
            <p className="form-message" role="status">
              {message}
            </p>
          )}
        </div>
        <footer className="modal-footer">
          <small>音频、模型与记录设置从下次会话生效</small>
          <button onClick={close} disabled={busy}>
            取消
          </button>
          <button className="primary" onClick={save} disabled={busy}>
            {busy ? '处理中…' : '保存设置'}
          </button>
        </footer>
      </section>
    </div>
  );
}
