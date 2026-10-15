# 实时面试语音转录与 AI 检索回复桌面系统 — 完整工程开发文档

**文档版本**：v1.0.0（生产级工程规范）  
**目标形态**：跨平台桌面客户端（Electron + React + TypeScript + 本地/云端流式检索与推理服务）  
**核心交互模型**：双声道物理隔离持续长连接 ➔ 实时流式语音转写 ➔ 面试官停顿（VAD）全自动触发 ➔ 知识库检索（RAG）与大模型流式回复
**语音识别采用云端大模型，一个阿里云和deepseek，本项目将不会保存您的数据！绝对隐私安全可控！项目将开源

## 1. 产品定义与核心交互规范

本系统专为实时线上技术与业务面试场景设计。系统启动后即保持**全时段持久连接状态**，在底层物理隔离采集“面试者麦克风”与“系统内录（面试官声音）”两条独立音频流，全程无需人工点击“下一题”或手动切换声道。

### 1.1 三栏同屏工作台布局规范

主界面严格采用从左到右**三栏同屏分屏布局**（CSS Grid 宽度比例固定为 `1fr : 1fr : 1.65fr`），面板内部砍除一切冗余标签、准确率徽章、进度条与打勾比对控件，仅保留高可读性的实时流式文本：

| 栏位顺序 | 面板名称 | 宽度占比 | 绑定物理音源 / 数据源 | 面板内部内容与触发逻辑 |
| :--- | :--- | :--- | :--- | :--- |
| **左栏** | **面试者实时文本** | `1fr` (约 27%) | **通道 A：本地麦克风（Mic）** | 仅实时流式展示面试者本人说出的话；停顿后自动分段定稿，用于上下文记忆与面试复盘。 |
| **中栏** | **面试官实时转录** | `1fr` (约 27%) | **通道 B：系统内录（System Loopback）** | 仅实时流式展示会议软件中面试官说出的话；内置 VAD 静音检测，**面试官一旦停顿满 600ms，立即全自动触发右栏检索与生成**。 |
| **右栏** | **AI 实时回复内容** | `1.65fr` (约 46%) | **中栏提问 + 题库/简历库 (RAG) + LLM** | 占据全屏最宽视觉面积；采用大字号（`16.5px+`）、宽行距纯流式文字输出，优先返回毫秒级本地检索答案并流式输出大模型话术。 |

### 1.2 桌面端顶栏极简控制规范

实战面试中严禁出现复杂的操作按钮或手动分流开关，客户端顶栏仅保留以下 4 项控制：

1. **持久连接状态指示灯**：展示 `🟢 实时连接已建立 · 双声道持续监听中`，支持整场面试开始/结束时一键启停。
2. **题库与 API 配置入口**：配置本地个人简历问答库、高频技术题库及大模型流式 API 密钥。
3. **字号快速缩放（`A-` / `A+`）**：动态调整三栏正文字号，适配不同外接显示器与视距。
4. **清屏与防共享隐身开关**：一键清空历史流或开启桌面窗口防截屏保护（`setContentProtection`）。

## 2. 系统总体架构与全链路时序设计

### 2.1 四层流式架构设计

1. **硬件音频采集与重采样层（Audio Capture & Worklet Layer）**
   * **左栏音源（Channel A）**：通过 `navigator.mediaDevices.getUserMedia` 独占采集本地麦克风，强制开启硬件回声消除（`echoCancellation: true`）、降噪（`noiseSuppression: true`），防止耳机漏音或扬声器外放被误录进左栏。
   * **中栏音源（Channel B）**：通过桌面操作系统底层回环接口（Windows `WASAPI Loopback` / macOS `ScreenCaptureKit`）直接抓取声卡输出缓冲区的数字音频流，100% 纯净获取面试官声音。
   * **独立音频线程重采样**：两条音轨各自进入独立的 `AudioWorkletProcessor` 线程，由系统默认的 `48kHz Float32` 实时降采样为 ASR 引擎标准的 `16kHz, 16-bit, Mono (单声道) PCM` 二进制流，每 `100ms`（3200 字节）切分一个音频帧。
