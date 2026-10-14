import { randomUUID } from 'node:crypto';
import type {
  AppEvent,
  AudioRole,
  AudioStats,
  Frame,
  Match,
  Question,
  Reply,
  Settings,
  Secrets,
  Transcript,
} from '../shared/contracts';
import { Database } from './storage/database';
import { SettingsStore } from './storage/settings';
import { ParaformerAdapter } from './asr/paraformerAdapter';
import { QuestionCoordinator } from './questionCoordinator';
import { ReplyCoordinator } from './llm/replyCoordinator';

export class SessionController {
  id: string | null = null;
  epoch = 0;
  private startedAt = 0;
  private diagnostic = false;
  private settings!: Settings;
  private secrets: Secrets = { asr: '', llm: '' };
  private clients: Partial<Record<AudioRole, ParaformerAdapter>> = {};
  private connected = { candidate: false, interviewer: false };
  private ended = { candidate: false, interviewer: false };
  private stats: Partial<Record<AudioRole, AudioStats & { sequence: number }>> = {};
  private questions?: QuestionCoordinator;
  private replies: ReplyCoordinator;
  private candidateText: string[] = [];
  private finals = new Set<string>();
  private cutoff = -1;
  private monitor?: ReturnType<typeof setInterval>;
  private lastAudioEmit = 0;
  private lastStatus = '';
  private replyTexts = new Map<string, { event: Reply; text: string; lastSaved: number }>();
  private diagnostics: unknown[] = [];
  private connecting = false;
  private stopping?: Promise<void>;
  constructor(
    private readonly db: Database,
    private readonly config: SettingsStore,
    private readonly emit: (event: AppEvent) => void,
  ) {
    this.replies = new ReplyCoordinator(
      (text) => this.db.call<Match[]>('search', text),
      (event) => this.reply(event),
    );
  }
  private status(
    status: 'starting' | 'listening' | 'degraded' | 'stopping' | 'stopped' | 'error',
    message: string,
  ) {
    if (this.lastStatus === status + message) return;
    this.lastStatus = status + message;
    this.emit({ type: 'status', status, message, sessionId: this.id, epoch: this.epoch });
    this.log({ type: 'status', status, message });
  }
  private log(record: object) {
    this.diagnostics.push({ at: Date.now(), ...record });
    if (this.diagnostics.length > 12000) this.diagnostics.shift();
  }
  async begin(diagnostic: boolean) {
    if (this.id || this.stopping) throw new Error('已有会话运行，请先停止');
    this.settings = this.config.public().settings;
    this.secrets = { asr: this.config.key('asr'), llm: this.config.key('llm') };
    if (!diagnostic && !this.secrets.asr)
      throw new Error('请先在设置中填写百炼语音识别密钥，或使用音频检测');
    this.id = randomUUID();
    this.epoch++;
    this.startedAt = Date.now();
    this.diagnostic = diagnostic;
    this.stats = {};
    this.connected = { candidate: false, interviewer: false };
    this.ended = { candidate: false, interviewer: false };
    this.finals.clear();
    this.candidateText = [];
    this.replyTexts.clear();
    this.cutoff = -1;
    this.diagnostics = [];
    this.replies.history.length = 0;
    this.questions = new QuestionCoordinator(
      this.id,
      (question) => this.question(question),
      (text) => {
        if (this.id)
          this.emit({ type: 'question-draft', sessionId: this.id, epoch: this.epoch, text });
      },
    );
    this.status('starting', diagnostic ? '正在启动音频检测' : '正在连接双路识别');
    if (this.settings.recordText) await this.db.call('start', this.id, this.settings);
    return { sessionId: this.id, epoch: this.epoch };
  }
  async connect(id: string) {
    if (id !== this.id || this.connecting) throw new Error('会话已失效或正在连接');
    this.connecting = true;
    try {
      if (!this.diagnostic) {
        await Promise.all(
          (['candidate', 'interviewer'] as const).map((role) => {
            const client = new ParaformerAdapter(
              id,
              role,
              this.settings,
              this.secrets.asr,
              () => Date.now() - this.startedAt,
              (text) => this.transcript(text),
              (ready, message) => {
                if (this.id !== id) return;
                this.connected[role] = ready;
                this.emit({ type: 'channel', role, connected: ready, message });
                this.log({ type: 'channel', role, ready, message });
                this.refresh();
                if (role === 'interviewer' && !ready)
                  this.questions?.clear(Date.now() - this.startedAt);
              },
            );
            this.clients[role] = client;
            return client.connect();
          }),
        );
      }
      if (this.id !== id) throw new Error('会话已停止');
      this.monitor = setInterval(() => {
        this.refresh();
      }, 1000);
    } catch (e) {
      await this.stop();
      throw e;
    } finally {
      this.connecting = false;
    }
  }
  frame(frame: Frame) {
    if (frame.sessionId !== this.id || this.ended[frame.role]) return;
    const prev = this.stats[frame.role];
    if (prev && frame.sequence <= prev.sequence) return;
    const data = new DataView(frame.pcm.buffer, frame.pcm.byteOffset, frame.pcm.byteLength);
    let power = 0,
      peak = 0,
      activeWindows = 0;
    for (let block = 0; block < 5; block++) {
      let blockPower = 0;
      for (let i = block * 320; i < (block + 1) * 320; i++) {
        const value = data.getInt16(i * 2, true) / 32768;
        blockPower += value * value;
        peak = Math.max(peak, Math.abs(value));
      }
      power += blockPower;
      if (Math.sqrt(blockPower / 320) > this.settings.vadThreshold) activeWindows++;
    }
    const rms = Math.sqrt(power / 1600);
    const speaking = activeWindows >= 2;
    const stats = {
      role: frame.role,
      frames: (prev?.frames ?? 0) + 1,
      rms,
      peak,
      speaking,
      lastFrameAt: Date.now(),
      sequence: frame.sequence,
    };
    this.stats[frame.role] = stats;
    if (speaking) this.questions?.voice(frame.role);
    this.clients[frame.role]?.send(frame.pcm);
    if (Date.now() - this.lastAudioEmit > 250) {
      this.lastAudioEmit = Date.now();
      for (const stat of Object.values(this.stats)) {
        this.emit({ type: 'audio', data: stat });
      }
    }
    if (stats.frames % 10 === 0)
      this.log({
        type: 'audio',
        role: frame.role,
        frames: stats.frames,
        rms,
        peak,
        sequence: frame.sequence,
      });
  }
  channelEnded(role: AudioRole, message: string) {
    this.ended[role] = true;
    this.connected[role] = false;
    this.clients[role]?.stop();
    this.emit({ type: 'channel', role, connected: false, message });
    this.log({ type: 'capture-ended', role, message });
    if (role === 'interviewer') {
      this.questions?.clear(Date.now() - this.startedAt);
      this.replies.cancel();
    }
    this.refresh();
  }
  private refresh() {
    if (!this.id) return;
    const alive = (role: AudioRole) =>
      !this.ended[role] && !!this.stats[role] && Date.now() - this.stats[role]!.lastFrameAt < 2500;
    const microphone = alive('candidate') && (this.diagnostic || this.connected.candidate);
    const system = alive('interviewer') && (this.diagnostic || this.connected.interviewer);
    if (microphone && system)
      this.status('listening', this.diagnostic ? '音频检测中 · 不会上传语音' : '双路监听中');
    else if (
      Date.now() - this.startedAt < 15000 &&
      !this.ended.candidate &&
      !this.ended.interviewer
    )
      this.status('starting', '等待音轨与识别就绪');
    else
      this.status(
        'degraded',
        !system ? '面试官声道不可用 · 自动回答暂停' : '面试者声道不可用 · 面试官转录继续',
      );
  }
  private transcript(text: Transcript) {
    if (text.sessionId !== this.id || text.audioStartMs < this.cutoff) return;
    if (this.finals.has(text.utteranceId)) return;
    this.emit({ type: 'transcript', data: text });
    if (text.isFinal) {
      this.finals.add(text.utteranceId);
      if (this.finals.size > 10000) this.finals.delete(this.finals.values().next().value!);
      if (text.role === 'candidate') {
        this.candidateText.push(text.text);
        if (this.candidateText.length > 20) this.candidateText.shift();
      }
      this.persist(text.utteranceId, 'transcript', text);
    }
    if (this.connected.interviewer && !this.ended.interviewer) this.questions?.transcript(text);
    this.log({
      type: 'transcript',
      role: text.role,
      utteranceId: text.utteranceId,
      isFinal: text.isFinal,
      length: text.text.length,
      audioStartMs: text.audioStartMs,
    });
  }
  private question(question: Question) {
    if (!this.id || this.diagnostic) return;
    this.log({
      type: 'question',
      questionId: question.questionId,
      revision: question.revision,
      length: question.text.length,
      provisional: question.provisional,
    });
    this.emit({ type: 'question', data: question });
    this.persist(question.questionId, 'question', question);
    // Saved model credentials/background apply to the next question without restarting capture.
    const settings = this.config.public().settings;
    void this.replies.generate(
      question,
      this.epoch,
      settings,
      this.config.key('llm'),
      this.candidateText.join('\n'),
    );
  }
  answerLatest() {
    if (!this.id || this.diagnostic) throw new Error('请先开始正式会话');
    if (!this.questions?.answerLatest()) throw new Error('还没有可回答的面试官提问');
  }
  private reply(event: Reply) {
    if (event.sessionId !== this.id || event.epoch !== this.epoch) return;
    this.emit({ type: 'reply', data: event });
    if (event.type === 'reference') return;
    const item = this.replyTexts.get(event.requestId) ?? { event, text: '', lastSaved: 0 };
    item.event = { ...event, source: event.source ?? item.event.source };
    if (event.type === 'delta') item.text += event.text ?? '';
    this.replyTexts.set(event.requestId, item);
    if (
      ['complete', 'cancelled', 'error'].includes(event.type) ||
      Date.now() - item.lastSaved > 1500
    ) {
      item.lastSaved = Date.now();
      this.persist(event.requestId, 'reply', { ...item.event, text: item.text });
    }
    if (['complete', 'cancelled', 'error'].includes(event.type))
      this.replyTexts.delete(event.requestId);
    this.log({
      type: 'reply',
      requestId: event.requestId,
      questionId: event.questionId,
      event: event.type,
      length: item.text.length,
      message: event.message,
    });
  }
  private persist(id: string, kind: string, body: unknown) {
    if (this.id && this.settings.recordText)
      void this.db
        .call('event', id, this.id, kind, body)
        .catch(() =>
          this.emit({ type: 'notice', message: '会话记录写入失败，请检查数据目录权限' }),
        );
  }
  clear() {
    this.replies.cancel();
    this.epoch++;
    this.cutoff = Date.now() - this.startedAt;
    this.questions?.clear(this.cutoff);
    this.replyTexts.clear();
    return { epoch: this.epoch };
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (!this.id) return Promise.resolve();
    const id = this.id;
    this.status('stopping', '正在释放音频与连接');
    this.questions?.stop();
    this.replies.cancel();
    clearInterval(this.monitor);
    this.stopping = (async () => {
      try {
        await Promise.all(Object.values(this.clients).map((c) => c.finish()));
        if (this.settings.recordText) await this.db.call('end', id, 'stopped');
      } catch {
        this.emit({ type: 'notice', message: '会话已结束，但最终记录保存失败' });
      } finally {
        Object.values(this.clients).forEach((c) => c.stop());
        this.clients = {};
        this.id = null;
        this.secrets = { asr: '', llm: '' };
        this.status('stopped', '会话已停止');
        this.stopping = undefined;
      }
    })();
    return this.stopping;
  }
  diagnosticReport() {
    return {
      schemaVersion: 1,
      target: '腾讯会议 / Windows / H01',
      verified: false,
      note: '本报告提供采样与连接证据，H01 仍需按真实会议场景人工验收。',
      sessionId: this.id,
      appVersion: '0.1.1',
      settings: { asrModel: this.settings?.asrModel, diagnostic: this.diagnostic },
      environment: { platform: process.platform, arch: process.arch, versions: process.versions },
      stats: this.stats,
      events: this.diagnostics,
    };
  }
}
