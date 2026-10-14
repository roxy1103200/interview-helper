import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import type { AudioRole, Settings, Transcript } from '../../shared/contracts';

export class ParaformerAdapter {
  private ws?: WebSocket;
  private closed = false;
  private finishing = false;
  private ready = false;
  private generation = 0;
  private retry = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  private taskId = '';
  private offset = 0;
  private sentAudio = false;
  constructor(
    private readonly sessionId: string,
    private readonly role: AudioRole,
    private readonly settings: Settings,
    private readonly key: string,
    private readonly elapsed: () => number,
    private readonly onText: (t: Transcript) => void,
    private readonly onState: (ready: boolean, message: string) => void,
  ) {}
  connect(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('识别连接已取消'));
    const generation = ++this.generation;
    this.taskId = randomUUID();
    this.offset = this.elapsed();
    this.sentAudio = false;
    this.ready = false;
    const socket = new WebSocket(this.settings.asrEndpoint, {
      headers: { Authorization: `Bearer ${this.key}` },
      handshakeTimeout: 8000,
      maxPayload: 1_000_000,
    });
    this.ws = socket;
    let fatal = false;
    let openedAt = 0;
    let settled = false;
    let alive = true;
    return new Promise((resolve, reject) => {
      const fail = (message: string) => {
        if (!settled) {
          settled = true;
          reject(new Error(message));
        }
      };
      this.handshakeTimer = setTimeout(() => {
        fail('语音识别连接超时');
        socket.terminate();
      }, 10000);
      socket.on('open', () => {
        if (this.closed || generation !== this.generation) {
          socket.close();
          return;
        }
        socket.send(
          JSON.stringify({
            header: { action: 'run-task', task_id: this.taskId, streaming: 'duplex' },
            payload: {
              task_group: 'audio',
              task: 'asr',
              function: 'recognition',
              model: this.settings.asrModel,
              parameters: {
                format: 'pcm',
                sample_rate: 16000,
                language_hints: ['zh'],
                semantic_punctuation_enabled: false,
                max_sentence_silence: 600,
                heartbeat: true,
              },
              input: {},
            },
          }),
        );
      });
      socket.on('message', (data) => {
        if ((this.closed && !this.finishing) || generation !== this.generation) return;
        try {
          const message = JSON.parse(data.toString());
          if (message.header?.task_id !== this.taskId) return;
          if (message.header.event === 'task-started') {
            clearTimeout(this.handshakeTimer);
            this.ready = true;
            openedAt = Date.now();
            settled = true;
            this.onState(true, '识别连接已建立');
            resolve();
            this.pingTimer = setInterval(() => {
              if (!alive) {
                socket.terminate();
                return;
              }
              alive = false;
              if (socket.readyState === WebSocket.OPEN) socket.ping();
            }, 10000);
          } else if (message.header.event === 'result-generated') {
            const s = message.payload?.output?.sentence;
            if (!s || s.heartbeat || typeof s.text !== 'string' || !s.text.trim()) return;
            const begin = Number(s.begin_time ?? 0);
            this.onText({
              sessionId: this.sessionId,
              role: this.role,
              generation,
              utteranceId: `${this.taskId}:${begin}`,
              text: s.text.trim().slice(0, 30000),
              isFinal: !!s.sentence_end,
              audioStartMs: this.offset + begin,
              audioEndMs: typeof s.end_time === 'number' ? this.offset + s.end_time : undefined,
              receivedAt: Date.now(),
            });
          } else if (message.header.event === 'task-failed') {
            fatal = /invalid|auth|access|key|403|401/i.test(String(message.header.error_code));
            fail(
              fatal ? '识别鉴权失败，请检查百炼密钥与地域' : '识别任务失败，请检查模型、地域或额度',
            );
            this.onState(false, fatal ? '识别鉴权失败，请修改设置' : '识别任务中断，正在重连');
            socket.close();
          } else if (message.header.event === 'task-finished') socket.close();
        } catch {
          fail('识别服务返回了无效消息');
          socket.close();
        }
      });
      socket.on('pong', () => {
        alive = true;
      });
      socket.on('unexpected-response', (_request, response) => {
        fatal = response.statusCode === 401 || response.statusCode === 403;
        response.resume();
        fail(fatal ? '识别鉴权失败，请检查密钥和地域' : '识别服务暂时不可用');
        socket.terminate();
      });
      socket.on('error', () => {
        fail('无法连接语音识别服务，请检查网络与配置');
      });
      socket.on('close', () => {
        clearTimeout(this.handshakeTimer);
        clearInterval(this.pingTimer);
        this.ready = false;
        fail(this.closed ? '识别连接已取消' : '语音识别连接已关闭');
        if (this.closed || generation !== this.generation) return;
        this.onState(
          false,
          fatal ? '识别鉴权失败，等待修改设置' : '声道断开，转录可能有缺口，正在重连',
        );
        if (fatal) return;
        if (openedAt && Date.now() - openedAt > 30000) this.retry = 0;
        const delay = Math.min(8000, 500 * 2 ** this.retry++) * (0.8 + Math.random() * 0.4);
        this.retryTimer = setTimeout(() => {
          void this.connect().catch(() => {});
        }, delay);
      });
    });
  }
  send(pcm: Uint8Array) {
    if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) return;
    if (!this.sentAudio) {
      this.offset = Math.max(0, this.elapsed() - 100);
      this.sentAudio = true;
    }
    if (this.ws.bufferedAmount > 32000) {
      this.ws.terminate();
      return;
    }
    this.ws.send(pcm);
  }
  stop() {
    this.closed = true;
    this.finishing = false;
    this.ready = false;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    clearTimeout(this.handshakeTimer);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          header: { action: 'finish-task', task_id: this.taskId, streaming: 'duplex' },
          payload: { input: {} },
        }),
      );
      this.ws.close();
    } else this.ws?.terminate();
  }
  finish(): Promise<void> {
    this.closed = true;
    this.finishing = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    clearTimeout(this.handshakeTimer);
    const socket = this.ws;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      this.stop();
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.finishing = false;
        this.ready = false;
        resolve();
      };
      const timer = setTimeout(() => {
        socket.terminate();
        done();
      }, 1200);
      socket.once('close', done);
      socket.send(
        JSON.stringify({
          header: { action: 'finish-task', task_id: this.taskId, streaming: 'duplex' },
          payload: { input: {} },
        }),
      );
    });
  }
}