2. **双通道持久 WebSocket 语音转写层（Persistent Streaming ASR Layer）**
   * 维护两条独立的 WebSocket 长连接（`ws_candidate` 与 `ws_interviewer`），内置心跳保活（每 10 秒 Ping/Pong）与断线指数退避重连（100ms ➔ 300ms ➔ 1000ms），保证 2 小时面试不断连。
   * 实时接收 `interim`（识别中临时字词，带闪烁光标实时刷新当前行）与 `final`（句尾定稿文本）。
3. **语义与静音混合 VAD 触发层（Hybrid VAD Trigger Engine）**
   * 仅挂载在中栏（面试官通道）。当面试官持续说话时，重置静音计时器；当检测到连续 `600ms` 无新增有效字词（或 ASR 返回 `speech_final=true`），且当前句有效字数 `>= 4`（自动过滤“嗯”、“好的”、“明白”等简短附和词），立即抛出 `INTERVIEWER_QUESTION_READY` 事件。
4. **混合检索与大模型流式生成层（Hybrid RAG + LLM SSE Layer）**
   * **第一阶段（0 ~ 15ms 本地极速检索）**：收到面试官问题文本后，立即在本地 SQLite FTS5 / 向量索引库中检索匹配的个人简历项目经历与高频题库。
   * **第二阶段（200 ~ 350ms 大模型流式合成）**：将召回的 Top-3 知识片段与最近 3 轮对话上下文拼装为 Prompt，通过 Server-Sent Events (SSE) 流式请求大模型，右栏实时逐字渲染输出。

### 2.2 端到端低延迟预算表（Target E2E Latency < 900ms）

| 链路阶段 | 耗时预算 | 核心优化手段 |
| :--- | :--- | :--- |
| **音频分片采集 (AudioWorklet)** | `80 ~ 100 ms` | 采用独立渲染外线程帧缓冲，每 1600 个采样点（100ms @ 16kHz）立即推送二进制帧 |
| **WebSocket 流式 ASR 识别** | `120 ~ 180 ms` | 复用 TLS 长连接；使用流式模型（Deepgram Nova-2 / 阿里 FunASR 流式版 / 讯飞流式版） |
| **VAD 停顿判定窗口** | `400 ~ 600 ms` | 句尾疑问词语义检测（命中“怎么”、“如何”、“为什么”、“吗”时动态缩短静音阈值至 `400ms`） |
| **本地题库/简历混合检索** | `5 ~ 15 ms` | 内存倒排索引 + 本地轻量级 Embedding 向量检索，命中高频题时可直接零延迟上屏 |
| **大模型首字响应 (TTFT)** | `220 ~ 320 ms` | 固定简历与系统提示词前缀以 100% 命中大模型 `Prefix KV Cache`；禁止输出寒暄前缀 |

## 3. 工程目录结构规范

项目采用基于 `electron-vite` 的标准 Monorepo 结构，清晰分离主进程（系统权限与原生音频）、预加载桥接层与 React 渲染进程：

```text
realtime-interview-copilot/
├── electron.vite.config.ts           # Electron + Vite 构建配置
├── package.json
├── src/
│   ├── main/                         # Electron 主进程 (Node.js 环境)
│   │   ├── index.ts                  # 窗口创建、防截屏隐身、置顶与全局快捷键注册
│   │   ├── systemAudioLoopback.ts    # Windows WASAPI / macOS ScreenCaptureKit 原生内录源挂载
│   │   └── localRagDb.ts             # SQLite 本地题库与简历知识库增删改查及全文/向量检索
│   ├── preload/                      # 预加载安全桥接层 (ContextBridge)
│   │   └── index.ts                  # 向渲染进程暴露双声道设备枚举、本地检索与配置持久化 API
│   └── renderer/                     # 前端渲染进程 (React 18 + TypeScript + Zustand)
│       ├── index.html
│       ├── assets/
│       │   └── pcm-worklet.js        # AudioWorklet 48kHz -> 16kHz PCM 重采样独立脚本
│       └── src/
│           ├── App.tsx               # 三栏分屏主布局容器与持久连接生命周期挂载
│           ├── styles/
│           │   └── workspace.css     # 1fr : 1fr : 1.65fr 三栏极简暗色主题样式
│           ├── store/
│           │   └── useSessionStore.ts# 全局流式文本队列、连接状态与题库配置状态管理
│           ├── services/
│           │   ├── dualAudioEngine.ts# 双声道 (Mic + Loopback) 采集与 AudioWorklet 管道管理
│           │   ├── persistentAsr.ts  # 双路 WebSocket ASR 自动重连客户端与混合 VAD 判定器
│           │   └── ragLlmStreamer.ts # 本地检索召回 + 大模型 SSE 流式请求与中断控制器
│           └── components/
│               ├── TopStatusBar.tsx  # 极简顶栏（连接状态灯、字号缩放、配置弹窗开关）
│               ├── CandidatePane.tsx # 左栏：面试者麦克风实时流式文本视图
│               ├── InterviewerPane.tsx # 中栏：面试官系统内录实时流式转录视图
│               ├── AiReplyPane.tsx   # 右栏：最宽面积 AI 实时流式回复视图
│               └── ConfigModal.tsx   # 题库管理与大模型 API 配置弹窗
```

## 4. 核心模块一：双声道物理隔离采集与重采样实现

### 4.1 Electron 主进程：开启防截屏隐身与系统内录源授权

在 `src/main/index.ts` 中，创建桌面窗口时默认开启防屏幕共享捕获保护，并拦截 `setDisplayMediaRequestHandler` 自动将系统回环音频（Loopback）挂载给中栏面试官通道，无需用户每次手动弹窗选择窗口：

```typescript
// src/main/index.ts
import { app, BrowserWindow, desktopCapturer, session, ipcMain } from 'electron';
import path from 'path';

let mainWindow: BrowserWindow | null = null;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 860,
    minWidth: 1080,
    minHeight: 640,
    frame: false,
    alwaysOnTop: true,
    backgroundColor: '#090c12',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 关键实战保护：开启窗口内容保护，腾讯会议/Zoom 共享整个桌面时本窗口自动透明不可见
  mainWindow.setContentProtection(true);

  // 自动接管系统内录音频请求（Windows WASAPI Loopback / macOS ScreenCaptureKit Audio）
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    if (sources.length > 0) {
      callback({
        video: sources[0],
        audio: 'loopback', // 直接抓取操作系统声卡回环输出（即面试官声音）
      });
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(createMainWindow);
```

### 4.2 AudioWorklet 独立线程 16kHz PCM 重采样器

为了防止双声道高频音频计算阻塞 UI 线程导致文字滚动卡顿，在 `src/renderer/assets/pcm-worklet.js` 中实现原生线性插值降采样与 Int16 量化：

```javascript
// src/renderer/assets/pcm-worklet.js
class PcmDownsamplerWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetSampleRate = 16000;
    this.frameSize = 1600; // 100ms @ 16kHz = 1600 samples (3200 bytes)
    this.buffer = new Int16Array(this.frameSize);
    this.writeIndex = 0;
  }

  process(inputs) {
    const inputChannel = inputs[0]?.[0];
    if (!inputChannel || inputChannel.length === 0) return true;

    const ratio = sampleRate / this.targetSampleRate;
    const outputLength = Math.floor(inputChannel.length / ratio);

    for (let i = 0; i < outputLength; i++) {
      const srcIdx = Math.floor(i * ratio);
      const sample = Math.max(-1, Math.min(1, inputChannel[srcIdx]));
      // Float32 [-1.0, 1.0] -> Int16 [-32768, 32767]
      this.buffer[this.writeIndex++] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;

      if (this.writeIndex >= this.frameSize) {
        const pcmChunk = this.buffer.slice(0).buffer;
        this.port.postMessage(pcmChunk, [pcmChunk]);
        this.writeIndex = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-downsampler', PcmDownsamplerWorklet);
```

### 4.3 双通道音频引擎管理类 (`dualAudioEngine.ts`)

严格将麦克风绑定到 `candidate`（左栏），将系统回环音频绑定到 `interviewer`（中栏）：

```typescript
// src/renderer/src/services/dualAudioEngine.ts
export type AudioChannelRole = 'candidate' | 'interviewer';

export class DualAudioEngine {
  private micContext: AudioContext | null = null;
  private sysContext: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  private sysStream: MediaStream | null = null;

  async startDualCapture(onPcmChunk: (role: AudioChannelRole, pcmBuffer: ArrayBuffer) => void) {
    // 1. 启动通道 A：本地麦克风（严格对应左栏：面试者）
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true, // 必须开启回声消除，防止外放面试官声音串入麦克风
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });
    this.micContext = await this.mountWorkletPipeline(this.micStream, (chunk) => {
      onPcmChunk('candidate', chunk);
    });

    // 2. 启动通道 B：系统内录 Loopback（严格对应中栏：面试官）
    this.sysStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });
    // 停止无用的视频轨道以节省内存，仅保留系统内录音频轨道
    this.sysStream.getVideoTracks().forEach((track) => track.stop());

    this.sysContext = await this.mountWorkletPipeline(this.sysStream, (chunk) => {
      onPcmChunk('interviewer', chunk);
    });
  }

  private async mountWorkletPipeline(
    stream: MediaStream,
    onChunk: (buf: ArrayBuffer) => void
  ): Promise<AudioContext> {
    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule('/assets/pcm-worklet.js');
    const source = ctx.createMediaStreamSource(stream);
    const workletNode = new AudioWorkletNode(ctx, 'pcm-downsampler');
    workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      onChunk(event.data);
    };
    source.connect(workletNode);
    return ctx;
  }

  async stopAll() {
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.sysStream?.getTracks().forEach((t) => t.stop());
    await this.micContext?.close();
    await this.sysContext?.close();
  }
}
```

## 5. 核心模块二：持久 WebSocket ASR 长连接与 VAD 停顿触发器

### 5.1 永不断连的流式语音识别与混合 VAD 实现 (`persistentAsr.ts`)

此模块负责维持双路 WebSocket 长连接，并在中栏（面试官通道）实现**“流式实时上屏 + 停顿满 600ms 全自动触发右栏检索回复”**：

```typescript
// src/renderer/src/services/persistentAsr.ts
import { AudioChannelRole } from './dualAudioEngine';

export interface AsrCallbacks {
  onInterimText: (role: AudioChannelRole, text: string) => void;
  onFinalTurn: (role: AudioChannelRole, text: string) => void;
  onInterviewerPauseTrigger: (questionText: string) => void;
  onConnectionChange: (role: AudioChannelRole, connected: boolean) => void;
}

export class PersistentAsrSocket {
  private ws: WebSocket | null = null;
  private keepAliveTimer: number | null = null;
  private vadTimer: number | null = null;
  private manuallyClosed = false;
  private reconnectDelay = 200;
  private currentTurnBuffer = '';

  // 过滤无实质意义的短语气词，防止面试官说“嗯好”时误触发冲掉右栏答案
  private static readonly FILLER_REGEX = /^(嗯+|啊+|哦+|好的|好|明白|行|是的|对|ok|okay)[。，！？,.!?]*$/i;

  constructor(
    private readonly role: AudioChannelRole,
    private readonly wsEndpoint: string,
    private readonly callbacks: AsrCallbacks
  ) {}

  connect() {
    this.manuallyClosed = false;
    this.ws = new WebSocket(`${this.wsEndpoint}?channel=${this.role}`);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      this.reconnectDelay = 200;
      this.callbacks.onConnectionChange(this.role, true);
      // 每 8 秒发送一次心跳帧，确保空闲等待期间长连接绝不中断
      this.keepAliveTimer = window.setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
        }
      }, 8000);
    };

    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type !== 'transcript') return;

      const text = (msg.text || '').trim();
      if (!text) return;

      if (!msg.is_final) {
        // 实时流式刷新当前未定稿行
        const preview = this.currentTurnBuffer + text;
        this.callbacks.onInterimText(this.role, preview);
        if (this.role === 'interviewer') {
          this.scheduleInterviewerVadTrigger(preview);
        }
      } else {
        // 累加已确认字词
        this.currentTurnBuffer += text;
        this.callbacks.onInterimText(this.role, this.currentTurnBuffer);
        if (this.role === 'interviewer') {
          this.scheduleInterviewerVadTrigger(this.currentTurnBuffer, msg.speech_final);
        } else {
          this.scheduleCandidateFinalize();
        }
      }
    };

    this.ws.onclose = () => {
      this.cleanupTimers();
      this.callbacks.onConnectionChange(this.role, false);
      // 只要未手动关闭，立即自动重连以保持持久连接状态
      if (!this.manuallyClosed) {
        window.setTimeout(() => this.connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(3000, this.reconnectDelay * 1.5);
      }
    };
  }

  sendPcmChunk(pcmBuffer: ArrayBuffer) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(pcmBuffer);
    }
  }

  private scheduleInterviewerVadTrigger(accumulatedText: string, speechFinal = false) {
    if (this.vadTimer) window.clearTimeout(this.vadTimer);

    // 若句尾带有明确疑问词，静音判定缩短至 420ms；常规停顿判定为 600ms
    const hasQuestionTail = /(吗|呢|怎么|如何|为什么|区别|原理|方案|讲讲|说说|介绍)[？?。.]*$/.test(accumulatedText);
    const silenceThreshold = speechFinal ? 150 : hasQuestionTail ? 420 : 600;

    this.vadTimer = window.setTimeout(() => {
      const finalUtterance = this.currentTurnBuffer.trim() || accumulatedText.trim();
      this.currentTurnBuffer = '';
      if (!finalUtterance) return;

      // 1. 将中栏当前流式行定稿
      this.callbacks.onFinalTurn('interviewer', finalUtterance);

      // 2. 校验是否为有效提问（字数 >= 4 且非纯语气词），若是则全自动触发右栏检索与生成
      if (finalUtterance.length >= 4 && !PersistentAsrSocket.FILLER_REGEX.test(finalUtterance)) {
        this.callbacks.onInterviewerPauseTrigger(finalUtterance);
      }
    }, silenceThreshold);
  }

  private scheduleCandidateFinalize() {
    if (this.vadTimer) window.clearTimeout(this.vadTimer);
    this.vadTimer = window.setTimeout(() => {
      const text = this.currentTurnBuffer.trim();
      this.currentTurnBuffer = '';
      if (text) {
        this.callbacks.onFinalTurn('candidate', text);
      }
    }, 650);
  }

  private cleanupTimers() {
    if (this.keepAliveTimer) window.clearInterval(this.keepAliveTimer);
    if (this.vadTimer) window.clearTimeout(this.vadTimer);
  }

  disconnect() {
    this.manuallyClosed = true;
    this.cleanupTimers();
    this.ws?.close();
  }
}
```

## 6. 核心模块三：本地毫秒级检索（RAG）与大模型流式回复引擎

### 6.1 本地知识库存储与混合检索设计

系统采用 **“本地题库毫秒级直出 + 大模型结合简历背景流式生成”** 的双保险架构：

| 数据表名称 | 核心字段定义 | 用途说明 |
| :--- | :--- | :--- |
| `knowledge_chunks` | `id`, `category`, `trigger_keywords`, `question_title`, `standard_answer`, `embedding_blob` | 存储个人简历项目深挖问答、自我介绍、高频技术八股标准答案 |
| `interview_sessions` | `session_id`, `job_title`, `resume_summary`, `created_at` | 存储当前面试场次关联的岗位 JD 与个人简历概要（固定在 Prompt 头部命中缓存） |
| `utterance_logs` | `id`, `session_id`, `role` (`candidate`/`interviewer`/`ai`), `content`, `created_at` | 按时间轴持久化三栏的所有转录与 AI 回复记录，支持面试后一键导出复盘 |

### 6.2 自动检索与 SSE 流式生成实现 (`ragLlmStreamer.ts`)

当面试官停顿触发 `onInterviewerPauseTrigger(questionText)` 时，立即执行以下流式管道（若前一次生成尚未结束而面试官又追问了新句子，通过 `AbortController` 自动中断旧请求并无缝合并上下文）：

```typescript
// src/renderer/src/services/ragLlmStreamer.ts
export interface StreamReplyOptions {
  question: string;
  recentHistory: { role: 'interviewer' | 'candidate'; text: string }[];
  resumeContext: string;
  apiUrl: string;
  apiKey: string;
  model: string;
  onTokenDelta: (accumulatedText: string) => void;
  onComplete: () => void;
}

export class RagLlmStreamer {
  private abortController: AbortController | null = null;

  async retrieveAndStream(options: StreamReplyOptions) {
    // 若上一轮流式输出未结束，立即安全中断
    this.abortController?.abort();
    this.abortController = new AbortController();

    // Step 1: 调用 Electron Preload 桥接的本地 SQLite FTS5 / 向量检索 (< 15ms)
    const matchedChunks: { title: string; answer: string; score: number }[] =
      await window.electronApi.searchKnowledgeBase(options.question, 3);

    // 若未配置外部大模型 API Key 且本地题库高置信度命中，直接流式输出本地题库答案
    if (!options.apiKey && matchedChunks.length > 0) {
      this.simulateFastLocalStream(matchedChunks[0].answer, options.onTokenDelta, options.onComplete);
      return;
    }

    // Step 2: 组装命中 Prefix Cache 的结构化 Prompt
    const ragReference = matchedChunks
      .map((c, idx) => `【参考资料 ${idx + 1}: ${c.title}】
${c.answer}`)
      .join('

');

    const systemPrompt = [
      '你是一名实时技术面试提词专家。面试官刚刚说完一句话并停顿，请直接输出供面试者现场自然口述的回答正文。',
      '输出规范：',
      '1. 严禁输出“好的”、“针对这个问题”等任何寒暄废话，第一行直接给出核心技术结论；',
      '2. 分点清晰，语言符合口语表达习惯，重点技术名词突出；',
      `3. 候选人真实简历背景：
${options.resumeContext}`,
      ragReference ? `4. 优先融合以下本地题库与项目细节：
${ragReference}` : '',
    ].join('
');

    const response = await fetch(options.apiUrl, {
      method: 'POST',
      signal: this.abortController.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        stream: true,
        temperature: 0.3,
        messages: [
          { role: 'system', content: systemPrompt },
          ...options.recentHistory.slice(-4).map((h) => ({
            role: h.role === 'interviewer' ? 'user' : 'assistant',
            content: h.text,
          })),
          { role: 'user', content: options.question },
        ],
      }),
    });

    if (!response.ok || !response.body) {
      throw new Error(`LLM Stream HTTP Error: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split('
')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ') || trimmed === 'data: [DONE]') continue;
        try {
          const json = JSON.parse(trimmed.slice(6));
          const delta = json.choices?.[0]?.delta?.content || '';
          if (delta) {
            fullText += delta;
            options.onTokenDelta(fullText);
          }
        } catch {
          // 忽略跨 chunk 半包解析异常
        }
      }
    }

    options.onComplete();
  }

  private simulateFastLocalStream(
    text: string,
    onDelta: (acc: string) => void,
    onDone: () => void
  ) {
    let i = 0;
    const timer = window.setInterval(() => {
      i += 6;
      onDelta(text.slice(0, i));
      if (i >= text.length) {
        window.clearInterval(timer);
        onDone();
      }
    }, 16);
  }
}
```

## 7. 核心模块四：前端三栏分屏状态与组件实现

### 7.1 全局状态管理 (`useSessionStore.ts`)

管理左（面试者）、中（面试官）、右（AI 回复）三栏的数据流：

```typescript
// src/renderer/src/store/useSessionStore.ts
import { create } from 'zustand';

export interface StreamTurnItem {
  id: string;
  timestamp: string;
  text: string;
  isStreaming?: boolean;
}

interface SessionState {
  isConnected: boolean;
  candidateTurns: StreamTurnItem[];
  candidateInterim: string;
  interviewerTurns: StreamTurnItem[];
  interviewerInterim: string;
  aiTurns: StreamTurnItem[];
  activeAiStreamText: string;
  isAiGenerating: boolean;

  setInterim: (role: 'candidate' | 'interviewer', text: string) => void;
  appendFinalTurn: (role: 'candidate' | 'interviewer', text: string) => void;
  startNewAiTurn: () => void;
  updateActiveAiStream: (text: string) => void;
  finishActiveAiTurn: () => void;
  clearAll: () => void;
}

const nowStr = () => new Date().toTimeString().slice(0, 8);

export const useSessionStore = create<SessionState>((set) => ({
  isConnected: true,
  candidateTurns: [],
  candidateInterim: '',
  interviewerTurns: [],
  interviewerInterim: '',
  aiTurns: [],
  activeAiStreamText: '',
  isAiGenerating: false,

  setInterim: (role, text) =>
    set(role === 'candidate' ? { candidateInterim: text } : { interviewerInterim: text }),

  appendFinalTurn: (role, text) =>
    set((state) => {
      const item: StreamTurnItem = {
        id: `${role}-${Date.now()}`,
        timestamp: nowStr(),
        text,
      };
      return role === 'candidate'
        ? { candidateTurns: [...state.candidateTurns, item], candidateInterim: '' }
        : { interviewerTurns: [...state.interviewerTurns, item], interviewerInterim: '' };
    }),

  startNewAiTurn: () =>
    set({ isAiGenerating: true, activeAiStreamText: '' }),

  updateActiveAiStream: (text) =>
    set({ activeAiStreamText: text }),

  finishActiveAiTurn: () =>
    set((state) => ({
      isAiGenerating: false,
      activeAiStreamText: '',
      aiTurns: state.activeAiStreamText
        ? [
            ...state.aiTurns,
            {
              id: `ai-${Date.now()}`,
              timestamp: nowStr(),
              text: state.activeAiStreamText,
            },
          ]
        : state.aiTurns,
    })),

  clearAll: () =>
    set({
      candidateTurns: [],
      candidateInterim: '',
      interviewerTurns: [],
      interviewerInterim: '',
      aiTurns: [],
      activeAiStreamText: '',
      isAiGenerating: false,
    }),
}));
```

### 7.2 三栏同屏主视图 (`App.tsx`)

严格按照 **「左：面试者文本 ｜ 中：面试官转录 ｜ 右：AI 回答（最宽面积）」** 布局渲染：

```tsx
// src/renderer/src/App.tsx
import React, { useEffect, useRef } from 'react';
import { useSessionStore } from './store/useSessionStore';

export const App: React.FC = () => {
  const {
    candidateTurns,
    candidateInterim,
    interviewerTurns,
    interviewerInterim,
    aiTurns,
    activeAiStreamText,
    isAiGenerating,
  } = useSessionStore();

  const leftRef = useRef<HTMLDivElement>(null);
  const midRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);

  // 新文字流式上屏时自动平滑滚动到底部
  useEffect(() => {
    leftRef.current?.scrollTo({ top: leftRef.current.scrollHeight });
  }, [candidateTurns, candidateInterim]);

  useEffect(() => {
    midRef.current?.scrollTo({ top: midRef.current.scrollHeight });
  }, [interviewerTurns, interviewerInterim]);

  useEffect(() => {
    rightRef.current?.scrollTo({ top: rightRef.current.scrollHeight });
  }, [aiTurns, activeAiStreamText]);

  return (
    <main className="three-pane-grid">
      {/* 左栏 (1fr)：面试者实时文本 (100% 绑定本地麦克风) */}
      <section className="pane pane-candidate">
        <header className="pane-header">
          <span>面试者实时文本</span>
          <span className="status-sub">麦克风持续监听中</span>
        </header>
        <div className="stream-body" ref={leftRef}>
          {candidateTurns.map((t) => (
            <div key={t.id} className="turn-block">
              <div className="turn-time">{t.timestamp}</div>
              <div className="turn-text">{t.text}</div>
            </div>
          ))}
          {candidateInterim && (
            <div className="turn-block">
              <div className="turn-time">正在说话...</div>
              <div className="turn-text streaming-cursor">{candidateInterim}</div>
            </div>
          )}
        </div>
      </section>

      {/* 中栏 (1fr)：面试官实时转录 (100% 绑定系统内录，停顿自动触发右栏) */}
      <section className="pane pane-interviewer">
        <header className="pane-header">
          <span>面试官实时转录</span>
          <span className="status-sub">系统声道持续监听 (停顿 0.6s 自动检索)</span>
        </header>
        <div className="stream-body" ref={midRef}>
          {interviewerTurns.map((t) => (
            <div key={t.id} className="turn-block">
              <div className="turn-time">{t.timestamp}</div>
              <div className="turn-text">{t.text}</div>
            </div>
          ))}
          {interviewerInterim && (
            <div className="turn-block">
              <div className="turn-time">正在实时识别...</div>
              <div className="turn-text streaming-cursor">{interviewerInterim}</div>
            </div>
          )}
        </div>
      </section>

      {/* 右栏 (1.65fr 最宽面积)：AI 实时流式回复内容 */}
      <section className="pane pane-ai">
        <header className="pane-header">
          <span>AI 实时回复内容</span>
          <span className="status-sub">
            {isAiGenerating ? '正在实时检索并流式生成...' : '监听就绪 · 面试官停顿即自动输出'}
          </span>
        </header>
        <div className="stream-body" ref={rightRef}>
          {aiTurns.map((t) => (
            <div key={t.id} className="turn-block">
              <div className="turn-time">{t.timestamp}</div>
              <div className="turn-text">{t.text}</div>
            </div>
          ))}
          {isAiGenerating && (
            <div className="turn-block">
              <div className="turn-time">AI 实时流式回复中...</div>
              <div className="turn-text streaming-cursor">{activeAiStreamText}</div>
            </div>
          )}
        </div>
      </section>
    </main>
  );
};
```

## 8. 后端流式代理网关实现（Python FastAPI 参考实现）

若采用本地或私有云服务器转发双路音频流至云端 ASR（如阿里 FunASR / Deepgram）及大模型，后端只需极简的 `FastAPI` 异步流式路由：

```python
# server/main.py
import asyncio
import json
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from openai import AsyncOpenAI

app = FastAPI(title="Realtime Interview Copilot Gateway")
llm_client = AsyncOpenAI(api_key="YOUR_API_KEY", base_url="https://api.deepseek.com/v1")

@app.websocket("/ws/asr")
async def websocket_asr_endpoint(websocket: WebSocket, channel: str = "interviewer"):
    await websocket.accept()
    try:
        while True:
            message = await websocket.receive()
            if "bytes" in message and message["bytes"]:
                pcm_chunk = message["bytes"]
                # 将 16kHz PCM 二进制帧直接转发至 FunASR / Deepgram 流式引擎
                # 收到流式识别结果后立即回推给前端对应声道：
                # await websocket.send_text(json.dumps({"type": "transcript", "text": "...", "is_final": False}))
            elif "text" in message and message["text"]:
                payload = json.loads(message["text"])
                if payload.get("type") == "ping":
                    await websocket.send_text(json.dumps({"type": "pong"}))
    except WebSocketDisconnect:
        pass
```

## 9. 关键边界场景处理与打包部署清单

### 9.1 实战面试四大边界问题与工程对策

| 边界场景 | 潜在现象 | 工程解决对策 |
| :--- | :--- | :--- |
| **外放扬声器回声串音** | 不用耳机外放时，面试官声音从音箱出来被麦克风录进左栏 | 1. 麦克风开启浏览器底层 `echoCancellation: true`；<br>2. 对比中栏与左栏时间戳和文本余弦相似度，若 `150ms` 内左栏出现与中栏高度重合文本则自动静默丢弃。 |
| **面试官说话中途短暂喘气停顿** | 面试官一句话分两半说，中间停了 700ms 导致提前触发了半句话的 AI 回答 | 使用 `AbortController` 抢跑修正机制：若触发后 `1.5秒` 内面试官继续说出下半句，自动将上下两半句拼接为完整问题，立即中断刚才的半截流式请求并重新流式生成。 |
| **面试官说简短附和词** | 面试官点头说“嗯，好的，明白”，触发右栏重新生成冲掉了当前正在念的答案 | VAD 触发器内置 `FILLER_REGEX` 黑名单与最小长度阈值（`< 4` 字不触发 AI 检索，仅在中栏上屏显示）。 |
| **用户视线正在阅读右栏上半段** | AI 流式吐字太快，底部自动滚动把用户正在读的段落顶上去 | 在右栏滚动容器监听 `onWheel` / `scrollTop`：当检测到滚动条距离底部 `> 80px` 时自动暂停强制滚底，直到下一轮新问题开始。 |

### 9.2 跨平台桌面打包权限配置 (`electron-builder.yml`)

* **Windows 平台（Windows 10/11）**：原生支持 `WASAPI Loopback`，无需安装 Virtual Audio Cable 虚拟声卡即可直接抓取系统声音。
* **macOS 平台（macOS 13.0+）**：在 `entitlements.mac.plist` 中声明麦克风与屏幕音频捕获权限：
  * `com.apple.security.device.audio-input`: `true`
  * `NSScreenCaptureUsageDescription`: `"用于实时捕获线上会议软件中的面试官音频流"`
  * `NSMicrophoneUsageDescription`: `"用于实时转录面试者本人的回答语音"`
